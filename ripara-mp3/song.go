package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Stato di salute di un brano.
const (
	stOK  = "ok"  // sano
	stHD  = "hd"  // rovinato, sostituito con la copia trovata sull'hard disk
	stRip = "rip" // rovinato, copia non trovata: ricostruito togliendo le parti rovinate
	stBad = "dif" // rovinato e non riparabile
	stAlt = "alt" // non è un mp3 (altro formato con estensione .mp3)
)

type song struct {
	path       string // posizione attuale
	origRel    string // percorso originale relativo alla chiavetta
	size       int64
	hash       [32]byte
	readErrors int
	info       *mp3Info
	tags       songTags
	raw        songTags // tag così come scritti nel file, prima delle correzioni
	payload    []byte   // audio del file rovinato, tenuto solo per il confronto
	audioHash  [20]byte
	backupPath string

	status  string
	outInfo *mp3Info // analisi del file dopo la riscrittura
	hdPath  string
	hdSim   float64
	removed int

	final        songTags
	coverID      string
	origCoverID  string
	coverResized bool
	coverSource  string
	fromName     bool
	incomplete   bool
	mbFound      bool

	target     string
	dup        bool
	needWrite  bool
	applied    bool   // le modifiche previste sono state fatte
	parkedFrom string // percorso prima di un nome temporaneo (scambi di nome)
	warn       string
	err        string
}

func (s *song) displayName() string {
	if s.final.Artist != "" {
		return s.final.Artist + " - " + s.final.Title
	}
	return s.final.Title
}

// --- Elenco e lettura dei file della chiavetta ------------------------------

func listStick(root string) ([]*song, error) {
	var songs []*song
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if d != nil && d.IsDir() && p != root {
				return fs.SkipDir
			}
			return nil
		}
		name := d.Name()
		lower := strings.ToLower(name)
		if d.IsDir() {
			if p != root && (strings.HasPrefix(name, ".") || strings.HasPrefix(name, "$") ||
				lower == "system volume information" || lower == "_doppioni" || lower == "_rovinati" || strings.HasPrefix(lower, "riparamp3 backup")) {
				return fs.SkipDir
			}
			return nil
		}
		if strings.HasPrefix(name, ".") || !strings.EqualFold(filepath.Ext(name), ".mp3") || !d.Type().IsRegular() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		songs = append(songs, &song{path: p, origRel: rel, size: info.Size()})
		return nil
	})
	sort.Slice(songs, func(i, j int) bool { return strings.ToLower(songs[i].origRel) < strings.ToLower(songs[j].origRel) })
	return songs, err
}

// readTolerant legge un file anche se alcuni blocchi sono illeggibili: i
// blocchi rovinati vengono riempiti di zeri e contati.
func readTolerant(path string) ([]byte, int, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, 0, err
	}
	size := st.Size()
	buf := make([]byte, size)
	const chunk = 256 << 10
	bad := 0
	for off := int64(0); off < size; off += chunk {
		end := off + chunk
		if end > size {
			end = size
		}
		n, err := f.ReadAt(buf[off:end], off)
		if err == nil {
			continue
		}
		if err == io.EOF {
			return buf[:off+int64(n)], bad, nil
		}
		for sub := off; sub < end; sub += 4096 {
			se := sub + 4096
			if se > end {
				se = end
			}
			if _, err := f.ReadAt(buf[sub:se], sub); err != nil && err != io.EOF {
				bad++
				clear(buf[sub:se])
			}
		}
	}
	return buf, bad, nil
}

