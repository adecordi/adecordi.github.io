package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/text/encoding/charmap"
)

// stripJS toglie commenti, stringhe ed espressioni regolari da un sorgente
// JavaScript, per controllare solo il codice.
func stripJS(src string) string {
	var out strings.Builder
	prev := byte('(') // ultimo carattere significativo, per riconoscere le regex
	for i := 0; i < len(src); i++ {
		c := src[i]
		switch {
		case c == '/' && i+1 < len(src) && src[i+1] == '/':
			for i < len(src) && src[i] != '\n' {
				i++
			}
			out.WriteByte('\n')
		case c == '/' && i+1 < len(src) && src[i+1] == '*':
			i += 2
			for i+1 < len(src) && !(src[i] == '*' && src[i+1] == '/') {
				i++
			}
			i++
		case c == '"' || c == '\'' || c == '`':
			q := c
			out.WriteByte(c)
			for i++; i < len(src) && src[i] != q; i++ {
				if src[i] == '\\' {
					i++
				}
			}
			out.WriteByte(q)
			prev = 'a'
		case c == '/' && strings.IndexByte("(,=:[!&|?{};+", prev) >= 0:
			out.WriteString("/r/")
			for i++; i < len(src) && src[i] != '/'; i++ {
				if src[i] == '\\' {
					i++
				} else if src[i] == '[' {
					for i < len(src) && src[i] != ']' {
						i++
					}
				}
			}
			for i+1 < len(src) && strings.IndexByte("gimsuy", src[i+1]) >= 0 {
				i++
			}
			prev = 'a'
		default:
			out.WriteByte(c)
			if c != ' ' && c != '\n' && c != '\t' && c != '\r' {
				prev = c
			}
		}
	}
	return out.String()
}

// La pagina deve funzionare sul vecchio iPad: solo JavaScript ES5.
func TestWebAppIsES5(t *testing.T) {
	b, err := fs.ReadFile(webFS, "web/app.js")
	if err != nil {
		t.Fatal(err)
	}
	code := stripJS(string(b))
	for _, re := range []string{`=>`, `\blet\s`, `\bconst\s`, "`", `\bclass\s+\w`, `\basync\b`, `\bawait\b`, `\?\.`, `\?\?`, `\.\.\.`,
		`\bfetch\(`, `\.includes\(`, `\.startsWith\(`, `\.endsWith\(`, `Object\.assign`, `\.closest\(`, `\bfor\s*\([^;)]*\bof\b`} {
		if loc := regexp.MustCompile(re).FindStringIndex(code); loc != nil {
			start := max(0, loc[0]-40)
			t.Errorf("app.js usa %q: ...%s...", re, code[start:min(len(code), loc[1]+40)])
		}
	}
	if !strings.Contains(string(b), "'use strict'") {
		t.Error("manca 'use strict'")
	}
}

func TestStripJS(t *testing.T) {
	got := stripJS("var a = \"x => y\"; // let b\n" + `var r = /a\/b[/]/g; /* const */ var c = a / 2;`)
	if strings.Contains(got, "=>") || strings.Contains(got, "let") || strings.Contains(got, "const") || !strings.Contains(got, "a / 2") {
		t.Errorf("stripJS: %q", got)
	}
}

func TestM3UFile(t *testing.T) {
	name, b := m3uFile("Più belle", []m3uEntry{{Path: "Viaggio/Lucio Dalla - Perché - 1990.mp3", Seconds: 201, Title: "Lucio Dalla - Perché"}})
	if name != "Più belle.m3u" {
		t.Errorf("nome %q", name)
	}
	text, _ := charmap.Windows1252.NewDecoder().Bytes(b)
	want := "#EXTM3U\r\n#EXTINF:201,Lucio Dalla - Perché\r\nViaggio\\Lucio Dalla - Perché - 1990.mp3\r\n"
	if string(text) != want {
		t.Errorf("contenuto %q", text)
	}
	if bytes.Contains(b, []byte("é")) {
		t.Error("il testo deve essere in Windows-1252, non UTF-8")
	}
	name, b = m3uFile("Giapponese", []m3uEntry{{Path: "Altri brani/坂本九 - 上を向いて歩こう.mp3", Title: "坂本九"}})
	if name != "Giapponese.m3u8" || !bytes.Contains(b, []byte("上を向いて歩こう")) {
		t.Errorf("m3u8: %s %q", name, b)
	}
}

