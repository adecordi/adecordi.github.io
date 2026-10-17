package main

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"testing"
)

func testJPEG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), 120, 255})
		}
	}
	var b bytes.Buffer
	if err := jpeg.Encode(&b, img, nil); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func TestParseFileName(t *testing.T) {
	cases := []struct {
		in, artist, title string
		track             int
	}{
		{"01 - Queen - Bohemian Rhapsody.mp3", "Queen", "Bohemian Rhapsody", 1},
		{"01_queen-bohemian_rhapsody[www.mp3.com].mp3", "Queen", "Bohemian Rhapsody", 1},
		{"Vasco Rossi - Albachiara (Official Video).mp3", "Vasco Rossi", "Albachiara", 0},
		{"883 - Hanno ucciso l'uomo ragno.mp3", "883", "Hanno ucciso l'uomo ragno", 0},
		{"99 Luftballons.mp3", "", "99 Luftballons", 0},
		{"1979.mp3", "", "1979", 0},
		{"03. Yesterday.mp3", "", "Yesterday", 3},
		{"1-05 Lucio Dalla - Caruso.mp3", "Lucio Dalla", "Caruso", 5},
		{"Pink Floyd-Money.mp3", "Pink Floyd", "Money", 0},
		{"Jay-Z.mp3", "", "Jay-Z", 0},
		{"LIGABUE - CERTE NOTTI [320 kbps].mp3", "Ligabue", "Certe Notti", 0},
		{"10cc - Dreadlock Holiday.mp3", "10cc", "Dreadlock Holiday", 0},
	}
	for _, c := range cases {
		a, ti, tr := parseFileName(c.in)
		if a != c.artist || ti != c.title || tr != c.track {
			t.Errorf("%q -> (%q, %q, %d), atteso (%q, %q, %d)", c.in, a, ti, tr, c.artist, c.title, c.track)
		}
	}
}

func TestCleanField(t *testing.T) {
	cases := map[string]string{
		"PerchÃ© no":                        "Perché no",
		"Albachiara (Official Music Video)": "Albachiara",
		"Certe notti (Live)":                "Certe notti (Live)",
		"Song (Audio)":                      "Song (Audio)",
		"Song [HQ] - www.musica.com":        "Song",
		"LA VITA È BELLA":                   "La Vita è Bella",
		"ABBA":                              "ABBA",
		"the dark side of the moon":         "The Dark Side of the Moon",
		"Rock'n'Roll Star":                  "Rock'n'Roll Star",
		"part ii":                           "Part II",
		"Mr. Brightside":                    "Mr. Brightside",
		"Caf\u0092 song":                    "Caf’ song",
	}
	for in, want := range cases {
		if got := cleanField(in); got != want {
			t.Errorf("cleanField(%q) = %q, atteso %q", in, got, want)
		}
	}
}

func TestSafeFileName(t *testing.T) {
	cases := map[string]string{
		"AC/DC - Back In Black": "AC-DC - Back In Black",
		`What? "Yes": <no>*|`:   "What 'Yes' - no-",
		"con":                   "con_",
		"Title...":              "Title",
		"  spazi   doppi  ":     "spazi doppi",
		"":                      "Senza titolo",
	}
	for in, want := range cases {
		if got := safeFileName(in, 120); got != want {
			t.Errorf("safeFileName(%q) = %q, atteso %q", in, got, want)
		}
	}
	long := safeFileName("Artista - "+string(bytes.Repeat([]byte("parola "), 40)), 120)
	if n := len([]rune(long)); n > 120 || n < 60 {
		t.Errorf("nome lungo tagliato male: %d caratteri", n)
	}
}

func TestComputeTags(t *testing.T) {
	root := "/chiavetta"
	s := &song{path: "/chiavetta/Musica/Lucio Dalla - Anidride Solforosa (1975)/02 - Lucio Dalla - Anidride Solforosa.mp3",
		tags: songTags{Title: "Track 02", Artist: "Unknown Artist"}}
	s.computeTags(root, nil)
	if s.final.Artist != "Lucio Dalla" || s.final.Title != "Anidride Solforosa" || s.final.Album != "Anidride Solforosa" ||
		s.final.Year != 1975 || s.final.Track != 2 || s.incomplete {
		t.Errorf("tag ricavati: %+v", s.final)
	}
	s = &song{path: "/chiavetta/x.mp3", tags: songTags{Title: "Queen - Bohemian Rhapsody"}}
	s.computeTags(root, nil)
	if s.final.Artist != "Queen" || s.final.Title != "Bohemian Rhapsody" {
		t.Errorf("artista nel titolo: %+v", s.final)
	}
	s = &song{path: "/chiavetta/y.mp3", tags: songTags{Title: "01 - Queen - Innuendo", Artist: "Queen"}}
	s.computeTags(root, nil)
	if s.final.Title != "Innuendo" || s.final.Track != 1 {
		t.Errorf("numero e artista nel titolo: %+v", s.final)
	}
}

func TestID3v1(t *testing.T) {
	v1 := buildID3v1(songTags{Title: "Città di notte", Artist: "Artista con un nome lunghissimo oltre trenta", Year: 2001, Track: 7, Genre: "Rock"})
	got, ok := readID3v1(v1)
	if !ok || got.Title != "Città di notte" || got.Artist != "Artista con un nome lunghissim" || got.Year != 2001 || got.Track != 7 || got.Genre != "Rock" {
		t.Errorf("ID3v1 riletto: %+v", got)
	}
}

func TestNormalizeCover(t *testing.T) {
	big := testJPEG(t, 1200, 900)
	n, err := normalizeCover(big)
	if err != nil {
		t.Fatal(err)
	}
	cfg, format, _ := image.DecodeConfig(bytes.NewReader(n))
	if format != "jpeg" || cfg.Width != 600 || cfg.Height != 450 || isProgressiveJPEG(n) {
		t.Errorf("copertina %s %dx%d", format, cfg.Width, cfg.Height)
	}
	small := testJPEG(t, 300, 300)
	if n, _ := normalizeCover(small); !bytes.Equal(n, small) {
		t.Error("una copertina già adatta non va ricodificata")
	}
}
