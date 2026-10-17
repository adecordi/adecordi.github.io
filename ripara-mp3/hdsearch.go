package main

import (
	"bytes"
	"io"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

// Indice degli mp3 presenti sull'hard disk, usato per trovare una copia sana
// dei file rovinati sulla chiavetta.

type hdFile struct {
	path     string
	size     int64
	nameKey  string // nome del file normalizzato
	looseKey string // come nameKey, senza numero di traccia iniziale
	pairKey  string // "artista|titolo" ricavato dal nome del file

	once     sync.Once
	tagKey   string
	duration float64
}

type hdIndex struct {
	files  []*hdFile
	bySize map[int64][]*hdFile
	byKey  map[string][]*hdFile

	tagOnce sync.Once
	byTag   map[string][]*hdFile
}

// Cartelle di sistema da non esplorare.
var skipAnywhere = map[string]bool{
	"$recycle.bin": true, "system volume information": true, "appdata": true,
	"node_modules": true, ".git": true, "windowsapps": true, "_doppioni": true,
}

var skipAtRoot = map[string]bool{
	"windows": true, "program files": true, "program files (x86)": true, "programdata": true,
	"recovery": true, "$winreagent": true, "perflogs": true, "msocache": true, "$windows.~bt": true,
	"$windows.~ws": true, "proc": true, "sys": true, "dev": true,
}

func pairKey(artist, title string) string {
	if artist == "" || title == "" {
		return ""
	}
	return normKey(artist) + "|" + normKey(stripParens(title))
}

var reAnyLeadNum = regexp.MustCompile(`^\d{1,3}(\s|$)`)

func fileKeys(path string) (nameKey, loose, pk string) {
	base := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	a, t, _ := parseFileName(path)
	nameKey = normKey(removeJunk(base))
	if l := strings.TrimSpace(reAnyLeadNum.ReplaceAllString(nameKey, "")); l != "" && l != nameKey {
		loose = l
	}
	return nameKey, loose, pairKey(a, t)
}

func isUnder(path string, roots []string) bool {
	p := strings.ToLower(filepath.Clean(path))
	for _, r := range roots {
		r = strings.ToLower(filepath.Clean(r))
		if r == "" {
			continue
		}
		if p == r || strings.HasPrefix(p, strings.TrimSuffix(r, string(filepath.Separator))+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

func buildHDIndex(roots, exclude []string, progress func(dirs, mp3s int, dir string)) *hdIndex {
	idx := &hdIndex{bySize: map[int64][]*hdFile{}, byKey: map[string][]*hdFile{}}
	dirs := 0
	for _, root := range roots {
		root = filepath.Clean(root)
		filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				if d != nil && d.IsDir() {
					return fs.SkipDir
				}
				return nil
			}
			if d.IsDir() {
				name := strings.ToLower(d.Name())
				if p != root {
					if skipAnywhere[name] || strings.HasPrefix(name, "riparamp3 backup") {
						return fs.SkipDir
					}
					if filepath.Dir(p) == root && skipAtRoot[name] {
						return fs.SkipDir
					}
				}
				if isUnder(p, exclude) {
					return fs.SkipDir
				}
				dirs++
				if progress != nil && dirs%200 == 0 {
					progress(dirs, len(idx.files), p)
				}
				return nil
			}
			if !strings.EqualFold(filepath.Ext(p), ".mp3") || d.Type()&fs.ModeSymlink != 0 {
				return nil
			}
			info, err := d.Info()
			if err != nil || info.Size() < 10<<10 {
				return nil
			}
			f := &hdFile{path: p, size: info.Size()}
			f.nameKey, f.looseKey, f.pairKey = fileKeys(p)
			idx.files = append(idx.files, f)
			idx.bySize[f.size] = append(idx.bySize[f.size], f)
			seen := map[string]bool{}
			for _, k := range []string{f.nameKey, f.looseKey, f.pairKey} {
				if k != "" && !seen[k] {
					seen[k] = true
					idx.byKey[k] = append(idx.byKey[k], f)
				}
			}
			return nil
		})
	}
	if progress != nil {
		progress(dirs, len(idx.files), "")
	}
	return idx
}

// readHead legge solo i tag iniziali e il primo frame: basta per artista,
// titolo e durata senza leggere tutto il file.
func (f *hdFile) loadTags() {
	f.once.Do(func() {
		fh, err := os.Open(f.path)
		if err != nil {
			return
		}
		defer fh.Close()
		head := make([]byte, 10)
		if _, err := io.ReadFull(fh, head); err != nil {
			return
		}
		n := 64 << 10
		if sz := id3v2Size(head); sz > 0 && sz < 16<<20 {
			n = sz + 16<<10
		}
		if int64(n) > f.size {
			n = int(f.size)
		}
		buf := make([]byte, n)
		copy(buf, head)
		io.ReadFull(fh, buf[10:])
		// aggiunge in coda gli ultimi 128 byte per l'eventuale ID3v1
		tail := make([]byte, 128)
		if f.size > int64(n)+128 {
			if _, err := fh.ReadAt(tail, f.size-128); err == nil && string(tail[:3]) == "TAG" {
				buf = append(buf, tail...)
			}
		}
		_, t := readTags(buf)
		f.tagKey = pairKey(cleanField(t.Artist), cleanField(t.Title))
		f.duration = estimateDuration(buf, f.size)
	})
}

func estimateDuration(head []byte, size int64) float64 {
	start := 0
	for {
		n := id3v2Size(head[start:])
		if n == 0 || start+n >= len(head) {
			break
		}
		start += n
	}
	p, h, ok := findSync(head, start, len(head), nil, 3)
	if !ok {
		return 0
	}
	f := frameRef{p, h.length}
	if p+h.length <= len(head) {
		if x := parseXing(head, f, h); x != nil && x.frames > 0 {
			return float64(x.frames*h.samples) / float64(h.sampleRate)
		}
	}
	return float64(size-int64(p)) * 8 / float64(h.bitrate*1000)
}

func (idx *hdIndex) buildTagIndex() {
	idx.tagOnce.Do(func() {
		idx.byTag = map[string][]*hdFile{}
		var wg sync.WaitGroup
		ch := make(chan *hdFile)
		for i := 0; i < 4; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for f := range ch {
					func() {
						defer func() { recover() }()
						f.loadTags()
					}()
				}
			}()
		}
		for _, f := range idx.files {
			ch <- f
		}
		close(ch)
		wg.Wait()
		for _, f := range idx.files {
			if f.tagKey != "" {
				idx.byTag[f.tagKey] = append(idx.byTag[f.tagKey], f)
			}
		}
	})
}