func TestTagsMatch(t *testing.T) {
	d := songTags{Title: "Albachiara", Artist: "Vasco Rossi", Album: "Non siamo mica gli americani!", Year: 1979, Track: 9, TrackTotal: 9}
	f := &fileChiavetta{Raw: d, Cop: "abc"}
	f.Raw.Format = "ID3v2.3"
	if !tagsMatch(f, d, "abc") {
		t.Error("tag uguali non riconosciuti")
	}
	if tagsMatch(f, d, "def") {
		t.Error("copertina diversa non vista")
	}
	f.Raw.Format = "ID3v1"
	if tagsMatch(f, d, "abc") {
		t.Error("un tag ID3v1 va riscritto")
	}
	f.Raw.Format = "ID3v2.4"
	f.Raw.AlbumArtist = "Artisti vari"
	if tagsMatch(f, d, "abc") {
		t.Error("l'artista dell'album va tolto")
	}
}

func TestCandidatiRanking(t *testing.T) {
	vols := map[string]*indiceVolume{"V1": {Unita: unita{Volume: "V1", Etichetta: "Musica"}, File: []fileDisco{
		{P: "Live/Vasco Rossi - Albachiara (Live).mp3", A: "Vasco Rossi", T: "Albachiara (Live)", D: 300, B: 320},
		{P: "Vasco/Albachiara.mp3", A: "Vasco Rossi", T: "Albachiara", Al: "Non siamo mica gli americani!", D: 243, B: 192},
		{P: "Download/vasco rossi - albachiara.mp3", D: 244, B: 128},
		{P: "Altro/Albachiara.mp3", A: "Altro Artista", T: "Albachiara", D: 243, B: 320},
		{P: "Vasco/Lunga.mp3", A: "Vasco Rossi", T: "Albachiara", D: 600, B: 320},
	}}}
	ix := buildSearchIndex(vols)
	c := ix.candidati("Vasco Rossi", "Albachiara", "Non siamo mica gli americani!", 243)
	if len(c) < 2 || c[0].F.P != "Vasco/Albachiara.mp3" || c[1].F.P != "Download/vasco rossi - albachiara.mp3" {
		for _, x := range c {
			t.Logf("%d %s", x.Punti, x.F.P)
		}
		t.Fatal("ordine sbagliato")
	}
	for _, x := range c {
		if strings.Contains(x.F.P, "Live") || strings.Contains(x.F.P, "Altro") || strings.Contains(x.F.P, "Lunga") {
			t.Errorf("candidato da scartare: %s (%d)", x.F.P, x.Punti)
		}
	}
	if got := ix.cerca("vasco alba", 10); len(got) != 4 {
		t.Errorf("ricerca per parole: %d risultati", len(got))
	}
}

// L'anno è quello della prima uscita, anche se viene da una registrazione
// diversa da quella del disco scelto.
func TestMBFirstReleaseYear(t *testing.T) {
	mbMinInterval = 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("limit") != "100" {
			t.Errorf("limite %q", r.URL.Query().Get("limit"))
		}
		w.Write([]byte(`{"recordings":[
			{"id":"a","score":100,"title":"Vita spericolata","length":282000,"first-release-date":"1990",
			 "artist-credit":[{"name":"Vasco Rossi"}],"releases":[{"id":"r1","title":"Tutto Sanremo","status":"Official","date":"1990",
			  "release-group":{"id":"g1","primary-type":"Album","secondary-types":["Compilation"]}}]},
			{"id":"b","score":100,"title":"Vita spericolata","length":285000,"first-release-date":"1983-04-14",
			 "artist-credit":[{"name":"Vasco Rossi"}],"releases":[{"id":"r2","title":"Bollicine","status":"Official","date":"1983-11-11",
			  "release-group":{"id":"g2","primary-type":"Album"}}]}]}`))
	}))
	defer srv.Close()
	r, err := newMBClient(srv.URL, t.TempDir()).lookup("Vasco Rossi", "Vita spericolata", 283)
	if err != nil || r.Year != 1983 || r.Album != "Bollicine" || r.AlbumIsComp {
		t.Errorf("%+v %v", r, err)
	}
	if earlierYear(0, "") != 0 || earlierYear(1990, "1983-04") != 1983 || earlierYear(1983, "1990") != 1983 {
		t.Error("earlierYear")
	}
}

