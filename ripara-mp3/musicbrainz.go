package main

import (
	"encoding/json"
	"math"
	"net/url"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Ricerca di album, anno e numero di traccia su MusicBrainz
// (https://musicbrainz.org). Le regole del servizio chiedono al massimo una
// richiesta al secondo e uno User-Agent che identifichi il programma.

// mbMinInterval è la pausa minima fra due richieste a MusicBrainz.
var mbMinInterval = 1100 * time.Millisecond

type mbResult struct {
	Found        bool      `json:"found"`
	Artist       string    `json:"artist,omitempty"`
	Title        string    `json:"title,omitempty"`
	Album        string    `json:"album,omitempty"`
	Year         int       `json:"year,omitempty"`
	Track        int       `json:"track,omitempty"`
	TrackTotal   int       `json:"track_total,omitempty"`
	ReleaseGroup string    `json:"release_group,omitempty"`
	Release      string    `json:"release,omitempty"`
	AlbumIsComp  bool      `json:"album_is_comp,omitempty"`
	CompTitles   []string  `json:"comp_titles,omitempty"` // raccolte che contengono il brano (normalizzate)
	Checked      time.Time `json:"checked"`
}

type mbClient struct {
	base      string
	web       *webClient
	cacheFile string

	mu    sync.Mutex
	cache map[string]*mbResult
}

func newMBClient(base, cacheDir string) *mbClient {
	c := &mbClient{
		base:      strings.TrimRight(base, "/"),
		web:       newWebClient(mbMinInterval),
		// v3: dalla 1.3 si chiedono 100 risultati e si usa la prima data di
		// uscita; i risultati della v2 (25 risultati) a volte avevano l'anno
		// di una raccolta invece di quello originale
		cacheFile: filepath.Join(cacheDir, "musicbrainz-v3.json"),
		cache:     map[string]*mbResult{},
	}
	readJSON(c.cacheFile, &c.cache)
	return c
}

func (c *mbClient) save() {
	c.mu.Lock()
	b, err := json.MarshalIndent(c.cache, "", " ")
	c.mu.Unlock()
	if err == nil {
		writeFileAtomic(c.cacheFile, b, 0o644)
	}
}

func (c *mbClient) cached(key string) (*mbResult, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	r, ok := c.cache[key]
	return r, ok
}

func (c *mbClient) remember(key string, r *mbResult) {
	c.mu.Lock()
	c.cache[key] = r
	c.mu.Unlock()
}

type mbArtistCredit []struct {
	Name       string `json:"name"`
	JoinPhrase string `json:"joinphrase"`
	Artist     struct {
		Name string `json:"name"`
	} `json:"artist"`
}

func (ac mbArtistCredit) String() string {
	var sb strings.Builder
	for _, a := range ac {
		sb.WriteString(a.Name)
		sb.WriteString(a.JoinPhrase)
	}
	return strings.TrimSpace(sb.String())
}

type mbRelease struct {
	ID           string         `json:"id"`
	Title        string         `json:"title"`
	Status       string         `json:"status"`
	Date         string         `json:"date"`
	ArtistCredit mbArtistCredit `json:"artist-credit"`
	ReleaseGroup struct {
		ID             string   `json:"id"`
		PrimaryType    string   `json:"primary-type"`
		SecondaryTypes []string `json:"secondary-types"`
	} `json:"release-group"`
	Media []struct {
		Position    int       `json:"position"`
		TrackCount  int       `json:"track-count"`
		TrackOffset *int      `json:"track-offset"`
		Track       []mbTrack `json:"track"`  // nelle ricerche
		Tracks      []mbTrack `json:"tracks"` // nelle richieste per identificativo
	} `json:"media"`
}

type mbTrack struct {
	Number   string `json:"number"`
	Position int    `json:"position"`
}

type mbSearch struct {
	Recordings []struct {
		ID           string         `json:"id"`
		Score        int            `json:"score"`
		Title        string         `json:"title"`
		Length       int            `json:"length"`
		FirstRelease string         `json:"first-release-date"`
		ArtistCredit mbArtistCredit `json:"artist-credit"`
		Releases     []mbRelease    `json:"releases"`
	} `json:"recordings"`
}

// earlierYear abbassa l'anno se la data indicata è più vecchia.
func earlierYear(year int, date string) int {
	if len(date) >= 4 {
		if y, err := strconv.Atoi(date[:4]); err == nil && y > 1000 && (year == 0 || y < year) {
			return y
		}
	}
	return year
}

func luceneQuote(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	return `"` + s + `"`
}

func cacheKey(artist, title string) string {
	return normKey(artist) + "|" + normKey(stripParens(title))
}

// isCompilationRelease: raccolte di più artisti o "greatest hits".
func isCompilationRelease(r mbRelease) bool {
	return contains(r.ReleaseGroup.SecondaryTypes, "Compilation") || isVariousArtists(r.ArtistCredit.String())
}

func releaseRank(r mbRelease) int {
	rank := 5
	sec := r.ReleaseGroup.SecondaryTypes
	switch {
	case isVariousArtists(r.ArtistCredit.String()):
		rank = 3
	case r.ReleaseGroup.PrimaryType == "Album" && len(sec) == 0:
		rank = 0
	case (r.ReleaseGroup.PrimaryType == "Single" || r.ReleaseGroup.PrimaryType == "EP") && len(sec) == 0:
		rank = 1
	case contains(sec, "Soundtrack"):
		rank = 2
	case contains(sec, "Compilation"):
		rank = 3
	case contains(sec, "Live"):
		rank = 4
	}
	if r.Status != "Official" {
		rank += 10
	}
	return rank
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func dateKey(d string) string {
	if d == "" {
		return "9999"
	}
	return d
}

// lookup cerca il brano su MusicBrainz e restituisce le informazioni del
// disco più adatto (album in studio ufficiale, il più vecchio).
func (c *mbClient) lookup(artist, title string, duration float64) (*mbResult, error) {
	key := cacheKey(artist, title)
	if r, ok := c.cached(key); ok && (r.Found || time.Since(r.Checked) < 30*24*time.Hour) {
		return r, nil
	}
	// i brani famosi hanno decine di registrazioni (dal vivo, raccolte) con
	// lo stesso punteggio: con pochi risultati l'originale può restare fuori
	q := "recording:" + luceneQuote(stripParens(title)) + " AND artist:" + luceneQuote(artist)
	body, err := c.web.get(c.base + "/ws/2/recording?fmt=json&limit=100&query=" + url.QueryEscape(q))
	if err != nil {
		return nil, err
	}
	var res mbSearch
	if err := json.Unmarshal(body, &res); err != nil {
		return nil, err
	}
	out := &mbResult{Checked: time.Now()}
	wantArtist := normKey(artist)
	wantTitle := normKey(stripParens(title))
	var releases []mbRelease
	firstYear := 0
	for _, rec := range res.Recordings {
		if rec.Score < 70 {
			continue
		}
		credit := normKey(rec.ArtistCredit.String())
		first := ""
		if len(rec.ArtistCredit) > 0 {
			first = normKey(rec.ArtistCredit[0].Name)
		}
		artistOK := credit == wantArtist || first == wantArtist ||
			(len(wantArtist) >= 4 && strings.Contains(credit, wantArtist)) ||
			(len(first) >= 4 && strings.Contains(wantArtist, first))
		titleOK := normKey(stripParens(rec.Title)) == wantTitle || normKey(rec.Title) == normKey(title)
		durOK := rec.Length == 0 || duration == 0 || math.Abs(float64(rec.Length)/1000-duration) <= 15
		if !artistOK || !titleOK || !durOK {
			continue
		}
		if !out.Found {
			out.Found = true
			out.Artist = rec.ArtistCredit.String()
			out.Title = rec.Title
		}
		releases = append(releases, rec.Releases...)
		firstYear = earlierYear(firstYear, rec.FirstRelease)
	}
	fillRelease(out, releases)
	if out.Found {
		out.Year = earlierYear(out.Year, strconv.Itoa(firstYear))
	}
	c.remember(key, out)
	return out, nil
}

// fillRelease sceglie fra le uscite di un brano il disco più adatto (album
// in studio ufficiale, il più vecchio) e ne copia album, anno e traccia.
func fillRelease(out *mbResult, releases []mbRelease) {
	for _, r := range releases {
		if isCompilationRelease(r) {
			if k := normKey(stripParens(r.Title)); k != "" && !contains(out.CompTitles, k) {
				out.CompTitles = append(out.CompTitles, k)
			}
		}
	}
	if !out.Found || len(releases) == 0 {
		return
	}
	// anno: la prima uscita ufficiale del brano
	for _, r := range releases {
		if r.Status != "" && r.Status != "Official" {
			continue
		}
		if len(r.Date) >= 4 {
			if y, err := strconv.Atoi(r.Date[:4]); err == nil && y > 1000 && (out.Year == 0 || y < out.Year) {
				out.Year = y
			}
		}
	}
	releases = append([]mbRelease(nil), releases...)
	sort.SliceStable(releases, func(i, j int) bool {
		ri, rj := releaseRank(releases[i]), releaseRank(releases[j])
		if ri != rj {
			return ri < rj
		}
		return dateKey(releases[i].Date) < dateKey(releases[j].Date)
	})
	best := releases[0]
	out.Album = best.Title
	out.AlbumIsComp = isCompilationRelease(best)
	out.ReleaseGroup = best.ReleaseGroup.ID
	out.Release = best.ID
	if len(best.Media) > 0 {
		m := best.Media[0]
		out.TrackTotal = m.TrackCount
		tracks := append(m.Track, m.Tracks...)
		switch {
		case len(tracks) > 0:
			if n, err := strconv.Atoi(tracks[0].Number); err == nil {
				out.Track = n
			} else if tracks[0].Position > 0 {
				out.Track = tracks[0].Position
			}
		case m.TrackOffset != nil && m.TrackCount > 0:
			out.Track = *m.TrackOffset + 1
		}
	}
}

// recording legge da MusicBrainz una registrazione conosciuta per
// identificativo (quello dato da AcoustID).
func (c *mbClient) recording(id string) (*mbResult, error) {
	body, err := c.web.get(c.base + "/ws/2/recording/" + url.PathEscape(id) + "?fmt=json&inc=artist-credits+releases+release-groups+media")
	if err != nil {
		return nil, err
	}
	var rec struct {
		Title        string         `json:"title"`
		FirstRelease string         `json:"first-release-date"`
		ArtistCredit mbArtistCredit `json:"artist-credit"`
		Releases     []mbRelease    `json:"releases"`
	}
	if err := json.Unmarshal(body, &rec); err != nil {
		return nil, err
	}
	out := &mbResult{Found: rec.Title != "", Artist: rec.ArtistCredit.String(), Title: rec.Title, Checked: time.Now()}
	fillRelease(out, rec.Releases)
	if out.Found {
		out.Year = earlierYear(out.Year, rec.FirstRelease)
	}
	return out, nil
}
