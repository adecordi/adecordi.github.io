package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Il piano di copia: cosa fare sulla chiavetta perché contenga esattamente
// le playlist. È una funzione pura dello stato (libreria, ultima lettura
// della chiavetta, indici dei dischi): ricalcolandola si ottiene lo stesso
// piano, ed è così che si controlla che una conferma valga ancora.

// Stati di un brano in una playlist.
const (
	stOk          = "ok"             // sulla chiavetta, già a posto
	stSistemare   = "sistemare"      // sulla chiavetta, nome o tag da sistemare
	stDaChiavetta = "da_chiavetta"   // copiato da un altro file della chiavetta
	stDisco       = "disco"          // copiato da un disco collegato
	stStaccato    = "disco_staccato" // su un disco che ora non è collegato
	stConfermare  = "confermare"     // due copie possibili: va scelta a mano
	stRovinato    = "rovinato"       // c'è solo una copia rovinata
	stManca       = "manca"          // non trovato da nessuna parte
)

type rigaPiano struct {
	Playlist string `json:"pl,omitempty"`
	Brano    string `json:"b"`
	Stato    string `json:"st"`
	Disco    string `json:"disco,omitempty"`
	File     string `json:"file,omitempty"` // dove sarà sulla chiavetta
}

type piano struct {
	ID         string         `json:"id"`
	Volume     string         `json:"volume"`
	Etichetta  string         `json:"etichetta,omitempty"`
	Operazioni []operazione   `json:"-"`
	Righe      []rigaPiano    `json:"righe"`
	Conteggi   map[string]int `json:"conteggi"`
	Ops        map[string]int `json:"ops"`
	Byte       int64          `json:"byte"`
	Liberi     uint64         `json:"liberi"`
	Bloccanti  []string       `json:"bloccanti"`
	Avvisi     []string       `json:"avvisi"`
	Tolti      []string       `json:"tolti"`
	Liste      []string       `json:"liste"` // playlist .m3u da scrivere
	Marcatore  []byte         `json:"-"`
	perBrano   map[string]rigaPiano
}

type pianoIn struct {
	lib      *libreria
	stick    *statoChiavetta
	ix       *indiceRicerca
	attached map[string]bool    // dischi e altre chiavette collegati adesso
	labels   map[string]string  // nome dei dischi
	altre    map[string][]fonte // brano -> file sani su altre chiavette lette
	oggi     string
	sito     string
}

// tagsMatch dice se un file della chiavetta ha già i tag e la copertina
// giusti (e un tag ID3v2.3 o 2.4, che leggono tutte le autoradio).
func tagsMatch(f *fileChiavetta, d songTags, cop string) bool {
	r := f.Raw
	switch r.Format {
	case "", "ID3v1", "ID3v2.2":
		return false
	}
	if r.Title != d.Title || r.Artist != d.Artist || r.Album != d.Album || r.Year != d.Year ||
		r.Track != d.Track || r.AlbumArtist != "" {
		return false
	}
	if d.TrackTotal != 0 && r.TrackTotal != d.TrackTotal {
		return false
	}
	if d.Genre != "" && r.Genre != d.Genre {
		return false
	}
	return cop == "" || f.Cop == cop
}

type obiettivo struct {
	b    *brano
	rel  string
	pl   *playlist
	tags songTags
	stato,
	disco string
	op *operazione
}

