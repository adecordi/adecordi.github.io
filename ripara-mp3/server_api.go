package main

import (
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Le richieste del sito (dal browser, dopo la portineria).

func (s *server) apiRoutes(mux *http.ServeMux) {
	h := func(pattern string, f http.HandlerFunc) { mux.HandleFunc(pattern, s.csrf(f)) }
	h("GET /api/stato", s.apiStato)
	h("GET /api/playlist", s.apiPlaylists)
	h("POST /api/playlist", s.apiNewPlaylist)
	h("GET /api/playlist/{id}", s.apiPlaylist)
	h("PATCH /api/playlist/{id}", s.apiEditPlaylist)
	h("DELETE /api/playlist/{id}", s.apiDeletePlaylist)
	h("POST /api/playlist/{id}/brani", s.apiAddSong)
	h("POST /api/playlist/{id}/togli", s.apiRemoveSongs)
	h("POST /api/playlist/{id}/ordine", s.apiOrder)
	h("POST /api/playlist/{id}/sposta", s.apiMove)
	h("GET /api/brani/{id}", s.apiSong)
	h("PATCH /api/brani/{id}", s.apiEditSong)
	h("GET /api/cerca", s.apiSearch)
	h("POST /api/riconosci", s.apiRecognize)
	h("GET /api/lavori", s.apiJobs)
	h("POST /api/lavori", s.apiNewJob)
	h("POST /api/lavori/{id}/annulla", s.apiCancelJob)
	h("GET /api/importa", s.apiImportPreview)
	h("POST /api/importa", s.apiImport)
	h("POST /api/rianalizza", s.apiReanalyze)
	h("GET /api/piano", s.apiPlan)
	h("POST /api/piano/{id}/conferma", s.apiConfirm)
	h("GET /api/proposte", s.apiProposals)
	h("POST /api/proposte/genera", s.apiGenerate)
	h("POST /api/proposte/{id}/accetta", s.apiAccept)
	h("POST /api/proposte/{id}/scarta", s.apiDiscard)
	h("GET /api/agenti", s.apiAgents)
	h("POST /api/agenti/abbina", s.apiPair)
	h("POST /api/agenti/biglietto", s.apiTicket)
	h("DELETE /api/agenti/{id}", s.apiRevoke)
	h("GET /api/programma", s.apiProgram)
	h("POST /api/chiavetta/usa", s.apiUseStick)
	h("PATCH /api/impostazioni", s.apiSettings)
	h("GET /api/testo", s.apiLyrics)
}

// apiUseStick sceglie la chiavetta su cui vanno le playlist (per esempio una
// nuova al posto di quella vecchia che si rovina).
func (s *server) apiUseStick(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Volume string `json:"volume"`
	}
	if err := readBody(r, &req, 4<<10); err != nil || req.Volume == "" {
		fail(w, http.StatusBadRequest, "richiesta non valida")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	known := s.chiav[req.Volume] != nil
	if ag := s.mainAgent(); ag != nil {
		for _, u := range ag.Unita {
			if u.Volume == req.Volume && u.Rimovibile {
				known = true
			}
		}
	}
	if !known {
		fail(w, http.StatusNotFound, "Chiavetta sconosciuta: attaccala al PC e riprova.")
		return
	}
	s.lib.Chiavetta = req.Volume
	s.relinkAllLocked()
	s.saveLib()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *server) apiSettings(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Formato string `json:"formato"`
	}
	if err := readBody(r, &req, 4<<10); err != nil || (req.Formato != formatoTesla && req.Formato != formatoClassico) {
		fail(w, http.StatusBadRequest, "richiesta non valida")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lib.Formato = req.Formato
	s.saveLib()
	writeJSON(w, http.StatusOK, map[string]string{"formato": req.Formato})
}

// csrf: le richieste che cambiano qualcosa devono arrivare dalla pagina del
// sito (un'intestazione propria non si può mandare da un altro sito).
func (s *server) csrf(f http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Header.Get("X-Richiesta") != "1" {
			fail(w, http.StatusForbidden, "richiesta non consentita")
			return
		}
		f(w, r)
	}
}

// --- Stato generale ---------------------------------------------------------------------------

type vistaUnita struct {
	Lettera     string `json:"lettera"`
	Etichetta   string `json:"etichetta,omitempty"`
	Volume      string `json:"volume"`
	Rimovibile  bool   `json:"rimovibile,omitempty"`
	Liberi      uint64 `json:"liberi,omitempty"`
	Dimensione  uint64 `json:"dimensione,omitempty"`
	Indicizzato string `json:"indicizzato,omitempty"`
	File        int    `json:"file,omitempty"`
	Giusta      bool   `json:"giusta,omitempty"` // la chiavetta delle playlist
	Letta       string `json:"letta,omitempty"`  // quando il sito l'ha letta
}

type vistaLavoro struct {
	ID        string      `json:"id"`
	Tipo      string      `json:"tipo"`
	Stato     string      `json:"stato"`
	Avanz     avanzamento `json:"avanz"`
	Messaggio string      `json:"messaggio,omitempty"`
	Creato    string      `json:"creato"`
	Finito    string      `json:"finito,omitempty"`
	Esiti     int         `json:"esiti,omitempty"`
	Errori    int         `json:"errori,omitempty"`
}

func vistaDi(j *lavoroSrv) vistaLavoro {
	v := vistaLavoro{ID: j.ID, Tipo: j.Tipo, Stato: j.Stato, Avanz: j.Avanz, Messaggio: j.Messaggio, Creato: humanAge(j.Creato), Esiti: len(j.Esiti)}
	if !j.Finito.IsZero() {
		v.Finito = humanAge(j.Finito)
	}
	for _, e := range j.Esiti {
		if !e.OK {
			v.Errori++
		}
	}
	return v
}

