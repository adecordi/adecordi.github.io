package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Ricerca di album, anno, numero di traccia e copertina su MusicBrainz
// (https://musicbrainz.org) e sul Cover Art Archive. Le regole del servizio
// chiedono al massimo una richiesta al secondo e uno User-Agent che
// identifichi il programma.

const userAgent = "RiparaMP3/1.0 ( https://github.com/adecordi/adecordi.github.io )"

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
	Checked      time.Time `json:"checked"`
}

type mbClient struct {
	base, caa string
	http      *http.Client
	last      time.Time
	cacheFile string
	coverDir  string
	cache     map[string]*mbResult
	offline   bool
	failures  int
}

func newMBClient(base, caa, cacheDir string) *mbClient {
	c := &mbClient{
		base:      strings.TrimRight(base, "/"),
		caa:       strings.TrimRight(caa, "/"),
		http:      &http.Client{Timeout: 25 * time.Second},
		cacheFile: filepath.Join(cacheDir, "musicbrainz.json"),
		coverDir:  filepath.Join(cacheDir, "copertine"),
		cache:     map[string]*mbResult{},
	}
	if b, err := os.ReadFile(c.cacheFile); err == nil {
		json.Unmarshal(b, &c.cache)
	}
	return c
}

func (c *mbClient) save() {
	os.MkdirAll(filepath.Dir(c.cacheFile), 0o755)
	if b, err := json.MarshalIndent(c.cache, "", " "); err == nil {
		os.WriteFile(c.cacheFile, b, 0o644)
	}
}

var errNotFound = errors.New("non trovato")

func (c *mbClient) get(u string, rateLimited bool) ([]byte, error) {
	for attempt := 0; attempt < 4; attempt++ {
		if rateLimited {
			if d := time.Until(c.last.Add(mbMinInterval)); d > 0 {
				time.Sleep(d)
			}
			c.last = time.Now()
		}
		req, _ := http.NewRequest("GET", u, nil)
		req.Header.Set("User-Agent", userAgent)
		req.Header.Set("Accept", "application/json")
		resp, err := c.http.Do(req)
		if err != nil {
			c.failures++
			if c.failures >= 3 {
				c.offline = true
			}
			return nil, err
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		resp.Body.Close()
		switch {
		case resp.StatusCode == http.StatusOK && err == nil:
			c.failures = 0
			return body, nil
		case resp.StatusCode == http.StatusNotFound:
			return nil, errNotFound
		case resp.StatusCode == http.StatusServiceUnavailable || resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500:
			time.Sleep(time.Duration(2+2*attempt) * time.Second)
			continue
		default:
			return nil, fmt.Errorf("risposta %d", resp.StatusCode)
		}
	}
	return nil, errors.New("servizio non disponibile")
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
	ID           string `json:"id"`
	Title        string `json:"title"`
	Status       string `json:"status"`
	Date         string `json:"date"`
	ReleaseGroup struct {
		ID             string   `json:"id"`
		PrimaryType    string   `json:"primary-type"`
		SecondaryTypes []string `json:"secondary-types"`
	} `json:"release-group"`
	Media []struct {
		Position    int `json:"position"`
		TrackCount  int `json:"track-count"`
		TrackOffset int `json:"track-offset"`
		Track       []struct {
			Number   string `json:"number"`
			Position int    `json:"position"`
		} `json:"track"`
	} `json:"media"`
}

type mbSearch struct {
	Recordings []struct {
		ID           string         `json:"id"`
		Score        int            `json:"score"`
		Title        string         `json:"title"`
		Length       int            `json:"length"`
		ArtistCredit mbArtistCredit `json:"artist-credit"`
		Releases     []mbRelease    `json:"releases"`
	} `json:"recordings"`
}

func luceneQuote(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	return `"` + s + `"`
}

func cacheKey(artist, title string) string {
	return normKey(artist) + "|" + normKey(stripParens(title))
}

func releaseRank(r mbRelease) int {
	rank := 5
	sec := r.ReleaseGroup.SecondaryTypes
	switch {
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
	if r, ok := c.cache[key]; ok && (r.Found || time.Since(r.Checked) < 30*24*time.Hour) {
		return r, nil
	}
	if c.offline {
		return nil, errors.New("internet non disponibile")
	}
	q := "recording:" + luceneQuote(stripParens(title)) + " AND artist:" + luceneQuote(artist)
	body, err := c.get(c.base+"/ws/2/recording?fmt=json&limit=25&query="+url.QueryEscape(q), true)
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
	}
	if out.Found && len(releases) > 0 {
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
		sort.SliceStable(releases, func(i, j int) bool {
			ri, rj := releaseRank(releases[i]), releaseRank(releases[j])
			if ri != rj {
				return ri < rj
			}
			return dateKey(releases[i].Date) < dateKey(releases[j].Date)
		})
		best := releases[0]
		out.Album = best.Title
		out.ReleaseGroup = best.ReleaseGroup.ID
		out.Release = best.ID
		if len(best.Media) > 0 {
			m := best.Media[0]
			out.TrackTotal = m.TrackCount
			if len(m.Track) > 0 {
				if n, err := strconv.Atoi(m.Track[0].Number); err == nil {
					out.Track = n
				} else if m.Track[0].Position > 0 {
					out.Track = m.Track[0].Position
				}
			} else if m.TrackOffset >= 0 && m.TrackCount > 0 {
				out.Track = m.TrackOffset + 1
			}
		}
	}
	c.cache[key] = out
	return out, nil
}

// cover scarica la copertina dell'album dal Cover Art Archive (500 pixel).
func (c *mbClient) cover(r *mbResult) []byte {
	if r == nil || r.ReleaseGroup == "" {
		return nil
	}
	os.MkdirAll(c.coverDir, 0o755)
	file := filepath.Join(c.coverDir, r.ReleaseGroup+".jpg")
	none := filepath.Join(c.coverDir, r.ReleaseGroup+".none")
	if b, err := os.ReadFile(file); err == nil {
		return b
	}
	if st, err := os.Stat(none); err == nil && time.Since(st.ModTime()) < 30*24*time.Hour {
		return nil
	}
	if c.offline {
		return nil
	}
	urls := []string{c.caa + "/release-group/" + r.ReleaseGroup + "/front-500"}
	if r.Release != "" {
		urls = append(urls, c.caa+"/release/"+r.Release+"/front-500")
	}
	for _, u := range urls {
		b, err := c.get(u, false)
		if err == nil && len(b) > 0 {
			if img, err := normalizeCover(b); err == nil {
				os.WriteFile(file, img, 0o644)
				return img
			}
		}
		if err != nil && !errors.Is(err, errNotFound) {
			return nil
		}
	}
	os.WriteFile(none, nil, 0o644)
	return nil
}