type hdMatch struct {
	file       *hdFile
	data       []byte
	info       *mp3Info
	similarity float64 // frazione di blocchi identici (0 se non confrontabile)
}

// findGoodCopy cerca sull'hard disk una copia integra del brano.
func (idx *hdIndex) findGoodCopy(s *song) *hdMatch {
	if idx == nil || len(idx.files) == 0 {
		return nil
	}
	seen := map[*hdFile]bool{}
	var strong, byName []*hdFile
	for _, f := range idx.bySize[s.size] {
		if !seen[f] {
			seen[f] = true
			strong = append(strong, f)
		}
	}
	nameKey, loose, filePair := fileKeys(s.path)
	tagKeys := []string{pairKey(s.tags.Artist, s.tags.Title), pairKey(s.final.Artist, s.final.Title)}
	byPair := map[*hdFile]bool{}
	for i, k := range []string{filePair, tagKeys[0], tagKeys[1], nameKey, loose} {
		if k == "" {
			continue
		}
		for _, f := range idx.byKey[k] {
			if i < 3 && f.pairKey == k {
				byPair[f] = true
			}
			if !seen[f] {
				seen[f] = true
				byName = append(byName, f)
			}
		}
	}
	var best *hdMatch
	consider := func(f *hdFile, needSimilar bool) {
		if s.info.Frames == 0 {
			// del file della chiavetta non resta audio da confrontare: si
			// accetta solo una copia con lo stesso artista e titolo e una
			// dimensione simile
			ratio := float64(f.size) / float64(s.size)
			if !byPair[f] || ratio < 0.85 || ratio > 1.15 {
				return
			}
		}
		data, err := os.ReadFile(f.path)
		if err != nil {
			return
		}
		info := analyzeMP3(data, 0)
		if info.Format != "" || info.Defective {
			return
		}
		m := &hdMatch{file: f, data: data, info: info}
		m.similarity = similarity(s, info, data)
		durOK := s.info.Duration == 0 ||
			(info.Duration >= s.info.Duration-2 && info.Duration <= s.info.Duration+2+s.info.LostSec+s.info.MissingSec)
		switch {
		case m.similarity >= 0.8:
		case needSimilar:
			return
		case !durOK:
			return
		}
		if best == nil || m.similarity > best.similarity ||
			(m.similarity == best.similarity && math.Abs(float64(info.Bitrate-s.info.Bitrate)) < math.Abs(float64(best.info.Bitrate-s.info.Bitrate))) {
			best = m
		}
	}
	for _, f := range strong {
		consider(f, true)
		if best != nil && best.similarity >= 0.99 {
			return best
		}
	}
	for _, f := range byName {
		consider(f, false)
		if best != nil && best.similarity >= 0.99 {
			return best
		}
	}
	if best == nil {
		// nessuna copia valida con lo stesso nome: si cercano i tag di tutti
		// gli mp3 dell'hard disk
		idx.buildTagIndex()
		for _, k := range tagKeys {
			for _, f := range idx.byTag[k] {
				if k != "" && !seen[f] {
					seen[f] = true
					byPair[f] = true
					consider(f, false)
				}
			}
		}
	}
	return best
}

// similarity confronta l'audio del file della chiavetta con quello di una
// copia, a blocchi di 64 KB: un file rovinato da settori difettosi resta
// identico all'originale tranne che nei blocchi danneggiati.
func similarity(s *song, info *mp3Info, data []byte) float64 {
	if s.payload == nil || info.Frames == 0 {
		return 0
	}
	a := s.payload
	b := data[info.FirstFrame:info.PayloadEnd]
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	n := len(a)
	if len(b) > n {
		n = len(b)
	}
	if math.Abs(float64(len(a)-len(b))) > float64(n)*0.05 {
		return 0
	}
	const blk = 64 << 10
	same, total := 0, 0
	for off := 0; off < n; off += blk {
		total++
		ea, eb := off+blk, off+blk
		if ea > len(a) {
			ea = len(a)
		}
		if eb > len(b) {
			eb = len(b)
		}
		if off < ea && off < eb && bytes.Equal(a[off:ea], b[off:eb]) {
			same++
		}
	}
	return float64(same) / float64(total)
}
