package main

import (
	"math"
	"path"
	"sort"
	"strings"
)

// Ricerca negli indici dei dischi: per nome (dal sito) e per trovare la
// copia migliore di ogni brano delle playlist.

type rifDisco struct {
	Vol string
	I   int
}

type chiaviFile struct {
	tag, file, name, loose, title string
	artist, text                  string
}

type indiceRicerca struct {
	vols    map[string]*indiceVolume
	keys    map[rifDisco]*chiaviFile
	byTag   map[string][]rifDisco
	byFile  map[string][]rifDisco
	byName  map[string][]rifDisco
	byTitle map[string][]rifDisco
	order   []rifDisco
}

func (s *server) rebuildSearch() {
	s.ricerca = buildSearchIndex(s.dischi)
}

func (s *server) rebuildSearchLocked() { s.rebuildSearch() }

func buildSearchIndex(vols map[string]*indiceVolume) *indiceRicerca {
	ix := &indiceRicerca{vols: vols, keys: map[rifDisco]*chiaviFile{}, byTag: map[string][]rifDisco{},
		byFile: map[string][]rifDisco{}, byName: map[string][]rifDisco{}, byTitle: map[string][]rifDisco{}}
	names := make([]string, 0, len(vols))
	for v := range vols {
		names = append(names, v)
	}
	sort.Strings(names)
	for _, v := range names {
		iv := vols[v]
		for i := range iv.File {
			f := &iv.File[i]
			r := rifDisco{v, i}
			a, t := cleanField(f.A), cleanField(f.T)
			k := &chiaviFile{tag: pairKey(a, t), title: normKey(stripParens(t)), artist: a}
			k.name, k.loose, k.file = fileKeys(f.P)
			k.text = normKey(a + " " + t + " " + f.Al + " " + strings.TrimSuffix(path.Base(f.P), path.Ext(f.P)))
			ix.keys[r] = k
			ix.order = append(ix.order, r)
			for m, key := range map[*map[string][]rifDisco]string{&ix.byTag: k.tag, &ix.byFile: k.file, &ix.byTitle: k.title} {
				if key != "" {
					(*m)[key] = append((*m)[key], r)
				}
			}
			for _, key := range []string{k.name, k.loose} {
				if key != "" {
					ix.byName[key] = append(ix.byName[key], r)
				}
			}
		}
	}
	return ix
}

func (ix *indiceRicerca) file(r rifDisco) *fileDisco {
	iv := ix.vols[r.Vol]
	if iv == nil || r.I < 0 || r.I >= len(iv.File) {
		return nil
	}
	return &iv.File[r.I]
}

// find cerca un file per volume e percorso.
func (ix *indiceRicerca) find(vol, p string) (rifDisco, bool) {
	iv := ix.vols[vol]
	if iv == nil {
		return rifDisco{}, false
	}
	for i := range iv.File {
		if iv.File[i].P == p {
			return rifDisco{vol, i}, true
		}
	}
	return rifDisco{}, false
}

// cerca restituisce i file in cui compaiono tutte le parole cercate.
func (ix *indiceRicerca) cerca(q string, max int) []rifDisco {
	words := strings.Fields(normKey(q))
	if len(words) == 0 {
		return nil
	}
	var out []rifDisco
	for _, r := range ix.order {
		text := " " + ix.keys[r].text + " "
		ok := true
		for _, w := range words {
			if !strings.Contains(text, " "+w) {
				ok = false
				break
			}
		}
		if ok {
			out = append(out, r)
			if len(out) >= max {
				break
			}
		}
	}
	return out
}

type candidato struct {
	Rif   rifDisco
	F     *fileDisco
	Punti int
}

// candidati trova le copie di un brano sui dischi, dalla migliore. Contano
// artista e titolo (dai tag o dal nome del file), la durata, il bitrate; le
// versioni dal vivo o remix sono penalizzate se il brano non lo è.
func (ix *indiceRicerca) candidati(artista, titolo, album string, durata float64) []candidato {
	if ix == nil || titolo == "" {
		return nil
	}
	base := map[rifDisco]int{}
	add := func(list []rifDisco, pts int) {
		for _, r := range list {
			if pts > base[r] {
				base[r] = pts
			}
		}
	}
	k := pairKey(artista, titolo)
	if k != "" {
		add(ix.byTag[k], 100)
		add(ix.byFile[k], 80)
	}
	add(ix.byName[normKey(artista+" "+titolo)], 50)
	for _, r := range ix.byTitle[normKey(stripParens(titolo))] {
		if artistMatch(ix.keys[r].artist, artista) && base[r] < 70 {
			base[r] = 70
		}
	}
	wantVersion := isVersionTitle(titolo)
	var out []candidato
	for r, pts := range base {
		f := ix.file(r)
		if f == nil {
			continue
		}
		if durata > 0 && f.D > 0 {
			switch d := math.Abs(durata - f.D); {
			case d <= 2:
				pts += 30
			case d <= 5:
				pts += 15
			case d <= 10:
			case d <= 20:
				pts -= 30
			default:
				continue
			}
		}
		if !wantVersion && (isVersionTitle(f.T) || isVersionTitle(f.Al) || isVersionTitle(path.Base(f.P))) {
			pts -= 60
		}
		if f.T != "" && normKey(f.T) == normKey(titolo) {
			pts += 10
		}
		if album != "" && f.Al != "" && albumMatchKey(f.Al) == albumMatchKey(album) {
			pts += 10
		}
		pts += min(f.B, 320) / 32
		if pts >= 90 {
			out = append(out, candidato{r, f, pts})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Punti != out[j].Punti {
			return out[i].Punti > out[j].Punti
		}
		if out[i].Rif.Vol != out[j].Rif.Vol {
			return out[i].Rif.Vol < out[j].Rif.Vol
		}
		return out[i].Rif.I < out[j].Rif.I
	})
	return out
}

// ambiguous: due copie quasi alla pari ma con audio chiaramente diverso
// (per esempio album e dal vivo con gli stessi tag).
func ambiguous(c []candidato) bool {
	if len(c) < 2 || c[0].Punti-c[1].Punti >= 15 {
		return false
	}
	return c[0].F.D > 0 && c[1].F.D > 0 && math.Abs(c[0].F.D-c[1].F.D) > 3
}