func TestSafeJoin(t *testing.T) {
	root := t.TempDir()
	for _, bad := range []string{"", "../x.mp3", "a/../../x", "/etc/passwd", `C:\x`, "a//b", "a\\b"} {
		if _, err := safeJoin(root, bad); err == nil {
			t.Errorf("accettato %q", bad)
		}
	}
	if p, err := safeJoin(root, "Viaggio/Vasco Rossi - Albachiara - 1979.mp3"); err != nil || !strings.HasPrefix(p, root) {
		t.Errorf("rifiutato un percorso buono: %v", err)
	}
}

func TestParseShazam(t *testing.T) {
	b, _ := os.ReadFile("testdata/shazam_albachiara.json")
	r, err := parseShazam(b)
	if err != nil || !r.Trovato || r.Artista != "Vasco Rossi" || r.Titolo != "Albachiara" || r.Anno != 1979 ||
		r.Album != "Albachiara (Non siamo mica gli americani)" || r.ISRC != "ITB008470507" || r.coverURL == "" {
		t.Errorf("%+v %v", r, err)
	}
	if r.Offset < 54 || r.Offset > 54.1 {
		t.Errorf("posizione nella canzone: %v", r.Offset)
	}
	b, _ = os.ReadFile("testdata/shazam_nessuno.json")
	if r, err := parseShazam(b); err != nil || r.Trovato {
		t.Errorf("nessun brano: %+v %v", r, err)
	}
	if _, err := parseShazam([]byte("errore")); err == nil {
		t.Error("una risposta non JSON deve dare errore")
	}
}

// webClient usato da più goroutine: la pausa minima vale per tutte.
func TestWebClientConcurrent(t *testing.T) {
	var mu sync.Mutex
	var times []time.Time
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		times = append(times, time.Now())
		mu.Unlock()
		w.Write([]byte("ok"))
	}))
	defer srv.Close()
	c := newWebClient(20 * time.Millisecond)
	var wg sync.WaitGroup
	for i := 0; i < 15; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c.get(srv.URL)
		}()
	}
	wg.Wait()
	if len(times) != 15 {
		t.Fatalf("%d richieste", len(times))
	}
	for i := 1; i < len(times); i++ {
		if d := times[i].Sub(times[i-1]); d < 15*time.Millisecond {
			t.Errorf("richieste troppo vicine: %v", d)
		}
	}

	// servizio irraggiungibile: dopo tre errori è offline, poi si riprova
	old := offlineRetry
	offlineRetry = 50 * time.Millisecond
	defer func() { offlineRetry = old }()
	dead := newWebClient(0)
	for i := 0; i < 3; i++ {
		dead.get("http://127.0.0.1:1/")
	}
	if !dead.isOffline() {
		t.Error("doveva risultare offline")
	}
	time.Sleep(80 * time.Millisecond)
	if dead.isOffline() {
		t.Error("dopo offlineRetry si deve riprovare")
	}
}

func TestOverlay(t *testing.T) {
	exe := bytes.Repeat([]byte("MZ programma "), 1000)
	out := withOverlay(exe, overlayData{Sito: "https://musica.example", Biglietto: "abc"})
	p := filepath.Join(t.TempDir(), "RiparaMP3-Collega.exe")
	os.WriteFile(p, out, 0o755)
	d, ok := readOverlay(p)
	if !ok || d.Sito != "https://musica.example" || d.Biglietto != "abc" {
		t.Errorf("biglietto %+v %v", d, ok)
	}
	if !bytes.Equal(stripOverlay(out), exe) {
		t.Error("stripOverlay")
	}
	os.WriteFile(p, exe, 0o755)
	if _, ok := readOverlay(p); ok {
		t.Error("biglietto trovato in un programma senza")
	}
}