func calcolaPiano(in pianoIn) *piano {
	p := &piano{Conteggi: map[string]int{}, Ops: map[string]int{}, Bloccanti: []string{}, Avvisi: []string{},
		Tolti: []string{}, Liste: []string{}, perBrano: map[string]rigaPiano{}}
	lower := strings.ToLower

	// 1. dove deve stare ogni brano. Per la Tesla tutto sta nella cartella
	// Music, ogni playlist è una cartella (le .m3u non le legge) e i file
	// hanno il numero davanti, perché li mette in ordine alfabetico.
	tesla := in.lib.tesla()
	top := ""
	if tesla {
		top = musicDir + "/"
	}
	var targets []*obiettivo
	first := map[string]*obiettivo{} // brano -> primo posto (per le .m3u)
	usedFolders := map[string]bool{lower(toltiDir): true, lower(altriBraniDir): true}
	namesIn := map[string]map[string]bool{}
	folderOf := map[string]string{}
	mkTarget := func(folder string, b *brano, pl *playlist, prefix string) {
		t := b.tags()
		names := namesIn[lower(folder)]
		if names == nil {
			names = map[string]bool{}
			namesIn[lower(folder)] = names
		}
		base := prefix + playlistFileName(t)
		name := base
		if names[lower(name)] && b.Album != "" {
			name = safeFileName(base+" ("+b.Album+")", 150)
		}
		for i := 2; names[lower(name)]; i++ {
			name = base + " (" + strconv.Itoa(i) + ")"
		}
		names[lower(name)] = true
		o := &obiettivo{b: b, rel: folder + "/" + name + ".mp3", pl: pl, tags: t}
		targets = append(targets, o)
		if first[b.ID] == nil {
			first[b.ID] = o
		}
	}
	for _, pl := range in.lib.Playlist {
		if pl.Tipo != tipoCartella && !tesla {
			continue
		}
		base := safeFileName(pl.Nome, 60)
		folder := base
		for i := 2; usedFolders[lower(folder)]; i++ {
			folder = base + " " + strconv.Itoa(i)
		}
		usedFolders[lower(folder)] = true
		folderOf[pl.ID] = top + folder
		seen := map[string]bool{}
		var songs []*brano
		for _, id := range pl.Brani {
			if b := in.lib.Brani[id]; b != nil && !seen[id] {
				seen[id] = true
				songs = append(songs, b)
			}
		}
		width := 2
		if len(songs) >= 100 {
			width = 3
		}
		for i, b := range songs {
			prefix := ""
			if tesla {
				prefix = fmt.Sprintf("%0*d - ", width, i+1)
			}
			mkTarget(top+folder, b, pl, prefix)
		}
	}
	for _, pl := range in.lib.Playlist {
		if pl.Tipo != tipoM3U || tesla {
			continue
		}
		for _, id := range pl.Brani {
			if b := in.lib.Brani[id]; b != nil && first[id] == nil {
				mkTarget(altriBraniDir, b, nil, "")
			}
		}
	}

	// 2. i file della chiavetta, per percorso e per brano
	st := in.stick
	byPath := map[string]*fileChiavetta{}
	healthy := map[string][]*fileChiavetta{}
	damaged := map[string][]*fileChiavetta{}
	var mp3s, lists []*fileChiavetta
	if st != nil {
		p.Volume, p.Etichetta, p.Liberi = st.Unita.Volume, st.Unita.nome(), st.Unita.Liberi
		for i := range st.File {
			f := &st.File[i]
			switch {
			case f.Fmt == "m3u":
				lists = append(lists, f)
				continue
			case f.Fmt != "":
				continue // altri formati con estensione .mp3: non si toccano
			}
			mp3s = append(mp3s, f)
			byPath[lower(f.P)] = f
			if id := st.Legami[f.P]; id != "" {
				if f.Rov {
					damaged[id] = append(damaged[id], f)
				} else {
					healthy[id] = append(healthy[id], f)
				}
			}
		}
	}
	used := map[string]bool{}
	var ops []*operazione
	addOp := func(op operazione) *operazione {
		ops = append(ops, &op)
		return &op
	}
	fromStick := func(f *fileChiavetta) fonte { return fonte{Tipo: "chiavetta", P: f.P, S: f.S, M: f.M} }

	// 3a. brani già al loro posto
	for _, o := range targets {
		f := byPath[lower(o.rel)]
		if f == nil || f.Rov || used[f.P] || st.Legami[f.P] != o.b.ID {
			continue
		}
		used[f.P] = true
		switch {
		case f.P != o.rel:
			o.op = addOp(operazione{Tipo: opRiscrivi, Da: f.P, S: f.S, M: f.M, A: o.rel, Tag: &o.tags, Cop: o.b.Copertina, Brano: o.b.ID})
			if tagsMatch(f, o.tags, o.b.Copertina) {
				o.op.Tipo, o.op.Tag, o.op.Cop = opRinomina, nil, ""
			}
			o.stato = stSistemare
		case tagsMatch(f, o.tags, o.b.Copertina):
			o.stato = stOk
		default:
			o.op = addOp(operazione{Tipo: opRiscrivi, Da: f.P, S: f.S, M: f.M, A: o.rel, Tag: &o.tags, Cop: o.b.Copertina, Brano: o.b.ID})
			o.stato = stSistemare
		}
	}
	// 3b. un altro file sano dello stesso brano viene spostato al suo posto
	// (prima quelli che sono già nella cartella giusta)
	for _, o := range targets {
		if o.stato != "" {
			continue
		}
		var same, others []*fileChiavetta
		for _, f := range healthy[o.b.ID] {
			if lower(topFolder(f.P)) == lower(topFolder(o.rel)) {
				same = append(same, f)
			} else {
				others = append(others, f)
			}
		}
		for _, f := range append(same, others...) {
			if used[f.P] {
				continue
			}
			used[f.P] = true
			if tagsMatch(f, o.tags, o.b.Copertina) {
				o.op = addOp(operazione{Tipo: opRinomina, Da: f.P, S: f.S, M: f.M, A: o.rel, Brano: o.b.ID})
			} else {
				o.op = addOp(operazione{Tipo: opRiscrivi, Da: f.P, S: f.S, M: f.M, A: o.rel, Tag: &o.tags, Cop: o.b.Copertina, Brano: o.b.ID})
			}
			o.stato = stSistemare
			break
		}
	}
	// 3c. copie dalla chiavetta o dai dischi
	staccati := map[string]int{}
	for _, o := range targets {
		if o.stato != "" {
			continue
		}
		if hs := healthy[o.b.ID]; len(hs) > 0 {
			o.op = addOp(operazione{Tipo: opCopia, A: o.rel, Tag: &o.tags, Cop: o.b.Copertina, Fonti: []fonte{fromStick(hs[0])}, Brano: o.b.ID})
			o.stato = stDaChiavetta
			continue
		}
		var cands []candidato
		if fs := o.b.Fonte; fs != nil && in.ix != nil {
			if r, ok := in.ix.find(fs.Volume, fs.P); ok {
				cands = []candidato{{Rif: r, F: in.ix.file(r), Punti: 1000}}
			}
		}
		if cands == nil && in.ix != nil {
			cands = in.ix.candidati(o.b.Artista, o.b.Titolo, o.b.Album, o.b.Durata)
		}
		switch {
		case len(cands) == 0 && len(in.altre[o.b.ID]) > 0:
			// sui dischi non c'è, ma c'è su un'altra chiavetta (la vecchia,
			// quando si passa a una nuova)
			var fonti []fonte
			for _, f := range in.altre[o.b.ID] {
				if in.attached[f.Volume] && len(fonti) < 3 {
					fonti = append(fonti, f)
				}
			}
			if len(fonti) == 0 {
				o.stato, o.disco = stStaccato, in.labels[in.altre[o.b.ID][0].Volume]
				staccati[o.disco]++
				continue
			}
			o.op = addOp(operazione{Tipo: opCopia, A: o.rel, Tag: &o.tags, Cop: o.b.Copertina, Fonti: fonti, Brano: o.b.ID})
			o.stato, o.disco = stDisco, in.labels[fonti[0].Volume]
		case len(cands) == 0:
			o.stato = stManca
			for _, f := range damaged[o.b.ID] {
				if used[f.P] {
					continue
				}
				used[f.P] = true
				o.stato = stRovinato
				if lower(f.P) != lower(o.rel) {
					o.op = addOp(operazione{Tipo: opRinomina, Da: f.P, S: f.S, M: f.M, A: o.rel, Brano: o.b.ID})
				}
				break
			}
		case ambiguous(cands) && o.b.Fonte == nil:
			o.stato, o.disco = stConfermare, in.labels[cands[0].Rif.Vol]
		default:
			var fonti []fonte
			for _, c := range cands {
				if in.attached[c.Rif.Vol] && len(fonti) < 3 {
					fonti = append(fonti, fonte{Tipo: "disco", Volume: c.Rif.Vol, P: c.F.P, S: c.F.S, M: c.F.M})
				}
			}
			if len(fonti) == 0 {
				o.stato, o.disco = stStaccato, in.labels[cands[0].Rif.Vol]
				staccati[o.disco]++
				continue
			}
			o.op = addOp(operazione{Tipo: opCopia, A: o.rel, Tag: &o.tags, Cop: o.b.Copertina, Fonti: fonti, Brano: o.b.ID})
			o.stato, o.disco = stDisco, in.labels[fonti[0].Volume]
		}
	}

	// 4. i file che non servono più vanno in _Tolti
	var togli []*operazione
	for _, f := range mp3s {
		if !used[f.P] {
			togli = append(togli, &operazione{Tipo: opTogli, Da: f.P, S: f.S, M: f.M, A: toltiDir + "/" + in.oggi + "/" + f.P})
			p.Tolti = append(p.Tolti, f.P)
		}
	}

	// 5. playlist .m3u
	present := func(o *obiettivo) bool {
		switch o.stato {
		case stOk, stSistemare, stDaChiavetta, stDisco, stRovinato:
			return true
		}
		return false
	}
	var m3uOps []*operazione
	wanted := map[string]bool{}
	for _, pl := range in.lib.Playlist {
		if pl.Tipo != tipoM3U || tesla {
			continue
		}
		var entries []m3uEntry
		for _, id := range pl.Brani {
			if o := first[id]; o != nil && present(o) {
				entries = append(entries, m3uEntry{Path: o.rel, Seconds: int(o.b.Durata + 0.5), Title: o.b.nome()})
			}
		}
		name, content := m3uFile(pl.Nome, entries)
		for i := 2; wanted[lower(name)]; i++ {
			ext := path.Ext(name)
			name = strings.TrimSuffix(name, ext) + " " + strconv.Itoa(i) + ext
		}
		wanted[lower(name)] = true
		p.Liste = append(p.Liste, name)
		sum := sha256.Sum256(content)
		same := false
		for _, f := range lists {
			if lower(f.P) == lower(name) && f.H == hex.EncodeToString(sum[:]) {
				same = true
			}
		}
		if !same {
			m3uOps = append(m3uOps, &operazione{Tipo: opM3U, A: name, Testo: content})
		}
	}
	for _, f := range lists {
		if !wanted[lower(f.P)] {
			togli = append(togli, &operazione{Tipo: opTogli, Da: f.P, S: f.S, M: f.M, A: toltiDir + "/" + in.oggi + "/" + f.P})
			p.Tolti = append(p.Tolti, f.P)
		}
	}

	// 6. ordine: prima si libera, poi si sistema, poi si copia
	var all []*operazione
	all = append(all, togli...)
	for _, op := range ops {
		if op.Tipo == opRinomina || op.Tipo == opRiscrivi {
			all = append(all, op)
		}
	}
	for _, op := range ops {
		if op.Tipo == opCopia {
			all = append(all, op)
		}
	}
	all = append(all, m3uOps...)
	if st == nil {
		all = nil
		p.Bloccanti = append(p.Bloccanti, "La chiavetta non è ancora stata letta: premi «Leggi la chiavetta».")
	}
	var biggest int64
	for i, op := range all {
		op.N = i + 1
		p.Operazioni = append(p.Operazioni, *op)
		p.Ops[op.Tipo]++
		switch op.Tipo {
		case opCopia:
			p.Byte += op.Fonti[0].S + 300<<10
			biggest = max(biggest, op.Fonti[0].S)
		case opRiscrivi:
			p.Byte += 300 << 10
			biggest = max(biggest, op.S)
		case opM3U:
			p.Byte += int64(len(op.Testo))
		}
	}

	// 7. righe per il sito, conteggi e avvisi
	for _, o := range targets {
		r := rigaPiano{Brano: o.b.ID, Stato: o.stato, Disco: o.disco, File: o.rel}
		if o.pl != nil {
			r.Playlist = o.pl.ID
		}
		p.Righe = append(p.Righe, r)
		p.Conteggi[o.stato]++
		if _, ok := p.perBrano[o.b.ID]; !ok {
			p.perBrano[o.b.ID] = r
		}
	}
	if st != nil && p.Liberi > 0 && uint64(p.Byte+biggest) > p.Liberi {
		p.Bloccanti = append(p.Bloccanti, fmt.Sprintf("Sulla chiavetta non c'è spazio: servono %s, ci sono %s liberi. Togli qualche brano dalle playlist.",
			humanBytes(p.Byte+biggest), humanBytes(int64(p.Liberi))))
	}
	for disk, n := range staccati {
		p.Avvisi = append(p.Avvisi, fmt.Sprintf("%s si trovano sul disco «%s», che adesso non è collegato.", plural(n, "Un brano", strconv.Itoa(n)+" brani"), disk))
	}
	if n := p.Conteggi[stConfermare]; n > 0 {
		p.Avvisi = append(p.Avvisi, fmt.Sprintf("%s: ci sono due versioni diverse sui dischi, scegli quella giusta.", plural(n, "Un brano da confermare", strconv.Itoa(n)+" brani da confermare")))
	}
	if n := p.Conteggi[stManca]; n > 0 {
		p.Avvisi = append(p.Avvisi, fmt.Sprintf("%s.", plural(n, "Un brano non è stato trovato né sulla chiavetta né sui dischi", strconv.Itoa(n)+" brani non sono stati trovati né sulla chiavetta né sui dischi")))
	}
	if n := p.Conteggi[stRovinato]; n > 0 {
		p.Avvisi = append(p.Avvisi, fmt.Sprintf("%s: non c'è una copia sana sui dischi.", plural(n, "Un brano è rovinato", strconv.Itoa(n)+" brani sono rovinati")))
	}

	// 8. marcatore e identificativo
	p.Marcatore = buildMarker(in, folderOf, targets, p.Liste)
	js, _ := json.Marshal(struct {
		V string
		O []operazione
	}{p.Volume, p.Operazioni})
	sum := sha256.Sum256(js)
	p.ID = hex.EncodeToString(sum[:8])
	return p
}

