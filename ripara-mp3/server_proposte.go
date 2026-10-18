package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Playlist proposte per somiglianza: prima i gruppi dai dati certi
// (decennio, genere, lingua, ritmo), poi quelli inventati da un'AI gratuita
// (Gemini, con Groq di riserva) che vede solo artisti, titoli e anni.

const uaBrowser = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"

type aiClient struct {
	gemini, groq       string
	geminiURL, groqURL string
	geminiModels       []string
	groqModels         []string
	http               *http.Client
}

func newAIClient(gemini, groq string) *aiClient {
	return &aiClient{gemini: gemini, groq: groq,
		geminiURL:    "https://generativelanguage.googleapis.com/v1beta",
		groqURL:      "https://api.groq.com/openai/v1",
		geminiModels: []string{"gemini-3.8-flash", "gemini-flash-latest"},
		groqModels:   []string{"openai/gpt-oss-120b", "openai/gpt-oss-20b"},
		http:         &http.Client{Timeout: 150 * time.Second}}
}

func (c *aiClient) configured() bool { return c != nil && (c.gemini != "" || c.groq != "") }

type aiHTTPError struct {
	status int
	msg    string
}

func (e *aiHTTPError) Error() string { return fmt.Sprintf("risposta %d: %s", e.status, e.msg) }

func (c *aiClient) post(url string, headers map[string]string, body any, out any) error {
	js, _ := json.Marshal(body)
	req, err := http.NewRequest("POST", url, bytes.NewReader(js))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode != http.StatusOK {
		msg := string(data)
		if len(msg) > 300 {
			msg = msg[:300]
		}
		return &aiHTTPError{resp.StatusCode, msg}
	}
	return json.Unmarshal(data, out)
}

func (c *aiClient) askGemini(model, prompt string) (string, error) {
	var res struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}
	body := map[string]any{
		"contents":         []any{map[string]any{"role": "user", "parts": []any{map[string]string{"text": prompt}}}},
		"generationConfig": map[string]any{"responseMimeType": "application/json", "temperature": 0.7},
	}
	if err := c.post(c.geminiURL+"/models/"+model+":generateContent", map[string]string{"x-goog-api-key": c.gemini}, body, &res); err != nil {
		return "", err
	}
	var sb strings.Builder
	for _, cand := range res.Candidates {
		for _, p := range cand.Content.Parts {
			sb.WriteString(p.Text)
		}
		break
	}
	if sb.Len() == 0 {
		return "", errors.New("risposta vuota")
	}
	return sb.String(), nil
}

func (c *aiClient) askGroq(model, prompt string) (string, error) {
	var res struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	body := map[string]any{"model": model, "temperature": 0.7, "response_format": map[string]string{"type": "json_object"},
		"messages": []any{map[string]string{"role": "user", "content": prompt}}}
	// Cloudflare davanti a Groq rifiuta gli User-Agent dei programmi (errore 1010)
	h := map[string]string{"Authorization": "Bearer " + c.groq, "User-Agent": uaBrowser}
	if err := c.post(c.groqURL+"/chat/completions", h, body, &res); err != nil {
		return "", err
	}
	if len(res.Choices) == 0 || res.Choices[0].Message.Content == "" {
		return "", errors.New("risposta vuota")
	}
	return res.Choices[0].Message.Content, nil
}

// ask prova Gemini e poi Groq; un modello sparito (404) passa al successivo.
func (c *aiClient) ask(prompt string) (string, string, error) {
	var errs []string
	try := func(name string, models []string, f func(string, string) (string, error)) (string, string, bool) {
		for _, m := range models {
			txt, err := f(m, prompt)
			if err == nil {
				return txt, name + " " + m, true
			}
			errs = append(errs, name+" "+m+": "+err.Error())
			// modello sparito, quota finita o modello sovraccarico: si prova il prossimo
			var he *aiHTTPError
			if !errors.As(err, &he) || (he.status != 404 && he.status != 429 && he.status != 400 && he.status != 503) {
				break
			}
		}
		return "", "", false
	}
	if c.gemini != "" {
		if txt, eng, ok := try("Gemini", c.geminiModels, c.askGemini); ok {
			return txt, eng, nil
		}
	}
	if c.groq != "" {
		if txt, eng, ok := try("Groq", c.groqModels, c.askGroq); ok {
			return txt, eng, nil
		}
	}
	if len(errs) == 0 {
		return "", "", errors.New("nessuna AI configurata")
	}
	return "", "", errors.New(strings.Join(errs, "; "))
}

// --- Gruppi -------------------------------------------------------------------------------

