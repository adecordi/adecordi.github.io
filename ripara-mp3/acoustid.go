package main

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Riconoscimento dei brani dall'audio con AcoustID (https://acoustid.org):
// l'impronta calcolata da fpcalc identifica la registrazione su MusicBrainz
// anche quando i tag del file sono del tutto sbagliati.

// acoustidMinInterval: il servizio accetta al massimo 3 richieste al secondo.
var acoustidMinInterval = 340 * time.Millisecond

// Soglie per accettare un riconoscimento.
const (
	acoustidMinScore = 0.85
	acoustidMaxDiff  = 10.0 // secondi di differenza ammessi sulla durata
)

var errBadKey = errors.New("chiave AcoustID non valida")

type idResult struct {
	Found        bool      `json:"found"`
	Artist       string    `json:"artist,omitempty"`
	Title        string    `json:"title,omitempty"`
	Album        string    `json:"album,omitempty"`
	Year         int       `json:"year,omitempty"`
	Track        int       `json:"track,omitempty"`
	TrackTotal   int       `json:"track_total,omitempty"`
	ReleaseGroup string    `json:"release_group,omitempty"`
	Release      string    `json:"release,omitempty"`
	Recording    string    `json:"recording,omitempty"`
	Score        float64   `json:"score,omitempty"`
	Checked      time.Time `json:"checked"`
}

type acoustidClient struct {
	base, key string
	web       *webClient
	cacheFile string
	badKey    bool

	mu    sync.Mutex
	cache map[string]*idResult
}

func newAcoustIDClient(base, key, cacheDir string) *acoustidClient {
	c := &acoustidClient{
		base:      strings.TrimRight(base, "/"),
		key:       key,
		web:       newWebClient(acoustidMinInterval),
		cacheFile: filepath.Join(cacheDir, "acoustid.json"),
		cache:     map[string]*idResult{},
	}
	readJSON(c.cacheFile, &c.cache)
	return c
}

func (c *acoustidClient) save() {
	c.mu.Lock()
	b, err := json.MarshalIndent(c.cache, "", " ")
	c.mu.Unlock()
	if err == nil {
		writeFileAtomic(c.cacheFile, b, 0o644)
	}
}

func (c *acoustidClient) cached(key string) (*idResult, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	r, ok := c.cache[key]
	if !ok || (!r.Found && time.Since(r.Checked) > 30*24*time.Hour) {
		return nil, false
	}
	return r, true
}

func (c *acoustidClient) remember(key string, r *idResult) {
	c.mu.Lock()
	c.cache[key] = r
	c.mu.Unlock()
}

type acArtist struct {
	Name       string `json:"name"`
	JoinPhrase string `json:"joinphrase"`
}

type acRecording struct {
	ID            string     `json:"id"`
	Title         string     `json:"title"`
	Duration      float64    `json:"duration"`
	Artists       []acArtist `json:"artists"`
	ReleaseGroups []struct {
		Title          string   `json:"title"`
		Type           string   `json:"type"`
		SecondaryTypes []string `json:"secondarytypes"`
	} `json:"releasegroups"`
}

func (r acRecording) artist() string {
	var sb strings.Builder
	for _, a := range r.Artists {
		sb.WriteString(a.Name + a.JoinPhrase)
	}
	return strings.TrimSpace(sb.String())
}

// album sceglie, fra i dischi indicati da AcoustID, un album non raccolta.
func (r acRecording) album() string {
	best, rank := "", 9
	for _, g := range r.ReleaseGroups {
		k := 3
		switch {
		case g.Type == "Album" && len(g.SecondaryTypes) == 0:
			k = 0
		case (g.Type == "Single" || g.Type == "EP") && len(g.SecondaryTypes) == 0:
			k = 1
		case !contains(g.SecondaryTypes, "Compilation") && !looksLikeCompilationTitle(g.Title):
			k = 2
		}
		if k < rank && g.Title != "" {
			best, rank = g.Title, k
		}
	}
	if rank == 3 {
		return ""
	}
	return best
}