func TestNormalizeCoverIdempotent(t *testing.T) {
	// immagine "rumorosa": a qualità 90 supererebbe i 200 KB
	big := coloredJPEG(t, 1400, 120, 80, 60)
	n1, err := normalizeCover(big)
	if err != nil {
		t.Fatal(err)
	}
	n2, _ := normalizeCover(n1)
	if !bytes.Equal(n1, n2) || len(n1) > 200<<10 {
		t.Errorf("copertina non stabile: %d byte", len(n1))
	}
}

// --- Server ---------------------------------------------------------------------------

func newTestServer(t *testing.T, o options) (*server, *httptest.Server) {
	t.Helper()
	if o.dataDir == "" {
		o.dataDir = t.TempDir()
	}
	if o.keysDir == "" {
		o.keysDir = t.TempDir()
	}
	for _, p := range []*string{&o.mbURL, &o.deezerURL, &o.itunesURL, &o.caaURL, &o.acoustidURL} {
		if *p == "" {
			*p = "http://127.0.0.1:1"
		}
	}
	if o.users == "" {
		o.users = "decordi"
	}
	s, err := newServer(o)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s.handler())
	t.Cleanup(ts.Close)
	return s, ts
}

type webReq struct {
	t  *testing.T
	ts *httptest.Server
}

func (c webReq) do(method, path string, body any, out any) int {
	c.t.Helper()
	var rd *bytes.Reader
	if b, ok := body.([]byte); ok {
		rd = bytes.NewReader(b)
	} else if body != nil {
		js, _ := json.Marshal(body)
		rd = bytes.NewReader(js)
	} else {
		rd = bytes.NewReader(nil)
	}
	req, _ := http.NewRequest(method, c.ts.URL+path, rd)
	req.Header.Set("X-Utente", "decordi")
	req.Header.Set("X-Richiesta", "1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	if out != nil {
		json.NewDecoder(resp.Body).Decode(out)
	}
	return resp.StatusCode
}

func TestAccessRules(t *testing.T) {
	_, ts := newTestServer(t, options{})
	get := func(path string, h map[string]string) int {
		req, _ := http.NewRequest("GET", ts.URL+path, nil)
		for k, v := range h {
			req.Header.Set(k, v)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if c := get("/api/stato", nil); c != http.StatusForbidden {
		t.Errorf("senza portineria: %d", c)
	}
	if c := get("/api/stato", map[string]string{"X-Utente": "intruso"}); c != http.StatusForbidden {
		t.Errorf("utente sconosciuto: %d", c)
	}
	if c := get("/api/stato", map[string]string{"X-Utente": "decordi"}); c != http.StatusOK {
		t.Errorf("utente giusto: %d", c)
	}
	if c := get("/", map[string]string{"X-Utente": "decordi"}); c != http.StatusOK {
		t.Errorf("pagina: %d", c)
	}
	if c := get("/agente/copertine/0123456789abcdef", map[string]string{"X-Utente": "decordi"}); c != http.StatusUnauthorized {
		t.Errorf("agente senza token: %d", c)
	}
	// le richieste che cambiano qualcosa vogliono l'intestazione della pagina
	req, _ := http.NewRequest("POST", ts.URL+"/api/playlist", strings.NewReader(`{"nome":"x"}`))
	req.Header.Set("X-Utente", "decordi")
	resp, _ := http.DefaultClient.Do(req)
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("senza X-Richiesta: %d", resp.StatusCode)
	}
}

func TestPairingWithCode(t *testing.T) {
	_, ts := newTestServer(t, options{})
	c := webReq{t, ts}
	var ab rispostaAbbina
	if code := c.do("POST", "/agente/abbina", richiestaAbbina{PC: "PC-CASA", Versione: "1.3"}, &ab); code != 200 || len(ab.Codice) != 6 {
		t.Fatalf("abbina: %d %+v", code, ab)
	}
	wrong := "999999"
	if ab.Codice == wrong {
		wrong = "888888"
	}
	if code := c.do("POST", "/api/agenti/abbina", map[string]string{"codice": wrong}, nil); code != http.StatusNotFound {
		t.Errorf("codice sbagliato accettato: %d", code)
	}
	done := make(chan esitoAbbina)
	go func() {
		var e esitoAbbina
		c.do("POST", "/agente/abbina/attendi", attesaAbbina{ab.Richiesta, ab.Segreto}, &e)
		done <- e
	}()
	time.Sleep(100 * time.Millisecond)
	var ok map[string]string
	if code := c.do("POST", "/api/agenti/abbina", map[string]string{"codice": ab.Codice[:3] + " " + ab.Codice[3:]}, &ok); code != 200 || ok["nome"] != "PC-CASA" {
		t.Fatalf("conferma: %d %v", code, ok)
	}
	e := <-done
	if e.Stato != "ok" || e.Token == "" {
		t.Fatalf("token non ricevuto: %+v", e)
	}
	// con il token l'agente è riconosciuto
	req, _ := http.NewRequest("GET", ts.URL+"/agente/copertine/0123456789abcdef", nil)
	req.Header.Set("Authorization", "Bearer "+e.Token)
	resp, _ := http.DefaultClient.Do(req)
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("token non valido: %d", resp.StatusCode)
	}
	// un segreto sbagliato non riceve niente
	var e2 esitoAbbina
	c.do("POST", "/agente/abbina/attendi", attesaAbbina{ab.Richiesta, "sbagliato"}, &e2)
	if e2.Token != "" {
		t.Error("token dato a chi non ha il segreto")
	}
}

