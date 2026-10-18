package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// Lo stato del sito: libreria (playlist e brani), PC collegati, lavori,
// letture della chiavetta e indici dei dischi. Tutto sta in file JSON nella
// cartella dei dati, scritti in modo atomico.

type brano struct {
	ID         string    `json:"id"`
	Artista    string    `json:"artista"`
	Titolo     string    `json:"titolo"`
	Album      string    `json:"album,omitempty"`
	Anno       int       `json:"anno,omitempty"`
	Traccia    int       `json:"traccia,omitempty"`
	TracceTot  int       `json:"tracce_tot,omitempty"`
	Durata     float64   `json:"durata,omitempty"`
	Genere     string    `json:"genere,omitempty"`    // dai tag del file
	GenereDz   string    `json:"genere_dz,omitempty"` // genere dell'album su Deezer
	Lingua     string    `json:"lingua,omitempty"`    // "it", "altro" o vuoto
	BPM        float64   `json:"bpm,omitempty"`
	ISRC       string    `json:"isrc,omitempty"`
	Copertina  string    `json:"copertina,omitempty"`
	FonteCop   string    `json:"fonte_cop,omitempty"`
	MBRG       string    `json:"mb_rg,omitempty"`
	MBRel      string    `json:"mb_rel,omitempty"`
	DeezerID   int64     `json:"deezer,omitempty"`
	ShazamKey  string    `json:"shazam,omitempty"`
	Audio      []string  `json:"audio,omitempty"` // audio (sha1) dei file noti di questo brano
	Origine    string    `json:"origine,omitempty"`
	Aggiunto   time.Time `json:"aggiunto"`
	AggiuntoDa string    `json:"aggiunto_da,omitempty"`
	Fonte      *fonte    `json:"fonte,omitempty"` // copia sul disco scelta a mano
	Info       bool      `json:"info,omitempty"`  // dati Deezer già cercati
	Cercato    bool      `json:"cercato,omitempty"`
}

func (b *brano) chiave() string { return pairKey(b.Artista, b.Titolo) }

func (b *brano) nome() string {
	if b.Artista == "" {
		return b.Titolo
	}
	return b.Artista + " - " + b.Titolo
}

// tags sono i tag da scrivere nel file del brano.
func (b *brano) tags() songTags {
	return songTags{Title: b.Titolo, Artist: b.Artista, Album: b.Album, Year: b.Anno,
		Track: b.Traccia, TrackTotal: b.TracceTot, Genre: b.Genere}
}

func (b *brano) genere() string {
	if b.GenereDz != "" {
		return b.GenereDz
	}
	return b.Genere
}

type playlist struct {
	ID          string    `json:"id"`
	Nome        string    `json:"nome"`
	Tipo        string    `json:"tipo"` // cartella, m3u
	Brani       []string  `json:"brani"`
	Descrizione string    `json:"descrizione,omitempty"`
	Origine     string    `json:"origine,omitempty"` // chiavetta, proposta, mano
	Creata      time.Time `json:"creata"`
	Modificata  time.Time `json:"modificata"`
}

const (
	tipoCartella = "cartella"
	tipoM3U      = "m3u"
)

type libreria struct {
	Versione  int               `json:"versione"`
	Playlist  []*playlist       `json:"playlist"`
	Brani     map[string]*brano `json:"brani"`
	Chiavetta string            `json:"chiavetta,omitempty"` // la chiavetta delle playlist
}

func (l *libreria) playlistByID(id string) *playlist {
	for _, p := range l.Playlist {
		if p.ID == id {
			return p
		}
	}
	return nil
}

// usato dice se il brano sta in almeno una playlist.
func (l *libreria) usato(id string) bool {
	for _, p := range l.Playlist {
		for _, b := range p.Brani {
			if b == id {
				return true
			}
		}
	}
	return false
}

// pulisci toglie i brani che non stanno più in nessuna playlist.
func (l *libreria) pulisci() {
	used := map[string]bool{}
	for _, p := range l.Playlist {
		for _, b := range p.Brani {
			used[b] = true
		}
	}
	for id := range l.Brani {
		if !used[id] {
			delete(l.Brani, id)
		}
	}
}

// --- PC collegati e abbinamenti --------------------------------------------------