// load legge il file, ne fa la copia di sicurezza (se richiesta) e lo
// analizza.
func (s *song) load(backupRoot string, covers *coverStore) error {
	data, bad, err := readTolerant(s.path)
	if err != nil {
		s.info = &mp3Info{Defective: true, Problems: []string{"impossibile aprire il file: " + err.Error()}}
		s.status = stBad
		return nil
	}
	s.readErrors = bad
	s.hash = sha256.Sum256(data)
	if backupRoot != "" {
		dst := filepath.Join(backupRoot, s.origRel)
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(dst, data, 0o644); err != nil {
			return err
		}
		s.backupPath = dst
	}
	s.info = analyzeMP3(data, bad)
	if s.info.Format != "" {
		s.status = stAlt
		return nil
	}
	s.raw, s.tags = readTags(data)
	s.raw.Picture = nil
	if len(s.tags.Picture) > 0 {
		if norm, err := normalizeCover(s.tags.Picture); err == nil {
			s.origCoverID = covers.add(norm)
			s.coverResized = !bytes.Equal(norm, s.tags.Picture)
		}
		s.tags.Picture = nil
	}
	if s.info.Frames > 0 {
		s.audioHash = sha1.Sum(audioPayload(data, s.info))
	}
	if s.info.Defective {
		s.status = stBad
	} else {
		s.status = stOK
	}
	return nil
}

// readSource rilegge il contenuto originale del file: dalla copia di
// sicurezza se c'è, altrimenti dalla chiavetta, controllando che sia
// identico a quello analizzato.
func (s *song) readSource() ([]byte, error) {
	if s.backupPath != "" {
		if data, err := os.ReadFile(s.backupPath); err == nil && sha256.Sum256(data) == s.hash {
			return data, nil
		}
	}
	data, _, err := readTolerant(s.path)
	if err != nil {
		return nil, err
	}
	if sha256.Sum256(data) != s.hash {
		return nil, errors.New("la chiavetta restituisce dati diversi a ogni lettura (lettura instabile)")
	}
	return data, nil
}

// freshRead rilegge il file dalla chiavetta (fino a tre volte) per i file
// che avevano blocchi illeggibili: a volte una seconda lettura riesce.
func (s *song) freshRead() ([]byte, int) {
	var best []byte
	bestBad := -1
	for i := 0; i < 3; i++ {
		data, bad, err := readTolerant(s.path)
		if err != nil {
			continue
		}
		if bestBad < 0 || bad < bestBad {
			best, bestBad = data, bad
		}
		if bad == 0 {
			break
		}
	}
	return best, bestBad
}

// --- Tag finali ---------------------------------------------------------------

var reYearInName = regexp.MustCompile(`[\(\[]((?:19|20)\d\d)[\)\]]|^((?:19|20)\d\d)\s*-\s*`)

