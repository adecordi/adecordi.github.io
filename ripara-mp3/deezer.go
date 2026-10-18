package main

import (
	"encoding/json"
	"math"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Informazioni in più da Deezer per raggruppare i brani nelle playlist
// proposte (genere dell'album, ritmo, codice ISRC) e ricerca nel catalogo
// per aggiungere brani dal sito.

type dzInfo struct {
	Found    bool      `json:"found"`
	TrackID  int64     `json:"track,omitempty"`
	AlbumID  int64     `json:"album_id,omitempty"`
	Artist   string    `json:"artist,omitempty"`
	Title    string    `json:"title,omitempty"`
	Album    string    `json:"album,omitempty"`
	ISRC     string    `json:"isrc,omitempty"`
	BPM      float64   `json:"bpm,omitempty"`
	Genre    string    `json:"genre,omitempty"`
	Year     int       `json:"year,omitempty"`
	Duration int       `json:"duration,omitempty"`
	Rank     int       `json:"rank,omitempty"`
	Checked  time.Time `json:"checked"`
}

type dzInfoCache struct {
	mu     sync.Mutex
	file   string
	Tracks map[string]*dzInfo `json:"tracks"`
	Genres map[int64]string   `json:"genres"` // genere per album
	dirty  int
}

func (a *artFinder) infoCache() *dzInfoCache {
	a.infoOnce.Do(func() {
		c := &dzInfoCache{file: filepath.Join(filepath.Dir(a.dir), "deezer-brani.json"), Tracks: map[string]*dzInfo{}, Genres: map[int64]string{}}
		readJSON(c.file, c)
		if c.Tracks == nil {
			c.Tracks = map[string]*dzInfo{}
		}
		if c.Genres == nil {
			c.Genres = map[int64]string{}
		}
		a.info = c
	})
	return a.info
}

func (c *dzInfoCache) save() {
	c.mu.Lock()
	b, err := json.Marshal(c)
	c.dirty = 0
	c.mu.Unlock()
	if err == nil {
		writeFileAtomic(c.file, b, 0o644)
	}
}

type dzTrack struct {
	ID          int64    `json:"id"`
	Title       string   `json:"title"`
	TitleShort  string   `json:"title_short"` // senza "(Remastered 2011)" e simili
	Duration    int      `json:"duration"`
	Rank        int      `json:"rank"`
	ISRC        string   `json:"isrc"`
	BPM         float64  `json:"bpm"`
	ReleaseDate string   `json:"release_date"`
	Preview     string   `json:"preview"`
	Artist      dzArtist `json:"artist"`
	Album       struct {
		ID          int64  `json:"id"`
		Title       string `json:"title"`
		CoverMedium string `json:"cover_medium"`
		CoverXL     string `json:"cover_xl"`
	} `json:"album"`
}

// isVersionTitle: versioni dal vivo, remix e simili, da evitare quando il
// brano cercato non lo è.
func isVersionTitle(t string) bool {
	k := " " + normKey(t) + " "
	for _, w := range versionWords {
		if strings.Contains(k, " "+w+" ") {
			return true
		}
	}
	return false
}

var versionWords = []string{"live", "dal vivo", "remix", "rmx", "edit", "karaoke", "instrumental", "strumentale",
	"acoustic", "acustica", "unplugged", "demo", "cover", "mix", "versione", "version", "reprise", "medley"}

// trackInfo trova il brano su Deezer e ne restituisce genere, ritmo e ISRC.
func (a *artFinder) trackInfo(artist, title string, duration float64) (*dzInfo, error) {
	c := a.infoCache()
	key := cacheKey(artist, title)
	c.mu.Lock()
	if r, ok := c.Tracks[key]; ok && (r.Found || time.Since(r.Checked) < 30*24*time.Hour) {
		c.mu.Unlock()
		return r, nil
	}
	c.mu.Unlock()
	var res struct {
		Data []dzTrack `json:"data"`
	}
	if err := a.deezerGet("/search/track?limit=25&q="+url.QueryEscape(artist+" "+stripParens(title)), &res); err != nil {
		return nil, err
	}
	want := normKey(stripParens(title))
	wantVersion := isVersionTitle(title)
	var best *dzTrack
	for i, d := range res.Data {
		if !artistMatch(d.Artist.Name, artist) || normKey(stripParens(d.Title)) != want {
			continue
		}
		if duration > 0 && d.Duration > 0 && math.Abs(float64(d.Duration)-duration) > 15 {
			continue
		}
		if !wantVersion && (isVersionTitle(d.Title) || isVersionTitle(d.Album.Title)) {
			continue
		}
		best = &res.Data[i]
		break
	}
	out := &dzInfo{Checked: time.Now()}
	if best != nil {
		out.Found = true
		out.TrackID, out.AlbumID = best.ID, best.Album.ID
		out.Artist, out.Title, out.Album = best.Artist.Name, best.Title, best.Album.Title
		out.Duration, out.Rank = best.Duration, best.Rank
		var tr dzTrack
		if err := a.deezerGet("/track/"+strconv.FormatInt(best.ID, 10), &tr); err == nil {
			out.ISRC, out.BPM = tr.ISRC, tr.BPM
			if len(tr.ReleaseDate) >= 4 {
				out.Year, _ = strconv.Atoi(tr.ReleaseDate[:4])
			}
		} else if err != errNotFound {
			return nil, err
		}
		out.Genre = a.albumGenre(best.Album.ID)
	}
	c.mu.Lock()
	c.Tracks[key] = out
	c.dirty++
	save := c.dirty >= 20
	c.mu.Unlock()
	if save {
		c.save()
	}
	return out, nil
}

func (a *artFinder) albumGenre(id int64) string {
	if id == 0 {
		return ""
	}
	c := a.infoCache()
	c.mu.Lock()
	g, ok := c.Genres[id]
	c.mu.Unlock()
	if ok {
		return g
	}
	var al struct {
		Genres struct {
			Data []struct {
				Name string `json:"name"`
			} `json:"data"`
		} `json:"genres"`
	}
	if err := a.deezerGet("/album/"+strconv.FormatInt(id, 10), &al); err != nil && err != errNotFound {
		return ""
	}
	if len(al.Genres.Data) > 0 {
		g = al.Genres.Data[0].Name
	}
	c.mu.Lock()
	c.Genres[id] = g
	c.mu.Unlock()
	return g
}

// searchTracks cerca nel catalogo Deezer (per aggiungere brani dal sito).
func (a *artFinder) searchTracks(q string, limit int) ([]dzTrack, error) {
	var res struct {
		Data []dzTrack `json:"data"`
	}
	if err := a.deezerGet("/search/track?limit="+strconv.Itoa(limit)+"&q="+url.QueryEscape(q), &res); err != nil {
		return nil, err
	}
	return res.Data, nil
}

// deezerTrackByID legge un brano del catalogo con il suo identificativo.
func (a *artFinder) deezerTrackByID(id int64) (*dzTrack, error) {
	var tr dzTrack
	if err := a.deezerGet("/track/"+strconv.FormatInt(id, 10), &tr); err != nil {
		return nil, err
	}
	if tr.ID == 0 {
		return nil, errNotFound
	}
	return &tr, nil
}
