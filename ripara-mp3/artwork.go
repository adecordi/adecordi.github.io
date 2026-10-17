package main

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Copertine ufficiali degli album, in ordine di preferenza: Deezer, Apple
// (iTunes Search) e Cover Art Archive. Deezer e Apple hanno le immagini
// pubblicate dalle case discografiche, quindi pulite e in alta qualità.

var (
	deezerMinInterval = 220 * time.Millisecond
	itunesMinInterval = 3100 * time.Millisecond
	deezerQuotaPause  = 5 * time.Second
)

type artFinder struct {
	deezerURL, itunesURL, caaURL string
	deezer, itunes, caa, img     *webClient
	dir                          string
}

func newArtFinder(deezerURL, itunesURL, caaURL, cacheDir string) *artFinder {
	return &artFinder{
		deezerURL: strings.TrimRight(deezerURL, "/"),
		itunesURL: strings.TrimRight(itunesURL, "/"),
		caaURL:    strings.TrimRight(caaURL, "/"),
		deezer:    newWebClient(deezerMinInterval),
		itunes:    newWebClient(itunesMinInterval),
		caa:       newWebClient(0),
		img:       newWebClient(0),
		dir:       filepath.Join(cacheDir, "copertine-v2"),
	}
}

func (a *artFinder) errors() int {
	return a.deezer.errors + a.itunes.errors + a.caa.errors + a.img.errors
}

func (a *artFinder) offline() bool {
	return a.deezer.offline && a.itunes.offline
}

// --- Cache su disco --------------------------------------------------------------

type artMeta struct {
	Found   bool      `json:"found"`
	Source  string    `json:"source,omitempty"`
	Album   string    `json:"album,omitempty"`
	Year    int       `json:"year,omitempty"`
	Checked time.Time `json:"checked"`
}

func (a *artFinder) cachePath(key string) string {
	sum := sha1.Sum([]byte(key))
	return filepath.Join(a.dir, hex.EncodeToString(sum[:10]))
}

func (a *artFinder) loadCache(key string) (*artMeta, []byte, bool) {
	base := a.cachePath(key)
	b, err := os.ReadFile(base + ".json")
	if err != nil {
		return nil, nil, false
	}
	var m artMeta
	if json.Unmarshal(b, &m) != nil {
		return nil, nil, false
	}
	if !m.Found {
		return &m, nil, time.Since(m.Checked) < 30*24*time.Hour
	}
	img, err := os.ReadFile(base + ".jpg")
	if err != nil {
		return nil, nil, false
	}
	return &m, img, true
}

func (a *artFinder) saveCache(key string, m *artMeta, img []byte) {
	os.MkdirAll(a.dir, 0o755)
	base := a.cachePath(key)
	m.Checked = time.Now()
	if img != nil {
		os.WriteFile(base+".jpg", img, 0o644)
	}
	if b, err := json.Marshal(m); err == nil {
		os.WriteFile(base+".json", b, 0o644)
	}
}

// --- Confronto di titoli e artisti -----------------------------------------------

var reEditionSuffix = regexp.MustCompile(`(?i)\s+[-–:]\s+[^-–:]*(remaster|deluxe|edition|edizione|version|versione|expanded|anniversary|bonus|special|legacy|reissue|mono|stereo)[^-–:]*$`)

// albumMatchKey toglie da un titolo d'album le indicazioni di edizione
// ("(Remastered 2011)", "- Deluxe Edition") per confrontarlo.
func albumMatchKey(album string) string {
	return normKey(reEditionSuffix.ReplaceAllString(stripParens(album), ""))
}

func artistMatch(found, want string) bool {
	f, w := normKey(found), normKey(want)
	if f == "" || w == "" {
		return false
	}
	return f == w || (len(w) >= 4 && strings.Contains(f, w)) || (len(f) >= 4 && strings.Contains(w, f))
}

func dzQuote(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, " ") + `"`
}

// download scarica un'immagine e la porta al formato per l'autoradio.
func (a *artFinder) download(u string) []byte {
	if u == "" {
		return nil
	}
	raw, err := a.img.get(u)
	if err != nil {
		return nil
	}
	img, err := normalizeCover(raw)
	if err != nil {
		return nil
	}
	return img
}

// --- Deezer ---------------------------------------------------------------------

type dzArtist struct {
	Name string `json:"name"`
}

