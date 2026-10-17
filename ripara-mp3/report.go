package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

//go:embed elenco_template.html
var elencoTemplate string

type reportSong struct {
	File       string `json:"f"`
	Title      string `json:"t"`
	Artist     string `json:"a,omitempty"`
	Album      string `json:"al,omitempty"`
	Year       int    `json:"y,omitempty"`
	Track      int    `json:"n,omitempty"`
	Duration   int    `json:"d"`
	Kbps       int    `json:"b,omitempty"`
	Size       int64  `json:"s"`
	Status     string `json:"st"`
	Note       string `json:"no,omitempty"`
	Cover      string `json:"c,omitempty"`
	Incomplete bool   `json:"inc,omitempty"`
}

// reportStatus restituisce lo stato effettivo del brano dopo le modifiche e
// una nota per chi legge l'elenco.
func reportStatus(s *song) (string, string) {
	problems := ""
	if s.info != nil && len(s.info.Problems) > 0 {
		problems = strings.Join(s.info.Problems, "; ")
	}
	if s.err != "" && (s.status == stHD || s.status == stRip) {
		return stBad, "Non è stato possibile sostituirlo: " + s.err + ". Problemi: " + problems + "."
	}
	switch s.status {
	case stHD:
		return stHD, "Sostituito con la copia sana trovata in " + s.hdPath + "."
	case stRip:
		return stRip, "Tolte le parti rovinate (" + humanBytes(int64(s.removed)) + "): " + problems + "."
	case stBad:
		return stBad, capitalizeFirst(problems) + ". Copia sana non trovata sull'hard disk."
	case stAlt:
		return stAlt, "Il file è in formato " + s.info.Format + " anche se ha l'estensione .mp3: non è stato modificato."
	}
	if s.err != "" {
		return s.status, "Non è stato possibile aggiornarlo: " + s.err + "."
	}
	return stOK, ""
}

func relURL(root, path string) string {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		rel = filepath.Base(path)
	}
	parts := strings.Split(filepath.ToSlash(rel), "/")
	for i, p := range parts {
		parts[i] = url.PathEscape(p)
	}
	return strings.Join(parts, "/")
}

func writeReport(root string, songs []*song, covers *coverStore, now time.Time) (string, error) {
	type data struct {
		Generated string            `json:"generated"`
		Songs     []reportSong      `json:"songs"`
		Covers    map[string]string `json:"covers"`
		Dups      int               `json:"dups"`
	}
	d := data{
		Generated: fmt.Sprintf("%s alle %s", now.Format("02/01/2006"), now.Format("15:04")),
		Songs:     []reportSong{},
		Covers:    map[string]string{},
	}
	for _, s := range songs {
		if s.dup && s.err == "" {
			d.Dups++
			continue
		}
		st, note := reportStatus(s)
		in := s.outInfo
		if in == nil {
			in = s.info
		}
		rs := reportSong{
			File:       relURL(root, s.path),
			Title:      s.final.Title,
			Artist:     s.final.Artist,
			Album:      s.final.Album,
			Year:       s.final.Year,
			Track:      s.final.Track,
			Size:       s.size,
			Status:     st,
			Note:       note,
			Incomplete: s.incomplete && st != stAlt,
		}
		if rs.Title == "" {
			rs.Title = strings.TrimSuffix(filepath.Base(s.path), filepath.Ext(s.path))
		}
		if in != nil {
			rs.Duration = int(in.Duration + 0.5)
			rs.Kbps = in.Bitrate
		}
		if s.coverID != "" && st != stAlt {
			if t := covers.thumb(s.coverID); t != "" {
				d.Covers[s.coverID] = t
				rs.Cover = s.coverID
			}
		}
		d.Songs = append(d.Songs, rs)
	}
	js, err := json.Marshal(d)
	if err != nil {
		return "", err
	}
	html := strings.Replace(elencoTemplate, "/*DATI*/", string(js), 1)
	out := filepath.Join(root, "elenco.html")
	return out, os.WriteFile(out, []byte(html), 0o644)
}

// --- Registro delle operazioni ---------------------------------------------------

type logger struct {
	lines []string
}

func (l *logger) add(kind, format string, args ...any) {
	l.lines = append(l.lines, fmt.Sprintf("%-11s %s", "["+kind+"]", fmt.Sprintf(format, args...)))
}

func (l *logger) save(path string, header string) error {
	var sb strings.Builder
	isNew := !exists(path)
	if isNew {
		sb.WriteString("\xEF\xBB\xBF")
	} else {
		sb.WriteString("\r\n")
	}
	sb.WriteString(header + "\r\n")
	sb.WriteString(strings.Repeat("=", len([]rune(header))) + "\r\n")
	for _, ln := range l.lines {
		sb.WriteString(ln + "\r\n")
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.WriteString(sb.String()); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
