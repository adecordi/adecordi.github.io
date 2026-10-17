package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io/fs"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"
)

// Prova completa: una "chiavetta" e un "hard disk" finti, MusicBrainz e Cover
// Art Archive simulati con un server locale.

type fakeRelease struct {
	artist, title, album, rg string
	year, track, total       int
}

var fakeDB = []fakeRelease{
	{"Queen", "Bohemian Rhapsody", "A Night at the Opera", "rg-queen", 1975, 11, 12},
	{"Lucio Battisti", "Emozioni", "Emozioni", "rg-emozioni", 1970, 1, 12},
	{"Vasco Rossi", "Vita spericolata", "Bollicine", "rg-bollicine", 1983, 4, 6},
	{"Vasco Rossi", "Albachiara", "Non siamo mica gli americani!", "rg-americani", 1979, 9, 9},
	{"Toto", "Africa", "Toto IV", "rg-toto", 1982, 10, 10},
}

var reQuery = regexp.MustCompile(`recording:"((?:[^"\\]|\\.)*)" AND artist:"((?:[^"\\]|\\.)*)"`)

func fakeServer(t *testing.T, cover []byte) (*httptest.Server, *int) {
	requests := new(int)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*requests++
		if r.Header.Get("User-Agent") != userAgent {
			t.Errorf("User-Agent mancante: %q", r.Header.Get("User-Agent"))
		}
		if strings.HasPrefix(r.URL.Path, "/release-group/") {
			if strings.Contains(r.URL.Path, "rg-") {
				w.Header().Set("Content-Type", "image/jpeg")
				w.Write(cover)
				return
			}
			http.NotFound(w, r)
			return
		}
		if r.URL.Path != "/ws/2/recording" {
			http.NotFound(w, r)
			return
		}
		m := reQuery.FindStringSubmatch(r.URL.Query().Get("query"))
		var recs []map[string]any
		if m != nil {
			for _, f := range fakeDB {
				if normKey(f.title) == normKey(m[1]) && normKey(f.artist) == normKey(m[2]) {
					recs = append(recs, map[string]any{
						"id": "rec", "score": 100, "title": f.title, "length": 20000,
						"artist-credit": []map[string]any{{"name": f.artist, "artist": map[string]any{"name": f.artist}}},
						"releases": []map[string]any{
							{"id": "comp", "title": "Greatest Hits", "status": "Official", "date": "1990",
								"release-group": map[string]any{"id": "rg-comp", "primary-type": "Album", "secondary-types": []string{"Compilation"}}},
							{"id": "rel", "title": f.album, "status": "Official", "date": fmt.Sprint(f.year),
								"release-group": map[string]any{"id": f.rg, "primary-type": "Album"},
								"media": []map[string]any{{"position": 1, "track-count": f.total, "track-offset": f.track - 1,
									"track": []map[string]any{{"number": fmt.Sprint(f.track), "position": f.track}}}}},
						},
					})
				}
			}
		}
		json.NewEncoder(w).Encode(map[string]any{"recordings": recs})
	}))
	t.Cleanup(srv.Close)
	return srv, requests
}

type e2e struct {
	t        *testing.T
	tmp, raw string
}

// mp3 genera un brano: ogni frequenza dà un audio diverso.
func (e *e2e) mp3(freq, secs int, bitrate string) []byte {
	e.t.Helper()
	f := filepath.Join(e.raw, fmt.Sprintf("%d-%d-%s.mp3", freq, secs, bitrate))
	if !exists(f) {
		if err := encode(f, freq, secs, "-c:a", "libmp3lame", "-b:a", bitrate, "-ac", "2", "-write_id3v1", "0", "-map_metadata", "-1", "-id3v2_version", "0"); err != nil {
			e.t.Fatal(err)
		}
	}
	b, _ := os.ReadFile(f)
	in := analyzeMP3(b, 0)
	return append([]byte(nil), audioPayload(b, in)...)
}