type acResponse struct {
	Status string `json:"status"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
	Results []struct {
		Score      float64       `json:"score"`
		Recordings []acRecording `json:"recordings"`
	} `json:"results"`
}

// match invia l'impronta e restituisce la registrazione riconosciuta (nil
// se il riconoscimento non è abbastanza sicuro).
func (c *acoustidClient) match(fp string, duration float64, curArtist, curTitle string) (*acRecording, float64, error) {
	form := url.Values{
		"client":      {c.key},
		"format":      {"json"},
		"duration":    {strconv.Itoa(int(duration + 0.5))},
		"fingerprint": {fp},
		"meta":        {"recordings releasegroups compress"},
	}
	body, err := c.web.postForm(c.base+"/v2/lookup", form)
	var he *httpError
	if errors.As(err, &he) {
		body, err = he.body, nil
	}
	if err != nil {
		return nil, 0, err
	}
	var res acResponse
	if err := json.Unmarshal(body, &res); err != nil {
		return nil, 0, err
	}
	if res.Status != "ok" {
		if res.Error != nil && (res.Error.Code == 4 || strings.Contains(strings.ToLower(res.Error.Message), "api key")) {
			c.badKey = true
			return nil, 0, errBadKey
		}
		msg := "risposta non valida"
		if res.Error != nil {
			msg = res.Error.Message
		}
		return nil, 0, errors.New("acoustid: " + msg)
	}
	sort.SliceStable(res.Results, func(i, j int) bool { return res.Results[i].Score > res.Results[j].Score })
	type cand struct {
		rec   acRecording
		score float64
	}
	var cands []cand
	for _, r := range res.Results {
		if r.Score < acoustidMinScore {
			continue
		}
		for _, rec := range r.Recordings {
			if rec.ID == "" || rec.Title == "" || len(rec.Artists) == 0 {
				continue
			}
			if rec.Duration > 0 && duration > 0 && math.Abs(rec.Duration-duration) > acoustidMaxDiff {
				continue
			}
			cands = append(cands, cand{rec, r.Score})
		}
	}
	if len(cands) == 0 {
		return nil, 0, nil
	}
	// a parità di audio si preferisce la registrazione più simile ai tag:
	// stesso titolo, stesso artista, durata più vicina, niente "(live)" o
	// "(remix)" che nei tag non c'è
	best, bestPts := 0, math.Inf(-1)
	for i, c := range cands {
		pts := c.score * 10
		switch {
		case normKey(c.rec.Title) == normKey(curTitle):
			pts += 4
		case normKey(stripParens(c.rec.Title)) == normKey(stripParens(curTitle)):
			pts += 2
		}
		if stripParens(c.rec.Title) != c.rec.Title && stripParens(curTitle) == curTitle {
			pts--
		}
		if artistMatch(c.rec.artist(), curArtist) {
			pts += 2
		}
		if c.rec.Duration > 0 && duration > 0 {
			pts -= math.Abs(c.rec.Duration-duration) / 10
		}
		if pts > bestPts {
			best, bestPts = i, pts
		}
	}
	return &cands[best].rec, cands[best].score, nil
}

// identifyAudio restituisce l'audio da cui calcolare l'impronta e le chiavi
// di cache con cui ricordare il risultato (anche quella dell'audio che
// verrà scritto, così alla prossima esecuzione non si ripete la ricerca).
func (s *song) identifyAudio() ([]byte, []string, error) {
	keys := []string{hex.EncodeToString(s.audioHash[:])}
	switch s.status {
	case stHD:
		data, err := os.ReadFile(s.hdPath)
		return data, keys, err
	case stRip:
		data, err := s.readSource()
		if err != nil {
			return nil, nil, err
		}
		p, _, err := repairPayload(data)
		if err != nil {
			return nil, nil, err
		}
		sum := sha1.Sum(p)
		return p, append(keys, hex.EncodeToString(sum[:])), nil
	default:
		data, err := s.readSource()
		return data, keys, err
	}
}

func (s *song) applyIdentified(r *idResult) {
	old := s.displayName()
	t := &s.final
	t.Artist, t.Title = r.Artist, r.Title
	if r.Album != "" {
		t.Album = r.Album
		t.Year, t.Track, t.TrackTotal = r.Year, r.Track, r.TrackTotal
		t.Disc, t.DiscTotal = 0, 0
		t.AlbumArtist = ""
	}
	s.identified = true
	s.compilation = false
	s.incomplete = false
	s.mbAlbum, s.mbRG, s.mbRel = r.Album, r.ReleaseGroup, r.Release
	if normKey(old) != normKey(s.displayName()) {
		s.idFrom = old
	}
}

// identifySongs riconosce dall'audio i brani sani, recuperati o riparati.
func identifySongs(songs []*song, ac *acoustidClient, mb *mbClient, bin string, progress func(label string, i, n int, name string)) (found, total int) {
	var need []*song
	for _, s := range songs {
		if s.dup || s.info == nil || s.info.Duration < 10 || (s.status != stOK && s.status != stHD && s.status != stRip) {
			continue
		}
		total++
		if r, ok := ac.cached(hex.EncodeToString(s.audioHash[:])); ok {
			if r.Found {
				s.applyIdentified(r)
				found++
			}
			continue
		}
		need = append(need, s)
	}
	if len(need) == 0 {
		return found, total
	}

	// impronte, quattro alla volta
	type fpRes struct {
		fp   string
		keys []string
	}
	fps := make([]fpRes, len(need))
	var wg sync.WaitGroup
	idx := make(chan int)
	done := make(chan int)
	for w := 0; w < 4; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range idx {
				func() {
					defer func() { recover() }()
					audio, keys, err := need[i].identifyAudio()
					if err == nil {
						if fp, err := fingerprintAudio(bin, audio); err == nil {
							fps[i] = fpRes{fp, keys}
						}
					}
				}()
				done <- i
			}
		}()
	}
	go func() {
		for i := range need {
			idx <- i
		}
		close(idx)
		wg.Wait()
		close(done)
	}()
	n := 0
	for i := range done {
		n++
		progress("Ascolto", n, len(need), need[i].displayName())
	}

	// riconoscimento
	for i, s := range need {
		if fps[i].fp == "" {
			continue
		}
		progress("Riconosco", i+1, len(need), s.displayName())
		ok, err := identifyOne(ac, mb, s, fps[i].fp, fps[i].keys)
		if err == errBadKey {
			break
		}
		if err != nil {
			if ac.web.isOffline() {
				break
			}
			continue
		}
		if ok {
			found++
		}
		if i%20 == 19 {
			ac.save()
		}
	}
	ac.save()
	return found, total
}

// identifyOne riconosce un brano dalla sua impronta: chiede ad AcoustID,
// completa con MusicBrainz e ricorda il risultato con le chiavi indicate.
// Restituisce true se il brano è stato riconosciuto (e corretto).
func identifyOne(ac *acoustidClient, mb *mbClient, s *song, fp string, keys []string) (bool, error) {
	rec, score, err := ac.match(fp, s.info.Duration, s.final.Artist, s.final.Title)
	if err != nil {
		return false, err
	}
	r := &idResult{Checked: time.Now()}
	cacheIt := true
	if rec != nil {
		r.Found, r.Recording, r.Score = true, rec.ID, score
		if mr, err := mb.recording(rec.ID); err == nil && mr.Found {
			r.Artist, r.Title = mr.Artist, mr.Title
			r.Album, r.Year, r.Track, r.TrackTotal = mr.Album, mr.Year, mr.Track, mr.TrackTotal
			r.ReleaseGroup, r.Release = mr.ReleaseGroup, mr.Release
			if mr.AlbumIsComp {
				r.Album, r.Track, r.TrackTotal, r.ReleaseGroup, r.Release = "", 0, 0, "", ""
			}
		} else {
			// MusicBrainz non risponde: bastano i dati di AcoustID, ma
			// la prossima volta si riprova per avere anche anno e traccia
			r.Artist, r.Title, r.Album = rec.artist(), rec.Title, rec.album()
			cacheIt = err == errNotFound
		}
	}
	if cacheIt {
		for _, k := range keys {
			ac.remember(k, r)
		}
	}
	if r.Found {
		s.applyIdentified(r)
	}
	return r.Found, nil
}
