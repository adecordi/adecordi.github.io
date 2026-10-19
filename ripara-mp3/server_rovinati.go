package main

import (
	"net/http"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// I brani rovinati senza una copia sana: quanto sono rovinati e dove
// ritrovarli (una ricerca su YouTube, per riconoscerli e riascoltarli).

type voceRovinato struct {
	Brano     string   `json:"brano"`
	PL        string   `json:"pl"`
	Playlist  string   `json:"playlist"`
	Nome      string   `json:"nome"`
	File      string   `json:"file,omitempty"` // com'è adesso sulla chiavetta
	Chiavetta string   `json:"chiavetta,omitempty"`
	Gravita   int      `json:"gravita"` // -1 = non c'è nessun file, nemmeno rovinato
	Problemi  []string `json:"problemi,omitempty"`
	YouTube   string   `json:"youtube"`
}

var (
	reDatiRovinati = regexp.MustCompile(`(\d+(?:,\d+)?) (byte|KB|MB|GB)\b`)
	reMancano      = regexp.MustCompile(`mancano circa (\d+) (s|min|h)\b`)
)

// gravitaDanno dice quanto è rovinato un file dai problemi trovati da
// analyzeMP3: 0 poco (al massimo un disturbo), 1 abbastanza (qualche salto),
// 2 molto (pezzi che mancano). Contano i dati non validi (16 KB sono circa un
// secondo a 128 kbps), l'inizio rovinato e la fine che manca.
func gravitaDanno(problemi []string) int {
	kb, g := 0.0, 0
	for _, p := range problemi {
		for _, m := range reDatiRovinati.FindAllStringSubmatch(p, -1) {
			n, _ := strconv.ParseFloat(strings.Replace(m[1], ",", ".", 1), 64)
			kb += n * map[string]float64{"byte": 1.0 / 1024, "KB": 1, "MB": 1024, "GB": 1 << 20}[m[2]]
		}
		if m := reMancano.FindStringSubmatch(p); m != nil {
			if n, _ := strconv.Atoi(m[1]); m[2] != "s" || n >= 5 {
				g = 2
			}
		}
		if strings.HasPrefix(p, "inizio del file") {
			g = max(g, 1)
		}
	}
	switch {
	case kb > 128:
		return 2
	case kb > 16:
		return max(g, 1)
	}
	return g
}

var reNonCercare = regexp.MustCompile(`(?i)\([^)]*(official|video|lyric|testo|audio|cdq|\bhd\b|\bhq\b|\d{4}|2o1\d)[^)]*\)`)

// ricercaYouTube è il link alla ricerca del brano su YouTube. Senza artista
// il titolo è spesso spazzatura («09 Traccia 9»): meglio il nome del file.
func ricercaYouTube(b *brano, file string) string {
	q := b.Artista + " " + b.Titolo
	if b.Artista == "" && file != "" {
		q = strings.ReplaceAll(strings.TrimSuffix(path.Base(file), path.Ext(file)), "_", " ")
	}
	q = strings.Join(strings.Fields(reNonCercare.ReplaceAllString(q, " ")), " ")
	return "https://www.youtube.com/results?search_query=" + url.QueryEscape(q)
}

// fileDiBranoLocked trova un file di ogni brano sulle chiavette lette,
// prima su quella delle playlist.
func (s *server) fileDiBranoLocked() map[string]*fileChiavetta {
	vols := make([]string, 0, len(s.chiav))
	for v := range s.chiav {
		vols = append(vols, v)
	}
	sort.Slice(vols, func(i, j int) bool {
		if (vols[i] == s.lib.Chiavetta) != (vols[j] == s.lib.Chiavetta) {
			return vols[i] == s.lib.Chiavetta
		}
		return vols[i] < vols[j]
	})
	out := map[string]*fileChiavetta{}
	for _, v := range vols {
		st := s.chiav[v]
		for i := range st.File {
			f := &st.File[i]
			if id := st.Legami[f.P]; id != "" && (out[id] == nil || (out[id].Rov && !f.Rov)) {
				out[id] = f
			}
		}
	}
	return out
}

func (s *server) apiDamaged(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.planLocked()
	files := s.fileDiBranoLocked()
	labels := map[*fileChiavetta]string{}
	for _, st := range s.chiav {
		for i := range st.File {
			labels[&st.File[i]] = st.Unita.nome()
		}
	}
	order := map[string]int{}
	names := map[string]string{}
	for i, pl := range s.lib.Playlist {
		order[pl.ID], names[pl.ID] = i, pl.Nome
	}
	out := []voceRovinato{}
	for _, row := range p.Righe {
		b := s.lib.Brani[row.Brano]
		if b == nil || (row.Stato != stRovinato && row.Stato != stManca) {
			continue
		}
		v := voceRovinato{Brano: b.ID, PL: row.Playlist, Playlist: names[row.Playlist], Nome: b.nome(), Gravita: -1}
		if b.Anno > 0 && b.Artista != "" {
			v.Nome += " (" + strconv.Itoa(b.Anno) + ")"
		}
		if f := files[b.ID]; f != nil {
			v.File, v.Chiavetta, v.Problemi = f.P, labels[f], f.Problemi
			if f.Rov {
				v.Gravita = gravitaDanno(f.Problemi)
			}
			if b.Artista == "" {
				v.Nome = strings.TrimSuffix(path.Base(f.P), path.Ext(f.P))
			}
		}
		v.YouTube = ricercaYouTube(b, v.File)
		out = append(out, v)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].PL != out[j].PL {
			return order[out[i].PL] < order[out[j].PL]
		}
		return strings.ToLower(out[i].Nome) < strings.ToLower(out[j].Nome)
	})
	writeJSON(w, http.StatusOK, map[string]any{"brani": out})
}
