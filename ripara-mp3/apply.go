package main

import (
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// applyAll esegue sulla chiavetta le sostituzioni, le riscritture dei tag e
// le rinomine decise prima.
func applyAll(root string, songs []*song, covers *coverStore, lg *logger, progress func(i, n int, name string)) {
	var pending []*song
	for _, s := range songs {
		if s.status == stAlt {
			continue
		}
		if s.needWrite || filepath.Clean(s.path) != filepath.Clean(s.target) {
			pending = append(pending, s)
		}
	}
	total, done := len(pending), 0
	dirs := map[string]bool{}
	for len(pending) > 0 {
		var rest []*song
		progressed := false
		for i, s := range pending {
			if stopRequested.Load() {
				lg.add("INTERROTTO", "%d file non sistemati", len(pending)-i+len(rest))
				removeEmptyDirs(root, dirs)
				return
			}
			if exists(s.target) && !sameFile(s.path, s.target) {
				owned := false
				for _, o := range pending {
					if o != s && sameFile(o.path, s.target) {
						owned = true
						break
					}
				}
				if owned {
					// il nome è ancora occupato da un brano che verrà spostato
					rest = append(rest, s)
					continue
				}
				s.target = freeName(s.target)
			}
			done++
			if progress != nil {
				progress(done, total, s.displayName())
			}
			dirs[filepath.Dir(s.path)] = true
			applyOne(root, s, covers, lg)
			progressed = true
		}
		if !progressed && len(rest) > 0 {
			// due brani che si scambiano il nome: uno passa da un nome temporaneo
			s := rest[0]
			tmp := tempPath(filepath.Dir(s.path))
			if err := os.Rename(s.path, tmp); err != nil {
				s.err = err.Error()
				lg.add("ERRORE", "%s: %v", relPath(root, s.path), err)
				rest = rest[1:]
			} else {
				s.path = tmp
			}
		}
		pending = rest
	}
	removeEmptyDirs(root, dirs)
}

func applyOne(root string, s *song, covers *coverStore, lg *logger) {
	oldRel := relPath(root, s.path)
	newRel := relPath(root, s.target)
	if s.needWrite {
		content, err := s.buildContent(covers)
		if err == nil {
			err = replaceFile(s.path, s.target, content)
		}
		if err != nil {
			s.err = err.Error()
			s.target = s.path
			lg.add("ERRORE", "%s: %v", oldRel, err)
			return
		}
		s.outInfo = analyzeMP3(content, 0)
		s.size = int64(len(content))
		switch s.status {
		case stHD:
			lg.add("RECUPERATO", "%s -> %s (copia sana da %s)", s.origRel, newRel, s.hdPath)
		case stRip:
			lg.add("RIPARATO", "%s -> %s (tolti %s di dati rovinati)", s.origRel, newRel, humanBytes(int64(s.removed)))
		default:
			if s.dup {
				lg.add("DOPPIONE", "%s -> %s", s.origRel, newRel)
			} else if oldRel != newRel {
				lg.add("SISTEMATO", "%s -> %s (nome e tag)", s.origRel, newRel)
			} else {
				lg.add("TAG", "%s", newRel)
			}
		}
	} else {
		if err := moveFile(s.path, s.target); err != nil {
			s.err = err.Error()
			s.target = s.path
			lg.add("ERRORE", "%s: %v", oldRel, err)
			return
		}
		kind := "RINOMINATO"
		if s.dup {
			kind = "DOPPIONE"
		}
		lg.add(kind, "%s -> %s", s.origRel, newRel)
	}
	s.path = s.target
}

func relPath(root, p string) string {
	if r, err := filepath.Rel(root, p); err == nil {
		return r
	}
	return p
}

func freeName(target string) string {
	ext := filepath.Ext(target)
	base := strings.TrimSuffix(target, ext)
	for i := 2; ; i++ {
		p := base + " (" + strconv.Itoa(i) + ")" + ext
		if !exists(p) {
			return p
		}
	}
}

// removeEmptyDirs toglie le cartelle rimaste completamente vuote dopo lo
// spostamento dei brani.
func removeEmptyDirs(root string, dirs map[string]bool) {
	var list []string
	for d := range dirs {
		for d != "" && !samePath(d, root) && strings.HasPrefix(strings.ToLower(d), strings.ToLower(filepath.Clean(root))) {
			list = append(list, d)
			parent := filepath.Dir(d)
			if parent == d {
				break
			}
			d = parent
		}
	}
	sort.Slice(list, func(i, j int) bool { return len(list[i]) > len(list[j]) })
	for _, d := range list {
		os.Remove(d)
	}
}
