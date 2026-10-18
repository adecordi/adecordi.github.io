package main

import (
	"encoding/hex"
	"log"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Il sito riconosce i brani letti dalla chiavetta (tag, impronta audio,
// MusicBrainz, copertine ufficiali) e li collega ai brani delle playlist.

// songFromFile ricostruisce un brano "da console" da un file della
// chiavetta, per riusare le regole di RiparaMP3 su tag e copertine. Anche i
// file rovinati passano come sani: vanno riconosciuti proprio per trovarne
// una copia buona.
func songFromFile(f *fileChiavetta) *song {
	sg := &song{path: "/k/" + f.P, origRel: f.P, size: f.S, status: stOK,
		info: &mp3Info{Duration: f.Dur, Bitrate: f.Kbps, Frames: 1}, tags: f.Tag, raw: f.Raw, origCoverID: f.Cop}
	if b, err := hex.DecodeString(f.AU); err == nil && len(b) == 20 {
		copy(sg.audioHash[:], b)
	}
	if f.CopLato >= minCoverSide {
		sg.fallback = f.Cop
	}
	return sg
}

// stickRoot: per i tag ricavati dalle cartelle, la radice è la cartella
// della playlist ("Anni 80" non deve diventare il nome di un artista).
func stickRoot(p string) string {
	parts := strings.Split(p, "/")
	n := 1
	if len(parts) > 2 && strings.EqualFold(parts[0], musicDir) {
		n = 2 // Music\Playlist\brano.mp3
	}
	if len(parts) > n {
		return "/k/" + strings.Join(parts[:n], "/")
	}
	return "/k"
}

// enrichSongs completa artista, titolo, album, anno e copertina, come fa
// RiparaMP3 sulla chiavetta, con l'impronta già calcolata dall'agente.
func (s *server) enrichSongs(songs []*song, fps map[*song]string, keys map[*song]string, progress func(fase string, i, n int)) {
	for _, sg := range songs {
		sg.computeTags(stickRoot(sg.origRel), nil)
		sg.coverID = sg.fallback
	}
	markCompilations(songs)
	shareCovers(songs)

	if s.ac != nil {
		n := 0
		for _, sg := range songs {
			n++
			progress("Riconosco i brani dall'audio", n, len(songs))
			fp := fps[sg]
			if fp == "" || sg.info.Duration < 10 {
				continue
			}
			if r, ok := s.ac.cached(keys[sg]); ok {
				if r.Found {
					sg.applyIdentified(r)
				}
				continue
			}
			if s.ac.badKey || s.ac.web.isOffline() {
				continue
			}
			if _, err := identifyOne(s.ac, s.mb, sg, fp, []string{keys[sg]}); err == errBadKey {
				log.Print("la chiave AcoustID non è valida")
			}
		}
		s.ac.save()
	}

	lookups := map[string][]*song{}
	var lkeys []string
	for _, sg := range songs {
		if sg.needsLookup() {
			k := cacheKey(sg.final.Artist, sg.final.Title)
			if lookups[k] == nil {
				lkeys = append(lkeys, k)
			}
			lookups[k] = append(lookups[k], sg)
		}
	}
	sort.Strings(lkeys)
	for i, k := range lkeys {
		g := lookups[k]
		progress("Cerco album e anni su MusicBrainz", i+1, len(lkeys))
		r, err := s.mb.lookup(g[0].final.Artist, g[0].final.Title, g[0].info.Duration)
		if err != nil || !r.Found {
			continue
		}
		for _, sg := range g {
			sg.applyMB(r)
		}
	}
	s.mb.save()
	assignCovers(songs, s.art, s.covers, true, func(i, n int, name string) { progress("Cerco le copertine ufficiali", i, n) })
	shareCovers(songs)
}

// processScan elabora una lettura completa della chiavetta.
func (s *server) processScan(jobID string, acc *scanAcc) {
	start := time.Now()
	// l'agente legge quattro file alla volta e li manda come finiscono: si
	// rimettono in ordine di nome, che è l'ordine in cui stanno sulla chiavetta
	// (e quello con cui si importano nelle playlist)
	sort.SliceStable(acc.files, func(i, j int) bool { return strings.ToLower(acc.files[i].P) < strings.ToLower(acc.files[j].P) })
	var songs []*song
	byFile := map[*song]*fileChiavetta{}
	fps := map[*song]string{}
	keys := map[*song]string{}
	for i := range acc.files {
		f := &acc.files[i]
		if f.Fmt != "" {
			continue
		}
		sg := songFromFile(f)
		songs = append(songs, sg)
		byFile[sg] = f
		fps[sg], keys[sg] = f.FP, f.AU
	}
	s.enrichSongs(songs, fps, keys, func(fase string, i, n int) { s.setActivity(fase, i, n) })

	st := &statoChiavetta{Unita: acc.info.Unita, Letta: time.Now(), File: acc.files, Finali: map[string]*finale{},
		Legami: map[string]string{}, Marcatore: acc.info.Marcatore}
	for _, sg := range songs {
		t := sg.final
		t.Picture = nil
		st.Finali[sg.origRel] = &finale{Tag: t, Cop: sg.coverID, FonteCop: sg.coverSource, MBRG: sg.mbRG, MBRel: sg.mbRel, Riconosciuto: sg.idFrom}
	}
	s.mu.Lock()
	if s.lib.Chiavetta == "" {
		s.lib.Chiavetta = st.Unita.Volume
		s.saveLib()
	}
	s.chiav[st.Unita.Volume] = st
	s.linkFilesLocked(st)
	s.saveStick(st)
	s.saveLib()
	s.mu.Unlock()
	log.Printf("chiavetta %s elaborata: %d file in %s", st.Unita.nome(), len(st.File), time.Since(start).Round(time.Second))
	s.enrichLibrary()
}

// linkFilesLocked collega i file della chiavetta ai brani della libreria:
// prima per audio identico, poi per artista e titolo con durata simile.
func (s *server) linkFilesLocked(st *statoChiavetta) {
	byAudio := map[string]string{}
	byKey := map[string][]*brano{}
	for _, b := range s.lib.Brani {
		for _, au := range b.Audio {
			byAudio[au] = b.ID
		}
		byKey[b.chiave()] = append(byKey[b.chiave()], b)
	}
	st.Legami = map[string]string{}
	for i := range st.File {
		f := &st.File[i]
		if f.Fmt != "" {
			continue
		}
		if id, ok := byAudio[f.AU]; ok && f.AU != "" {
			st.Legami[f.P] = id
			continue
		}
		fin := st.Finali[f.P]
		if fin == nil {
			continue
		}
		for _, b := range byKey[pairKey(fin.Tag.Artist, fin.Tag.Title)] {
			if b.Durata == 0 || f.Dur == 0 || math.Abs(b.Durata-f.Dur) <= 5 {
				st.Legami[f.P] = b.ID
				if f.AU != "" && !f.Rov && !contains(b.Audio, f.AU) {
					b.Audio = append(b.Audio, f.AU)
				}
				if b.Durata == 0 {
					b.Durata = f.Dur
				}
				break
			}
		}
	}
}

// relinkAllLocked ricollega tutte le chiavette dopo un cambio della libreria.
func (s *server) relinkAllLocked() {
	for _, st := range s.chiav {
		s.linkFilesLocked(st)
	}
}

// branoFromFile crea un brano della libreria da un file della chiavetta.
func branoFromFile(f *fileChiavetta, fin *finale, user string) *brano {
	t := fin.Tag
	b := &brano{ID: newID("b_"), Artista: t.Artist, Titolo: t.Title, Album: t.Album, Anno: t.Year, Traccia: t.Track,
		TracceTot: t.TrackTotal, Durata: f.Dur, Genere: t.Genre, Copertina: fin.Cop, FonteCop: fin.FonteCop,
		MBRG: fin.MBRG, MBRel: fin.MBRel, Origine: "chiavetta", Aggiunto: time.Now(), AggiuntoDa: user, Cercato: true}
	if f.AU != "" && !f.Rov {
		b.Audio = []string{f.AU}
	}
	return b
}

// --- Importazione -------------------------------------------------------------------------

type gruppoImport struct {
	Chiave   string          `json:"chiave"` // cartella della chiavetta ("" = principale)
	Nome     string          `json:"nome"`
	Playlist string          `json:"playlist,omitempty"` // playlist che ha già questa cartella
	Brani    []anteprimaFile `json:"brani"`
}

type anteprimaFile struct {
	P         string `json:"p"`
	Artista   string `json:"artista"`
	Titolo    string `json:"titolo"`
	Anno      int    `json:"anno,omitempty"`
	Copertina string `json:"copertina,omitempty"`
	Rovinato  bool   `json:"rovinato,omitempty"`
}

// topFolder è la cartella della playlist di un file della chiavetta: la prima
// cartella, oppure quella dentro Music nel formato per la Tesla.
func topFolder(p string) string {
	parts := strings.Split(p, "/")
	if len(parts) > 2 && strings.EqualFold(parts[0], musicDir) {
		return parts[1]
	}
	if len(parts) > 1 && !strings.EqualFold(parts[0], musicDir) {
		return parts[0]
	}
	return ""
}

// importPreviewLocked raggruppa per cartella i file della chiavetta che non
// sono ancora in nessuna playlist.
func (s *server) importPreviewLocked() (*statoChiavetta, []gruppoImport) {
	st := s.chiav[s.lib.Chiavetta]
	if st == nil {
		return nil, nil
	}
	byFolder := map[string]*gruppoImport{}
	var order []string
	for i := range st.File {
		f := &st.File[i]
		if f.Fmt != "" || st.Legami[f.P] != "" {
			continue
		}
		top := topFolder(f.P)
		if strings.EqualFold(top, toltiDir) {
			continue
		}
		g := byFolder[top]
		if g == nil {
			name := top
			if name == "" {
				name = st.Unita.Etichetta
				if name == "" {
					name = "Chiavetta"
				}
			}
			g = &gruppoImport{Chiave: top, Nome: name}
			for _, p := range s.lib.Playlist {
				if (p.Tipo == tipoCartella || s.lib.tesla()) && strings.EqualFold(safeFileName(p.Nome, 60), top) && top != "" {
					g.Playlist = p.ID
				}
			}
			byFolder[top] = g
			order = append(order, top)
		}
		fin := st.Finali[f.P]
		a := anteprimaFile{P: f.P, Rovinato: f.Rov}
		if fin != nil {
			a.Artista, a.Titolo, a.Anno, a.Copertina = fin.Tag.Artist, fin.Tag.Title, fin.Tag.Year, fin.Cop
		}
		g.Brani = append(g.Brani, a)
	}
	sort.Strings(order)
	out := make([]gruppoImport, 0, len(order))
	for _, k := range order {
		out = append(out, *byFolder[k])
	}
	return st, out
}

type sceltaImport struct {
	Chiave   string `json:"chiave"`
	Nome     string `json:"nome"`
	Playlist string `json:"playlist,omitempty"`
	Includi  bool   `json:"includi"`
}

// importLocked crea brani e playlist dai gruppi scelti.
func (s *server) importLocked(scelte []sceltaImport, user string) (int, int) {
	st, groups := s.importPreviewLocked()
	if st == nil {
		return 0, 0
	}
	want := map[string]sceltaImport{}
	for _, c := range scelte {
		want[c.Chiave] = c
	}
	byAudio := map[string]*brano{}
	newSongs, newLists := 0, 0
	for _, g := range groups {
		c, ok := want[g.Chiave]
		if !ok || !c.Includi {
			continue
		}
		pl := s.lib.playlistByID(c.Playlist)
		if pl == nil {
			name := strings.TrimSpace(c.Nome)
			if name == "" {
				name = g.Nome
			}
			pl = &playlist{ID: newID("p_"), Nome: s.uniqueNameLocked(name, ""), Tipo: tipoCartella, Origine: "chiavetta",
				Creata: time.Now(), Modificata: time.Now()}
			s.lib.Playlist = append(s.lib.Playlist, pl)
			newLists++
		}
		for _, a := range g.Brani {
			f := st.file(a.P)
			fin := st.Finali[a.P]
			if f == nil || fin == nil {
				continue
			}
			b := byAudio[f.AU]
			if id := st.Legami[f.P]; id != "" {
				b = s.lib.Brani[id]
			}
			if b == nil {
				b = branoFromFile(f, fin, user)
				s.lib.Brani[b.ID] = b
				newSongs++
				if f.AU != "" {
					byAudio[f.AU] = b
				}
			}
			st.Legami[f.P] = b.ID
			if !contains(pl.Brani, b.ID) {
				pl.Brani = append(pl.Brani, b.ID)
				pl.Modificata = time.Now()
			}
		}
	}
	s.relinkAllLocked()
	s.saveStick(st)
	s.saveLib()
	return newLists, newSongs
}

// uniqueNameLocked evita due playlist con lo stesso nome (e quindi la
// stessa cartella sulla chiavetta).
func (s *server) uniqueNameLocked(name, except string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "Playlist"
	}
	taken := func(n string) bool {
		k := strings.ToLower(safeFileName(n, 60))
		if k == strings.ToLower(altriBraniDir) || k == strings.ToLower(toltiDir) {
			return true
		}
		for _, p := range s.lib.Playlist {
			if p.ID != except && strings.ToLower(safeFileName(p.Nome, 60)) == k {
				return true
			}
		}
		return false
	}
	out := name
	for i := 2; taken(out); i++ {
		out = name + " " + strconv.Itoa(i)
	}
	return out
}

// --- Completamento dei brani ------------------------------------------------------------------

// enrichLibrary completa in sottofondo i brani aggiunti dal sito (anno,
// album originale, copertina) e raccoglie per tutti genere, ritmo e lingua
// per le playlist proposte.
func (s *server) enrichLibrary() {
	s.mu.Lock()
	var todo []brano
	for _, b := range s.lib.Brani {
		if !b.Cercato || !b.Info {
			todo = append(todo, *b)
		}
	}
	s.mu.Unlock()
	sort.Slice(todo, func(i, j int) bool { return todo[i].Aggiunto.Before(todo[j].Aggiunto) })
	for i := range todo {
		b := &todo[i]
		s.setActivity("Completo le informazioni dei brani", i+1, len(todo))
		if !b.Cercato {
			// se MusicBrainz non ha risposto si riprova più tardi (periodic)
			b.Cercato = s.completeSong(b)
		}
		if !b.Info {
			if inf, err := s.art.trackInfo(b.Artista, b.Titolo, b.Durata); err == nil {
				b.Info = true
				if inf.Found {
					b.GenereDz, b.BPM, b.ISRC = inf.Genre, inf.BPM, inf.ISRC
					if b.DeezerID == 0 {
						b.DeezerID = inf.TrackID
					}
				}
			}
			b.Lingua = linguaDi(b)
		}
		s.mu.Lock()
		if cur := s.lib.Brani[b.ID]; cur != nil {
			// le modifiche fatte nel frattempo dal sito restano
			if cur.Artista == b.Artista && cur.Titolo == b.Titolo {
				merged := *b
				merged.Fonte, merged.Audio = cur.Fonte, cur.Audio
				*cur = merged
			} else {
				cur.Cercato, cur.Info = false, false
			}
		}
		if i%25 == 24 || i == len(todo)-1 {
			s.saveLib()
		}
		s.mu.Unlock()
	}
	s.art.infoCache().save()
	s.mb.save()
}

// completeSong cerca anno e album originali e la copertina ufficiale di un
// brano aggiunto dal sito (da Deezer, Shazam o da un disco). Restituisce
// false se MusicBrainz non ha risposto: il brano va ripreso più tardi.
func (s *server) completeSong(b *brano) bool {
	if b.Artista == "" || b.Titolo == "" {
		return true
	}
	r, err := s.mb.lookup(b.Artista, b.Titolo, b.Durata)
	if err != nil {
		return false
	}
	if r.Found {
		if r.Year > 0 && (b.Anno == 0 || r.Year < b.Anno) {
			b.Anno = r.Year
		}
		// l'album dato da Deezer o da Shazam è spesso una ristampa o una
		// raccolta: per quei brani vale quello originale trovato su MusicBrainz
		fromCatalog := b.Origine == "deezer" || b.Origine == "shazam"
		if (b.Album == "" || looksLikeCompilationTitle(b.Album) || fromCatalog) && r.Album != "" && !r.AlbumIsComp {
			b.Album, b.Traccia, b.TracceTot = r.Album, r.Track, r.TrackTotal
		}
		if albumMatchKey(r.Album) == albumMatchKey(b.Album) {
			b.MBRG, b.MBRel = r.ReleaseGroup, r.Release
		}
	}
	if b.Copertina != "" && b.FonteCop != "" && b.FonteCop != "file" && b.FonteCop != "Shazam" {
		return true
	}
	if b.Album != "" {
		if img, src := s.art.albumCover(b.Artista, b.Album, b.MBRG, b.MBRel); img != nil {
			b.Copertina, b.FonteCop = s.covers.add(img), src
			return true
		}
	}
	if r := s.art.trackAlbum(b.Artista, b.Titolo, b.Durata); r != nil {
		if b.Album == "" {
			b.Album = r.Album
		}
		if b.Anno == 0 {
			b.Anno = r.Year
		}
		b.Copertina, b.FonteCop = s.covers.add(r.Cover), r.Source
	}
	return true
}

var paroleItaliane = map[string]bool{
	"il": true, "gli": true, "una": true, "che": true, "di": true, "del": true, "della": true, "dei": true,
	"non": true, "per": true, "con": true, "sei": true, "sono": true, "ti": true, "mi": true, "io": true,
	"tu": true, "noi": true, "amore": true, "cuore": true, "vita": true, "perche": true, "quando": true,
	"dove": true, "notte": true, "mare": true, "ancora": true, "sempre": true, "nel": true, "nella": true,
	"alla": true, "sul": true, "questa": true, "questo": true, "senza": true, "tutto": true,
	"cosa": true, "piu": true, "anche": true, "ragazzo": true, "ragazza": true, "canzone": true, "estate": true,
	"bella": true, "solo": true, "voglio": true, "mio": true, "mia": true, "tua": true, "tuo": true,
}

// linguaDi capisce se un brano è italiano: dal codice ISRC (IT...) o dalle
// parole del titolo.
func linguaDi(b *brano) string {
	if strings.HasPrefix(strings.ToUpper(b.ISRC), "IT") {
		return "it"
	}
	for _, w := range strings.Fields(normKey(b.Titolo)) {
		if paroleItaliane[w] {
			return "it"
		}
	}
	if b.ISRC != "" {
		return "altro"
	}
	return ""
}
