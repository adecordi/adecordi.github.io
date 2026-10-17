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
	defer func() {
		restoreParked(root, songs, lg)
		removeEmptyDirs(root, dirs)
	}()
	for len(pending) > 0 {
		var rest []*song
		progressed := false
		for i, s := range pending {
			if stopRequested.Load() {
				lg.add("INTERROTTO", "%d file non sistemati", len(pending)-i+len(rest))
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
			// brani che si scambiano il nome: uno passa da un nome temporaneo
			s := rest[0]
			tmp := tempPath(filepath.Dir(s.path))
			if err := rename(s.path, tmp); err != nil {
				s.err = err.Error()
				lg.add("ERRORE", "%s: %v", relPath(root, s.path), err)
				rest = rest[1:]
			} else {
				dirs[filepath.Dir(s.path)] = true
				s.parkedFrom, s.path = s.path, tmp
			}
		}
		pending = rest
	}
}

// restoreParked rimette al loro nome i brani rimasti con un nome temporaneo
// (per un'interruzione o un errore).
func restoreParked(root string, songs []*song, lg *logger) {
	for _, s := range songs {
		if s.parkedFrom == "" || s.applied {
			continue
		}
		dest := s.parkedFrom
		if exists(dest) {
			if s.target != "" && !exists(s.target) {
				dest = s.target
			} else {
				dest = freeName(s.parkedFrom)
			}
		}
		if err := rename(s.path, dest); err != nil {
			lg.add("ERRORE", "%s è rimasto con il nome temporaneo %s", s.origRel, relPath(root, s.path))
			continue
		}
		s.path = dest
		s.parkedFrom = ""
	}
}

func applyOne(root string, s *song, covers *coverStore, lg *logger) {
	oldRel := relPath(root, s.path)
	newRel := relPath(root, s.target)
	if s.needWrite {
		content, err := s.buildContent(covers)
		warn := ""
		if err == nil {
			keep := ""
			if s.status == stRip && s.readErrors > 0 {
				// l'originale ha settori illeggibili: lo si conserva a parte
				keep = filepath.Join(root, "_Rovinati", filepath.Base(s.origRel))
			}
			warn, err = replaceFile(s.path, s.target, content, keep)
			if err == nil && keep != "" {
				lg.add("CONSERVATO", "originale illeggibile spostato in _Rovinati: %s", filepath.Base(s.origRel))
			}
		}
		if err != nil {
			s.err = err.Error()
			lg.add("ERRORE", "%s: %v", oldRel, err)
			return
		}
		if warn != "" {
			s.warn = warn
			lg.add("ATTENZIONE", "%s: %s", newRel, warn)
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
	s.applied = true
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
		for d != "" && !samePath(d, root) && isUnder(d, []string{root}) {
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
