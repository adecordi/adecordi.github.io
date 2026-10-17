package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func fpcalcForTest(t *testing.T) string {
	t.Helper()
	if p := os.Getenv("RMP3_FPCALC"); p != "" {
		return p
	}
	p, err := exec.LookPath("fpcalc")
	if err != nil {
		t.Skip("fpcalc non disponibile")
	}
	return p
}

func TestAcoustIDMatch(t *testing.T) {
	acoustidMinInterval = 0
	var gotForm map[string]string
	reply := ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		gotForm = map[string]string{}
		for k := range r.PostForm {
			gotForm[k] = r.PostForm.Get(k)
		}
		if strings.Contains(reply, `"error"`) {
			w.WriteHeader(400)
		}
		w.Write([]byte(reply))
	}))
	defer srv.Close()
	c := newAcoustIDClient(srv.URL, "CHIAVE", t.TempDir())

	reply = `{"status":"ok","results":[
		{"score":0.5,"recordings":[{"id":"basso","title":"Altro","duration":200,"artists":[{"name":"X"}]}]},
		{"score":0.95,"recordings":[
			{"id":"lungo","title":"Easy","duration":400,"artists":[{"name":"Commodores"}]},
			{"id":"live","title":"Easy (live)","duration":242,"artists":[{"name":"Commodores"}]},
			{"id":"giusto","title":"Easy","duration":241,"artists":[{"name":"Commodores"}]}]}]}`
	rec, score, err := c.match("FP", 240.6, "lady", "Easy")
	if err != nil || rec == nil || rec.ID != "giusto" || score != 0.95 {
		t.Fatalf("rec %+v score %v err %v", rec, score, err)
	}
	if gotForm["client"] != "CHIAVE" || gotForm["duration"] != "241" || gotForm["fingerprint"] != "FP" || gotForm["meta"] != "recordings releasegroups compress" {
		t.Errorf("richiesta: %v", gotForm)
	}

	reply = `{"status":"ok","results":[{"score":0.6,"recordings":[{"id":"x","title":"Easy","artists":[{"name":"Commodores"}]}]}]}`
	if rec, _, err := c.match("FP", 240, "", ""); rec != nil || err != nil {
		t.Errorf("punteggio basso accettato: %+v %v", rec, err)
	}

	reply = `{"status":"error","error":{"code":4,"message":"invalid API key"}}`
	if _, _, err := c.match("FP", 240, "", ""); err != errBadKey || !c.badKey {
		t.Errorf("chiave non valida non riconosciuta: %v", err)
	}
}

func TestAcRecordingAlbum(t *testing.T) {
	var r acRecording
	json.Unmarshal([]byte(`{"releasegroups":[
		{"title":"Hits 1977","type":"Album","secondarytypes":["Compilation"]},
		{"title":"Easy","type":"Single"},
		{"title":"Commodores","type":"Album"}]}`), &r)
	if r.album() != "Commodores" {
		t.Errorf("album %q", r.album())
	}
}

func TestFingerprintFromStdin(t *testing.T) {
	bin := fpcalcForTest(t)
	b := load(t, "cbr128")
	fp, err := fingerprintAudio(bin, b)
	if err != nil || len(fp) < 100 {
		t.Fatalf("impronta %q err %v", fp, err)
	}
	if _, err := fingerprintAudio(bin, []byte("non è audio")); err == nil {
		t.Error("un file non audio deve dare errore")
	}
}