func (s *server) recentJobsLocked(n int) []vistaLavoro {
	list := make([]*lavoroSrv, 0, len(s.lavori))
	for _, j := range s.lavori {
		list = append(list, j)
	}
	sort.Slice(list, func(a, b int) bool { return list[a].Creato.After(list[b].Creato) })
	out := []vistaLavoro{}
	for i, j := range list {
		if i >= n {
			break
		}
		out = append(out, vistaDi(j))
	}
	return out
}

func (s *server) apiStato(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]any{"versione": version, "attivita": s.attivita, "lavori": s.recentJobsLocked(8),
		"playlist": len(s.lib.Playlist), "brani": len(s.lib.Brani), "ai": s.ai.configured(), "acoustid": s.ac != nil,
		"sito": s.sito, "programma": s.o.exePath != "", "formato": map[bool]string{true: formatoTesla, false: formatoClassico}[s.lib.tesla()]}
	if ag := s.mainAgent(); ag != nil {
		v := map[string]any{"id": ag.ID, "nome": ag.Nome, "online": ag.online(), "visto": humanAge(ag.Visto), "versione": ag.Versione}
		var units []vistaUnita
		for _, u := range ag.Unita {
			vu := vistaUnita{Lettera: u.Lettera, Etichetta: u.Etichetta, Volume: u.Volume, Rimovibile: u.Rimovibile, Liberi: u.Liberi,
				Dimensione: u.Dimensione, Giusta: u.Volume == s.lib.Chiavetta}
			if iv := s.dischi[u.Volume]; iv != nil {
				vu.Indicizzato, vu.File = humanAge(iv.Aggiornato), len(iv.File)
			}
			if st := s.chiav[u.Volume]; st != nil {
				vu.Letta = humanAge(st.Letta)
				vu.File = 0
				for _, f := range st.File {
					if f.Fmt == "" {
						vu.File++
					}
				}
			}
			units = append(units, vu)
		}
		v["unita"] = units
		out["agente"] = v
	}
	if st := s.chiav[s.lib.Chiavetta]; st != nil {
		n := 0
		for _, f := range st.File {
			if f.Fmt == "" {
				n++
			}
		}
		out["chiavetta"] = map[string]any{"etichetta": st.Unita.nome(), "volume": st.Unita.Volume, "letta": humanAge(st.Letta),
			"file": n, "liberi": st.Unita.Liberi, "dimensione": st.Unita.Dimensione, "da_importare": s.toImportLocked("")}
	}
	// le altre chiavette lette, che si possono importare come playlist
	altre := []map[string]any{}
	for v, st := range s.chiav {
		if v == s.lib.Chiavetta {
			continue
		}
		n := 0
		for _, f := range st.File {
			if f.Fmt == "" {
				n++
			}
		}
		altre = append(altre, map[string]any{"etichetta": st.Unita.nome(), "volume": v, "letta": humanAge(st.Letta), "file": n,
			"da_importare": s.toImportLocked(v)})
	}
	sort.Slice(altre, func(a, b int) bool { return altre[a]["etichetta"].(string) < altre[b]["etichetta"].(string) })
	out["altre"] = altre
	var disks []vistaUnita
	for _, iv := range s.dischi {
		disks = append(disks, vistaUnita{Lettera: iv.Unita.Lettera, Etichetta: iv.Unita.Etichetta, Volume: iv.Unita.Volume,
			Indicizzato: humanAge(iv.Aggiornato), File: len(iv.File)})
	}
	sort.Slice(disks, func(a, b int) bool { return disks[a].Lettera < disks[b].Lettera })
	out["dischi"] = disks
	nuove := 0
	for _, p := range s.proposte.Lista {
		if p.Stato == "nuova" {
			nuove++
		}
	}
	out["proposte"] = nuove
	writeJSON(w, http.StatusOK, out)
}

// --- Playlist -----------------------------------------------------------------------------------

type vistaBrano struct {
	ID        string  `json:"id"`
	Artista   string  `json:"artista"`
	Titolo    string  `json:"titolo"`
	Album     string  `json:"album,omitempty"`
	Anno      int     `json:"anno,omitempty"`
	Durata    float64 `json:"durata,omitempty"`
	Copertina string  `json:"copertina,omitempty"`
	Stato     string  `json:"stato,omitempty"`
	Disco     string  `json:"disco,omitempty"`
	File      string  `json:"file,omitempty"`
	Origine   string  `json:"origine,omitempty"`
}

func vistaDiBrano(b *brano, row rigaPiano) vistaBrano {
	return vistaBrano{ID: b.ID, Artista: b.Artista, Titolo: b.Titolo, Album: b.Album, Anno: b.Anno, Durata: b.Durata,
		Copertina: b.Copertina, Stato: row.Stato, Disco: row.Disco, File: row.File, Origine: b.Origine}
}

