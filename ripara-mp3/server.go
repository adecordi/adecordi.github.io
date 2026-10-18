package main

import (
	"compress/gzip"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// Il sito delle playlist. Sta sulla VPS dietro Caddy: le persone passano dalla
// portineria (che aggiunge l'intestazione X-Utente), l'agente sul PC usa i
// percorsi /agente/ con il suo token.

//go:embed web
var webFS embed.FS

type server struct {
	o     options
	dati  string
	sito  string
	users map[string]bool

	mu          sync.Mutex
	lib         *libreria
	agenti      []*agenteSrv
	agentsSaved time.Time
	biglietti   []*bigliettoSrv
	abbinamenti map[string]*abbinamento
	lavori      map[string]*lavoroSrv
	sveglie     map[string]chan struct{} // un campanello per agente
	chiav       map[string]*statoChiavetta
	dischi      map[string]*indiceVolume
	ricerca     *indiceRicerca
	proposte    statoProposte
	attivita    avanzamento // lavoro del sito in sottofondo
	tentativi   map[string][]time.Time

	covers *coverStore
	mb     *mbClient
	ac     *acoustidClient
	art    *artFinder
	ai     *aiClient
	elab   chan func()
	busy   atomic.Int32 // lavori in sottofondo in coda o in corso
	shazam shazamState
}

func runServer(o options) error {
	s, err := newServer(o)
	if err != nil {
		return err
	}
	srv := &http.Server{Addr: o.listen, Handler: s.handler(), ReadHeaderTimeout: 20 * time.Second}
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-ch
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		srv.Shutdown(ctx)
	}()
	log.Printf("RiparaMP3 %s: sito delle playlist su %s, dati in %s", version, o.listen, s.dati)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	s.mu.Lock()
	s.saveAgents()
	s.mu.Unlock()
	s.mb.save()
	if s.ac != nil {
		s.ac.save()
	}
	s.art.infoCache().save()
	return nil
}

func readKey(dir, name string) string {
	b, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func newServer(o options) (*server, error) {
	dati := o.dataDir
	if dati == "" {
		dati = filepath.Join(appCacheDir(), "sito")
	}
	if err := os.MkdirAll(dati, 0o700); err != nil {
		return nil, err
	}
	keys := o.keysDir
	if keys == "" {
		home, _ := os.UserHomeDir()
		keys = filepath.Join(home, ".config", "musica")
	}
	offlineRetry = 2 * time.Minute
	s := &server{
		o:           o,
		dati:        dati,
		sito:        strings.TrimRight(o.site, "/"),
		users:       map[string]bool{},
		abbinamenti: map[string]*abbinamento{},
		lavori:      map[string]*lavoroSrv{},
		sveglie:     map[string]chan struct{}{},
		chiav:       map[string]*statoChiavetta{},
		dischi:      map[string]*indiceVolume{},
		tentativi:   map[string][]time.Time{},
		elab:        make(chan func(), 1000),
	}
	for _, u := range strings.Split(o.users, ",") {
		if u = strings.TrimSpace(u); u != "" {
			s.users[u] = true
		}
	}
	cache := filepath.Join(dati, "cache")
	s.covers = newDiskCoverStore(filepath.Join(dati, "copertine"))
	s.mb = newMBClient(o.mbURL, cache)
	key := strings.TrimSpace(o.acoustidKey)
	if key == "" {
		key = readKey(keys, "acoustid.key")
	}
	if key != "" {
		s.ac = newAcoustIDClient(o.acoustidURL, key, cache)
	}
	s.art = newArtFinder(o.deezerURL, o.itunesURL, o.caaURL, cache)
	s.ai = newAIClient(readKey(keys, "gemini.key"), readKey(keys, "groq.key"))
	s.load()
	go s.worker()
	go s.periodic()
	return s, nil
}

// worker esegue uno alla volta i lavori lunghi del sito (riconoscimento dei
// brani, ricerche online, proposte).
func (s *server) worker() {
	for f := range s.elab {
		func() {
			defer func() {
				if r := recover(); r != nil {
					log.Printf("errore nel lavoro in sottofondo: %v", r)
				}
				s.setActivity("", 0, 0)
				s.busy.Add(-1)
			}()
			f()
		}()
	}
}

func (s *server) enqueue(f func()) {
	s.busy.Add(1)
	select {
	case s.elab <- f:
	default:
		s.busy.Add(-1)
		log.Print("troppi lavori in sottofondo: uno è stato scartato")
	}
}

func (s *server) setActivity(fase string, done, total int) {
	s.mu.Lock()
	s.attivita = avanzamento{Fase: fase, Fatti: done, Totale: total}
	s.mu.Unlock()
}

// periodic salva le cache, rimette in coda i lavori consegnati a un agente
// che non li ha mai cominciati e ogni mezz'ora riprova a completare i brani
// rimasti indietro (servizi online che non rispondevano).
func (s *server) periodic() {
	n := 0
	for range time.Tick(time.Minute) {
		s.mb.save()
		if s.ac != nil {
			s.ac.save()
		}
		s.art.infoCache().save()
		if n++; n%30 == 0 && s.busy.Load() == 0 {
			s.mu.Lock()
			pending := false
			for _, b := range s.lib.Brani {
				if !b.Cercato || !b.Info {
					pending = true
					break
				}
			}
			s.mu.Unlock()
			if pending {
				s.enqueue(s.enrichLibrary)
			}
		}
		s.mu.Lock()
		for _, j := range s.lavori {
			if j.Stato == "inviato" && time.Since(j.Inviato) > 90*time.Second {
				s.requeue(j, "l'agente non ha cominciato il lavoro")
			}
		}
		for id, ab := range s.abbinamenti {
			if time.Since(ab.Scade) > time.Minute {
				delete(s.abbinamenti, id)
			}
		}
		s.mu.Unlock()
	}
}

// --- Richieste e risposte -----------------------------------------------------------

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"errore": msg})
}