var genreNames = map[string]string{
	"films/games": "Colonne sonore", "film/games": "Colonne sonore", "soundtrack": "Colonne sonore",
	"latin music": "Musica latina", "classical": "Classica", "kids": "Per bambini", "rap/hip hop": "Rap e hip hop",
	"soul & funk": "Soul e funk", "electro": "Elettronica", "alternative": "Alternative", "dance": "Dance",
	"pop": "Pop", "rock": "Rock", "jazz": "Jazz", "metal": "Metal", "blues": "Blues", "country": "Country",
	"reggae": "Reggae", "r&b": "R&B", "folk": "Folk", "musica italiana": "Musica italiana", "italian music": "Musica italiana",
}

func genreLabel(g string) string {
	k := strings.ToLower(strings.TrimSpace(g))
	if l, ok := genreNames[k]; ok {
		return l
	}
	return capitalizeFirst(strings.TrimSpace(g))
}

func decadeName(d int) string {
	if d < 2000 {
		return fmt.Sprintf("Anni %d", d%100)
	}
	return fmt.Sprintf("Anni %d", d)
}

func jaccard(a, b []string) float64 {
	set := map[string]bool{}
	for _, x := range a {
		set[x] = true
	}
	inter := 0
	seen := map[string]bool{}
	for _, x := range b {
		if set[x] && !seen[x] {
			inter++
		}
		seen[x] = true
	}
	union := len(set) + len(seen) - inter
	if union == 0 {
		return 0
	}
	return float64(inter) / float64(union)
}

// dataGroups: i gruppi che si ricavano dai dati certi.
func dataGroups(list []*brano) []*proposta {
	byDec := map[int][]string{}
	byGenre := map[string][]string{}
	var it, other, slow []string
	for _, b := range list {
		if b.Anno > 1900 {
			d := b.Anno / 10 * 10
			byDec[d] = append(byDec[d], b.ID)
		}
		if g := genreLabel(b.genere()); g != "" {
			byGenre[g] = append(byGenre[g], b.ID)
		}
		switch b.Lingua {
		case "it":
			it = append(it, b.ID)
		case "altro":
			other = append(other, b.ID)
		}
		if b.BPM > 0 && b.BPM < 90 {
			slow = append(slow, b.ID)
		}
	}
	var out []*proposta
	add := func(name, desc string, ids []string) {
		if len(ids) >= 8 {
			out = append(out, &proposta{Nome: name, Descrizione: desc, Brani: ids, Fonte: "dati"})
		}
	}
	decs := make([]int, 0, len(byDec))
	for d := range byDec {
		decs = append(decs, d)
	}
	sort.Ints(decs)
	for _, d := range decs {
		add(decadeName(d), fmt.Sprintf("I brani usciti dal %d al %d.", d, d+9), byDec[d])
	}
	genres := make([]string, 0, len(byGenre))
	for g := range byGenre {
		genres = append(genres, g)
	}
	sort.Strings(genres)
	for _, g := range genres {
		if len(byGenre[g]) < len(list) { // un genere che contiene tutto non aiuta
			add(g, "Brani di genere "+strings.ToLower(g)+".", byGenre[g])
		}
	}
	add("Italiane", "Le canzoni in italiano.", it)
	add("Straniere", "Le canzoni non in italiano.", other)
	add("Lenti", "Brani dal ritmo lento, meno di 90 battiti al minuto.", slow)
	return out
}

func aiPrompt(list []*brano) string {
	var sb strings.Builder
	sb.WriteString("Sei un esperto di musica. Ecco i brani di una chiavetta per l'autoradio, uno per riga, nel formato ")
	sb.WriteString("numero|artista|titolo|anno|genere|lingua|bpm (i campi vuoti non sono noti).\n\n")
	for i, b := range list {
		bpm := ""
		if b.BPM > 0 {
			bpm = strconv.Itoa(int(b.BPM + 0.5))
		}
		anno := ""
		if b.Anno > 0 {
			anno = strconv.Itoa(b.Anno)
		}
		fmt.Fprintf(&sb, "%d|%s|%s|%s|%s|%s|%s\n", i+1, b.Artista, b.Titolo, anno, b.genere(), b.Lingua, bpm)
	}
	sb.WriteString("\nProponi da 6 a 12 playlist a tema che mettano insieme brani simili: per atmosfera, genere, epoca, ")
	sb.WriteString("lingua o occasione (per esempio «Cantautori anni 70», «Da cantare in macchina», «Lenti», «Rock energico»). ")
	sb.WriteString("Ogni playlist deve avere da 8 a 40 brani; lo stesso brano può stare in più playlist. Usa solo i numeri dell'elenco. ")
	sb.WriteString("Il nome è in italiano, al massimo 30 caratteri; la descrizione è una frase breve che spiega cosa hanno in comune i brani. ")
	sb.WriteString(`Rispondi solo con JSON in questa forma: {"playlist":[{"nome":"...","descrizione":"...","brani":[1,2,3]}]}`)
	return sb.String()
}