func (s *server) apiPlaylists(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.planLocked()
	byPl := map[string]map[string]int{}
	for _, row := range p.Righe {
		if byPl[row.Playlist] == nil {
			byPl[row.Playlist] = map[string]int{}
		}
		byPl[row.Playlist][row.Stato]++
	}
	out := []map[string]any{}
	for _, pl := range s.lib.Playlist {
		var covers []string
		seen := map[string]bool{}
		counts := byPl[pl.ID]
		if pl.Tipo == tipoM3U {
			counts = map[string]int{}
			for _, id := range pl.Brani {
				counts[p.perBrano[id].Stato]++
			}
		}
		for _, id := range pl.Brani {
			if b := s.lib.Brani[id]; b != nil && b.Copertina != "" && !seen[b.Copertina] && len(covers) < 4 {
				seen[b.Copertina] = true
				covers = append(covers, b.Copertina)
			}
		}
		out = append(out, map[string]any{"id": pl.ID, "nome": pl.Nome, "tipo": pl.Tipo, "n": len(pl.Brani),
			"copertine": covers, "conteggi": counts, "descrizione": pl.Descrizione, "origine": pl.Origine})
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *server) apiNewPlaylist(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Nome  string   `json:"nome"`
		Tipo  string   `json:"tipo"`
		Brani []string `json:"brani"`
	}
	if err := readBody(r, &req, 1<<20); err != nil {
		fail(w, http.StatusBadRequest, "richiesta non valida")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tipo := tipoCartella
	if req.Tipo == tipoM3U {
		tipo = tipoM3U
	}
	pl := &playlist{ID: newID("p_"), Nome: s.uniqueNameLocked(limit(req.Nome, 60), ""), Tipo: tipo, Origine: "mano",
		Creata: time.Now(), Modificata: time.Now(), Brani: []string{}}
	for _, id := range req.Brani {
		if s.lib.Brani[id] != nil && !contains(pl.Brani, id) {
			pl.Brani = append(pl.Brani, id)
		}
	}
	s.lib.Playlist = append(s.lib.Playlist, pl)
	s.saveLib()
	writeJSON(w, http.StatusOK, map[string]string{"id": pl.ID, "nome": pl.Nome})
}

func (s *server) plOf(w http.ResponseWriter, r *http.Request) *playlist {
	pl := s.lib.playlistByID(r.PathValue("id"))
	if pl == nil {
		fail(w, http.StatusNotFound, "playlist non trovata")
	}
	return pl
}

func (s *server) apiPlaylist(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pl := s.plOf(w, r)
	if pl == nil {
		return
	}
	p := s.planLocked()
	rows := map[string]rigaPiano{}
	for _, row := range p.Righe {
		if row.Playlist == pl.ID {
			rows[row.Brano] = row
		}
	}
	songs := []vistaBrano{}
	for _, id := range pl.Brani {
		b := s.lib.Brani[id]
		if b == nil {
			continue
		}
		row, ok := rows[id]
		if !ok {
			row = p.perBrano[id]
		}
		songs = append(songs, vistaDiBrano(b, row))
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": pl.ID, "nome": pl.Nome, "tipo": pl.Tipo, "descrizione": pl.Descrizione,
		"origine": pl.Origine, "brani": songs})
}

func (s *server) apiEditPlaylist(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Nome        *string `json:"nome"`
		Tipo        *string `json:"tipo"`
		Descrizione *string `json:"descrizione"`
	}
	if err := readBody(r, &req, 64<<10); err != nil {
		fail(w, http.StatusBadRequest, "richiesta non valida")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	pl := s.plOf(w, r)
	if pl == nil {
		return
	}
	if req.Nome != nil && strings.TrimSpace(*req.Nome) != "" {
		pl.Nome = s.uniqueNameLocked(limit(*req.Nome, 60), pl.ID)
	}
	if req.Tipo != nil && (*req.Tipo == tipoCartella || *req.Tipo == tipoM3U) {
		pl.Tipo = *req.Tipo
	}
	if req.Descrizione != nil {
		pl.Descrizione = limit(*req.Descrizione, 200)
	}
	pl.Modificata = time.Now()
	s.saveLib()
	writeJSON(w, http.StatusOK, map[string]string{"id": pl.ID, "nome": pl.Nome})
}

