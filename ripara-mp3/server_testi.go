package main

import (
	"encoding/json"
	"math"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Testi delle canzoni per il karaoke, da LRCLIB (https://lrclib.net): gratuito
// e con il tempo di ogni riga. La Tesla non mostra i testi dei file della
// chiavetta: il karaoke si guarda sul telefono, che li fa scorrere a tempo.

type rigaTesto struct {
	T     float64 `json:"t"`
	Testo string  `json:"testo"`
}

type testoBrano struct {
	Trovato       bool        `json:"trovato"`
	Sincronizzato bool        `json:"sincronizzato"`
	Righe         []rigaTesto `json:"righe,omitempty"`
	Semplice      string      `json:"semplice,omitempty"`
	Strumentale   bool        `json:"strumentale,omitempty"`
	Durata        float64     `json:"durata,omitempty"`
	Checked       time.Time   `json:"checked"`
}

var lrclibMinInterval = 200 * time.Millisecond

type lrcClient struct {
	base string
	web  *webClient
	file string

	mu    sync.Mutex
	cache map[string]*testoBrano
}

func newLrcClient(base, cacheDir string) *lrcClient {
	c := &lrcClient{base: strings.TrimRight(base, "/"), web: newWebClient(lrclibMinInterval),
		file: filepath.Join(cacheDir, "testi.json"), cache: map[string]*testoBrano{}}
	readJSON(c.file, &c.cache)
	if c.cache == nil {
		c.cache = map[string]*testoBrano{}
	}
	return c
}

type lrcRecord struct {
	TrackName    string  `json:"trackName"`
	ArtistName   string  `json:"artistName"`
	AlbumName    string  `json:"albumName"`
	Duration     float64 `json:"duration"`
	Instrumental bool    `json:"instrumental"`
	PlainLyrics  string  `json:"plainLyrics"`
	SyncedLyrics string  `json:"syncedLyrics"`
}

var reLrcTime = regexp.MustCompile(`\[(\d+):(\d+(?:\.\d+)?)\]`)

// parseLRC legge le righe "[mm:ss.cc] testo" (anche con più tempi sulla
// stessa riga, per i ritornelli) e le mette in ordine di tempo.
func parseLRC(s string) []rigaTesto {
	var out []rigaTesto
	for _, line := range strings.Split(strings.ReplaceAll(s, "\r", ""), "\n") {
		times := reLrcTime.FindAllStringSubmatch(line, -1)
		if len(times) == 0 {
			continue
		}
		text := strings.TrimSpace(reLrcTime.ReplaceAllString(line, ""))
		for _, m := range times {
			min, _ := strconv.Atoi(m[1])
			sec, _ := strconv.ParseFloat(m[2], 64)
			out = append(out, rigaTesto{T: float64(min)*60 + sec, Testo: text})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].T < out[j].T })
	return out
}

func testoDa(r *lrcRecord) *testoBrano {
	t := &testoBrano{Checked: time.Now(), Durata: r.Duration, Strumentale: r.Instrumental, Semplice: r.PlainLyrics}
	t.Righe = parseLRC(r.SyncedLyrics)
	t.Sincronizzato = len(t.Righe) > 0
	t.Trovato = t.Sincronizzato || t.Semplice != "" || t.Strumentale
	return t
}

// lyrics cerca il testo: prima la ricerca esatta (con la durata), poi quella
// libera, preferendo i testi con i tempi e la durata più vicina.
func (c *lrcClient) lyrics(artist, title, album string, duration float64) (*testoBrano, error) {
	key := cacheKey(artist, title)
	c.mu.Lock()
	if t, ok := c.cache[key]; ok && (t.Trovato || time.Since(t.Checked) < 7*24*time.Hour) {
		c.mu.Unlock()
		return t, nil
	}
	c.mu.Unlock()
	var best *lrcRecord
	if duration > 0 {
		q := url.Values{"artist_name": {artist}, "track_name": {stripParens(title)}, "duration": {strconv.Itoa(int(duration + 0.5))}}
		if album != "" {
			q.Set("album_name", album)
		}
		body, err := c.web.get(c.base + "/api/get?" + q.Encode())
		switch {
		case err == nil:
			var r lrcRecord
			if json.Unmarshal(body, &r) == nil && (r.SyncedLyrics != "" || r.Instrumental) {
				best = &r
			}
		case err != errNotFound:
			return nil, err
		}
	}
	if best == nil {
		q := url.Values{"artist_name": {artist}, "track_name": {stripParens(title)}}
		body, err := c.web.get(c.base + "/api/search?" + q.Encode())
		if err != nil && err != errNotFound {
			return nil, err
		}
		var list []lrcRecord
		json.Unmarshal(body, &list)
		want := normKey(stripParens(title))
		wantVersion := isVersionTitle(title)
		score := func(r *lrcRecord) float64 {
			s := 0.0
			if r.SyncedLyrics != "" {
				s += 100
			} else if r.PlainLyrics == "" {
				return -1
			}
			if duration > 0 && r.Duration > 0 {
				d := math.Abs(r.Duration - duration)
				if d > 15 {
					return -1
				}
				s -= d
			}
			if !wantVersion && (isVersionTitle(r.TrackName) || isVersionTitle(r.AlbumName)) {
				s -= 50
			}
			return s
		}
		bestScore := -1.0
		for i := range list {
			r := &list[i]
			if !artistMatch(r.ArtistName, artist) || normKey(stripParens(r.TrackName)) != want {
				continue
			}
			if sc := score(r); sc > bestScore {
				best, bestScore = r, sc
			}
		}
	}
	out := &testoBrano{Checked: time.Now()}
	if best != nil {
		out = testoDa(best)
	}
	c.mu.Lock()
	c.cache[key] = out
	c.mu.Unlock()
	return out, nil
}

func (c *lrcClient) save() {
	c.mu.Lock()
	b, err := json.Marshal(c.cache)
	c.mu.Unlock()
	if err == nil {
		writeFileAtomic(c.file, b, 0o644)
	}
}

// apiLyrics: GET /api/testo?brano=ID oppure ?artista=&titolo=&album=&durata=
func (s *server) apiLyrics(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	artist, title, album := limit(q.Get("artista"), 200), limit(q.Get("titolo"), 200), limit(q.Get("album"), 200)
	dur, _ := strconv.ParseFloat(q.Get("durata"), 64)
	if id := q.Get("brano"); id != "" {
		s.mu.Lock()
		b := s.lib.Brani[id]
		if b != nil {
			artist, title, album, dur = b.Artista, b.Titolo, b.Album, b.Durata
		}
		s.mu.Unlock()
		if b == nil {
			fail(w, http.StatusNotFound, "brano non trovato")
			return
		}
	}
	if title == "" {
		fail(w, http.StatusBadRequest, "manca il titolo")
		return
	}
	t, err := s.lrc.lyrics(artist, title, album, dur)
	if err != nil {
		fail(w, http.StatusBadGateway, "Il servizio dei testi non risponde: riprova fra poco.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"artista": artist, "titolo": title, "testo": t})
}
