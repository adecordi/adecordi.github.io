package main

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"
)

// Le richieste dell'agente: abbinamento, lavori, risultati, copertine.

// --- Abbinamento con il codice ---------------------------------------------------------

func (s *server) agAbbina(w http.ResponseWriter, r *http.Request) {
	if s.tooMany("abbina", clientIP(r), 10) {
		fail(w, http.StatusTooManyRequests, "troppi tentativi: riprova fra qualche minuto")
		return
	}
	var req richiestaAbbina
	if err := readBody(r, &req, 4<<10); err != nil {
		fail(w, http.StatusBadRequest, "richiesta non valida")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	pending := 0
	for _, ab := range s.abbinamenti {
		if time.Now().Before(ab.Scade) && ab.Token == "" {
			pending++
		}
	}
	if pending >= 3 {
		fail(w, http.StatusTooManyRequests, "ci sono già altri PC in attesa: riprova fra qualche minuto")
		return
	}
	var code string
	for {
		n, _ := rand.Int(rand.Reader, big.NewInt(1000000))
		code = fmt.Sprintf("%06d", n.Int64())
		clash := false
		for _, ab := range s.abbinamenti {
			if ab.Codice == code {
				clash = true
			}
		}
		if !clash {
			break
		}
	}
	secret := newSecret()
	ab := &abbinamento{ID: newID("ab_"), SegretoHash: hashSecret(secret), Codice: code, PC: limit(req.PC, 60),
		Versione: limit(req.Versione, 20), IP: clientIP(r), Scade: time.Now().Add(10 * time.Minute), pronto: make(chan struct{})}
	s.abbinamenti[ab.ID] = ab
	writeJSON(w, http.StatusOK, rispostaAbbina{Richiesta: ab.ID, Segreto: secret, Codice: code, Scade: ab.Scade.Unix()})
}

func limit(s string, n int) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) > n {
		r = r[:n]
	}
	return string(r)
}