type marcatore struct {
	Programma string        `json:"programma"`
	Sito      string        `json:"sito,omitempty"`
	Scritto   string        `json:"scritto"`
	Playlist  []marcatorePl `json:"playlist"`
	Nota      string        `json:"nota"`
}

type marcatorePl struct {
	Nome     string   `json:"nome"`
	Tipo     string   `json:"tipo"`
	Cartella string   `json:"cartella,omitempty"`
	Brani    []string `json:"brani"`
}

// buildMarker descrive le playlist della chiavetta: serve a RiparaMP3 da
// console per non appiattirla, e a chi la guarda per capire com'è fatta.
func buildMarker(in pianoIn, folderOf map[string]string, targets []*obiettivo, liste []string) []byte {
	m := marcatore{Programma: "RiparaMP3 " + version, Sito: in.sito, Scritto: time.Now().In(romeTZ()).Format("02/01/2006 15:04"),
		Nota: "Chiavetta organizzata a playlist dal sito: si modifica da lì."}
	byPl := map[string][]string{}
	for _, o := range targets {
		if o.pl != nil {
			byPl[o.pl.ID] = append(byPl[o.pl.ID], o.rel)
		}
	}
	li := 0
	for _, pl := range in.lib.Playlist {
		mp := marcatorePl{Nome: pl.Nome, Tipo: pl.Tipo, Brani: byPl[pl.ID]}
		if folder, ok := folderOf[pl.ID]; ok {
			mp.Cartella = folder
		} else if li < len(liste) {
			mp.Cartella = liste[li]
			li++
		}
		if mp.Brani == nil {
			mp.Brani = []string{}
		}
		m.Playlist = append(m.Playlist, mp)
	}
	b, _ := json.MarshalIndent(m, "", "  ")
	return b
}