func (s *song) computeTags(root string, hdTags *songTags) {
	t := s.tags
	t.Picture = nil
	if hdTags != nil {
		if isJunkTitle(t.Title) {
			t.Title = hdTags.Title
		}
		if isJunkArtist(t.Artist) {
			t.Artist = hdTags.Artist
		}
		if t.Album == "" {
			t.Album = hdTags.Album
		}
		if t.Year == 0 {
			t.Year = hdTags.Year
		}
		if t.Track == 0 {
			t.Track, t.TrackTotal = hdTags.Track, hdTags.TrackTotal
		}
		if t.Genre == "" {
			t.Genre = hdTags.Genre
		}
		if t.Lyrics == "" {
			t.Lyrics, t.LyricsLang = hdTags.Lyrics, hdTags.LyricsLang
		}
		if t.Composer == "" {
			t.Composer = hdTags.Composer
		}
	}
	if hdTags != nil {
		// stessa scritta ma con maiuscole/minuscole migliori sulla copia
		t.Title = betterCase(t.Title, hdTags.Title)
		t.Artist = betterCase(t.Artist, hdTags.Artist)
		t.Album = betterCase(t.Album, hdTags.Album)
	}
	t.Title = cleanField(t.Title)
	t.Artist = cleanField(t.Artist)
	t.Album = cleanField(t.Album)
	t.AlbumArtist = cleanField(t.AlbumArtist)
	t.Composer = cleanField(t.Composer)
	if isSpam(t.Comment) {
		t.Comment = ""
	}

	if nt, n := stripLeadTrack(t.Title); n > 0 && nt != "" {
		t.Title = nt
		if t.Track == 0 {
			t.Track = n
		}
	}
	// "Artista - Titolo" scritto tutto nel titolo
	if parts := splitDash(t.Title); len(parts) >= 2 {
		if isJunkArtist(t.Artist) && len(parts) == 2 {
			t.Artist, t.Title = parts[0], parts[1]
		} else if normKey(parts[0]) == normKey(t.Artist) {
			t.Title = strings.Join(parts[1:], " - ")
		}
	}

	fa, ft, ftrack := parseFileName(s.path)
	if isJunkTitle(t.Title) {
		t.Title = ft
		s.fromName = true
	}
	if isJunkArtist(t.Artist) {
		t.Artist = fa
		s.fromName = true
	}
	dir := filepath.Dir(s.path)
	if !samePath(dir, root) {
		folder := fixText(filepath.Base(dir))
		parent := fixText(filepath.Base(filepath.Dir(dir)))
		year := 0
		if m := reYearInName.FindStringSubmatch(folder); m != nil {
			year, _ = strconv.Atoi(m[1] + m[2])
			folder = tidy(reYearInName.ReplaceAllString(folder, " "))
		}
		parts := splitDash(folder)
		switch {
		case isJunkArtist(t.Artist) && len(parts) == 1 && !samePath(filepath.Dir(dir), root) && t.Album == "":
			// Artista\Album\brano.mp3
			t.Artist, t.Album = cleanField(parent), cleanField(folder)
		case isJunkArtist(t.Artist) && len(parts) == 2:
			t.Artist = cleanField(parts[0])
			if t.Album == "" {
				t.Album = cleanField(parts[1])
			}
		case t.Album == "" && len(parts) == 2 && normKey(parts[0]) == normKey(t.Artist):
			t.Album = cleanField(parts[1])
		case t.Album == "" && len(parts) == 1 && normKey(parent) == normKey(t.Artist) && t.Artist != "":
			t.Album = cleanField(folder)
		}
		if t.Year == 0 && year > 0 && t.Album != "" {
			t.Year = year
		}
	}
	if t.Track == 0 && ftrack > 0 && ftrack < 100 {
		t.Track = ftrack
	}
	if isJunkArtist(t.Artist) {
		t.Artist = ""
	}
	if isJunkTitle(t.Title) {
		t.Title = ""
	}
	s.incomplete = t.Artist == "" || t.Title == ""
	if t.Title == "" {
		t.Title = tidy(removeJunk(fixText(strings.TrimSuffix(filepath.Base(s.path), filepath.Ext(s.path)))))
	}
	s.final = t
}

func betterCase(cur, alt string) string {
	if alt != "" && normKey(cur) == normKey(alt) && singleCase(cur) && !singleCase(alt) {
		return alt
	}
	return cur
}

// singleCase dice se un testo è scritto tutto maiuscolo o tutto minuscolo.
func singleCase(s string) bool {
	return strings.ToUpper(s) == s || strings.ToLower(s) == s
}

func samePath(a, b string) bool {
	return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
}

func (s *song) needsLookup() bool {
	return s.status != stAlt && s.final.Artist != "" && s.final.Title != "" &&
		(s.final.Album == "" || s.final.Year == 0 || s.coverID == "" ||
			strings.ToUpper(s.final.Artist) == s.final.Artist || strings.ToUpper(s.final.Title) == s.final.Title)
}

func (s *song) applyMB(r *mbResult) {
	if r == nil || !r.Found {
		return
	}
	s.mbFound = true
	t := &s.final
	if normKey(r.Artist) == normKey(t.Artist) {
		t.Artist = r.Artist
	}
	if normKey(r.Title) == normKey(t.Title) {
		t.Title = r.Title
	}
	if t.Album == "" && r.Album != "" {
		t.Album = r.Album
		if t.Track == 0 {
			t.Track, t.TrackTotal = r.Track, r.TrackTotal
		}
	}
	if t.Year == 0 {
		t.Year = r.Year
	}
}

