package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Riconoscimento "come Shazam": il telefono registra qualche secondo dal
// microfono, il sito lo converte con ffmpeg e lo passa a songrec, che usa
// lo stesso servizio dell'app Shazam.

type shazamState struct {
	mu   sync.Mutex
	last time.Time
	hour []time.Time
}

var (
	shazamMinGap  = 5 * time.Second
	shazamPerHour = 30
)

type risultatoShazam struct {
	Trovato    bool          `json:"trovato"`
	Artista    string        `json:"artista,omitempty"`
	Titolo     string        `json:"titolo,omitempty"`
	Album      string        `json:"album,omitempty"`
	Anno       int           `json:"anno,omitempty"`
	Genere     string        `json:"genere,omitempty"`
	ISRC       string        `json:"isrc,omitempty"`
	Chiave     string        `json:"chiave,omitempty"`
	Copertina  string        `json:"copertina,omitempty"`
	Dischi     []voceDisco   `json:"dischi,omitempty"`
	InLibreria []voceLibrary `json:"in_libreria,omitempty"`
	Messaggio  string        `json:"messaggio,omitempty"`
	Offset     float64       `json:"offset,omitempty"` // dove era la canzone (secondi) nel pezzo ascoltato
	coverURL   string
}

// parseShazam legge il JSON di songrec (la risposta di Shazam).
func parseShazam(out []byte) (*risultatoShazam, error) {
	var d struct {
		Matches []struct {
			Offset float64 `json:"offset"`
		} `json:"matches"`
		Track *struct {
			Key      string `json:"key"`
			Title    string `json:"title"`
			Subtitle string `json:"subtitle"`
			ISRC     string `json:"isrc"`
			Genres   struct {
				Primary string `json:"primary"`
			} `json:"genres"`
			Images struct {
				Coverart   string `json:"coverart"`
				Coverarthq string `json:"coverarthq"`
			} `json:"images"`
			Sections []struct {
				Type     string `json:"type"`
				Metadata []struct {
					Title string `json:"title"`
					Text  string `json:"text"`
				} `json:"metadata"`
			} `json:"sections"`
		} `json:"track"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(out), &d); err != nil {
		return nil, err
	}
	r := &risultatoShazam{}
	t := d.Track
	if t == nil || t.Title == "" || t.Subtitle == "" || t.Key == "" {
		return r, nil
	}
	r.Trovato = true
	if len(d.Matches) > 0 {
		r.Offset = d.Matches[0].Offset
	}
	r.Artista, r.Titolo, r.Chiave, r.ISRC, r.Genere = t.Subtitle, t.Title, t.Key, t.ISRC, t.Genres.Primary
	r.coverURL = t.Images.Coverarthq
	if r.coverURL == "" {
		r.coverURL = t.Images.Coverart
	}
	for _, sec := range t.Sections {
		if sec.Type != "SONG" {
			continue
		}
		for _, m := range sec.Metadata {
			switch m.Title {
			case "Album":
				r.Album = m.Text
			case "Released":
				if len(m.Text) >= 4 {
					r.Anno, _ = strconv.Atoi(m.Text[:4])
				}
			}
		}
	}
	return r, nil
}

var errTooMany = errors.New("troppi riconoscimenti in poco tempo: riprova fra qualche minuto")

// shazamOf converte la registrazione e la fa riconoscere.
func (s *server) shazamOf(audio []byte) (*risultatoShazam, error) {
	sh := &s.shazam
	sh.mu.Lock()
	defer sh.mu.Unlock()
	var keep []time.Time
	for _, t := range sh.hour {
		if time.Since(t) < time.Hour {
			keep = append(keep, t)
		}
	}
	sh.hour = keep
	if len(keep) >= shazamPerHour {
		return nil, errTooMany
	}
	if d := shazamMinGap - time.Since(sh.last); d > 0 {
		time.Sleep(d)
	}
	sh.last = time.Now()
	sh.hour = append(sh.hour, sh.last)

	dir := s.path("tmp")
	os.MkdirAll(dir, 0o700)
	in := dir + "/" + newID("audio_")
	wav := in + ".wav"
	defer os.Remove(in)
	defer os.Remove(wav)
	if err := os.WriteFile(in, audio, 0o600); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(ctx, "ffmpeg", "-nostdin", "-v", "error", "-y", "-i", in, "-ss", "0.3", "-t", "14",
		"-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", wav).CombinedOutput(); err != nil {
		return nil, errors.New("non riesco a leggere la registrazione: " + strings.TrimSpace(limit(string(out), 200)))
	}
	ctx2, cancel2 := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel2()
	cmd := exec.CommandContext(ctx2, s.o.songrec, "audio-file-to-recognized-song", wav)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	runErr := cmd.Run()
	r, err := parseShazam(stdout.Bytes())
	if err != nil {
		msg := strings.ToLower(stderr.String())
		if strings.Contains(msg, "429") || strings.Contains(msg, "rate") {
			return nil, errors.New("Shazam è occupato: riprova fra un minuto")
		}
		if runErr != nil {
			return nil, errors.New("il riconoscimento non ha funzionato: " + limit(strings.TrimSpace(stderr.String()), 200))
		}
		return nil, errors.New("il riconoscimento non ha funzionato")
	}
	return r, nil
}

// riconosci fa riconoscere la registrazione e cerca il brano sui dischi e
// nelle playlist; anno e copertina vengono, se possibile, da MusicBrainz e
// dalle copertine ufficiali come per gli altri brani.
func (s *server) riconosci(audio []byte) (*risultatoShazam, error) {
	r, err := s.shazamOf(audio)
	if err != nil {
		return nil, err
	}
	if !r.Trovato {
		r.Messaggio = "Non ho riconosciuto il brano. Avvicina il telefono alla musica e riprova, oppure cercalo per nome."
		return r, nil
	}
	if mr, err := s.mb.lookup(r.Artista, r.Titolo, 0); err == nil && mr.Found {
		if mr.Year > 0 && (r.Anno == 0 || mr.Year < r.Anno) {
			r.Anno = mr.Year
		}
		if mr.Album != "" && !mr.AlbumIsComp {
			r.Album = mr.Album
		}
	}
	if r.Album != "" {
		if img, _ := s.art.albumCover(r.Artista, r.Album, "", ""); img != nil {
			r.Copertina = s.covers.add(img)
		}
	}
	if r.Copertina == "" && r.coverURL != "" {
		if img := s.art.download(r.coverURL); img != nil {
			r.Copertina = s.covers.add(img)
		}
	}
	s.mu.Lock()
	r.Dischi = s.diskHitsLocked(s.ricerca.candidati(r.Artista, r.Titolo, r.Album, 0), 5)
	r.InLibreria = s.libraryHitsLocked(pairKey(r.Artista, r.Titolo), "", 5)
	s.mu.Unlock()
	return r, nil
}