func TestTicketDownload(t *testing.T) {
	exe := filepath.Join(t.TempDir(), "RiparaMP3-Collega.exe")
	os.WriteFile(exe, bytes.Repeat([]byte("MZ"), 5000), 0o755)
	_, ts := newTestServer(t, options{exePath: exe, site: "https://musica.example"})
	c := webReq{t, ts}
	var tk map[string]string
	if code := c.do("POST", "/api/agenti/biglietto", map[string]any{}, &tk); code != 200 || !strings.Contains(tk["url"], "/agente/scarica/") {
		t.Fatalf("biglietto: %d %v", code, tk)
	}
	ticket := tk["url"][strings.LastIndex(tk["url"], "/")+1:]
	resp, err := http.Get(ts.URL + "/agente/scarica/" + ticket)
	if err != nil {
		t.Fatal(err)
	}
	var body bytes.Buffer
	body.ReadFrom(resp.Body)
	resp.Body.Close()
	// il programma è sempre lo stesso; il biglietto sta nel nome del file
	orig, _ := os.ReadFile(exe)
	if !bytes.Equal(body.Bytes(), orig) {
		t.Error("il programma scaricato deve essere identico a quello sul server")
	}
	cd := resp.Header.Get("Content-Disposition")
	if !strings.Contains(cd, `filename="RiparaMP3-Collega-`+ticket+`.exe"`) {
		t.Fatalf("nome del file: %q", cd)
	}
	for _, name := range []string{"RiparaMP3-Collega-" + ticket + ".exe", "RiparaMP3-Collega-" + ticket + " (1).exe",
		filepath.Join("C:", "Users", "x", "Downloads", "riparamp3-collega-"+ticket+".EXE")} {
		if got := ticketFromName(name); got != ticket {
			t.Errorf("%s: biglietto %q", name, got)
		}
	}
	if ticketFromName("RiparaMP3-Collega.exe") != "" || ticketFromName("RiparaMP3.exe") != "" {
		t.Error("biglietto trovato in un nome che non lo ha")
	}
	var e esitoAbbina
	if code := c.do("POST", "/agente/biglietto", richiestaBiglietto{Biglietto: ticket, PC: "PC"}, &e); code != 200 || e.Token == "" {
		t.Fatalf("biglietto non accettato: %d", code)
	}
	if code := c.do("POST", "/agente/biglietto", richiestaBiglietto{Biglietto: ticket, PC: "PC"}, &e); code != http.StatusForbidden {
		t.Errorf("biglietto usato due volte: %d", code)
	}
	resp, _ = http.Get(ts.URL + "/agente/scarica/" + ticket)
	resp.Body.Close()
	if resp.StatusCode != http.StatusGone {
		t.Errorf("scaricamento con biglietto usato: %d", resp.StatusCode)
	}
}