func (s *server) apiDeletePlaylist(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pl := s.plOf(w, r)
	if pl == nil {
		return
	}
	var keep []*playlist
	for _, p := range s.lib.Playlist {
		if p != pl {
			keep = append(keep, p)
		}
	}
	s.lib.Playlist = keep
	s.saveLib()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// findSongLocked cerca nella libreria un brano con lo stesso artista e
// titolo (e durata simile), per non creare doppioni.
func (s *server) findSongLocked(artista, titolo string, durata float64) *brano {
	k := pairKey(artista, titolo)
	if k == "" {
		return nil
	}
	for _, b := range s.lib.Brani {
		if b.chiave() == k && (b.Durata == 0 || durata == 0 || math.Abs(b.Durata-durata) <= 5) {
			return b
		}
	}
	return nil
}

type richiestaAggiungi struct {
	Brano string `json:"brano,omitempty"`
	Disco *struct {
		Volume string `json:"volume"`
		P      string `json:"p"`
	} `json:"disco,omitempty"`
	Deezer int64            `json:"deezer,omitempty"`
	Shazam *risultatoShazam `json:"shazam,omitempty"`
	Nuovo  *struct {
		Artista string `json:"artista"`
		Titolo  string `json:"titolo"`
		Album   string `json:"album"`
		Anno    int    `json:"anno"`
	} `json:"nuovo,omitempty"`
}

func (s *server) apiAddSong(w http.ResponseWriter, r *http.Request) {
	var req richiestaAggiungi
	if err := readBody(r, &req, 64<<10); err != nil {
		fail(w, http.StatusBadRequest, "richiesta non valida")
		return
	}
	user := userOf(r)
	var nb *brano // brano nuovo da aggiungere alla libreria
	switch {
	case req.Deezer != 0:
		tr, err := s.art.deezerTrackByID(req.Deezer)
		if err != nil {
			fail(w, http.StatusBadGateway, "Deezer non ha risposto: riprova")
			return
		}
		title := tr.TitleShort
		if title == "" {
			title = tr.Title
		}
		nb = &brano{Artista: tr.Artist.Name, Titolo: title, Album: tr.Album.Title, Durata: float64(tr.Duration),
			DeezerID: tr.ID, ISRC: tr.ISRC, BPM: tr.BPM, Origine: "deezer"}
		if len(tr.ReleaseDate) >= 4 {
			nb.Anno, _ = strconv.Atoi(tr.ReleaseDate[:4])
		}
		if looksLikeCompilationTitle(nb.Album) {
			nb.Album = ""
		}
	case req.Shazam != nil && req.Shazam.Titolo != "":
		sh := req.Shazam
		nb = &brano{Artista: limit(sh.Artista, 200), Titolo: limit(sh.Titolo, 200), Album: limit(sh.Album, 200), Anno: sh.Anno,
			ISRC: limit(sh.ISRC, 20), ShazamKey: limit(sh.Chiave, 30), Origine: "shazam"}
		if s.covers.has(sh.Copertina) {
			nb.Copertina, nb.FonteCop = sh.Copertina, "Shazam"
		}
	case req.Nuovo != nil && strings.TrimSpace(req.Nuovo.Titolo) != "":
		n := req.Nuovo
		nb = &brano{Artista: cleanField(limit(n.Artista, 200)), Titolo: cleanField(limit(n.Titolo, 200)), Album: cleanField(limit(n.Album, 200)),
			Anno: n.Anno, Origine: "mano"}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	pl := s.plOf(w, r)
	if pl == nil {
		return
	}
	var b *brano
	switch {
	case req.Brano != "":
		b = s.lib.Brani[req.Brano]
	case req.Disco != nil:
		ref, ok := s.ricerca.find(req.Disco.Volume, req.Disco.P)
		if !ok {
			fail(w, http.StatusNotFound, "file non trovato sui dischi")
			return
		}
		f := s.ricerca.file(ref)
		a, t := cleanField(f.A), cleanField(f.T)
		if a == "" || t == "" {
			fa, ft, _ := parseFileName(f.P)
			if a == "" {
				a = fa
			}
			if t == "" {
				t = ft
			}
		}
		nb = &brano{Artista: a, Titolo: t, Album: cleanField(f.Al), Anno: f.Y, Durata: f.D, Genere: cleanGenre(f.G), Origine: "disco",
			Fonte: &fonte{Tipo: "disco", Volume: req.Disco.Volume, P: f.P, S: f.S, M: f.M}}
		if looksLikeCompilationTitle(nb.Album) {
			nb.Album = ""
		}
	}
	if b == nil && nb != nil {
		if b = s.findSongLocked(nb.Artista, nb.Titolo, nb.Durata); b != nil {
			if nb.Fonte != nil && b.Fonte == nil {
				b.Fonte = nb.Fonte
			}
		} else {
			nb.ID, nb.Aggiunto, nb.AggiuntoDa = newID("b_"), time.Now(), user
			s.lib.Brani[nb.ID] = nb
			b = nb
		}
	}
	if b == nil || b.Titolo == "" {
		fail(w, http.StatusBadRequest, "brano non valido")
		return
	}
	already := contains(pl.Brani, b.ID)
	if !already {
		pl.Brani = append(pl.Brani, b.ID)
		pl.Modificata = time.Now()
	}
	s.relinkAllLocked()
	s.saveLib()
	if !b.Cercato || !b.Info {
		s.enqueue(s.enrichLibrary)
	}
	writeJSON(w, http.StatusOK, map[string]any{"brano": vistaDiBrano(b, rigaPiano{}), "gia_presente": already})
}

func (s *server) apiRemoveSongs(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Brani []string `json:"brani"`
	}
	if err := readBody(r, &req, 1<<20); err != nil {
		fail(w, http.StatusBadRequest, "richiesta non valida")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	pl := s.plOf(w, r)
	if pl == nil {
		return
	}
	pl.Brani = without(pl.Brani, req.Brani)
	pl.Modificata = time.Now()
	s.saveLib()
	writeJSON(w, http.StatusOK, map[string]int{"n": len(pl.Brani)})
}

func without(list, remove []string) []string {
	out := []string{}
	for _, x := range list {
		if !contains(remove, x) {
			out = append(out, x)
		}
	}
	return out
}

func (s *server) apiOrder(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Brani []string `json:"brani"`
	}
	if err := readBody(r, &req, 1<<20); err != nil {
		fail(w, http.StatusBadRequest, "richiesta non valida")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	pl := s.plOf(w, r)
	if pl == nil {
		return
	}
	a := append([]string(nil), pl.Brani...)
	b := append([]string(nil), req.Brani...)
	sort.Strings(a)
	sort.Strings(b)
	if strings.Join(a, ",") != strings.Join(b, ",") {
		fail(w, http.StatusConflict, "la playlist è cambiata: ricarica la pagina")
		return
	}
	pl.Brani, pl.Modificata = req.Brani, time.Now()
	s.saveLib()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *server) apiMove(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Brani []string `json:"brani"`
		A     string   `json:"a"`
		Copia bool     `json:"copia"`
	}
	if err := readBody(r, &req, 1<<20); err != nil {
		fail(w, http.StatusBadRequest, "richiesta non valida")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	pl := s.plOf(w, r)
	if pl == nil {
		return
	}
	dst := s.lib.playlistByID(req.A)
	if dst == nil || dst == pl {
		fail(w, http.StatusBadRequest, "playlist di destinazione non valida")
		return
	}
	for _, id := range pl.Brani {
		if contains(req.Brani, id) && !contains(dst.Brani, id) {
			dst.Brani = append(dst.Brani, id)
		}
	}
	if !req.Copia {
		pl.Brani = without(pl.Brani, req.Brani)
	}
	pl.Modificata, dst.Modificata = time.Now(), time.Now()
	s.saveLib()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// --- Brani ------------------------------------------------------------------------------------

type voceDisco struct {
	Volume    string  `json:"volume"`
	Disco     string  `json:"disco"`
	P         string  `json:"p"`
	Artista   string  `json:"artista,omitempty"`
	Titolo    string  `json:"titolo,omitempty"`
	Album     string  `json:"album,omitempty"`
	Anno      int     `json:"anno,omitempty"`
	Durata    float64 `json:"durata,omitempty"`
	Kbps      int     `json:"kbps,omitempty"`
	Punti     int     `json:"punti,omitempty"`
	Copie     int     `json:"copie,omitempty"`
	Collegato bool    `json:"collegato"`
	Scelto    bool    `json:"scelto,omitempty"`
}

type voceLibrary struct {
	ID        string   `json:"id"`
	Artista   string   `json:"artista"`
	Titolo    string   `json:"titolo"`
	Anno      int      `json:"anno,omitempty"`
	Copertina string   `json:"copertina,omitempty"`
	Playlist  []string `json:"playlist"`
}

func (s *server) attachedLocked() map[string]bool {
	out := map[string]bool{}
	if ag := s.mainAgent(); ag != nil && ag.online() {
		for _, u := range ag.Unita {
			out[u.Volume] = true
		}
	}
	return out
}

func (s *server) voceDiscoLocked(r rifDisco, f *fileDisco, attached map[string]bool) voceDisco {
	label := r.Vol
	if iv := s.dischi[r.Vol]; iv != nil {
		label = iv.Unita.nome()
	}
	v := voceDisco{Volume: r.Vol, Disco: label, P: f.P, Artista: cleanField(f.A), Titolo: cleanField(f.T), Album: f.Al, Anno: f.Y,
		Durata: f.D, Kbps: f.B, Collegato: attached[r.Vol]}
	if v.Titolo == "" {
		v.Artista, v.Titolo, _ = parseFileName(f.P)
	}
	return v
}

func (s *server) diskHitsLocked(c []candidato, n int) []voceDisco {
	attached := s.attachedLocked()
	out := []voceDisco{}
	for i, x := range c {
		if i >= n {
			break
		}
		v := s.voceDiscoLocked(x.Rif, x.F, attached)
		v.Punti = x.Punti
		out = append(out, v)
	}
	return out
}

func (s *server) libraryHitsLocked(key, q string, n int) []voceLibrary {
	words := strings.Fields(normKey(q))
	out := []voceLibrary{}
	for _, b := range s.lib.Brani {
		ok := key != "" && b.chiave() == key
		if !ok && len(words) > 0 {
			text := " " + normKey(b.Artista+" "+b.Titolo+" "+b.Album) + " "
			ok = true
			for _, w := range words {
				if !strings.Contains(text, " "+w) {
					ok = false
				}
			}
		}
		if !ok {
			continue
		}
		v := voceLibrary{ID: b.ID, Artista: b.Artista, Titolo: b.Titolo, Anno: b.Anno, Copertina: b.Copertina, Playlist: []string{}}
		for _, pl := range s.lib.Playlist {
			if contains(pl.Brani, b.ID) {
				v.Playlist = append(v.Playlist, pl.Nome)
			}
		}
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Artista+out[i].Titolo < out[j].Artista+out[j].Titolo })
	if len(out) > n {
		out = out[:n]
	}
	return out
}

func (s *server) apiSong(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b := s.lib.Brani[r.PathValue("id")]
	if b == nil {
		fail(w, http.StatusNotFound, "brano non trovato")
		return
	}
	p := s.planLocked()
	cands := s.diskHitsLocked(s.ricerca.candidati(b.Artista, b.Titolo, b.Album, b.Durata), 10)
	if b.Fonte != nil {
		found := false
		for i := range cands {
			if cands[i].Volume == b.Fonte.Volume && cands[i].P == b.Fonte.P {
				cands[i].Scelto, found = true, true
			}
		}
		if ref, ok := s.ricerca.find(b.Fonte.Volume, b.Fonte.P); ok && !found {
			v := s.voceDiscoLocked(ref, s.ricerca.file(ref), s.attachedLocked())
			v.Scelto = true
			cands = append([]voceDisco{v}, cands...)
		}
	}
	var lists []string
	for _, pl := range s.lib.Playlist {
		if contains(pl.Brani, b.ID) {
			lists = append(lists, pl.Nome)
		}
	}
	var stick []map[string]any
	if st := s.chiav[s.lib.Chiavetta]; st != nil {
		for _, f := range st.File {
			if st.Legami[f.P] == b.ID {
				stick = append(stick, map[string]any{"p": f.P, "rovinato": f.Rov, "kbps": f.Kbps, "problemi": f.Problemi})
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"brano": b, "vista": vistaDiBrano(b, p.perBrano[b.ID]), "candidati": cands,
		"playlist": lists, "chiavetta": stick})
}

func (s *server) apiEditSong(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Artista *string `json:"artista"`
		Titolo  *string `json:"titolo"`
		Album   *string `json:"album"`
		Anno    *int    `json:"anno"`
		Fonte   *struct {
			Volume string `json:"volume"`
			P      string `json:"p"`
		} `json:"fonte"`
		Automatica bool `json:"automatica"` // torna alla scelta automatica della copia
	}
	if err := readBody(r, &req, 64<<10); err != nil {
		fail(w, http.StatusBadRequest, "richiesta non valida")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	b := s.lib.Brani[r.PathValue("id")]
	if b == nil {
		fail(w, http.StatusNotFound, "brano non trovato")
		return
	}
	oldKey := b.chiave()
	if req.Artista != nil {
		b.Artista = limit(*req.Artista, 200)
	}
	if req.Titolo != nil && strings.TrimSpace(*req.Titolo) != "" {
		b.Titolo = limit(*req.Titolo, 200)
	}
	if req.Album != nil {
		b.Album = limit(*req.Album, 200)
	}
	if req.Anno != nil && (*req.Anno == 0 || (*req.Anno > 1800 && *req.Anno < 2200)) {
		b.Anno = *req.Anno
	}
	if req.Fonte != nil {
		ref, ok := s.ricerca.find(req.Fonte.Volume, req.Fonte.P)
		if !ok {
			fail(w, http.StatusNotFound, "file non trovato sui dischi")
			return
		}
		f := s.ricerca.file(ref)
		b.Fonte = &fonte{Tipo: "disco", Volume: req.Fonte.Volume, P: f.P, S: f.S, M: f.M}
	}
	if req.Automatica {
		b.Fonte = nil
	}
	if b.chiave() != oldKey {
		b.Info = false
		s.relinkAllLocked()
		s.enqueue(s.enrichLibrary)
	}
	s.saveLib()
	writeJSON(w, http.StatusOK, map[string]any{"brano": b})
}

// --- Ricerca e riconoscimento ---------------------------------------------------------------------

type voceDeezer struct {
	ID        int64  `json:"id"`
	Artista   string `json:"artista"`
	Titolo    string `json:"titolo"`
	Album     string `json:"album,omitempty"`
	Durata    int    `json:"durata,omitempty"`
	Copertina string `json:"copertina,omitempty"`
	Ascolta   string `json:"ascolta,omitempty"`
}

func (s *server) apiSearch(w http.ResponseWriter, r *http.Request) {
	q := limit(r.URL.Query().Get("q"), 100)
	if len(strings.TrimSpace(q)) < 2 {
		writeJSON(w, http.StatusOK, map[string]any{"dischi": []voceDisco{}, "deezer": []voceDeezer{}, "libreria": []voceLibrary{}})
		return
	}
	deezer := []voceDeezer{}
	deezerErr := ""
	if r.URL.Query().Get("deezer") != "0" {
		if res, err := s.art.searchTracks(q, 15); err == nil {
			for _, t := range res {
				deezer = append(deezer, voceDeezer{ID: t.ID, Artista: t.Artist.Name, Titolo: t.Title, Album: t.Album.Title, Durata: t.Duration,
					Copertina: t.Album.CoverMedium, Ascolta: t.Preview})
			}
		} else {
			deezerErr = "Deezer non risponde"
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	attached := s.attachedLocked()
	type gruppo struct {
		v     voceDisco
		copie int
	}
	groups := map[string]*gruppo{}
	var order []string
	for _, ref := range s.ricerca.cerca(q, 400) {
		f := s.ricerca.file(ref)
		k := s.ricerca.keys[ref].tag
		if k == "" {
			k = s.ricerca.keys[ref].file
		}
		if k == "" {
			k = f.P
		}
		g := groups[k]
		v := s.voceDiscoLocked(ref, f, attached)
		if g == nil {
			groups[k] = &gruppo{v: v, copie: 1}
			order = append(order, k)
			continue
		}
		g.copie++
		// si mostra la copia migliore: collegata e con il bitrate più alto
		if (v.Collegato && !g.v.Collegato) || (v.Collegato == g.v.Collegato && v.Kbps > g.v.Kbps) {
			g.v = v
		}
	}
	disks := []voceDisco{}
	for _, k := range order {
		g := groups[k]
		g.v.Copie = g.copie
		disks = append(disks, g.v)
		if len(disks) >= 40 {
			break
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"dischi": disks, "deezer": deezer, "deezer_errore": deezerErr,
		"libreria": s.libraryHitsLocked("", q, 20)})
}

func (s *server) apiRecognize(w http.ResponseWriter, r *http.Request) {
	audio, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 8<<20))
	if err != nil || len(audio) < 1000 {
		fail(w, http.StatusBadRequest, "registrazione mancante o troppo grande")
		return
	}
	res, err := s.riconosci(audio)
	if err != nil {
		code := http.StatusBadGateway
		if errors.Is(err, errTooMany) {
			code = http.StatusTooManyRequests
		}
		fail(w, code, capitalizeFirst(err.Error())+".")
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// --- Lavori -----------------------------------------------------------------------------------------

var jobKinds = map[string]string{"scansiona": lvScansiona, "indicizza": lvIndicizza, "svuota": lvSvuota}

func (s *server) apiJobs(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	writeJSON(w, http.StatusOK, s.recentJobsLocked(50))
}

// newJobLocked crea un lavoro per il PC collegato (uno per tipo alla volta).
func (s *server) newJobLocked(tipo string, param any, user string) (*lavoroSrv, error) {
	ag := s.mainAgent()
	if ag == nil {
		return nil, errors.New("nessun PC è collegato al sito: vai nella pagina «PC»")
	}
	for _, j := range s.lavori {
		if j.Tipo == tipo && j.attivo() {
			return j, nil
		}
	}
	var raw json.RawMessage
	if param != nil {
		raw, _ = json.Marshal(param)
	}
	j := &lavoroSrv{ID: newID("l_"), Tipo: tipo, Agente: ag.ID, Param: raw, Stato: "in_coda", Creato: time.Now(), DaChi: user}
	s.lavori[j.ID] = j
	s.saveJob(j)
	s.wake(ag.ID)
	return j, nil
}

func (s *server) apiNewJob(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Tipo   string   `json:"tipo"`
		Volumi []string `json:"volumi"`
		Volume string   `json:"volume"` // la chiavetta da leggere, se ce n'è più d'una
	}
	if err := readBody(r, &req, 64<<10); err != nil || jobKinds[req.Tipo] == "" {
		fail(w, http.StatusBadRequest, "richiesta non valida")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var param any
	switch jobKinds[req.Tipo] {
	case lvScansiona:
		// quella indicata; altrimenti quella delle playlist se è attaccata;
		// altrimenti l'unica chiavetta collegata
		vol := req.Volume
		if vol == "" {
			if ag := s.mainAgent(); ag != nil {
				for _, u := range ag.Unita {
					if u.Rimovibile && u.Volume == s.lib.Chiavetta {
						vol = u.Volume
					}
				}
			}
		}
		param = paramScansiona{Volume: vol}
	case lvIndicizza:
		param = paramIndicizza{Volumi: req.Volumi}
	case lvSvuota:
		param = paramScansiona{Volume: s.lib.Chiavetta}
	}
	j, err := s.newJobLocked(jobKinds[req.Tipo], param, userOf(r))
	if err != nil {
		fail(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, vistaDi(j))
}

func (s *server) apiCancelJob(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	j := s.lavori[r.PathValue("id")]
	if j == nil {
		fail(w, http.StatusNotFound, "lavoro non trovato")
		return
	}
	switch j.Stato {
	case "in_coda":
		j.Stato, j.Finito, j.Messaggio = "annullato", time.Now(), "annullato prima di cominciare"
	case "inviato", "in_corso":
		j.Annulla = true
	}
	s.saveJob(j)
	writeJSON(w, http.StatusOK, vistaDi(j))
}

// --- Importazione dalla chiavetta --------------------------------------------------------------------

// toImportLocked conta i brani di una chiavetta letta ("" = quella delle
// playlist) che non sono ancora nelle playlist.
func (s *server) toImportLocked(vol string) int {
	_, groups := s.importPreviewLocked(vol)
	n := 0
	for _, g := range groups {
		n += len(g.Brani)
	}
	return n
}

func (s *server) apiImportPreview(w http.ResponseWriter, r *http.Request) {
	vol := r.URL.Query().Get("volume")
	s.mu.Lock()
	defer s.mu.Unlock()
	if vol != "" && s.chiav[vol] == nil {
		fail(w, http.StatusNotFound, "Questa chiavetta non è stata letta.")
		return
	}
	st, groups := s.importPreviewLocked(vol)
	out := map[string]any{"gruppi": groups, "principale": vol == "" || vol == s.lib.Chiavetta}
	if st != nil {
		out["chiavetta"] = st.Unita.nome()
		out["letta"] = humanAge(st.Letta)
	}
	pls := []map[string]string{}
	for _, p := range s.lib.Playlist {
		pls = append(pls, map[string]string{"id": p.ID, "nome": p.Nome, "tipo": p.Tipo})
	}
	out["playlist"] = pls
	writeJSON(w, http.StatusOK, out)
}

func (s *server) apiImport(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Volume string         `json:"volume"`
		Gruppi []sceltaImport `json:"gruppi"`
	}
	if err := readBody(r, &req, 1<<20); err != nil {
		fail(w, http.StatusBadRequest, "richiesta non valida")
		return
	}
	s.mu.Lock()
	if req.Volume != "" && s.chiav[req.Volume] == nil {
		s.mu.Unlock()
		fail(w, http.StatusNotFound, "Questa chiavetta non è stata letta.")
		return
	}
	lists, songs := s.importLocked(req.Volume, req.Gruppi, userOf(r))
	s.mu.Unlock()
	s.enqueue(s.enrichLibrary)
	writeJSON(w, http.StatusOK, map[string]int{"playlist": lists, "brani": songs})
}

// apiReanalyze riconosce di nuovo i brani delle chiavette già lette (dopo
// aver messo la chiave AcoustID, o se i servizi online non rispondevano).
func (s *server) apiReanalyze(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	n := len(s.chiav)
	if n > 0 {
		s.attivita = avanzamento{Fase: "Riconosco di nuovo i brani"}
	}
	s.mu.Unlock()
	if n == 0 {
		fail(w, http.StatusConflict, "Nessuna chiavetta è stata ancora letta.")
		return
	}
	s.enqueue(s.reanalyze)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// --- Piano e copia ---------------------------------------------------------------------------------------

func (s *server) apiPlan(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.planLocked()
	type riga struct {
		rigaPiano
		Artista   string `json:"artista"`
		Titolo    string `json:"titolo"`
		Anno      int    `json:"anno,omitempty"`
		Copertina string `json:"copertina,omitempty"`
	}
	per := map[string][]riga{}
	for _, row := range p.Righe {
		b := s.lib.Brani[row.Brano]
		if b == nil {
			continue
		}
		per[row.Playlist] = append(per[row.Playlist], riga{row, b.Artista, b.Titolo, b.Anno, b.Copertina})
	}
	var lists []map[string]any
	for _, pl := range s.lib.Playlist {
		item := map[string]any{"id": pl.ID, "nome": pl.Nome, "tipo": pl.Tipo, "n": len(pl.Brani)}
		if pl.Tipo == tipoCartella {
			item["righe"] = per[pl.ID]
		}
		lists = append(lists, item)
	}
	if rows := per[""]; len(rows) > 0 {
		lists = append(lists, map[string]any{"id": "", "nome": altriBraniDir, "tipo": tipoCartella, "n": len(rows), "righe": rows})
	}
	ag := s.mainAgent()
	online := ag != nil && ag.online()
	stickOn := false
	if ag != nil {
		for _, u := range ag.Unita {
			if u.Volume == p.Volume && u.Rimovibile {
				stickOn = true
			}
		}
	}
	running := ""
	for _, j := range s.lavori {
		if j.Tipo == lvCopia && j.attivo() {
			running = j.ID
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"piano": p, "playlist": lists, "pc_collegato": online, "chiavetta_collegata": stickOn,
		"copia_in_corso": running})
}

func (s *server) apiConfirm(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Backup bool `json:"backup"`
	}
	if err := readBody(r, &req, 64<<10); err != nil {
		fail(w, http.StatusBadRequest, "richiesta non valida")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.planLocked()
	switch {
	case p.ID != r.PathValue("id"):
		fail(w, http.StatusConflict, "Nel frattempo qualcosa è cambiato: ricontrolla il piano e conferma di nuovo.")
		return
	case len(p.Bloccanti) > 0:
		fail(w, http.StatusConflict, p.Bloccanti[0])
		return
	case len(p.Operazioni) == 0:
		fail(w, http.StatusBadRequest, "La chiavetta è già a posto: non c'è niente da copiare.")
		return
	}
	for _, j := range s.lavori {
		if j.Tipo == lvCopia && j.attivo() {
			fail(w, http.StatusConflict, "C'è già una copia in corso.")
			return
		}
	}
	j, err := s.newJobLocked(lvCopia, paramCopia{Volume: p.Volume, Piano: p.ID, Backup: req.Backup, Operazioni: p.Operazioni,
		Marcatore: p.Marcatore}, userOf(r))
	if err != nil {
		fail(w, http.StatusConflict, err.Error())
		return
	}
	j.Piano = p.ID
	s.saveJob(j)
	writeJSON(w, http.StatusOK, vistaDi(j))
}

// --- Proposte ----------------------------------------------------------------------------------------------

func (s *server) apiProposals(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	type vista struct {
		*proposta
		Copertine []string     `json:"copertine"`
		Esempi    []vistaBrano `json:"esempi"`
	}
	list := []vista{}
	for _, p := range s.proposte.Lista {
		if p.Stato != "nuova" {
			continue
		}
		v := vista{proposta: p, Copertine: []string{}, Esempi: []vistaBrano{}}
		seen := map[string]bool{}
		for _, id := range p.Brani {
			b := s.lib.Brani[id]
			if b == nil {
				continue
			}
			if b.Copertina != "" && !seen[b.Copertina] && len(v.Copertine) < 4 {
				seen[b.Copertina] = true
				v.Copertine = append(v.Copertine, b.Copertina)
			}
			v.Esempi = append(v.Esempi, vistaDiBrano(b, rigaPiano{}))
		}
		list = append(list, v)
	}
	busy := strings.Contains(s.attivita.Fase, "proposte") || strings.Contains(s.attivita.Fase, "AI")
	writeJSON(w, http.StatusOK, map[string]any{"lista": list, "create": humanAge(s.proposte.Create), "motore": s.proposte.Motore,
		"errore": s.proposte.Errore, "ai": s.ai.configured(), "in_corso": busy})
}

func (s *server) apiGenerate(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	s.attivita = avanzamento{Fase: "Preparo le playlist proposte"}
	s.mu.Unlock()
	s.enqueue(s.generaProposte)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *server) propOf(w http.ResponseWriter, r *http.Request) *proposta {
	for _, p := range s.proposte.Lista {
		if p.ID == r.PathValue("id") && p.Stato == "nuova" {
			return p
		}
	}
	fail(w, http.StatusNotFound, "proposta non trovata")
	return nil
}

func (s *server) apiAccept(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Nome  string   `json:"nome"`
		Brani []string `json:"brani"`
		Tipo  string   `json:"tipo"`
	}
	if err := readBody(r, &req, 1<<20); err != nil {
		fail(w, http.StatusBadRequest, "richiesta non valida")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.propOf(w, r)
	if p == nil {
		return
	}
	name := p.Nome
	if strings.TrimSpace(req.Nome) != "" {
		name = req.Nome
	}
	ids := p.Brani
	if req.Brani != nil {
		ids = nil
		for _, id := range req.Brani {
			if contains(p.Brani, id) {
				ids = append(ids, id)
			}
		}
	}
	tipo := tipoM3U
	if req.Tipo == tipoCartella || s.lib.tesla() { // la Tesla non legge le .m3u
		tipo = tipoCartella
	}
	pl := &playlist{ID: newID("p_"), Nome: s.uniqueNameLocked(limit(name, 60), ""), Tipo: tipo, Descrizione: p.Descrizione,
		Origine: "proposta", Creata: time.Now(), Modificata: time.Now(), Brani: []string{}}
	for _, id := range ids {
		if s.lib.Brani[id] != nil {
			pl.Brani = append(pl.Brani, id)
		}
	}
	s.lib.Playlist = append(s.lib.Playlist, pl)
	p.Stato = "accettata"
	s.saveLib()
	s.saveProposte()
	writeJSON(w, http.StatusOK, map[string]string{"id": pl.ID, "nome": pl.Nome})
}

func (s *server) apiDiscard(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.propOf(w, r)
	if p == nil {
		return
	}
	p.Stato = "scartata"
	s.saveProposte()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// --- PC collegati --------------------------------------------------------------------------------------------

func (s *server) apiAgents(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []map[string]any{}
	for _, a := range s.agenti {
		out = append(out, map[string]any{"id": a.ID, "nome": a.Nome, "online": a.online(), "visto": humanAge(a.Visto),
			"versione": a.Versione, "unita": a.Unita, "creato": humanAge(a.Creato), "da_chi": a.DaChi})
	}
	writeJSON(w, http.StatusOK, map[string]any{"agenti": out, "programma": s.o.exePath != ""})
}

func (s *server) apiPair(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Codice string `json:"codice"`
	}
	if err := readBody(r, &req, 4<<10); err != nil {
		fail(w, http.StatusBadRequest, "richiesta non valida")
		return
	}
	if s.tooMany("codice", userOf(r), 10) {
		fail(w, http.StatusTooManyRequests, "Troppi tentativi: aspetta qualche minuto.")
		return
	}
	code := strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, req.Codice)
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, ab := range s.abbinamenti {
		if ab.Codice == code && ab.Token == "" && time.Now().Before(ab.Scade) {
			ab.Token = s.newAgentLocked(ab.PC, ab.Versione, userOf(r))
			close(ab.pronto)
			writeJSON(w, http.StatusOK, map[string]string{"nome": ab.PC})
			return
		}
	}
	fail(w, http.StatusNotFound, "Codice sbagliato o scaduto: controlla il numero nella finestra sul PC.")
}

func (s *server) siteURL(r *http.Request) string {
	if s.sito != "" {
		return s.sito
	}
	return "https://" + r.Host
}

func (s *server) apiTicket(w http.ResponseWriter, r *http.Request) {
	if s.o.exePath == "" {
		fail(w, http.StatusServiceUnavailable, "Il programma per Windows non è disponibile sul sito.")
		return
	}
	ticket := newSecret()[:24]
	s.mu.Lock()
	defer s.mu.Unlock()
	var keep []*bigliettoSrv
	for _, b := range s.biglietti {
		if time.Now().Before(b.Scade) && !b.Usato {
			keep = append(keep, b)
		}
	}
	scade := time.Now().Add(7 * 24 * time.Hour)
	s.biglietti = append(keep, &bigliettoSrv{Hash: hashSecret(ticket), Creato: time.Now(), Scade: scade, DaChi: userOf(r)})
	s.saveTickets()
	writeJSON(w, http.StatusOK, map[string]string{"url": s.siteURL(r) + "/agente/scarica/" + ticket,
		"scade": scade.In(romeTZ()).Format("02/01/2006 15:04")})
}

func (s *server) apiRevoke(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var keep []*agenteSrv
	found := false
	for _, a := range s.agenti {
		if a.ID == r.PathValue("id") {
			found = true
			continue
		}
		keep = append(keep, a)
	}
	if !found {
		fail(w, http.StatusNotFound, "PC non trovato")
		return
	}
	s.agenti = keep
	s.saveAgents()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *server) apiProgram(w http.ResponseWriter, r *http.Request) {
	exe, err := s.exeBytes()
	if err != nil {
		http.Error(w, "programma non disponibile", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/vnd.microsoft.portable-executable")
	w.Header().Set("Content-Disposition", `attachment; filename="RiparaMP3-Collega.exe"`)
	w.Write(exe)
}