func withTags(payload []byte, t *songTags) []byte {
	if t == nil {
		return append([]byte(nil), payload...)
	}
	return append(buildID3v23(*t), payload...)
}

func write(t *testing.T, path string, data []byte) {
	t.Helper()
	os.MkdirAll(filepath.Dir(path), 0o755)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func corrupt(b []byte, kind int) []byte {
	b = append([]byte(nil), b...)
	switch kind {
	case 0:
		clear(b[len(b)/2 : len(b)/2+4096])
	case 1:
		for i := len(b) / 3; i < len(b)/3+4096; i++ {
			b[i] = 0xFF
		}
	case 2:
		rand.New(rand.NewSource(7)).Read(b[len(b)/2 : len(b)/2+8192])
	}
	return b
}

func treeHashes(t *testing.T, root string) map[string][32]byte {
	out := map[string][32]byte{}
	filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			b, _ := os.ReadFile(p)
			rel, _ := filepath.Rel(root, p)
			out[rel] = sha256.Sum256(b)
		}
		return nil
	})
	return out
}

func readSongTags(t *testing.T, path string) (songTags, *mp3Info, []byte) {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("manca %s", filepath.Base(path))
	}
	_, tg := readTags(b)
	return tg, analyzeMP3(b, 0), b
}

func TestEndToEnd(t *testing.T) {
	ffmpegAvailable(t)
	mbMinInterval = 10 * time.Millisecond
	tmp := t.TempDir()
	e := &e2e{t: t, tmp: tmp, raw: filepath.Join(tmp, "raw")}
	os.MkdirAll(e.raw, 0o755)
	stick := filepath.Join(tmp, "chiavetta")
	hd := filepath.Join(tmp, "hd")
	backup := filepath.Join(tmp, "backup")
	cache := filepath.Join(tmp, "cache")

	cover := testJPEG(t, 600, 600)
	bigCover := testJPEG(t, 1200, 1200)

	// --- hard disk: le copie sane
	bohemian := e.mp3(300, 20, "128k")
	write(t, filepath.Join(hd, "Musica/Queen/A Night at the Opera/11 Bohemian Rhapsody.mp3"),
		withTags(bohemian, &songTags{Artist: "Queen", Title: "Bohemian Rhapsody", Album: "A Night at the Opera", Year: 1975, Track: 11}))
	albachiara := withTags(e.mp3(350, 21, "128k"), nil)
	write(t, filepath.Join(hd, "Download/vasco_rossi-albachiara.mp3"), albachiara)
	caruso := e.mp3(400, 22, "160k")
	write(t, filepath.Join(hd, "Musica/Lucio Dalla - Caruso.mp3"), withTags(caruso, &songTags{Artist: "Lucio Dalla", Title: "Caruso", Year: 1986}))
	certeHD := e.mp3(450, 20, "192k")
	write(t, filepath.Join(hd, "Altro/brano.mp3"), withTags(certeHD, &songTags{Artist: "Ligabue", Title: "Certe notti", Picture: cover}))
	// una copia rovinata anche sull'hard disk: non deve essere usata
	write(t, filepath.Join(hd, "Vecchi/Queen - Bohemian Rhapsody.mp3"), corrupt(withTags(bohemian, nil), 2))

	// --- chiavetta
	write(t, filepath.Join(stick, "Queen/Bohemian Rhapsody.mp3"),
		corrupt(withTags(bohemian, &songTags{Artist: "QUEEN", Title: "BOHEMIAN RHAPSODY"}), 0))
	write(t, filepath.Join(stick, "Queen/folder.jpg"), cover)
	write(t, filepath.Join(stick, "01 - vasco rossi - albachiara.mp3"), corrupt(albachiara, 1))
	write(t, filepath.Join(stick, "Caruso.mp3"), corrupt(withTags(caruso, &songTags{Artist: "Lucio Dalla", Title: "Caruso"}), 2))
	certe := e.mp3(450, 20, "128k") // stesso brano, codificato diversamente
	write(t, filepath.Join(stick, "Varie/ligabue - certe notti.mp3"), corrupt(withTags(certe, &songTags{Artist: "Ligabue", Title: "Certe notti"}), 0))
	write(t, filepath.Join(stick, "Varie/Sconosciuto - Brano rotto.mp3"), corrupt(withTags(e.mp3(500, 20, "128k"), nil), 2))
	destroyed := make([]byte, 300000)
	copy(destroyed, e.mp3(520, 20, "128k")[:2000])
	write(t, filepath.Join(stick, "Varie/distrutto.mp3"), destroyed)
	emozioni := withTags(e.mp3(550, 20, "128k"), nil)
	write(t, filepath.Join(stick, "Download/01_lucio_battisti-emozioni[www.mp3.com].mp3"), emozioni)
	write(t, filepath.Join(stick, "Emozioni (copia).mp3"), withTags(e.mp3(550, 20, "128k"), &songTags{Artist: "Lucio Battisti", Title: "Emozioni"}))
	write(t, filepath.Join(stick, "perche.mp3"), withTags(e.mp3(600, 20, "128k"), &songTags{Artist: "Lucio Battisti", Title: "PerchÃ©", Album: "Il mio canto libero", Year: 1972}))
	write(t, filepath.Join(stick, "vita.mp3"), withTags(e.mp3(650, 20, "128k"), &songTags{Artist: "VASCO ROSSI", Title: "VITA SPERICOLATA", Picture: bigCover}))
	write(t, filepath.Join(stick, "Alfa - Uno.mp3"), withTags(e.mp3(700, 20, "128k"), &songTags{Artist: "Beta", Title: "Due", Album: "X", Year: 2000}))
	write(t, filepath.Join(stick, "Beta - Due.mp3"), withTags(e.mp3(750, 20, "128k"), &songTags{Artist: "Alfa", Title: "Uno", Album: "X", Year: 2000}))
	write(t, filepath.Join(stick, "Già a posto - Ok.mp3"), withTags(e.mp3(800, 20, "128k"), &songTags{Artist: "Già a posto", Title: "Ok", Album: "Y", Year: 2001, Picture: cover}))
	write(t, filepath.Join(stick, "toto.mp3"), withTags(e.mp3(850, 20, "128k"), &songTags{Artist: "TOTO", Title: "Africa", Album: "Toto IV", Year: 1982, Picture: cover}))
	m4a := filepath.Join(stick, "canzone.mp3")
	exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=duration=3", "-c:a", "aac", "-f", "ipod", m4a).Run()
	write(t, filepath.Join(stick, "._Caruso.mp3"), []byte("AppleDouble"))
	write(t, filepath.Join(stick, "Varie/note.txt"), []byte("non toccare"))

	before := treeHashes(t, stick)
	hdBefore := treeHashes(t, hd)
	srv, requests := fakeServer(t, cover)

	opts := options{stick: stick, search: listFlag{hd}, yes: true, backupDir: backup, noOpen: true,
		mbURL: srv.URL, caaURL: srv.URL, cacheDir: cache}
	u := &ui{r: bufio.NewReader(strings.NewReader("")), yes: true}
	out := captureStdout(t, func() {
		if err := run(opts, u); err != nil {
			t.Fatal(err)
		}
	})
	t.Log(out)

	// l'hard disk non va mai toccato
	if hdAfter := treeHashes(t, hd); fmt.Sprint(hdAfter) != fmt.Sprint(hdBefore) {
		t.Error("l'hard disk è stato modificato")
	}
	// la copia di sicurezza contiene i file originali
	backups, _ := filepath.Glob(filepath.Join(backup, "RiparaMP3 backup *"))
	if len(backups) != 1 {
		t.Fatalf("copia di sicurezza: %v", backups)
	}
	bk := treeHashes(t, backups[0])
	for rel, h := range before {
		if strings.HasSuffix(rel, ".mp3") && !strings.HasPrefix(filepath.Base(rel), ".") {
			if bk[rel] != h {
				t.Errorf("copia di sicurezza: %s mancante o diverso", rel)
			}
		}
	}

	var names []string
	entries, _ := os.ReadDir(stick)
	for _, en := range entries {
		names = append(names, en.Name())
	}
	sort.Strings(names)
	want := []string{
		"._Caruso.mp3", "Alfa - Uno.mp3", "Beta - Due.mp3", "Brano rotto.mp3", "Distrutto.mp3",
		"Già a posto - Ok.mp3", "Ligabue - Certe notti.mp3",
		"Lucio Battisti - Emozioni.mp3", "Lucio Battisti - Perché.mp3", "Lucio Dalla - Caruso.mp3",
		"Queen", "Queen - Bohemian Rhapsody.mp3", "RiparaMP3-registro.txt",
		"Toto - Africa.mp3", "Varie", "Vasco Rossi - Albachiara.mp3", "Vasco Rossi - Vita spericolata.mp3", "_Doppioni",
		"canzone.mp3", "elenco.html",
	}
	if strings.Join(names, "\n") != strings.Join(want, "\n") {
		t.Errorf("contenuto della chiavetta:\n%s\natteso:\n%s", strings.Join(names, "\n"), strings.Join(want, "\n"))
	}
	if exists(filepath.Join(stick, "Download")) {
		t.Error("la cartella vuota Download doveva essere tolta")
	}
	if !exists(filepath.Join(stick, "Varie/note.txt")) || !exists(filepath.Join(stick, "Queen/folder.jpg")) {
		t.Error("i file non mp3 devono restare dove sono")
	}
	if d, _ := filepath.Glob(filepath.Join(stick, "_Doppioni", "*.mp3")); len(d) != 1 {
		t.Errorf("doppioni: %v", d)
	}

	// recuperati dall'hard disk: l'audio deve essere identico alla copia sana
	checkAudio := func(name string, wantAudio []byte) songTags {
		t.Helper()
		tg, in, b := readSongTags(t, filepath.Join(stick, name))
		if in.Defective {
			t.Errorf("%s: ancora rovinato: %v", name, in.Problems)
		}
		if wantAudio != nil && !bytes.Equal(audioPayload(b, in), wantAudio) {
			t.Errorf("%s: audio diverso dalla copia sana", name)
		}
		return tg
	}
	tg := checkAudio("Queen - Bohemian Rhapsody.mp3", bohemian)
	if tg.Artist != "Queen" || tg.Title != "Bohemian Rhapsody" || tg.Album != "A Night at the Opera" || tg.Year != 1975 || len(tg.Picture) == 0 {
		t.Errorf("Bohemian Rhapsody: %+v", tg)
	}
	alb := analyzeMP3(albachiara, 0)
	tg = checkAudio("Vasco Rossi - Albachiara.mp3", audioPayload(albachiara, alb))
	if tg.Album != "Non siamo mica gli americani!" || tg.Year != 1979 || tg.Track != 1 {
		t.Errorf("Albachiara: %+v", tg)
	}
	checkAudio("Lucio Dalla - Caruso.mp3", caruso)
	tg = checkAudio("Ligabue - Certe notti.mp3", certeHD)
	if len(tg.Picture) == 0 {
		t.Error("Certe notti: copertina della copia sull'hard disk non usata")
	}
	// riparato in parte
	if _, in, b := readSongTags(t, filepath.Join(stick, "Brano rotto.mp3")); in.Gaps > 0 || ffmpegErrors(t, b) != "" {
		t.Errorf("Brano rotto non riparato: %v", in.Problems)
	}
	// tag sistemati
	tg = checkAudio("Lucio Battisti - Emozioni.mp3", nil)
	if tg.Artist != "Lucio Battisti" || tg.Title != "Emozioni" || tg.Album != "Emozioni" || tg.Year != 1970 || len(tg.Picture) == 0 {
		t.Errorf("Emozioni: %+v", tg)
	}
	if tg = checkAudio("Lucio Battisti - Perché.mp3", nil); tg.Title != "Perché" {
		t.Errorf("Perché: %+v", tg)
	}
	tg = checkAudio("Vasco Rossi - Vita spericolata.mp3", nil)
	if tg.Artist != "Vasco Rossi" || tg.Title != "Vita spericolata" || tg.Album != "Bollicine" {
		t.Errorf("Vita spericolata: %+v", tg)
	}
	if n, _ := normalizeCover(tg.Picture); len(tg.Picture) == 0 || !bytes.Equal(n, tg.Picture) {
		t.Error("Vita spericolata: copertina non ridotta")
	}
	if tg = checkAudio("Alfa - Uno.mp3", nil); tg.Artist != "Alfa" || tg.Title != "Uno" {
		t.Errorf("scambio di nomi: %+v", tg)
	}
	// il file m4a non va toccato
	if h := treeHashes(t, stick)["canzone.mp3"]; h != before["canzone.mp3"] {
		t.Error("il file m4a è stato modificato")
	}
	// elenco e registro
	html, _ := os.ReadFile(filepath.Join(stick, "elenco.html"))
	for _, w := range []string{"Bohemian Rhapsody", `"st":"hd"`, `"st":"rip"`, `"st":"dif"`, `"st":"alt"`, `"dups":1`, "Lucio%20Battisti%20-%20Perch%C3%A9.mp3"} {
		if !bytes.Contains(html, []byte(w)) {
			t.Errorf("elenco.html non contiene %q", w)
		}
	}
	reg, _ := os.ReadFile(filepath.Join(stick, "RiparaMP3-registro.txt"))
	t.Log(string(reg))
	for _, w := range []string{"[RECUPERATO]", "[RIPARATO]", "[DOPPIONE]", "[NON RIPARATO]"} {
		if !bytes.Contains(reg, []byte(w)) {
			t.Errorf("il registro non contiene %s", w)
		}
	}
	if *requests == 0 {
		t.Error("MusicBrainz non è stato interrogato")
	}

	if keep := os.Getenv("RMP3_KEEP"); keep != "" {
		os.RemoveAll(keep)
		exec.Command("cp", "-r", stick, keep).Run()
	}

	// una seconda esecuzione non deve cambiare nulla
	after := treeHashes(t, stick)
	reqBefore := *requests
	opts.noBackup = true
	captureStdout(t, func() {
		if err := run(opts, u); err != nil {
			t.Fatal(err)
		}
	})
	again := treeHashes(t, stick)
	for rel, h := range after {
		if rel == "elenco.html" || rel == "RiparaMP3-registro.txt" {
			continue
		}
		if again[rel] != h {
			t.Errorf("seconda esecuzione: %s è cambiato", rel)
		}
	}
	if len(again) != len(after) {
		t.Errorf("seconda esecuzione: %d file invece di %d", len(again), len(after))
	}
	if *requests != reqBefore {
		t.Errorf("seconda esecuzione: %d richieste online invece di usare la cache", *requests-reqBefore)
	}
}

func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	r, w, _ := os.Pipe()
	old := os.Stdout
	os.Stdout = w
	done := make(chan string)
	go func() {
		var b bytes.Buffer
		b.ReadFrom(r)
		done <- b.String()
	}()
	defer func() { os.Stdout = old }()
	fn()
	w.Close()
	os.Stdout = old
	return <-done
}

func (t songTags) String() string {
	return fmt.Sprintf("{%q - %q, album %q, anno %d, traccia %d/%d, copertina %d byte}", t.Artist, t.Title, t.Album, t.Year, t.Track, t.TrackTotal, len(t.Picture))
}