type dzAlbum struct {
	ID          int64    `json:"id"`
	Title       string   `json:"title"`
	RecordType  string   `json:"record_type"`
	ReleaseDate string   `json:"release_date"`
	CoverXL     string   `json:"cover_xl"`
	CoverBig    string   `json:"cover_big"`
	Artist      dzArtist `json:"artist"`
}

type dzError struct {
	Error *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// deezerGet gestisce anche il limite di richieste di Deezer, che risponde
// con un errore dentro il JSON invece che con un codice HTTP.
func (a *artFinder) deezerGet(path string, v any) error {
	for attempt := 0; attempt < 3; attempt++ {
		body, err := a.deezer.get(a.deezerURL + path)
		if err != nil {
			return err
		}
		var e dzError
		if json.Unmarshal(body, &e) == nil && e.Error != nil {
			if e.Error.Code == 4 {
				time.Sleep(deezerQuotaPause)
				continue
			}
			if e.Error.Code == 800 {
				return errNotFound
			}
			return fmt.Errorf("deezer: %s", e.Error.Message)
		}
		return json.Unmarshal(body, v)
	}
	return fmt.Errorf("deezer: troppe richieste")
}

func (al dzAlbum) cover() string {
	if al.CoverXL != "" {
		return al.CoverXL
	}
	return al.CoverBig
}

// deezerAlbum cerca l'album e restituisce l'indirizzo della copertina.
func (a *artFinder) deezerAlbum(artist, album string) (string, error) {
	want := albumMatchKey(album)
	queries := []string{
		"artist:" + dzQuote(artist) + " album:" + dzQuote(album),
		artist + " " + stripParens(album),
	}
	var lastErr error
	for _, q := range queries {
		var res struct {
			Data []dzAlbum `json:"data"`
		}
		if err := a.deezerGet("/search/album?limit=25&q="+url.QueryEscape(q), &res); err != nil {
			lastErr = err
			continue
		}
		lastErr = nil
		best, bestRank := "", 9
		for _, d := range res.Data {
			if d.RecordType == "compile" || isVariousArtists(d.Artist.Name) ||
				!artistMatch(d.Artist.Name, artist) || albumMatchKey(d.Title) != want || d.cover() == "" {
				continue
			}
			rank := 1
			if d.RecordType == "album" {
				rank = 0
			}
			if rank < bestRank {
				best, bestRank = d.cover(), rank
			}
		}
		if best != "" {
			return best, nil
		}
	}
	return "", lastErr
}

// deezerTrack cerca il brano e restituisce il primo album originale (non
// raccolta) che lo contiene.
func (a *artFinder) deezerTrack(artist, title string, duration float64) (*dzAlbum, error) {
	var res struct {
		Data []struct {
			Title    string   `json:"title"`
			Duration int      `json:"duration"`
			Artist   dzArtist `json:"artist"`
			Album    dzAlbum  `json:"album"`
		} `json:"data"`
	}
	q := "artist:" + dzQuote(artist) + " track:" + dzQuote(stripParens(title))
	if err := a.deezerGet("/search/track?limit=25&q="+url.QueryEscape(q), &res); err != nil {
		return nil, err
	}
	want := normKey(stripParens(title))
	seen := map[int64]bool{}
	checked := 0
	for _, d := range res.Data {
		if !artistMatch(d.Artist.Name, artist) || normKey(stripParens(d.Title)) != want {
			continue
		}
		if duration > 0 && d.Duration > 0 && math.Abs(float64(d.Duration)-duration) > 15 {
			continue
		}
		if seen[d.Album.ID] || looksLikeCompilationTitle(d.Album.Title) {
			continue
		}
		seen[d.Album.ID] = true
		if checked++; checked > 6 {
			break
		}
		var al dzAlbum
		if err := a.deezerGet("/album/"+strconv.FormatInt(d.Album.ID, 10), &al); err != nil {
			continue
		}
		if al.RecordType == "compile" || isVariousArtists(al.Artist.Name) || al.cover() == "" {
			continue
		}
		return &al, nil
	}
	return nil, nil
}

// --- Apple (iTunes Search) --------------------------------------------------------

func (a *artFinder) itunesAlbum(artist, album string) (string, error) {
	var res struct {
		Results []struct {
			CollectionType string `json:"collectionType"`
			ArtistName     string `json:"artistName"`
			CollectionName string `json:"collectionName"`
			ArtworkURL100  string `json:"artworkUrl100"`
		} `json:"results"`
	}
	term := artist + " " + stripParens(album)
	body, err := a.itunes.get(a.itunesURL + "/search?entity=album&limit=25&country=it&term=" + url.QueryEscape(term))
	if err != nil {
		return "", err
	}
	if err := json.Unmarshal(body, &res); err != nil {
		return "", err
	}
	want := albumMatchKey(album)
	for _, r := range res.Results {
		if r.CollectionType == "Compilation" || isVariousArtists(r.ArtistName) || r.ArtworkURL100 == "" ||
			!artistMatch(r.ArtistName, artist) || albumMatchKey(r.CollectionName) != want {
			continue
		}
		return strings.Replace(r.ArtworkURL100, "100x100bb", "1000x1000bb", 1), nil
	}
	return "", nil
}

// --- Ricerche complete -------------------------------------------------------------

// albumCover restituisce la copertina ufficiale dell'album (già nel formato
// per l'autoradio) e il nome della fonte.
func albumCacheKey(artist, album string) string {
	return "album|" + normKey(artist) + "|" + albumMatchKey(album)
}

func (a *artFinder) albumCover(artist, album, releaseGroup, release string) ([]byte, string) {
	key := albumCacheKey(artist, album)
	if m, img, ok := a.loadCache(key); ok {
		return img, m.Source
	}
	netErr := false
	try := func(u string, err error, source string) []byte {
		if err != nil && err != errNotFound {
			netErr = true
			return nil
		}
		if u == "" {
			return nil
		}
		img := a.download(u)
		if img == nil {
			netErr = true
			return nil
		}
		a.saveCache(key, &artMeta{Found: true, Source: source}, img)
		return img
	}
	u, err := a.deezerAlbum(artist, album)
	if img := try(u, err, "Deezer"); img != nil {
		return img, "Deezer"
	}
	u, err = a.itunesAlbum(artist, album)
	if img := try(u, err, "Apple"); img != nil {
		return img, "Apple"
	}
	for _, p := range []string{"/release-group/" + releaseGroup, "/release/" + release} {
		if strings.HasSuffix(p, "/") {
			continue
		}
		raw, err := a.caa.get(a.caaURL + p + "/front-1200")
		if err != nil {
			if err != errNotFound {
				netErr = true
			}
			continue
		}
		if img, err := normalizeCover(raw); err == nil {
			a.saveCache(key, &artMeta{Found: true, Source: "Cover Art Archive"}, img)
			return img, "Cover Art Archive"
		}
	}
	if !netErr {
		a.saveCache(key, &artMeta{Found: false}, nil)
	}
	return nil, ""
}

type trackAlbumResult struct {
	Album  string
	Year   int
	Cover  []byte
	Source string
}

// trackAlbum trova l'album originale di un brano (quando non lo si conosce
// o quando i tag indicano una raccolta) con la sua copertina.
func (a *artFinder) trackAlbum(artist, title string, duration float64) *trackAlbumResult {
	key := "track|" + normKey(artist) + "|" + normKey(stripParens(title))
	if m, img, ok := a.loadCache(key); ok {
		if !m.Found {
			return nil
		}
		return &trackAlbumResult{m.Album, m.Year, img, m.Source}
	}
	al, err := a.deezerTrack(artist, title, duration)
	if err != nil {
		if err == errNotFound {
			a.saveCache(key, &artMeta{Found: false}, nil)
		}
		return nil
	}
	if al == nil {
		a.saveCache(key, &artMeta{Found: false}, nil)
		return nil
	}
	img := a.download(al.cover())
	if img == nil {
		return nil
	}
	r := &trackAlbumResult{Album: al.Title, Cover: img, Source: "Deezer"}
	if len(al.ReleaseDate) >= 4 {
		r.Year, _ = strconv.Atoi(al.ReleaseDate[:4])
	}
	a.saveCache(key, &artMeta{Found: true, Source: r.Source, Album: r.Album, Year: r.Year}, img)
	// la prossima volta il brano avrà l'album nei tag: si salva anche la
	// copertina dell'album, così non serve cercarla di nuovo
	if _, _, ok := a.loadCache(albumCacheKey(artist, r.Album)); !ok {
		a.saveCache(albumCacheKey(artist, r.Album), &artMeta{Found: true, Source: r.Source}, img)
	}
	return r
}