func albumKey(t songTags) string {
	if t.Album == "" {
		return ""
	}
	a := t.AlbumArtist
	if a == "" {
		a = t.Artist
	}
	return normKey(a) + "|" + normKey(t.Album)
}

// shareCovers dà la stessa copertina a tutti i brani dello stesso album.
func shareCovers(songs []*song) {
	byAlbum := map[string]string{}
	for _, s := range songs {
		if k := albumKey(s.final); k != "" && s.coverID != "" && byAlbum[k] == "" {
			byAlbum[k] = s.coverID
		}
	}
	for _, s := range songs {
		if s.coverID == "" && s.status != stAlt {
			if id := byAlbum[albumKey(s.final)]; id != "" {
				s.coverID = id
				s.coverSource = "album"
			}
		}
	}
}

// folderCovers usa le immagini trovate nelle cartelle (cover.jpg, folder.jpg
// ...) solo se la cartella contiene un unico album.
func folderCovers(songs []*song, covers *coverStore) {
	byDir := map[string][]*song{}
	for _, s := range songs {
		if s.status != stAlt {
			d := filepath.Dir(s.path)
			byDir[d] = append(byDir[d], s)
		}
	}
	for dir, list := range byDir {
		counts := map[string]int{}
		for _, s := range list {
			counts[albumKey(s.final)]++
		}
		best, n := "", 0
		for k, c := range counts {
			if k != "" && c > n {
				best, n = k, c
			}
		}
		if best == "" || n*5 < len(list)*4 {
			continue
		}
		var id string
		loaded := false
		for _, s := range list {
			if s.coverID != "" || albumKey(s.final) != best {
				continue
			}
			if !loaded {
				id = covers.add(folderCover(dir))
				loaded = true
			}
			if id != "" {
				s.coverID = id
				s.coverSource = "cartella"
			}
		}
	}
}

// --- Nomi e doppioni -----------------------------------------------------------

func songQuality(s *song) int {
	q := 0
	switch s.status {
	case stOK:
		q += 100
	case stHD:
		q += 90
	case stRip:
		q += 10
	}
	if s.coverID != "" {
		q += 5
	}
	if s.final.Album != "" {
		q += 2
	}
	if s.final.Year != 0 {
		q++
	}
	return q
}

func planTargets(root string, songs []*song) {
	var zero [20]byte
	byAudio := map[[20]byte][]*song{}
	for _, s := range songs {
		s.dup = false
		if (s.status == stOK || s.status == stHD) && s.audioHash != zero {
			byAudio[s.audioHash] = append(byAudio[s.audioHash], s)
		}
	}
	for _, group := range byAudio {
		if len(group) < 2 {
			continue
		}
		sort.SliceStable(group, func(i, j int) bool { return songQuality(group[i]) > songQuality(group[j]) })
		for _, s := range group[1:] {
			s.dup = true
		}
	}
	named := map[*song]bool{}
	for _, s := range songs {
		cur := strings.TrimSuffix(filepath.Base(s.path), filepath.Ext(s.path))
		named[s] = samePath(filepath.Dir(s.path), root) && strings.EqualFold(cur, safeFileName(s.displayName(), 120))
	}
	ordered := append([]*song(nil), songs...)
	sort.SliceStable(ordered, func(i, j int) bool {
		a, b := ordered[i], ordered[j]
		if a.dup != b.dup {
			return !a.dup
		}
		if named[a] != named[b] {
			// alla seconda esecuzione chi ha già il nome giusto lo tiene
			return named[a]
		}
		if qa, qb := songQuality(a), songQuality(b); qa != qb {
			return qa > qb
		}
		return strings.ToLower(a.origRel) < strings.ToLower(b.origRel)
	})
	used := map[string]bool{}
	usedDup := map[string]bool{}
	for _, s := range songs {
		if s.status == stAlt {
			used[strings.ToLower(filepath.Base(s.path))] = true
		}
	}
	for _, s := range ordered {
		if s.status == stAlt {
			s.target = s.path
			continue
		}
		base := safeFileName(s.displayName(), 120)
		dir, u := root, used
		if s.dup {
			dir, u = filepath.Join(root, "_Doppioni"), usedDup
		}
		name := base
		if u[strings.ToLower(name+".mp3")] && s.final.Album != "" && !s.dup {
			name = safeFileName(s.displayName()+" ("+s.final.Album+")", 150)
		}
		for i := 2; u[strings.ToLower(name+".mp3")]; i++ {
			name = base + " (" + strconv.Itoa(i) + ")"
		}
		u[strings.ToLower(name+".mp3")] = true
		s.target = filepath.Join(dir, name+".mp3")
	}
}