// readBody legge un corpo JSON (anche compresso) di al massimo max byte.
func readBody(r *http.Request, v any, max int64) error {
	var rd io.Reader = http.MaxBytesReader(nil, r.Body, max)
	if r.Header.Get("Content-Encoding") == "gzip" {
		zr, err := gzip.NewReader(rd)
		if err != nil {
			return err
		}
		defer zr.Close()
		rd = io.LimitReader(zr, 8*max)
	}
	return json.NewDecoder(rd).Decode(v)
}

func clientIP(r *http.Request) string {
	if f := r.Header.Get("X-Forwarded-For"); f != "" {
		return strings.TrimSpace(strings.Split(f, ",")[0])
	}
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	return host
}

// tooMany conta i tentativi per indirizzo: al massimo n ogni dieci minuti.
func (s *server) tooMany(kind, ip string, n int) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	k := kind + "|" + ip
	var keep []time.Time
	for _, t := range s.tentativi[k] {
		if time.Since(t) < 10*time.Minute {
			keep = append(keep, t)
		}
	}
	if len(keep) >= n {
		s.tentativi[k] = keep
		return true
	}
	s.tentativi[k] = append(keep, time.Now())
	return false
}

func userOf(r *http.Request) string { return r.Header.Get("X-Utente") }

// --- Instradamento -------------------------------------------------------------------