type agenteSrv struct {
	ID        string    `json:"id"`
	Nome      string    `json:"nome"`
	TokenHash string    `json:"token_hash"`
	Creato    time.Time `json:"creato"`
	DaChi     string    `json:"da_chi,omitempty"`
	Versione  string    `json:"versione,omitempty"`
	Visto     time.Time `json:"visto"`
	Unita     []unita   `json:"unita,omitempty"`
	InCorso   string    `json:"in_corso,omitempty"`
}

func (a *agenteSrv) online() bool { return time.Since(a.Visto) < 75*time.Second }

type bigliettoSrv struct {
	Hash   string    `json:"hash"`
	Creato time.Time `json:"creato"`
	Scade  time.Time `json:"scade"`
	DaChi  string    `json:"da_chi,omitempty"`
	Usi    int       `json:"usi"`
	Usato  bool      `json:"usato"`
}

type abbinamento struct {
	ID          string
	SegretoHash string
	Codice      string
	PC          string
	Versione    string
	IP          string
	Scade       time.Time
	Token       string // pronto quando il sito conferma
	pronto      chan struct{}
}

// --- Lavori ----------------------------------------------------------------------

type lavoroSrv struct {
	ID         string          `json:"id"`
	Tipo       string          `json:"tipo"`
	Agente     string          `json:"agente"`
	Param      json.RawMessage `json:"param,omitempty"`
	Stato      string          `json:"stato"` // in_coda, inviato, in_corso, fatto, errore, annullato
	Creato     time.Time       `json:"creato"`
	Inviato    time.Time       `json:"inviato,omitempty"`
	Aggiornato time.Time       `json:"aggiornato,omitempty"`
	Finito     time.Time       `json:"finito,omitempty"`
	Avanz      avanzamento     `json:"avanz"`
	Annulla    bool            `json:"annulla,omitempty"`
	Messaggio  string          `json:"messaggio,omitempty"`
	DaChi      string          `json:"da_chi,omitempty"`
	Tentativi  int             `json:"tentativi,omitempty"`
	Esiti      []esitoOp       `json:"esiti,omitempty"`
	Piano      string          `json:"piano,omitempty"`

	parti  map[int]bool
	scan   *scanAcc
	indici map[string]*indiceVolume
}

func (j *lavoroSrv) attivo() bool {
	return j.Stato == "in_coda" || j.Stato == "inviato" || j.Stato == "in_corso"
}

type scanAcc struct {
	info     *infoChiavetta
	files    []fileChiavetta
	complete bool // l'agente ha mandato tutto
}

// --- Chiavetta e dischi --------------------------------------------------------------

// finale: come il sito ha capito un file della chiavetta.
type finale struct {
	Tag          songTags `json:"tag"`
	Cop          string   `json:"cop,omitempty"`
	FonteCop     string   `json:"fonte_cop,omitempty"`
	MBRG         string   `json:"mb_rg,omitempty"`
	MBRel        string   `json:"mb_rel,omitempty"`
	Riconosciuto string   `json:"riconosciuto,omitempty"` // nome prima del riconoscimento dall'audio
}

type statoChiavetta struct {
	Unita     unita              `json:"unita"`
	Letta     time.Time          `json:"letta"`
	File      []fileChiavetta    `json:"file"`
	Finali    map[string]*finale `json:"finali"`
	Legami    map[string]string  `json:"legami"` // percorso -> brano
	Marcatore json.RawMessage    `json:"marcatore,omitempty"`
}

func (st *statoChiavetta) file(p string) *fileChiavetta {
	for i := range st.File {
		if st.File[i].P == p {
			return &st.File[i]
		}
	}
	return nil
}

type indiceVolume struct {
	Unita      unita       `json:"unita"`
	Aggiornato time.Time   `json:"aggiornato"`
	File       []fileDisco `json:"file"`
}

// --- Playlist proposte ---------------------------------------------------------------

type proposta struct {
	ID          string   `json:"id"`
	Nome        string   `json:"nome"`
	Descrizione string   `json:"descrizione,omitempty"`
	Brani       []string `json:"brani"`
	Fonte       string   `json:"fonte"` // dati, ai
	Stato       string   `json:"stato"` // nuova, accettata, scartata
}

type statoProposte struct {
	Create time.Time   `json:"create"`
	Motore string      `json:"motore,omitempty"`
	Errore string      `json:"errore,omitempty"`
	Lista  []*proposta `json:"lista"`
}