// planLocked calcola il piano con lo stato attuale del sito.
func (s *server) planLocked() *piano {
	in := pianoIn{lib: s.lib, stick: s.chiav[s.lib.Chiavetta], ix: s.ricerca, attached: map[string]bool{}, labels: map[string]string{},
		altre: map[string][]fonte{}, oggi: time.Now().In(romeTZ()).Format("2006-01-02"), sito: s.sito}
	for v, iv := range s.dischi {
		in.labels[v] = iv.Unita.nome()
	}
	// le altre chiavette lette (la vecchia, quando si passa a una nuova, o
	// una importata come playlist)
	vols := make([]string, 0, len(s.chiav))
	for v := range s.chiav {
		vols = append(vols, v)
	}
	sort.Strings(vols)
	for _, v := range vols {
		st := s.chiav[v]
		if v == s.lib.Chiavetta {
			continue
		}
		in.labels[v] = st.Unita.nome() + " (altra chiavetta)"
		for _, f := range st.File {
			if id := st.Legami[f.P]; id != "" && f.Fmt == "" && !f.Rov {
				in.altre[id] = append(in.altre[id], fonte{Tipo: "disco", Volume: v, P: f.P, S: f.S, M: f.M})
			}
		}
	}
	if ag := s.mainAgent(); ag != nil {
		for _, u := range ag.Unita {
			if u.Volume != s.lib.Chiavetta {
				in.attached[u.Volume] = true
			}
			if u.Volume == s.lib.Chiavetta && in.stick != nil && u.Liberi > 0 {
				st := *in.stick
				st.Unita.Liberi = u.Liberi
				in.stick = &st
			}
		}
	}
	return calcolaPiano(in)
}