func (s *server) handler() http.Handler {
	mux := http.NewServeMux()

	// agente sul PC
	mux.HandleFunc("GET /agente/salute", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "ok\n") })
	mux.HandleFunc("POST /agente/abbina", s.agAbbina)
	mux.HandleFunc("POST /agente/abbina/attendi", s.agAttendi)
	mux.HandleFunc("POST /agente/biglietto", s.agBiglietto)
	mux.HandleFunc("GET /agente/scarica/{biglietto}", s.agScarica)
	mux.HandleFunc("POST /agente/lavoro", s.withAgent(s.agLavoro))
	mux.HandleFunc("POST /agente/lavori/{id}/avanzamento", s.withAgent(s.agAvanzamento))
	mux.HandleFunc("POST /agente/lavori/{id}/parte", s.withAgent(s.agParte))
	mux.HandleFunc("POST /agente/lavori/{id}/fine", s.withAgent(s.agFine))
	mux.HandleFunc("PUT /agente/copertine/{id}", s.withAgent(s.agPutCopertina))
	mux.HandleFunc("GET /agente/copertine/{id}", s.withAgent(s.agGetCopertina))

	// sito
	mux.HandleFunc("GET /{$}", s.static("index.html"))
	mux.HandleFunc("GET /app.js", s.static("app.js"))
	mux.HandleFunc("GET /app.css", s.static("app.css"))
	mux.HandleFunc("GET /copertine/{file}", s.apiCopertina)
	mux.HandleFunc("GET /salute", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "ok\n") })
	s.apiRoutes(mux)
	return s.guard(mux)
}

// guard: le pagine del sito sono solo per gli utenti della portineria.
func (s *server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Robots-Tag", "noindex, nofollow, noarchive")
		if strings.HasPrefix(r.URL.Path, "/agente/") {
			next.ServeHTTP(w, r)
			return
		}
		u := userOf(r)
		if u == "" || (len(s.users) > 0 && !s.users[u]) {
			http.Error(w, "accesso non consentito", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *server) static(name string) http.HandlerFunc {
	types := map[string]string{".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8"}
	return func(w http.ResponseWriter, r *http.Request) {
		b, err := fs.ReadFile(webFS, "web/"+name)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", types[filepath.Ext(name)])
		w.Header().Set("Cache-Control", "no-cache")
		w.Write(b)
	}
}

func (s *server) apiCopertina(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("file")
	var b []byte
	switch {
	case strings.HasSuffix(name, "_160.jpg"):
		b = s.covers.thumbFile(strings.TrimSuffix(name, "_160.jpg"))
	case strings.HasSuffix(name, ".jpg"):
		b = s.covers.get(strings.TrimSuffix(name, ".jpg"))
	}
	if b == nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.Write(b)
}

// --- Agente: autenticazione -----------------------------------------------------------

func (s *server) withAgent(h func(http.ResponseWriter, *http.Request, *agenteSrv)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || tok == "" {
			fail(w, http.StatusUnauthorized, "manca il token")
			return
		}
		h256 := hashSecret(tok)
		s.mu.Lock()
		var ag *agenteSrv
		for _, a := range s.agenti {
			if constantTimeEqual(a.TokenHash, h256) {
				ag = a
			}
		}
		if ag != nil {
			ag.Visto = time.Now()
		}
		s.mu.Unlock()
		if ag == nil {
			fail(w, http.StatusUnauthorized, "PC non riconosciuto")
			return
		}
		h(w, r, ag)
	}
}

func constantTimeEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	var v byte
	for i := 0; i < len(a); i++ {
		v |= a[i] ^ b[i]
	}
	return v == 0
}

// mainAgent è il PC collegato visto più di recente (di solito ce n'è uno).
func (s *server) mainAgent() *agenteSrv {
	var best *agenteSrv
	for _, a := range s.agenti {
		if best == nil || a.Visto.After(best.Visto) {
			best = a
		}
	}
	return best
}

func (s *server) wake(agentID string) {
	if ch := s.sveglie[agentID]; ch != nil {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

func humanAge(t time.Time) string {
	if t.IsZero() {
		return "mai"
	}
	d := time.Since(t)
	switch {
	case d < 2*time.Minute:
		return "adesso"
	case d < time.Hour:
		return fmt.Sprintf("%d minuti fa", int(d.Minutes()))
	}
	return t.In(romeTZ()).Format("02/01 15:04")
}

// romeTZ: la VPS è in UTC, le persone leggono l'ora italiana.
func romeTZ() *time.Location {
	if loc, err := time.LoadLocation("Europe/Rome"); err == nil {
		return loc
	}
	return time.Local
}