// --- Salvataggi ----------------------------------------------------------------------

func newID(prefix string) string {
	var b [8]byte
	rand.Read(b[:])
	return prefix + hex.EncodeToString(b[:])
}

func newSecret() string {
	var b [32]byte
	rand.Read(b[:])
	return base64.RawURLEncoding.EncodeToString(b[:])
}

func hashSecret(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func (s *server) path(parts ...string) string {
	return filepath.Join(append([]string{s.dati}, parts...)...)
}

func (s *server) load() {
	s.lib = &libreria{Brani: map[string]*brano{}}
	readJSON(s.path("libreria.json"), s.lib)
	if s.lib.Brani == nil {
		s.lib.Brani = map[string]*brano{}
	}
	readJSON(s.path("agenti.json"), &s.agenti)
	readJSON(s.path("biglietti.json"), &s.biglietti)
	readJSON(s.path("proposte.json"), &s.proposte)
	files, _ := filepath.Glob(s.path("chiavette", "*.json.gz"))
	for _, f := range files {
		var st statoChiavetta
		if readJSONGz(f, &st) == nil && st.Unita.Volume != "" {
			s.chiav[st.Unita.Volume] = &st
		}
	}
	files, _ = filepath.Glob(s.path("indici", "*.json.gz"))
	for _, f := range files {
		var iv indiceVolume
		if readJSONGz(f, &iv) == nil && iv.Unita.Volume != "" {
			s.dischi[iv.Unita.Volume] = &iv
		}
	}
	files, _ = filepath.Glob(s.path("lavori", "*.json"))
	for _, f := range files {
		var j lavoroSrv
		if readJSON(f, &j) == nil && j.ID != "" {
			if j.attivo() && j.Stato != "in_coda" {
				// il server è ripartito durante il lavoro: l'agente lo
				// ripeterà da capo
				j.Stato, j.Avanz = "in_coda", avanzamento{}
			}
			s.lavori[j.ID] = &j
		}
	}
	s.rebuildSearch()
}

// saveLib salva la libreria; la prima volta di ogni giorno ne tiene una
// copia (le ultime cinque).
func (s *server) saveLib() {
	s.lib.Versione++
	p := s.path("libreria.json")
	day := s.path("copie", "libreria-"+time.Now().Format("2006-01-02")+".json")
	if exists(p) && !exists(day) {
		if b, err := os.ReadFile(p); err == nil {
			writeFileAtomic(day, b, 0o644)
		}
		old, _ := filepath.Glob(s.path("copie", "libreria-*.json"))
		sort.Strings(old)
		for len(old) > 5 {
			os.Remove(old[0])
			old = old[1:]
		}
	}
	writeJSONAtomic(p, s.lib)
	if s.o.libCopy != "" {
		writeJSONAtomic(filepath.Join(s.o.libCopy, "libreria.json"), s.lib)
	}
}

func (s *server) saveAgents() {
	writeJSONAtomic(s.path("agenti.json"), s.agenti)
	s.agentsSaved = time.Now()
}

func (s *server) saveTickets() { writeJSONAtomic(s.path("biglietti.json"), s.biglietti) }

func (s *server) saveProposte() { writeJSONAtomic(s.path("proposte.json"), s.proposte) }

func (s *server) saveJob(j *lavoroSrv) {
	writeJSONAtomic(s.path("lavori", j.ID+".json"), j)
	if j.attivo() {
		return
	}
	// si tengono gli ultimi 200 lavori finiti
	var done []*lavoroSrv
	for _, x := range s.lavori {
		if !x.attivo() {
			done = append(done, x)
		}
	}
	if len(done) <= 200 {
		return
	}
	sort.Slice(done, func(a, b int) bool { return done[a].Creato.Before(done[b].Creato) })
	for _, x := range done[:len(done)-200] {
		delete(s.lavori, x.ID)
		os.Remove(s.path("lavori", x.ID+".json"))
	}
}

func volFile(vol string) string { return safeFileName(vol, 40) + ".json.gz" }

func (s *server) saveStick(st *statoChiavetta) {
	writeJSONGz(s.path("chiavette", volFile(st.Unita.Volume)), st)
}

func (s *server) saveIndex(iv *indiceVolume) {
	writeJSONGz(s.path("indici", volFile(iv.Unita.Volume)), iv)
}