// parseAIGroups legge la risposta dell'AI; i numeri tornano identificativi.
func parseAIGroups(txt string, list []*brano) ([]*proposta, error) {
	txt = strings.TrimSpace(txt)
	txt = strings.TrimPrefix(strings.TrimSuffix(strings.TrimPrefix(txt, "```json"), "```"), "```")
	if i := strings.IndexByte(txt, '{'); i > 0 {
		txt = txt[i:]
	}
	var res struct {
		Playlist []struct {
			Nome        string            `json:"nome"`
			Descrizione string            `json:"descrizione"`
			Brani       []json.RawMessage `json:"brani"`
		} `json:"playlist"`
	}
	if err := json.Unmarshal([]byte(txt), &res); err != nil {
		return nil, fmt.Errorf("risposta dell'AI non valida: %v", err)
	}
	var out []*proposta
	for _, p := range res.Playlist {
		pr := &proposta{Nome: limit(p.Nome, 40), Descrizione: limit(p.Descrizione, 200), Fonte: "ai"}
		for _, raw := range p.Brani {
			var n int
			if json.Unmarshal(raw, &n) != nil {
				var s string
				if json.Unmarshal(raw, &s) != nil {
					continue
				}
				n, _ = strconv.Atoi(strings.TrimSpace(s))
			}
			if n >= 1 && n <= len(list) {
				pr.Brani = append(pr.Brani, list[n-1].ID)
			}
		}
		out = append(out, pr)
	}
	return out, nil
}

// cleanProposals toglie doppioni e gruppi troppo piccoli o uguali a
// playlist che ci sono già.
func cleanProposals(cands []*proposta, existing [][]string, existingNames map[string]bool) []*proposta {
	var out []*proposta
	names := map[string]bool{}
	for k := range existingNames {
		names[k] = true
	}
	for _, p := range cands {
		seen := map[string]bool{}
		var ids []string
		for _, id := range p.Brani {
			if !seen[id] {
				seen[id] = true
				ids = append(ids, id)
			}
		}
		p.Brani = ids
		if len(ids) < 6 || strings.TrimSpace(p.Nome) == "" {
			continue
		}
		dup := false
		for _, o := range out {
			if jaccard(o.Brani, ids) > 0.8 {
				dup = true
			}
		}
		for _, e := range existing {
			if jaccard(e, ids) > 0.8 {
				dup = true
			}
		}
		if dup {
			continue
		}
		base := strings.TrimSpace(p.Nome)
		name := base
		for i := 2; names[strings.ToLower(safeFileName(name, 60))]; i++ {
			name = base + " " + strconv.Itoa(i)
		}
		names[strings.ToLower(safeFileName(name, 60))] = true
		p.Nome = name
		p.ID = newID("pr_")
		p.Stato = "nuova"
		out = append(out, p)
		if len(out) >= 20 {
			break
		}
	}
	return out
}

func (s *server) generaProposte() {
	s.setActivity("Preparo le playlist proposte", 0, 0)
	s.mu.Lock()
	var list []*brano
	seen := map[string]bool{}
	var existing [][]string
	existingNames := map[string]bool{}
	for _, p := range s.lib.Playlist {
		existing = append(existing, append([]string(nil), p.Brani...))
		existingNames[strings.ToLower(safeFileName(p.Nome, 60))] = true
		for _, id := range p.Brani {
			if b := s.lib.Brani[id]; b != nil && !seen[id] {
				seen[id] = true
				c := *b
				list = append(list, &c)
			}
		}
	}
	s.mu.Unlock()
	sort.Slice(list, func(i, j int) bool { return list[i].nome() < list[j].nome() })
	if len(list) > 1500 {
		list = list[:1500]
	}
	res := statoProposte{Create: time.Now()}
	if len(list) < 8 {
		res.Errore = "Servono almeno 8 brani nelle playlist per proporne di nuove."
	} else {
		var cands []*proposta
		if s.ai.configured() {
			s.setActivity("Chiedo all'AI di raggruppare i brani", 0, 0)
			txt, engine, err := s.ai.ask(aiPrompt(list))
			if err == nil {
				var groups []*proposta
				if groups, err = parseAIGroups(txt, list); err == nil {
					cands = append(cands, groups...)
					res.Motore = engine
				}
			}
			if err != nil {
				log.Printf("proposte: AI non disponibile: %v", err)
				res.Errore = "L'AI non ha risposto: ci sono solo i gruppi ricavati dai dati."
			}
		}
		cands = append(cands, dataGroups(list)...)
		res.Lista = cleanProposals(cands, existing, existingNames)
	}
	s.mu.Lock()
	s.proposte = res
	s.saveProposte()
	s.mu.Unlock()
}