// Prova completa del riconoscimento dall'audio con AcoustID e MusicBrainz
// simulati; le impronte sono vere, calcolate con fpcalc.
func TestIdentifyEndToEnd(t *testing.T) {
	bin := fpcalcForTest(t)
	ffmpegAvailable(t)
	mbMinInterval, acoustidMinInterval = 0, 0
	deezerMinInterval, itunesMinInterval = 0, 0
	tmp := t.TempDir()
	e := &e2e{t: t, tmp: tmp, raw: filepath.Join(tmp, "raw")}
	os.MkdirAll(e.raw, 0o755)
	stick := filepath.Join(tmp, "chiavetta")

	easy := e.mp3(1100, 30, "128k")
	other := e.mp3(1200, 30, "128k")
	weak := e.mp3(1300, 30, "128k")
	write(t, filepath.Join(stick, "lady - Easy.mp3"), withTags(easy, &songTags{Artist: "lady", Title: "Easy"}))
	write(t, filepath.Join(stick, "Rossi - Canzone.mp3"), withTags(other, &songTags{Artist: "Rossi", Title: "Canzone", Album: "Disco", Year: 2000}))
	write(t, filepath.Join(stick, "Bianchi - Canzone.mp3"), withTags(weak, &songTags{Artist: "Bianchi", Title: "Canzone", Album: "Disco", Year: 2000}))

	fpOf := func(audio []byte) string {
		fp, err := fingerprintAudio(bin, audio)
		if err != nil {
			t.Fatal(err)
		}
		return fp
	}
	known := map[string]string{fpOf(easy): `{"score":0.97,"recordings":[{"id":"rec-easy","title":"Easy","duration":30,"artists":[{"name":"Commodores"}]}]}`,
		fpOf(weak): `{"score":0.4,"recordings":[{"id":"rec-weak","title":"Sbagliato","duration":30,"artists":[{"name":"Nessuno"}]}]}`}
	var log []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log = append(log, r.URL.Path)
		switch {
		case r.URL.Path == "/v2/lookup":
			r.ParseForm()
			if r.PostForm.Get("client") != "CHIAVE" {
				w.WriteHeader(400)
				w.Write([]byte(`{"status":"error","error":{"code":4,"message":"invalid API key"}}`))
				return
			}
			res := "[]"
			if v, ok := known[r.PostForm.Get("fingerprint")]; ok {
				res = "[" + v + "]"
			}
			w.Write([]byte(`{"status":"ok","results":` + res + `}`))
		case r.URL.Path == "/ws/2/recording/rec-easy":
			w.Write([]byte(`{"title":"Easy","artist-credit":[{"name":"Commodores"}],"releases":[
				{"id":"c1","title":"Love Songs","status":"Official","date":"1985","artist-credit":[{"name":"Various Artists"}],
				 "release-group":{"id":"rg-c","primary-type":"Album","secondary-types":["Compilation"]}},
				{"id":"r1","title":"Commodores","status":"Official","date":"1977-03-01","release-group":{"id":"rg-1","primary-type":"Album"},
				 "media":[{"position":1,"track-count":9,"track-offset":3,"tracks":[{"number":"4","position":4}]}]}]}`))
		case r.URL.Path == "/ws/2/recording":
			w.Write([]byte(`{"recordings":[]}`))
		case r.URL.Path == "/search/album" || r.URL.Path == "/search/track":
			w.Write([]byte(`{"data":[]}`))
		case r.URL.Path == "/search":
			w.Write([]byte(`{"results":[]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	opts := options{stick: stick, yes: true, noBackup: true, noOpen: true, cacheDir: filepath.Join(tmp, "cache"),
		mbURL: srv.URL, caaURL: srv.URL, deezerURL: srv.URL, itunesURL: srv.URL, acoustidURL: srv.URL,
		acoustidKey: "CHIAVE", fpcalc: bin}
	u := &ui{r: bufio.NewReader(strings.NewReader("")), yes: true}
	out := captureStdout(t, func() {
		if err := run(opts, u); err != nil {
			t.Fatal(err)
		}
	})
	if !strings.Contains(out, "Brani riconosciuti dall'audio: 1 su 3") {
		t.Errorf("riepilogo:\n%s", out)
	}
	if got := listDir(t, stick); strings.Join(got, "|") != "Bianchi - Canzone.mp3|Commodores - Easy.mp3|RiparaMP3-registro.txt|Rossi - Canzone.mp3|elenco.html" {
		t.Errorf("file: %v", got)
	}
	tg, _, _ := readSongTags(t, filepath.Join(stick, "Commodores - Easy.mp3"))
	if tg.Artist != "Commodores" || tg.Title != "Easy" || tg.Album != "Commodores" || tg.Year != 1977 || tg.Track != 4 || tg.TrackTotal != 9 {
		t.Errorf("tag riconosciuti: %v", tg)
	}
	if tg, _, _ := readSongTags(t, filepath.Join(stick, "Bianchi - Canzone.mp3")); tg.Artist != "Bianchi" || tg.Album != "Disco" {
		t.Errorf("riconoscimento incerto applicato lo stesso: %v", tg)
	}
	reg, _ := os.ReadFile(filepath.Join(stick, "RiparaMP3-registro.txt"))
	if !bytes.Contains(reg, []byte(`[RICONOSCIUTO] Lady - Easy -> Commodores - Easy (album "Commodores")`)) {
		t.Errorf("registro:\n%s", reg)
	}
	html, _ := os.ReadFile(filepath.Join(stick, "elenco.html"))
	if !bytes.Contains(html, []byte("Riconosciuto dall'audio")) {
		t.Error("nota mancante nell'elenco")
	}

	// seconda esecuzione: nessuna richiesta e nessun file cambiato
	before := treeHashes(t, stick)
	n := len(log)
	captureStdout(t, func() { run(opts, u) })
	if len(log) != n {
		t.Errorf("seconda esecuzione: richieste %v", log[n:])
	}
	after := treeHashes(t, stick)
	for k, h := range before {
		if k != "elenco.html" && k != "RiparaMP3-registro.txt" && after[k] != h {
			t.Errorf("seconda esecuzione: %s cambiato", k)
		}
	}

	// chiave sbagliata: nessun cambiamento, chiave dimenticata
	opts.acoustidKey = "SBAGLIATA"
	opts.cacheDir = filepath.Join(tmp, "cache2")
	out = captureStdout(t, func() { run(opts, u) })
	if !strings.Contains(out, "La chiave AcoustID non è valida") {
		t.Errorf("chiave sbagliata non segnalata:\n%s", out)
	}
	if exists(filepath.Join(opts.cacheDir, "acoustid-key.txt")) {
		t.Error("la chiave sbagliata doveva essere dimenticata")
	}
	_ = time.Now
}
