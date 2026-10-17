package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestCompilationTitles(t *testing.T) {
	yes := []string{"Festivalbar 98", "Greatest Hits", "The Very Best of Queen", "Sanremo 2003", "Hit Mania Dance 2000",
		"Il meglio di Lucio Battisti", "I grandi successi", "Gold", "Now That's What I Call Music! 45", "Raccolta",
		"Love Songs", "Summer Hits 2010", "The Essential Bruce Springsteen", "Hits 99", "Vol. 2"}
	no := []string{"A Night at the Opera", "Bollicine", "Cambio", "Emozioni", "Toto IV", "Opera prima",
		"Non siamo mica gli americani!", "The Wall", "Thriller", "Anime salve", "Golden Hour", "Bestial"}
	for _, a := range yes {
		if !looksLikeCompilationTitle(a) {
			t.Errorf("%q dovrebbe essere una raccolta", a)
		}
	}
	for _, a := range no {
		if looksLikeCompilationTitle(a) {
			t.Errorf("%q non è una raccolta", a)
		}
	}
	for _, a := range []string{"Various Artists", "Artisti Vari", "AA.VV.", "V.A.", "VA"} {
		if !isVariousArtists(a) {
			t.Errorf("%q dovrebbe essere 'artisti vari'", a)
		}
	}
	if isVariousArtists("Vasco Rossi") {
		t.Error("Vasco Rossi non è 'artisti vari'")
	}
}

func TestMarkCompilations(t *testing.T) {
	mk := func(artist, album, albumArtist string) *song {
		return &song{status: stOK, final: songTags{Artist: artist, Album: album, AlbumArtist: albumArtist}}
	}
	songs := []*song{
		mk("A", "Estate", ""), mk("B", "Estate", ""), mk("C", "Estate", ""), // stesso album, tre artisti
		mk("Queen", "A Night at the Opera", ""), mk("Queen", "A Night at the Opera", ""),
		mk("D", "Qualcosa", "Artisti vari"),
	}
	want := []bool{true, true, true, false, false, true}
	markCompilations(songs)
	for i, s := range songs {
		if s.compilation != want[i] {
			t.Errorf("%s / %s: raccolta %v", s.final.Artist, s.final.Album, s.compilation)
		}
	}
}

func TestAlbumMatchKey(t *testing.T) {
	same := [][2]string{
		{"A Night at the Opera", "A Night at the Opera (2011 Remaster)"},
		{"Bollicine", "Bollicine - Remastered"},
		{"Nevermind", "Nevermind (Deluxe Edition)"},
		{"Abbey Road", "Abbey Road - 50th Anniversary Super Deluxe"},
	}
	for _, p := range same {
		if albumMatchKey(p[0]) != albumMatchKey(p[1]) {
			t.Errorf("%q e %q dovrebbero coincidere", p[0], p[1])
		}
	}
	if albumMatchKey("Toto IV") == albumMatchKey("Toto") {
		t.Error("album diversi considerati uguali")
	}
}

func TestDeezerQuotaRetry(t *testing.T) {
	deezerMinInterval, deezerQuotaPause = 0, 10*time.Millisecond
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"code": 4, "message": "Quota limit exceeded"}})
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{
			{"title": "Cambio", "record_type": "compile", "cover_xl": "x", "artist": map[string]any{"name": "Lucio Dalla"}},
			{"title": "Cambio", "record_type": "album", "cover_xl": "giusta", "artist": map[string]any{"name": "Lucio Dalla"}},
		}})
	}))
	defer srv.Close()
	a := newArtFinder(srv.URL, srv.URL, srv.URL, t.TempDir())
	u, err := a.deezerAlbum("Lucio Dalla", "Cambio")
	if err != nil || u != "giusta" || calls != 2 {
		t.Errorf("url %q err %v chiamate %d", u, err, calls)
	}
}

func TestNoNegativeCacheOnNetworkError(t *testing.T) {
	deezerMinInterval, itunesMinInterval = 0, 0
	dir := t.TempDir()
	// indirizzo che rifiuta la connessione
	a := newArtFinder("http://127.0.0.1:1", "http://127.0.0.1:1", "http://127.0.0.1:1", dir)
	if img, _ := a.albumCover("Queen", "Innuendo", "rg", "rel"); img != nil {
		t.Fatal("niente rete: nessuna copertina")
	}
	if _, _, ok := a.loadCache(albumCacheKey("Queen", "Innuendo")); ok {
		t.Error("senza rete non va salvato 'non trovato'")
	}
	// con il servizio raggiungibile ma senza risultati, invece, sì
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/search/album" || r.URL.Path == "/search" {
			w.Write([]byte(`{"data":[],"results":[]}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()
	a = newArtFinder(srv.URL, srv.URL, srv.URL, dir)
	a.albumCover("Queen", "Innuendo", "rg", "rel")
	if m, _, ok := a.loadCache(albumCacheKey("Queen", "Innuendo")); !ok || m.Found {
		t.Error("risultato negativo non salvato")
	}
}