func (s *server) agAttendi(w http.ResponseWriter, r *http.Request) {
	var req attesaAbbina
	if err := readBody(r, &req, 4<<10); err != nil {
		fail(w, http.StatusBadRequest, "richiesta non valida")
		return
	}
	s.mu.Lock()
	ab := s.abbinamenti[req.Richiesta]
	s.mu.Unlock()
	if ab == nil || !constantTimeEqual(ab.SegretoHash, hashSecret(req.Segreto)) || time.Now().After(ab.Scade) {
		writeJSON(w, http.StatusOK, esitoAbbina{Stato: "scaduto"})
		return
	}
	select {
	case <-ab.pronto:
	case <-time.After(25 * time.Second):
	case <-r.Context().Done():
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if ab.Token != "" {
		delete(s.abbinamenti, ab.ID)
		writeJSON(w, http.StatusOK, esitoAbbina{Stato: "ok", Token: ab.Token})
		return
	}
	writeJSON(w, http.StatusOK, esitoAbbina{Stato: "attesa"})
}

// newAgent registra un PC e ne restituisce il token (da dare una volta sola).
func (s *server) newAgentLocked(pc, versione, daChi string) string {
	token := newSecret()
	s.agenti = append(s.agenti, &agenteSrv{ID: newID("pc_"), Nome: pc, TokenHash: hashSecret(token), Creato: time.Now(),
		DaChi: daChi, Versione: versione, Visto: time.Now()})
	s.saveAgents()
	return token
}

// --- Biglietti: il programma scaricato dal sito si collega da solo --------------------------

func (s *server) findTicketLocked(ticket string) *bigliettoSrv {
	h := hashSecret(ticket)
	for _, b := range s.biglietti {
		if constantTimeEqual(b.Hash, h) && !b.Usato && time.Now().Before(b.Scade) {
			return b
		}
	}
	return nil
}

func (s *server) agBiglietto(w http.ResponseWriter, r *http.Request) {
	if s.tooMany("biglietto", clientIP(r), 10) {
		fail(w, http.StatusTooManyRequests, "troppi tentativi")
		return
	}
	var req richiestaBiglietto
	if err := readBody(r, &req, 4<<10); err != nil {
		fail(w, http.StatusBadRequest, "richiesta non valida")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	b := s.findTicketLocked(req.Biglietto)
	if b == nil {
		fail(w, http.StatusForbidden, "il link per collegare il PC è scaduto o è già stato usato: chiedine uno nuovo")
		return
	}
	b.Usato = true
	s.saveTickets()
	token := s.newAgentLocked(limit(req.PC, 60), limit(req.Versione, 20), b.DaChi)
	log.Printf("PC %q collegato con il biglietto creato da %s", req.PC, b.DaChi)
	writeJSON(w, http.StatusOK, esitoAbbina{Stato: "ok", Token: token})
}

func (s *server) exeBytes() ([]byte, error) {
	if s.o.exePath == "" {
		return nil, os.ErrNotExist
	}
	b, err := os.ReadFile(s.o.exePath)
	if err != nil {
		return nil, err
	}
	return stripOverlay(b), nil
}

func (s *server) agScarica(w http.ResponseWriter, r *http.Request) {
	ticket := r.PathValue("biglietto")
	if s.tooMany("scarica", clientIP(r), 20) {
		http.Error(w, "troppi tentativi", http.StatusTooManyRequests)
		return
	}
	s.mu.Lock()
	b := s.findTicketLocked(ticket)
	if b != nil {
		if b.Usi >= 5 {
			b = nil
		} else {
			b.Usi++
			s.saveTickets()
		}
	}
	s.mu.Unlock()
	if b == nil {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusGone)
		io.WriteString(w, "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>"+
			"<p style='font:18px sans-serif;margin:2em'>Questo link è scaduto o è già stato usato. Chiedi un link nuovo.</p>")
		return
	}
	exe, err := s.exeBytes()
	if err != nil {
		http.Error(w, "programma non disponibile", http.StatusServiceUnavailable)
		return
	}
	// il programma è identico per tutti; il biglietto sta nel nome del file
	w.Header().Set("Content-Type", "application/vnd.microsoft.portable-executable")
	w.Header().Set("Content-Disposition", `attachment; filename="RiparaMP3-Collega-`+ticket+`.exe"`)
	w.Header().Set("Cache-Control", "no-store")
	w.Write(exe)
}

// --- Lavori -------------------------------------------------------------------------------

// requeue rimette in coda un lavoro che l'agente non ha portato a termine.
func (s *server) requeue(j *lavoroSrv, why string) {
	j.Tentativi++
	if j.Tentativi >= 3 {
		j.Stato, j.Messaggio, j.Finito = "errore", "interrotto più volte: "+why, time.Now()
	} else {
		j.Stato, j.Avanz, j.parti, j.scan, j.indici = "in_coda", avanzamento{}, nil, nil, nil
	}
	s.saveJob(j)
}

func (s *server) nextJobLocked(ag *agenteSrv) *lavoroSrv {
	var queue []*lavoroSrv
	for _, j := range s.lavori {
		if j.Agente == ag.ID && j.Stato == "in_coda" {
			queue = append(queue, j)
		}
	}
	if len(queue) == 0 {
		return nil
	}
	sort.Slice(queue, func(a, b int) bool { return queue[a].Creato.Before(queue[b].Creato) })
	return queue[0]
}

func (s *server) agLavoro(w http.ResponseWriter, r *http.Request, ag *agenteSrv) {
	var b battito
	if err := readBody(r, &b, 1<<20); err != nil {
		fail(w, http.StatusBadRequest, "richiesta non valida")
		return
	}
	if b.Proto != protoVersion {
		fail(w, http.StatusUpgradeRequired, "programma da aggiornare")
		return
	}
	s.mu.Lock()
	ag.Versione, ag.Unita, ag.InCorso = limit(b.Versione, 20), b.Unita, b.InCorso
	if b.PC != "" {
		ag.Nome = limit(b.PC, 60)
	}
	// un lavoro consegnato che l'agente non sta facendo è stato interrotto
	// (finestra chiusa, PC spento)
	for _, j := range s.lavori {
		if j.Agente == ag.ID && (j.Stato == "inviato" || j.Stato == "in_corso") && j.ID != b.InCorso &&
			time.Since(j.Inviato) > 5*time.Second {
			s.requeue(j, "il programma sul PC è stato chiuso durante il lavoro")
		}
	}
	if time.Since(s.agentsSaved) > time.Minute {
		s.saveAgents()
	}
	ch := s.sveglie[ag.ID]
	if ch == nil {
		ch = make(chan struct{}, 1)
		s.sveglie[ag.ID] = ch
	}
	s.mu.Unlock()

	deadline := time.After(25 * time.Second)
	for {
		s.mu.Lock()
		var j *lavoroSrv
		if b.InCorso == "" {
			j = s.nextJobLocked(ag)
		}
		if j != nil {
			j.Stato, j.Inviato, j.Aggiornato, j.parti = "inviato", time.Now(), time.Now(), map[int]bool{}
			s.saveJob(j)
			s.mu.Unlock()
			writeJSON(w, http.StatusOK, rispostaBattito{Lavoro: &lavoroAgente{ID: j.ID, Tipo: j.Tipo, Param: j.Param}})
			return
		}
		s.mu.Unlock()
		select {
		case <-ch:
		case <-deadline:
			writeJSON(w, http.StatusOK, rispostaBattito{})
			return
		case <-r.Context().Done():
			return
		}
	}
}

func (s *server) jobOf(w http.ResponseWriter, r *http.Request, ag *agenteSrv) *lavoroSrv {
	j := s.lavori[r.PathValue("id")]
	if j == nil || j.Agente != ag.ID {
		fail(w, http.StatusNotFound, "lavoro sconosciuto")
		return nil
	}
	return j
}

func (s *server) agAvanzamento(w http.ResponseWriter, r *http.Request, ag *agenteSrv) {
	var a avanzamento
	if err := readBody(r, &a, 64<<10); err != nil {
		fail(w, http.StatusBadRequest, "richiesta non valida")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	j := s.jobOf(w, r, ag)
	if j == nil {
		return
	}
	if j.Stato == "inviato" {
		j.Stato = "in_corso"
	}
	a.Fase, a.Corrente = limit(a.Fase, 100), limit(a.Corrente, 200)
	j.Avanz, j.Aggiornato = a, time.Now()
	writeJSON(w, http.StatusOK, rispostaAvanzamento{Annulla: j.Annulla})
}

func (s *server) agParte(w http.ResponseWriter, r *http.Request, ag *agenteSrv) {
	var p parteLavoro
	if err := readBody(r, &p, 64<<20); err != nil {
		fail(w, http.StatusBadRequest, "richiesta non valida")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	j := s.jobOf(w, r, ag)
	if j == nil {
		return
	}
	if !j.attivo() {
		fail(w, http.StatusConflict, "il lavoro è già chiuso")
		return
	}
	if j.parti == nil {
		j.parti = map[int]bool{}
	}
	if j.parti[p.N] {
		writeJSON(w, http.StatusOK, rispostaParte{}) // già ricevuto
		return
	}
	j.parti[p.N] = true
	j.Stato, j.Aggiornato = "in_corso", time.Now()
	var resp rispostaParte
	switch p.Tipo {
	case parteChiavetta:
		var info infoChiavetta
		if json.Unmarshal(p.Voci, &info) != nil {
			fail(w, http.StatusBadRequest, "dati non validi")
			return
		}
		// dopo una copia la chiavetta viene riletta nello stesso lavoro
		j.scan = &scanAcc{info: &info}
	case parteFileChiav:
		var files []fileChiavetta
		if json.Unmarshal(p.Voci, &files) != nil || j.scan == nil {
			fail(w, http.StatusBadRequest, "dati non validi")
			return
		}
		j.scan.files = append(j.scan.files, files...)
		j.Avanz = avanzamento{Fase: "Leggo la chiavetta", Fatti: len(j.scan.files), Totale: j.Avanz.Totale}
		seen := map[string]bool{}
		for _, f := range files {
			if f.Cop != "" && !seen[f.Cop] && !s.covers.has(f.Cop) {
				seen[f.Cop] = true
				resp.CopertineMancanti = append(resp.CopertineMancanti, f.Cop)
			}
		}
	case parteDisco:
		var pz pezzoIndice
		if json.Unmarshal(p.Voci, &pz) != nil || pz.Unita.Volume == "" {
			fail(w, http.StatusBadRequest, "dati non validi")
			return
		}
		if j.indici == nil {
			j.indici = map[string]*indiceVolume{}
		}
		iv := j.indici[pz.Unita.Volume]
		if pz.Inizio || iv == nil {
			iv = &indiceVolume{Unita: pz.Unita}
			j.indici[pz.Unita.Volume] = iv
		}
		iv.File = append(iv.File, pz.File...)
		if pz.Fine {
			iv.Aggiornato = time.Now()
			s.dischi[iv.Unita.Volume] = iv
			s.saveIndex(iv)
			s.rebuildSearchLocked()
			delete(j.indici, pz.Unita.Volume)
		}
	case parteFineChiav:
		if j.scan == nil {
			fail(w, http.StatusBadRequest, "dati non validi")
			return
		}
		j.scan.complete = true
	case parteEsiti:
		var es []esitoOp
		if json.Unmarshal(p.Voci, &es) != nil {
			fail(w, http.StatusBadRequest, "dati non validi")
			return
		}
		j.Esiti = append(j.Esiti, es...)
	default:
		fail(w, http.StatusBadRequest, "tipo di dati sconosciuto")
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *server) agFine(w http.ResponseWriter, r *http.Request, ag *agenteSrv) {
	var f fineLavoro
	if err := readBody(r, &f, 64<<10); err != nil {
		fail(w, http.StatusBadRequest, "richiesta non valida")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	j := s.jobOf(w, r, ag)
	if j == nil {
		return
	}
	if !j.attivo() {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		return
	}
	switch f.Esito {
	case "fatto", "annullato":
		j.Stato = f.Esito
	default:
		j.Stato = "errore"
	}
	j.Messaggio, j.Finito = limit(f.Messaggio, 500), time.Now()
	if j.scan != nil && j.scan.complete {
		// una lettura interrotta a metà non deve sostituire quella buona
		acc, id := j.scan, j.ID
		s.attivita = avanzamento{Fase: "Riconosco i brani della chiavetta"}
		s.enqueue(func() { s.processScan(id, acc) })
	}
	j.scan, j.indici, j.parti = nil, nil, nil
	s.saveJob(j)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// --- Copertine ----------------------------------------------------------------------------

func (s *server) agPutCopertina(w http.ResponseWriter, r *http.Request, ag *agenteSrv) {
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil || !s.covers.putNormalized(r.PathValue("id"), b) {
		fail(w, http.StatusBadRequest, "copertina non valida")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *server) agGetCopertina(w http.ResponseWriter, r *http.Request, ag *agenteSrv) {
	b := s.covers.get(r.PathValue("id"))
	if b == nil {
		fail(w, http.StatusNotFound, "copertina sconosciuta")
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Write(b)
}