func TestProposalsWithAI(t *testing.T) {
	var asked string
	fail := false
	ai := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Contents []struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"contents"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if r.Header.Get("x-goog-api-key") != "CHIAVE" {
			w.WriteHeader(403)
			return
		}
		if fail {
			w.WriteHeader(500)
			return
		}
		asked = body.Contents[0].Parts[0].Text
		js := `{"playlist":[{"nome":"Cantautori in viaggio","descrizione":"Voci italiane da strada.","brani":[1,2,3,4,5,6,7,8,99]},` +
			`{"nome":"Troppo piccola","descrizione":"x","brani":[1,2]}]}`
		resp, _ := json.Marshal(map[string]any{"candidates": []any{map[string]any{"content": map[string]any{"parts": []any{map[string]string{"text": js}}}}}})
		w.Write(resp)
	}))
	defer ai.Close()
	keys := t.TempDir()
	os.WriteFile(filepath.Join(keys, "gemini.key"), []byte("CHIAVE\n"), 0o600)
	s, _ := newTestServer(t, options{keysDir: keys})
	s.ai.geminiURL = ai.URL
	s.mu.Lock()
	pl := &playlist{ID: "p1", Nome: "Tutto", Tipo: tipoCartella}
	for i := 0; i < 12; i++ {
		anno := 1975
		if i < 4 {
			anno = 1985
		}
		b := &brano{ID: "b" + string(rune('a'+i)), Artista: "Artista", Titolo: "Brano " + string(rune('A'+i)), Anno: anno, Lingua: "it", Info: true, Cercato: true}
		s.lib.Brani[b.ID] = b
		pl.Brani = append(pl.Brani, b.ID)
	}
	s.lib.Playlist = append(s.lib.Playlist, pl)
	s.mu.Unlock()

	s.generaProposte()
	if !strings.Contains(asked, "1|Artista|Brano A|1985||it|\n") || !strings.Contains(asked, "5|Artista|Brano E|1975||it|\n") {
		t.Errorf("richiesta all'AI:\n%s", asked)
	}
	names := map[string]int{}
	for _, p := range s.proposte.Lista {
		names[p.Nome] = len(p.Brani)
	}
	if names["Cantautori in viaggio"] != 8 || names["Anni 70"] != 8 {
		t.Errorf("proposte: %v (errore %q)", names, s.proposte.Errore)
	}
	if _, ok := names["Troppo piccola"]; ok {
		t.Error("una proposta con 2 brani doveva essere scartata")
	}
	if _, ok := names["Italiane"]; ok {
		t.Error("«Italiane» coincide con la playlist che c'è già: andava scartata")
	}

	fail = true
	s.generaProposte()
	if s.proposte.Errore == "" || len(s.proposte.Lista) == 0 {
		t.Errorf("con l'AI giù restano i gruppi dai dati: %+v", s.proposte)
	}
}

func TestParseLRC(t *testing.T) {
	r := parseLRC("[ar:Vasco]\n[00:17.50] Respiri piano\r\n[00:05.00][01:02.25] Ritornello\n[00:20.63]\nsenza tempo")
	if len(r) != 4 || r[0].T != 5 || r[0].Testo != "Ritornello" || r[1].T != 17.5 || r[2].Testo != "" || r[3].T != 62.25 {
		t.Errorf("%+v", r)
	}
}