func (s *song) computeNeedWrite() {
	s.needWrite = false
	switch s.status {
	case stAlt, stBad:
		return
	case stHD, stRip:
		s.needWrite = true
		return
	}
	r, f := s.raw, s.final
	switch {
	case r.Title != f.Title, r.Artist != f.Artist, r.Album != f.Album, r.AlbumArtist != f.AlbumArtist,
		r.Genre != f.Genre, r.Year != f.Year, r.Track != f.Track, r.Comment != f.Comment,
		f.TrackTotal != 0 && r.TrackTotal != f.TrackTotal,
		r.Format == "" || r.Format == "ID3v1" || r.Format == "ID3v2.2",
		s.coverID != s.origCoverID, s.coverResized:
		s.needWrite = true
	}
}

// --- Costruzione e scrittura dei file -------------------------------------------

func (s *song) buildContent(covers *coverStore) ([]byte, error) {
	var payload []byte
	switch s.status {
	case stHD:
		data, err := os.ReadFile(s.hdPath)
		if err != nil {
			return nil, fmt.Errorf("impossibile leggere la copia sull'hard disk: %v", err)
		}
		in := analyzeMP3(data, 0)
		if in.Defective || in.Format != "" {
			return nil, errors.New("la copia sull'hard disk non è più integra")
		}
		payload = audioPayload(data, in)
	case stRip:
		var data []byte
		if s.readErrors > 0 {
			// la copia di sicurezza ha zeri al posto dei blocchi illeggibili:
			// meglio riprovare a leggere la chiavetta
			fresh, bad := s.freshRead()
			if fresh != nil && bad == 0 {
				if in := analyzeMP3(fresh, 0); !in.Defective && in.Format == "" {
					s.status, s.info, s.readErrors = stOK, in, 0
					payload = audioPayload(fresh, in)
					break
				}
			}
			data = fresh
		}
		if data == nil {
			var err error
			if data, err = s.readSource(); err != nil {
				return nil, err
			}
		}
		p, removed, err := repairPayload(data)
		if err != nil {
			return nil, err
		}
		payload, s.removed = p, removed
	default:
		data, err := s.readSource()
		if err != nil {
			return nil, err
		}
		payload = data[s.info.FirstFrame:s.info.PayloadEnd]
	}
	t := s.final
	t.Picture = covers.get(s.coverID)
	var out bytes.Buffer
	out.Write(buildID3v23(t))
	out.Write(payload)
	out.Write(buildID3v1(t))
	if s.status != stRip {
		if chk := analyzeMP3(out.Bytes(), 0); chk.Defective {
			return nil, errors.New("il file ricostruito non supera il controllo")
		}
	}
	return out.Bytes(), nil
}

func tempPath(dir string) string {
	var b [6]byte
	rand.Read(b[:])
	return filepath.Join(dir, ".riparamp3-"+hex.EncodeToString(b[:])+".tmp")
}

