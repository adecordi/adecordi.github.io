package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"golang.org/x/text/encoding/charmap"
)

// Prova completa del sito con l'agente: una chiavetta e un disco finti,
// MusicBrainz, Deezer, Apple e Cover Art Archive simulati.

func waitIdle(t *testing.T, s *server) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Minute)
	for s.busy.Load() > 0 {
		if time.Now().After(deadline) {
			t.Fatal("il sito è rimasto occupato troppo a lungo")
		}
		time.Sleep(30 * time.Millisecond)
	}
}

// stepAgent fa un battito e svolge il lavoro che arriva.
func stepAgent(t *testing.T, a *agent) {
	t.Helper()
	var r rispostaBattito
	if err := a.call("POST", "/agente/lavoro", a.heartbeat(), &r, 40*time.Second); err != nil {
		t.Fatal(err)
	}
	if r.Lavoro == nil {
		t.Fatal("il sito non ha dato nessun lavoro")
	}
	out := captureStdout(t, func() { a.run(r.Lavoro) })
	t.Log(out)
}

func listTree(t *testing.T, root string) []string {
	var out []string
	for rel := range treeHashes(t, root) {
		out = append(out, filepath.ToSlash(rel))
	}
	sort.Strings(out)
	return out
}

func TestPlaylistEndToEnd(t *testing.T) {
	ffmpegAvailable(t)
	mbMinInterval = 10 * time.Millisecond
	deezerMinInterval, itunesMinInterval = 0, 0
	tmp := t.TempDir()
	e := &e2e{t: t, tmp: tmp, raw: filepath.Join(tmp, "raw")}
	os.MkdirAll(e.raw, 0o755)
	stick := filepath.Join(tmp, "MUSICA")
	hd := filepath.Join(tmp, "hd")
	images := fakeImages{deezer: coloredJPEG(t, 1000, 200, 30, 30), itunes: coloredJPEG(t, 1000, 30, 200, 30), caa: coloredJPEG(t, 1200, 30, 30, 200)}
	fake, _ := fakeServer(t, images)

	// il disco del PC
	albachiara := e.mp3(350, 21, "128k")
	write(t, filepath.Join(hd, "Musica/Vasco Rossi - Albachiara.mp3"), withTags(albachiara, nil))
	write(t, filepath.Join(hd, "Musica/Lucio Dalla/Attenti al lupo.mp3"),
		withTags(e.mp3(1010, 20, "160k"), &songTags{Artist: "Lucio Dalla", Title: "Attenti al lupo"}))
	// la chiavetta: due cartelle e un file nella principale
	bohemian := e.mp3(300, 20, "128k")
	write(t, filepath.Join(stick, "Viaggio/01 - Queen - Bohemian Rhapsody.mp3"), withTags(bohemian, &songTags{Artist: "QUEEN", Title: "BOHEMIAN RHAPSODY"}))
	write(t, filepath.Join(stick, "Viaggio/vasco.mp3"), corrupt(withTags(albachiara, &songTags{Artist: "Vasco Rossi", Title: "Albachiara"}), 0))
	write(t, filepath.Join(stick, "Anni 80/toto.mp3"), withTags(e.mp3(850, 20, "128k"), &songTags{Artist: "Toto", Title: "Africa", Album: "Toto IV", Year: 1982}))
	write(t, filepath.Join(stick, "Anni 80/bohemian.mp3"), withTags(bohemian, &songTags{Artist: "Queen", Title: "Bohemian Rhapsody"}))
	write(t, filepath.Join(stick, "emozioni.mp3"), withTags(e.mp3(550, 20, "128k"), &songTags{Artist: "Lucio Battisti", Title: "Emozioni"}))
	write(t, filepath.Join(stick, "Anni 80/note.txt"), []byte("non toccare"))
	hdBefore := treeHashes(t, hd)

	s, ts := newTestServer(t, options{mbURL: fake.URL, deezerURL: fake.URL, itunesURL: fake.URL + "/", caaURL: fake.URL, site: "http://musica.test"})
	c := webReq{t, ts}
	// qui si prova l'autoradio normale (cartelle e .m3u); la Tesla ha la sua prova
	if code := c.do("PATCH", "/api/impostazioni", map[string]string{"formato": formatoClassico}, nil); code != 200 {
		t.Fatalf("formato: %d", code)
	}
	s.mu.Lock()
	token := s.newAgentLocked("PC-PROVA", version, "decordi")
	s.mu.Unlock()
	backupDir := filepath.Join(tmp, "copie")
	a := newAgent(options{site: ts.URL, stick: stick, search: listFlag{hd}, cacheDir: filepath.Join(tmp, "agente"), noInstall: true, backupDir: backupDir})
	a.cfg = agentConfig{Sito: ts.URL, Token: token}

	// 1. lettura della chiavetta
	var job vistaLavoro
	if code := c.do("POST", "/api/lavori", map[string]string{"tipo": "scansiona"}, &job); code != 200 {
		t.Fatalf("lavoro: %d", code)
	}
	stepAgent(t, a)
	waitIdle(t, s)
	var st struct {
		Chiavetta struct {
			File        int `json:"file"`
			DaImportare int `json:"da_importare"`
		} `json:"chiavetta"`
	}
	c.do("GET", "/api/stato", nil, &st)
	if st.Chiavetta.File != 5 || st.Chiavetta.DaImportare != 5 {
		t.Fatalf("stato dopo la lettura: %+v", st)
	}

	// 2. importazione: una playlist per cartella
	var prev struct {
		Gruppi []gruppoImport `json:"gruppi"`
	}
	c.do("GET", "/api/importa", nil, &prev)
	var scelte []sceltaImport
	var keys []string
	for _, g := range prev.Gruppi {
		keys = append(keys, g.Chiave+"="+g.Nome)
		scelte = append(scelte, sceltaImport{Chiave: g.Chiave, Nome: g.Nome, Includi: true})
	}
	if strings.Join(keys, "|") != "=MUSICA|Anni 80=Anni 80|Viaggio=Viaggio" {
		t.Fatalf("gruppi: %v", keys)
	}
	var imp map[string]int
	c.do("POST", "/api/importa", map[string]any{"gruppi": scelte}, &imp)
	if imp["playlist"] != 3 || imp["brani"] != 4 {
		t.Fatalf("importati: %v", imp)
	}
	waitIdle(t, s)

	// 3. indice del disco
	c.do("POST", "/api/lavori", map[string]string{"tipo": "indicizza"}, &job)
	stepAgent(t, a)
	waitIdle(t, s)

	// 4. una playlist .m3u con un brano già sulla chiavetta e uno dal disco;
	// Emozioni esce dalla playlist della cartella principale
	var res struct {
		Dischi []voceDisco `json:"dischi"`
	}
	c.do("GET", "/api/cerca?deezer=0&q=attenti+lupo", nil, &res)
	if len(res.Dischi) != 1 || res.Dischi[0].Titolo != "Attenti al lupo" || !res.Dischi[0].Collegato {
		t.Fatalf("ricerca sui dischi: %+v", res.Dischi)
	}
	var lists []struct {
		ID, Nome string
	}
	c.do("GET", "/api/playlist", nil, &lists)
	ids := map[string]string{}
	for _, l := range lists {
		ids[l.Nome] = l.ID
	}
	var detail struct {
		Brani []vistaBrano `json:"brani"`
	}
	c.do("GET", "/api/playlist/"+ids["Viaggio"], nil, &detail)
	bohemianID := ""
	for _, b := range detail.Brani {
		if b.Titolo == "Bohemian Rhapsody" {
			bohemianID = b.ID
		}
	}
	var nuova map[string]string
	c.do("POST", "/api/playlist", map[string]string{"nome": "Preferite", "tipo": "m3u"}, &nuova)
	c.do("POST", "/api/playlist/"+nuova["id"]+"/brani", map[string]string{"brano": bohemianID}, nil)
	c.do("POST", "/api/playlist/"+nuova["id"]+"/brani", map[string]any{"disco": map[string]string{"volume": res.Dischi[0].Volume, "p": res.Dischi[0].P}}, nil)
	c.do("GET", "/api/playlist/"+ids["MUSICA"], nil, &detail)
	c.do("POST", "/api/playlist/"+ids["MUSICA"]+"/togli", map[string]any{"brani": []string{detail.Brani[0].ID}}, nil)
	waitIdle(t, s)

	// 5. piano e copia
	var plan struct {
		Piano piano `json:"piano"`
	}
	c.do("GET", "/api/piano", nil, &plan)
	p := plan.Piano
	t.Logf("piano: ops %v conteggi %v avvisi %v bloccanti %v tolti %v", p.Ops, p.Conteggi, p.Avvisi, p.Bloccanti, p.Tolti)
	// copiati dal disco: Albachiara (sulla chiavetta era rovinato) e Attenti al
	// lupo; riscritti i due Bohemian Rhapsody (tag e copertina nuovi); Africa
	// ha già i tag giusti e cambia solo nome; Emozioni e il file rovinato vanno
	// in _Tolti
	if p.Ops[opCopia] != 2 || p.Ops[opRiscrivi] != 2 || p.Ops[opRinomina] != 1 || p.Ops[opTogli] != 2 || p.Ops[opM3U] != 1 || len(p.Bloccanti) != 0 {
		t.Fatalf("piano inatteso")
	}
	if code := c.do("POST", "/api/piano/"+p.ID+"/conferma", map[string]bool{"backup": true}, &job); code != 200 {
		t.Fatalf("conferma: %d", code)
	}
	if code := c.do("POST", "/api/piano/"+p.ID+"/conferma", map[string]bool{"backup": true}, nil); code != 409 {
		t.Errorf("seconda conferma: %d", code)
	}
	stepAgent(t, a)
	waitIdle(t, s)

	// 6. la chiavetta
	day := time.Now().In(romeTZ()).Format("2006-01-02")
	want := []string{
		"Altri brani/Lucio Dalla - Attenti al lupo - 1990.mp3",
		"Anni 80/Queen - Bohemian Rhapsody - 1975.mp3",
		"Anni 80/Toto - Africa - 1982.mp3",
		"Anni 80/note.txt",
		"Preferite.m3u",
		"RiparaMP3-playlist.json",
		"RiparaMP3-registro.txt",
		"Viaggio/Queen - Bohemian Rhapsody - 1975.mp3",
		"Viaggio/Vasco Rossi - Albachiara - 1979.mp3",
		"_Tolti/" + day + "/Viaggio/vasco.mp3",
		"_Tolti/" + day + "/emozioni.mp3",
	}
	if got := listTree(t, stick); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("chiavetta:\n%s\nattesa:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	norm := func(raw []byte) []byte { n, _ := normalizeCover(raw); return n }
	for _, name := range []string{"Viaggio/Queen - Bohemian Rhapsody - 1975.mp3", "Anni 80/Queen - Bohemian Rhapsody - 1975.mp3"} {
		tg, in, b := readSongTags(t, filepath.Join(stick, name))
		if tg.Artist != "Queen" || tg.Title != "Bohemian Rhapsody" || tg.Album != "A Night at the Opera" || tg.Year != 1975 ||
			tg.Track != 11 || tg.TrackTotal != 12 || !bytes.Equal(tg.Picture, norm(images.deezer)) {
			t.Errorf("%s: %v", name, tg)
		}
		if !bytes.Equal(audioPayload(b, in), bohemian) {
			t.Errorf("%s: audio cambiato", name)
		}
	}
	tg, in, b := readSongTags(t, filepath.Join(stick, "Viaggio/Vasco Rossi - Albachiara - 1979.mp3"))
	if in.Defective || !bytes.Equal(audioPayload(b, in), albachiara) || tg.Album != "Non siamo mica gli americani!" {
		t.Errorf("Albachiara dal disco: %v %v", tg, in.Problems)
	}
	tg, _, _ = readSongTags(t, filepath.Join(stick, "Altri brani/Lucio Dalla - Attenti al lupo - 1990.mp3"))
	if tg.Album != "Cambio" || tg.Year != 1990 || len(tg.Picture) == 0 {
		t.Errorf("Attenti al lupo: %v", tg)
	}
	raw, _ := os.ReadFile(filepath.Join(stick, "Preferite.m3u"))
	text, _ := charmap.Windows1252.NewDecoder().Bytes(raw)
	lines := strings.Split(strings.TrimSuffix(string(text), "\r\n"), "\r\n")
	if len(lines) != 5 || lines[0] != "#EXTM3U" {
		t.Fatalf("m3u: %q", text)
	}
	for _, l := range []string{lines[2], lines[4]} {
		if !exists(filepath.Join(stick, filepath.FromSlash(strings.ReplaceAll(l, `\`, "/")))) {
			t.Errorf("la m3u punta a un file che non c'è: %s", l)
		}
	}
	var marker marcatore
	if mb, _ := os.ReadFile(filepath.Join(stick, markerFile)); json.Unmarshal(mb, &marker) != nil || len(marker.Playlist) != 4 {
		t.Errorf("marcatore: %+v", marker)
	}
	if fmt.Sprint(treeHashes(t, hd)) != fmt.Sprint(hdBefore) {
		t.Error("il disco è stato modificato")
	}
	backups, _ := filepath.Glob(filepath.Join(backupDir, "RiparaMP3 backup *"))
	if len(backups) != 1 {
		t.Fatalf("copie di sicurezza: %v", backups)
	}
	if saved := listTree(t, backups[0]); strings.Join(saved, "|") != "Anni 80/bohemian.mp3|Viaggio/01 - Queen - Bohemian Rhapsody.mp3" {
		t.Errorf("copia di sicurezza dei file riscritti: %v", saved)
	}

	// 7. il lavoro è andato bene e un secondo piano non ha più niente da fare
	var jobs []vistaLavoro
	c.do("GET", "/api/lavori", nil, &jobs)
	if jobs[0].Tipo != lvCopia || jobs[0].Stato != "fatto" || jobs[0].Errori != 0 {
		t.Errorf("lavoro di copia: %+v", jobs[0])
	}
	var again struct {
		Piano piano `json:"piano"`
	}
	c.do("GET", "/api/piano", nil, &again)
	if len(again.Piano.Ops) != 0 || len(again.Piano.Conteggi) != 1 || again.Piano.Conteggi[stOk] != 5 {
		t.Errorf("dopo la copia il piano ha ancora: %v %v", again.Piano.Ops, again.Piano.Conteggi)
	}
	c.do("GET", "/api/stato", nil, &st)
	if st.Chiavetta.DaImportare != 0 {
		t.Errorf("dopo la copia risultano brani da importare: %d", st.Chiavetta.DaImportare)
	}
}

// Un lavoro fermato dal sito lascia la chiavetta senza file a metà.
func TestCopyCancelled(t *testing.T) {
	ffmpegAvailable(t)
	tmp := t.TempDir()
	e := &e2e{t: t, tmp: tmp, raw: filepath.Join(tmp, "raw")}
	os.MkdirAll(e.raw, 0o755)
	stick := filepath.Join(tmp, "CHIAVE")
	for i := 0; i < 4; i++ {
		write(t, filepath.Join(stick, fmt.Sprintf("Lista/brano%d.mp3", i)),
			withTags(e.mp3(400+50*i, 10, "128k"), &songTags{Artist: "Gruppo", Title: fmt.Sprintf("Canzone %d", i), Year: 2000}))
	}
	s, ts := newTestServer(t, options{})
	c := webReq{t, ts}
	s.mu.Lock()
	token := s.newAgentLocked("PC", version, "decordi")
	s.mu.Unlock()
	a := newAgent(options{site: ts.URL, stick: stick, search: listFlag{filepath.Join(tmp, "vuoto")}, cacheDir: filepath.Join(tmp, "agente"), noInstall: true})
	os.MkdirAll(filepath.Join(tmp, "vuoto"), 0o755)
	a.cfg = agentConfig{Sito: ts.URL, Token: token}
	c.do("POST", "/api/lavori", map[string]string{"tipo": "scansiona"}, nil)
	stepAgent(t, a)
	waitIdle(t, s)
	var prev struct {
		Gruppi []gruppoImport `json:"gruppi"`
	}
	c.do("GET", "/api/importa", nil, &prev)
	c.do("POST", "/api/importa", map[string]any{"gruppi": []sceltaImport{{Chiave: "Lista", Nome: "Lista", Includi: true}}}, nil)
	waitIdle(t, s)
	var plan struct {
		Piano piano `json:"piano"`
	}
	c.do("GET", "/api/piano", nil, &plan)
	if plan.Piano.Ops[opRinomina] != 4 {
		t.Fatalf("piano: %v", plan.Piano.Ops)
	}
	var job vistaLavoro
	c.do("POST", "/api/piano/"+plan.Piano.ID+"/conferma", map[string]bool{"backup": false}, &job)
	c.do("POST", "/api/lavori/"+job.ID+"/annulla", map[string]any{}, nil) // ancora in coda: annullato subito
	var jobs []vistaLavoro
	c.do("GET", "/api/lavori", nil, &jobs)
	if jobs[0].Stato != "annullato" {
		t.Fatalf("annullamento in coda: %+v", jobs[0])
	}
	// di nuovo, fermato mentre lavora
	c.do("POST", "/api/piano/"+plan.Piano.ID+"/conferma", map[string]bool{"backup": false}, &job)
	var r rispostaBattito
	a.call("POST", "/agente/lavoro", a.heartbeat(), &r, 30*time.Second)
	c.do("POST", "/api/lavori/"+job.ID+"/annulla", map[string]any{}, nil)
	captureStdout(t, func() { a.run(r.Lavoro) })
	c.do("GET", "/api/lavori", nil, &jobs)
	if jobs[0].Stato != "annullato" {
		t.Errorf("lavoro fermato: %+v", jobs[0])
	}
	for _, f := range listTree(t, stick) {
		if strings.Contains(f, ".riparamp3-") {
			t.Errorf("file temporaneo rimasto: %s", f)
		}
	}
	n := 0
	for _, f := range listTree(t, stick) {
		if strings.HasSuffix(f, ".mp3") {
			n++
		}
	}
	if n != 4 {
		t.Errorf("dopo l'interruzione ci sono %d brani invece di 4", n)
	}
}

// Chiavetta per la Tesla, e passaggio a una chiavetta nuova: i brani che sui
// dischi non ci sono vengono copiati da quella vecchia.
func TestTeslaNewStick(t *testing.T) {
	ffmpegAvailable(t)
	mbMinInterval = 10 * time.Millisecond
	deezerMinInterval, itunesMinInterval = 0, 0
	tmp := t.TempDir()
	e := &e2e{t: t, tmp: tmp, raw: filepath.Join(tmp, "raw")}
	os.MkdirAll(e.raw, 0o755)
	old := filepath.Join(tmp, "VECCHIA")
	nuova := filepath.Join(tmp, "NUOVA")
	hd := filepath.Join(tmp, "hd")
	os.MkdirAll(nuova, 0o755)
	fake, _ := fakeServer(t, fakeImages{deezer: coloredJPEG(t, 1000, 200, 30, 30), itunes: coloredJPEG(t, 1000, 30, 200, 30), caa: coloredJPEG(t, 1200, 30, 30, 200)})

	bohemian := e.mp3(300, 20, "128k")
	africa := e.mp3(850, 20, "128k")
	albachiara := e.mp3(350, 21, "128k")
	write(t, filepath.Join(old, "Viaggio/bohemian.mp3"), withTags(bohemian, &songTags{Artist: "Queen", Title: "Bohemian Rhapsody"}))
	write(t, filepath.Join(old, "Viaggio/africa.mp3"), withTags(africa, &songTags{Artist: "Toto", Title: "Africa", Album: "Toto IV", Year: 1982}))
	write(t, filepath.Join(hd, "Musica/Vasco Rossi - Albachiara.mp3"), withTags(albachiara, nil))
	oldBefore := treeHashes(t, old)

	drives := listDrivesFn
	listDrivesFn = func() []driveInfo {
		return []driveInfo{{root: old, label: "VECCHIA", removable: true, serial: "AAAA-0001", free: 1 << 30},
			{root: nuova, label: "NUOVA", removable: true, serial: "BBBB-0002", free: 1 << 30}}
	}
	defer func() { listDrivesFn = drives }()

	s, ts := newTestServer(t, options{mbURL: fake.URL, deezerURL: fake.URL, itunesURL: fake.URL + "/", caaURL: fake.URL})
	c := webReq{t, ts}
	s.mu.Lock()
	token := s.newAgentLocked("PC", version, "decordi")
	s.mu.Unlock()
	a := newAgent(options{site: ts.URL, search: listFlag{hd}, cacheDir: filepath.Join(tmp, "agente"), noInstall: true, backupDir: filepath.Join(tmp, "copie")})
	a.cfg = agentConfig{Sito: ts.URL, Token: token}

	// la vecchia: lettura e importazione; poi l'HD
	c.do("POST", "/api/lavori", map[string]string{"tipo": "scansiona", "volume": "AAAA-0001"}, nil)
	stepAgent(t, a)
	waitIdle(t, s)
	c.do("POST", "/api/importa", map[string]any{"gruppi": []sceltaImport{{Chiave: "Viaggio", Nome: "Viaggio", Includi: true}}}, nil)
	c.do("POST", "/api/lavori", map[string]string{"tipo": "indicizza"}, nil)
	stepAgent(t, a)
	waitIdle(t, s)
	var lists []struct{ ID, Nome string }
	c.do("GET", "/api/playlist", nil, &lists)
	var res struct {
		Dischi []voceDisco `json:"dischi"`
	}
	c.do("GET", "/api/cerca?deezer=0&q=albachiara", nil, &res)
	c.do("POST", "/api/playlist/"+lists[0].ID+"/brani", map[string]any{"disco": map[string]string{"volume": res.Dischi[0].Volume, "p": res.Dischi[0].P}}, nil)
	waitIdle(t, s)

	// la nuova diventa quella delle playlist e viene letta (è vuota)
	if code := c.do("POST", "/api/chiavetta/usa", map[string]string{"volume": "BBBB-0002"}, nil); code != 200 {
		t.Fatalf("usa: %d", code)
	}
	c.do("POST", "/api/lavori", map[string]string{"tipo": "scansiona"}, nil)
	stepAgent(t, a)
	waitIdle(t, s)

	var plan struct {
		Piano piano `json:"piano"`
	}
	c.do("GET", "/api/piano", nil, &plan)
	t.Logf("piano: %v %v %v", plan.Piano.Ops, plan.Piano.Conteggi, plan.Piano.Avvisi)
	if plan.Piano.Ops[opCopia] != 3 || plan.Piano.Ops[opM3U] != 0 || plan.Piano.Volume != "BBBB-0002" {
		t.Fatalf("piano inatteso")
	}
	c.do("POST", "/api/piano/"+plan.Piano.ID+"/conferma", map[string]bool{"backup": true}, nil)
	stepAgent(t, a)
	waitIdle(t, s)

	// l'ordine è quello dei file sulla chiavetta vecchia (africa, bohemian),
	// poi il brano aggiunto dal disco
	want := []string{
		"Music/Viaggio/01 - Toto - Africa - 1982.mp3",
		"Music/Viaggio/02 - Queen - Bohemian Rhapsody - 1975.mp3",
		"Music/Viaggio/03 - Vasco Rossi - Albachiara - 1979.mp3",
		"RiparaMP3-playlist.json",
		"RiparaMP3-registro.txt",
	}
	if got := listTree(t, nuova); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("chiavetta nuova:\n%s\nattesa:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	for name, audio := range map[string][]byte{"02 - Queen - Bohemian Rhapsody - 1975.mp3": bohemian, "01 - Toto - Africa - 1982.mp3": africa,
		"03 - Vasco Rossi - Albachiara - 1979.mp3": albachiara} {
		_, in, b := readSongTags(t, filepath.Join(nuova, "Music", "Viaggio", name))
		if !bytes.Equal(audioPayload(b, in), audio) {
			t.Errorf("%s: audio diverso", name)
		}
	}
	if fmt.Sprint(treeHashes(t, old)) != fmt.Sprint(oldBefore) {
		t.Error("la chiavetta vecchia è stata modificata")
	}
	var again struct {
		Piano piano `json:"piano"`
	}
	c.do("GET", "/api/piano", nil, &again)
	if len(again.Piano.Ops) != 0 || again.Piano.Conteggi[stOk] != 3 {
		t.Errorf("dopo la copia: %v %v", again.Piano.Ops, again.Piano.Conteggi)
	}
	// l'ordine della playlist è nei numeri: spostare un brano rinomina i file
	var detail struct {
		Brani []vistaBrano `json:"brani"`
	}
	c.do("GET", "/api/playlist/"+lists[0].ID, nil, &detail)
	ids := []string{detail.Brani[2].ID, detail.Brani[0].ID, detail.Brani[1].ID}
	c.do("POST", "/api/playlist/"+lists[0].ID+"/ordine", map[string]any{"brani": ids}, nil)
	var moved struct {
		Piano piano `json:"piano"`
	}
	c.do("GET", "/api/piano", nil, &moved)
	if moved.Piano.Ops[opRinomina] != 3 || len(moved.Piano.Ops) != 1 {
		t.Errorf("dopo il cambio d'ordine: %v", moved.Piano.Ops)
	}
}