func TestLyricsSearch(t *testing.T) {
	lrclibMinInterval = 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		switch r.URL.Path {
		case "/api/get":
			if q.Get("duration") == "243" {
				w.Write([]byte(`{"trackName":"Albachiara","artistName":"Vasco Rossi","duration":245,"syncedLyrics":"[00:17.50] Respiri piano","plainLyrics":"Respiri piano"}`))
				return
			}
			http.NotFound(w, r)
		case "/api/search":
			w.Write([]byte(`[{"trackName":"Vita Spericolata","artistName":"Vasco Rossi","albumName":"Fronte del palco (Live)","duration":338,"syncedLyrics":"[00:01.00] dal vivo"},
				{"trackName":"Vita spericolata","artistName":"Vasco Rossi","albumName":"Bollicine","duration":284,"syncedLyrics":"[00:10.00] Voglio una vita"},
				{"trackName":"Vita spericolata","artistName":"Altro","duration":284,"syncedLyrics":"[00:01.00] no"}]`))
		}
	}))
	defer srv.Close()
	c := newLrcClient(srv.URL, t.TempDir())
	if r, err := c.lyrics("Vasco Rossi", "Albachiara", "", 243); err != nil || !r.Sincronizzato || r.Righe[0].Testo != "Respiri piano" {
		t.Errorf("get: %+v %v", r, err)
	}
	if r, err := c.lyrics("Vasco Rossi", "Vita spericolata", "", 283); err != nil || !r.Trovato || r.Righe[0].Testo != "Voglio una vita" {
		t.Errorf("search: %+v %v", r, err)
	}
	if r, err := c.lyrics("Nessuno", "Niente", "", 0); err != nil || r.Trovato {
		t.Errorf("non trovato: %+v %v", r, err)
	}
}

// Riconoscimento dal microfono con un songrec finto che risponde come Shazam.
func TestRecognizeAPI(t *testing.T) {
	ffmpegAvailable(t)
	if runtime.GOOS == "windows" {
		t.Skip("serve una shell")
	}
	cover := coloredJPEG(t, 400, 10, 120, 200)
	img := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write(cover) }))
	defer img.Close()
	dir := t.TempDir()
	fixture, _ := os.ReadFile("testdata/shazam_albachiara.json")
	fixture = regexp.MustCompile(`https://is1-ssl[^"]+`).ReplaceAll(fixture, []byte(img.URL+"/cover.jpg"))
	os.WriteFile(filepath.Join(dir, "risposta.json"), fixture, 0o644)
	script := filepath.Join(dir, "songrec")
	os.WriteFile(script, []byte("#!/bin/sh\ntest \"$1\" = audio-file-to-recognized-song && test -s \"$2\" && cat '"+filepath.Join(dir, "risposta.json")+"'\n"), 0o755)
	oldGap, oldHour := shazamMinGap, shazamPerHour
	shazamMinGap, shazamPerHour = 0, 1
	defer func() { shazamMinGap, shazamPerHour = oldGap, oldHour }()

	_, ts := newTestServer(t, options{songrec: script})
	wav := filepath.Join(dir, "registrazione.webm")
	if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "libopus", wav).CombinedOutput(); err != nil {
		t.Skipf("ffmpeg senza opus: %s", out)
	}
	audio, _ := os.ReadFile(wav)
	var r risultatoShazam
	if code := (webReq{t, ts}).do("POST", "/api/riconosci", audio, &r); code != 200 || !r.Trovato || r.Artista != "Vasco Rossi" ||
		r.Titolo != "Albachiara" || r.Anno != 1979 || r.Copertina == "" {
		t.Fatalf("riconoscimento: %d %+v", code, r)
	}
	var e map[string]string
	if code := (webReq{t, ts}).do("POST", "/api/riconosci", audio, &e); code != http.StatusTooManyRequests {
		t.Errorf("limite orario non applicato: %d %v", code, e)
	}
}

func TestConsoleRefusesPlaylistStick(t *testing.T) {
	stick := t.TempDir()
	os.WriteFile(filepath.Join(stick, markerFile), []byte(`{}`), 0o644)
	os.WriteFile(filepath.Join(stick, "a.mp3"), []byte("x"), 0o644)
	u := &ui{r: bufio.NewReader(strings.NewReader("")), yes: true}
	out := captureStdout(t, func() {
		if err := run(options{stick: stick, yes: true, noBackup: true, offline: true}, u); err != nil {
			t.Fatal(err)
		}
	})
	if !strings.Contains(out, "organizzata a playlist") || !exists(filepath.Join(stick, "a.mp3")) {
		t.Errorf("la console doveva rifiutarsi:\n%s", out)
	}
}