// writeVerified scrive il file, lo rilegge e controlla che sia identico.
func writeVerified(path string, data []byte) error {
	for attempt := 0; attempt < 2; attempt++ {
		f, err := os.Create(path)
		if err != nil {
			return err
		}
		_, werr := f.Write(data)
		serr := f.Sync()
		cerr := f.Close()
		if werr != nil {
			return werr
		}
		if serr != nil {
			return serr
		}
		if cerr != nil {
			return cerr
		}
		back, bad, err := readTolerant(path)
		if err == nil && bad == 0 && bytes.Equal(back, data) {
			return nil
		}
	}
	return errors.New("dopo la scrittura il file non risulta identico: la chiavetta potrebbe essere danneggiata")
}

// retry ripete un'operazione sui file che può fallire per un attimo, per
// esempio perché l'antivirus sta controllando il file appena scritto.
func retry(fn func() error) error {
	var err error
	for i := 0; i < 5; i++ {
		if err = fn(); err == nil {
			return nil
		}
		time.Sleep(time.Duration(200*(i+1)) * time.Millisecond)
	}
	return err
}

func exists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}

// renameFn e removeFn sono os.Rename e os.Remove; i test le sostituiscono
// per simulare errori.
var (
	renameFn = os.Rename
	removeFn = os.Remove
)

func rename(a, b string) error { return retry(func() error { return renameFn(a, b) }) }

func sameFile(a, b string) bool {
	if filepath.Clean(a) == filepath.Clean(b) {
		return true
	}
	if !samePath(a, b) {
		return false
	}
	fa, err1 := os.Stat(a)
	fb, err2 := os.Stat(b)
	return err1 == nil && err2 == nil && os.SameFile(fa, fb)
}

// replaceFile scrive il nuovo contenuto in `target` al posto di `old`.
// L'originale non viene mai tolto prima che il file nuovo sia al suo posto:
// se qualcosa va storto resta intatto. Se keep non è vuoto, il file vecchio
// viene spostato lì invece di essere cancellato. warn segnala problemi che
// non impediscono la sostituzione.
func replaceFile(old, target string, content []byte, keep string) (warn string, err error) {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return "", err
	}
	tmp := tempPath(filepath.Dir(target))
	if err := writeVerified(tmp, content); err != nil {
		os.Remove(tmp)
		return "", err
	}
	exact := filepath.Clean(old) == filepath.Clean(target)
	switch {
	case exact && keep == "":
		// sostituzione in un colpo solo: se non riesce l'originale resta
		if err := rename(tmp, target); err != nil {
			os.Remove(tmp)
			return "", err
		}
		return "", nil
	case exact || keep != "" || sameFile(old, target):
		// il vecchio file viene prima messo da parte, poi il nuovo prende il
		// suo posto; se non riesce il vecchio torna dov'era
		park := keep
		if park == "" {
			park = tempPath(filepath.Dir(old))
		} else {
			os.MkdirAll(filepath.Dir(park), 0o755)
			if exists(park) {
				park = freeName(park)
			}
		}
		if err := rename(old, park); err != nil {
			os.Remove(tmp)
			return "", err
		}
		if err := rename(tmp, target); err != nil {
			renameFn(park, old)
			os.Remove(tmp)
			return "", err
		}
		if keep == "" {
			if err := retry(func() error { return removeFn(park) }); err != nil {
				return "la versione vecchia è rimasta in " + park, nil
			}
		}
		return "", nil
	default:
		// il nome nuovo è libero (lo controlla chi chiama)
		if err := rename(tmp, target); err != nil {
			os.Remove(tmp)
			return "", err
		}
		if err := retry(func() error { return removeFn(old) }); err != nil {
			return "non è stato possibile cancellare la versione vecchia " + old, nil
		}
		return "", nil
	}
}

func moveFile(old, target string) error {
	if filepath.Clean(old) == filepath.Clean(target) {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	if sameFile(old, target) {
		// cambia solo maiuscole/minuscole: serve un passaggio intermedio
		tmp := tempPath(filepath.Dir(target))
		if err := rename(old, tmp); err != nil {
			return err
		}
		if err := rename(tmp, target); err != nil {
			renameFn(tmp, old)
			return err
		}
		return nil
	}
	return rename(old, target)
}
