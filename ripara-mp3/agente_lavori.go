package main

import (
	"bytes"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// I lavori che il sito chiede all'agente.

// --- Impronte già calcolate -------------------------------------------------------

type fpCache struct {
	mu    sync.Mutex
	path  string
	m     map[string]string // sha256 del file -> impronta
	dirty bool
}

func loadFPCache(dir string) *fpCache {
	c := &fpCache{path: filepath.Join(dir, "impronte.json.gz"), m: map[string]string{}}
	readJSONGz(c.path, &c.m)
	if c.m == nil {
		c.m = map[string]string{}
	}
	return c
}

func (c *fpCache) get(h string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	fp, ok := c.m[h]
	return fp, ok
}

func (c *fpCache) put(h, fp string) {
	c.mu.Lock()
	c.m[h] = fp
	c.dirty = true
	c.mu.Unlock()
}

func (c *fpCache) save() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.dirty {
		writeJSONGz(c.path, c.m)
		c.dirty = false
	}
}

// cleanTemp toglie i file temporanei lasciati da un lavoro interrotto (per
// esempio dalla chiavetta staccata durante la copia).
func cleanTemp(root string) {
	filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if d != nil && d.IsDir() && p != root {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			if p != root && strings.EqualFold(d.Name(), "System Volume Information") {
				return fs.SkipDir
			}
			return nil
		}
		if strings.HasPrefix(d.Name(), ".riparamp3-") && strings.HasSuffix(d.Name(), ".tmp") {
			os.Remove(p)
		}
		return nil
	})
}

// --- Lettura della chiavetta ---------------------------------------------------------

func (a *agent) scanStick(jr *jobRun, raw json.RawMessage) error {
	var p paramScansiona
	json.Unmarshal(raw, &p)
	u, err := a.stickUnit(p.Volume)
	if err != nil {
		return err
	}
	n, err := a.sendStick(jr, u)
	if err != nil {
		return err
	}
	jr.summary = fmt.Sprintf("Letti %d brani dalla chiavetta %s.", n, u.nome())
	return nil
}

// readStickFile legge e analizza un file della chiavetta; restituisce anche
// la copertina incorporata, già normalizzata.
func readStickFile(root, path, bin string, fpc *fpCache) (fileChiavetta, []byte) {
	fc := fileChiavetta{P: relSlash(root, path)}
	st, err := os.Stat(path)
	if err != nil {
		fc.Rov, fc.Problemi = true, []string{"impossibile aprire il file: " + err.Error()}
		return fc, nil
	}
	fc.S, fc.M = st.Size(), st.ModTime().Unix()
	data, bad, err := readTolerant(path)
	if err != nil {
		fc.Rov, fc.Problemi = true, []string{"impossibile aprire il file: " + err.Error()}
		return fc, nil
	}
	sum := sha256.Sum256(data)
	fc.H = hex.EncodeToString(sum[:])
	info := analyzeMP3(data, bad)
	fc.Dur, fc.Kbps = info.Duration, info.Bitrate
	if info.Format != "" {
		fc.Fmt = info.Format
		return fc, nil
	}
	fc.Rov, fc.Problemi = info.Defective, info.Problems
	rawTags, t := readTags(data)
	pic := t.Picture
	rawTags.Picture, t.Picture = nil, nil
	fc.Raw, fc.Tag = rawTags, t
	var cover []byte
	if len(pic) > 0 {
		if norm, err := normalizeCover(pic); err == nil {
			cover = norm
			fc.Cop = coverID(norm)
			if cfg, _, err := image.DecodeConfig(bytes.NewReader(norm)); err == nil {
				fc.CopLato = min(cfg.Width, cfg.Height)
			}
		}
	}
	if info.Frames > 0 {
		au := sha1.Sum(audioPayload(data, info))
		fc.AU = hex.EncodeToString(au[:])
	}
	if bin != "" && info.Duration >= 10 {
		if fp, ok := fpc.get(fc.H); ok {
			fc.FP = fp
		} else {
			audio := data
			if info.Defective {
				if p, _, err := repairPayload(data); err == nil {
					audio = p
				}
			}
			if fp, err := fingerprintAudio(bin, audio); err == nil {
				fc.FP = fp
				fpc.put(fc.H, fp)
			}
		}
	}
	return fc, cover
}

// sendStick legge tutta la chiavetta e la manda al sito a pezzi.
func (a *agent) sendStick(jr *jobRun, u unita) (int, error) {
	root := u.Lettera
	cleanTemp(root)
	u.Liberi = freeSpace(root)
	info := infoChiavetta{Unita: u}
	if b, err := os.ReadFile(filepath.Join(root, markerFile)); err == nil && len(b) < 4<<20 && json.Valid(b) {
		info.Marcatore = b
	}
	if _, err := jr.send(parteChiavetta, info); err != nil {
		return 0, err
	}
	songs, err := listStick(root)
	if err != nil && len(songs) == 0 {
		return 0, fmt.Errorf("non riesco a leggere la chiavetta: %v", err)
	}
	var lists []fileChiavetta
	entries, _ := os.ReadDir(root)
	for _, e := range entries {
		ext := strings.ToLower(filepath.Ext(e.Name()))
		if e.IsDir() || (ext != ".m3u" && ext != ".m3u8") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(root, e.Name()))
		if err != nil {
			continue
		}
		st, _ := e.Info()
		sum := sha256.Sum256(b)
		lists = append(lists, fileChiavetta{P: e.Name(), S: int64(len(b)), M: st.ModTime().Unix(), H: hex.EncodeToString(sum[:]), Fmt: "m3u"})
	}

	bin, _ := fpcalcBinary(a.o.fpcalc)
	fpc := loadFPCache(a.cache)
	defer fpc.save()
	results := make([]fileChiavetta, len(songs))
	var cmu sync.Mutex
	coverData := map[string][]byte{}
	idx := make(chan int)
	done := make(chan int)
	var wg sync.WaitGroup
	for w := 0; w < 4; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range idx {
				func() {
					defer func() {
						if r := recover(); r != nil {
							results[i] = fileChiavetta{P: relSlash(root, songs[i].path), Rov: true, Problemi: []string{fmt.Sprint(r)}}
						}
					}()
					fc, cover := readStickFile(root, songs[i].path, bin, fpc)
					results[i] = fc
					if cover != nil {
						cmu.Lock()
						coverData[fc.Cop] = cover
						cmu.Unlock()
					}
				}()
				done <- i
			}
		}()
	}
	go func() {
		for i := range songs {
			if stopRequested.Load() {
				break
			}
			idx <- i
		}
		close(idx)
		wg.Wait()
		close(done)
	}()

	var batch []fileChiavetta
	var sendErr error
	flush := func() {
		if len(batch) == 0 || sendErr != nil {
			return
		}
		resp, err := jr.send(parteFileChiav, batch)
		batch = nil
		if err != nil {
			sendErr = err
			return
		}
		for _, id := range resp.CopertineMancanti {
			cmu.Lock()
			img := coverData[id]
			cmu.Unlock()
			if img != nil {
				a.rawRequest("PUT", "/agente/copertine/"+id, img)
			}
		}
	}
	n := 0
	for i := range done {
		n++
		jr.progress("Leggo la chiavetta", n, len(songs), songs[i].origRel)
		batch = append(batch, results[i])
		if len(batch) >= 50 {
			flush()
		}
	}
	batch = append(batch, lists...)
	flush()
	endProgress()
	if sendErr == nil && !stopRequested.Load() {
		_, sendErr = jr.send(parteFineChiav, map[string]int{"file": n})
	}
	return n, sendErr
}

// --- Indice dei dischi ------------------------------------------------------------------

func (a *agent) indexDisks(jr *jobRun, raw json.RawMessage) error {
	var p paramIndicizza
	json.Unmarshal(raw, &p)
	var targets []unita
	exclude := []string{a.cache}
	for _, u := range a.units() {
		if u.Rimovibile {
			exclude = append(exclude, u.Lettera)
			continue
		}
		if len(p.Volumi) == 0 || contains(p.Volumi, u.Volume) {
			targets = append(targets, u)
		}
	}
	if len(targets) == 0 {
		return errors.New("non trovo dischi da esplorare")
	}
	total := 0
	var pmu sync.Mutex
	for _, u := range targets {
		if stopRequested.Load() {
			break
		}
		label := u.nome()
		others := append([]string(nil), exclude...)
		for _, o := range targets {
			// una cartella indicata a mano dentro un'altra viene esplorata una volta sola
			if o.Lettera != u.Lettera && isUnder(o.Lettera, []string{u.Lettera}) {
				others = append(others, o.Lettera)
			}
		}
		idx := buildHDIndex([]string{u.Lettera}, others, func(dirs, mp3s int, dir string) {
			jr.progress("Cerco gli mp3 in "+label, mp3s, mp3s, relSlash(u.Lettera, dir))
		})
		if stopRequested.Load() {
			break
		}
		cachePath := filepath.Join(a.cache, "indice-"+safeFileName(u.Volume, 40)+".json.gz")
		old := map[string]fileDisco{}
		readJSONGz(cachePath, &old)
		recs := make([]fileDisco, len(idx.files))
		var need []*hdFile
		needAt := map[*hdFile]int{}
		for i, f := range idx.files {
			rel := relSlash(u.Lettera, f.path)
			if c, ok := old[rel]; ok && c.S == f.size && c.M == f.mtime {
				recs[i] = c
				continue
			}
			need = append(need, f)
			needAt[f] = i
		}
		loadAllTags(need, nil, func(done, n int) {
			pmu.Lock()
			jr.progress("Leggo i tag in "+label, done, n, "")
			pmu.Unlock()
		})
		for _, f := range need {
			t := f.tags
			recs[needAt[f]] = fileDisco{P: relSlash(u.Lettera, f.path), S: f.size, M: f.mtime, A: t.Artist, T: t.Title,
				Al: t.Album, Y: t.Year, G: t.Genre, D: f.duration, B: f.kbps}
		}
		fresh := make(map[string]fileDisco, len(recs))
		for _, r := range recs {
			fresh[r.P] = r
		}
		for i := 0; i == 0 || i < len(recs); i += 2000 {
			end := min(i+2000, len(recs))
			pz := pezzoIndice{Unita: u, Inizio: i == 0, Fine: end >= len(recs), File: recs[i:end]}
			if _, err := jr.send(parteDisco, pz); err != nil {
				return err
			}
		}
		writeJSONGz(cachePath, fresh)
		total += len(recs)
	}
	endProgress()
	jr.summary = fmt.Sprintf("Trovati %d mp3 in %s.", total, plural(len(targets), "un disco", fmt.Sprintf("%d dischi", len(targets))))
	return nil
}

// --- Copia sulla chiavetta ------------------------------------------------------------------

var errStickChanged = errors.New("la chiavetta è cambiata da quando è stata letta: rileggila dal sito e riprova")

// buildFromSource prepara il brano da scrivere: l'audio del file sorgente
// con i tag e la copertina decisi dal sito. Testo, genere e compositore che il
// sito non conosce restano quelli del file.
func buildFromSource(path string, t songTags, cover []byte) ([]byte, error) {
	data, bad, err := readTolerant(path)
	if err != nil {
		return nil, err
	}
	if bad > 0 {
		return nil, errors.New("il file ha settori illeggibili")
	}
	in := analyzeMP3(data, 0)
	if in.Format != "" {
		return nil, fmt.Errorf("il file è in formato %s", in.Format)
	}
	if in.Defective {
		return nil, errors.New("il file è rovinato")
	}
	_, old := readTags(data)
	if t.Genre == "" {
		t.Genre = old.Genre
	}
	if t.Composer == "" {
		t.Composer = old.Composer
	}
	if t.Lyrics == "" {
		t.Lyrics, t.LyricsLang = old.Lyrics, old.LyricsLang
	}
	t.Picture = cover
	if cover == nil {
		if norm, err := normalizeCover(old.Picture); err == nil {
			t.Picture = norm
		}
	}
	var out bytes.Buffer
	out.Write(buildID3v23(t))
	out.Write(audioPayload(data, in))
	out.Write(buildID3v1(t))
	if chk := analyzeMP3(out.Bytes(), 0); chk.Defective {
		return nil, errors.New("il file ricostruito non supera il controllo")
	}
	return out.Bytes(), nil
}

func copyFileTo(src, dst string) error {
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	return os.WriteFile(dst, b, 0o644)
}

// writeNew scrive un file nuovo passando da un nome temporaneo: sulla
// chiavetta non resta mai un file scritto a metà.
func writeNew(dst string, content []byte) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	tmp := tempPath(filepath.Dir(dst))
	if err := writeVerified(tmp, content); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := rename(tmp, dst); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

func (a *agent) copyPlan(jr *jobRun, raw json.RawMessage) error {
	var p paramCopia
	if err := json.Unmarshal(raw, &p); err != nil {
		return err
	}
	u, err := a.stickUnit(p.Volume)
	if err != nil {
		return err
	}
	root := u.Lettera

	// 0. i file da toccare devono essere proprio quelli letti dal sito
	check := func(rel string, size, mtime int64) error {
		path, err := safeJoin(root, rel)
		if err != nil {
			return err
		}
		st, err := os.Stat(path)
		if err != nil || st.Size() != size || st.ModTime().Unix() != mtime {
			return errStickChanged
		}
		return nil
	}
	var need, biggest int64
	for _, op := range p.Operazioni {
		if _, err := safeJoin(root, op.A); err != nil {
			return err
		}
		if op.Da != "" {
			if err := check(op.Da, op.S, op.M); err != nil {
				return err
			}
		}
		for _, f := range op.Fonti {
			if f.Tipo == "chiavetta" {
				if err := check(f.P, f.S, f.M); err != nil {
					return err
				}
			}
		}
		switch op.Tipo {
		case opCopia:
			if len(op.Fonti) > 0 {
				need += op.Fonti[0].S + 300<<10
				biggest = max(biggest, op.Fonti[0].S)
			}
		case opRiscrivi:
			need += 300 << 10
			biggest = max(biggest, op.S)
		case opM3U:
			need += int64(len(op.Testo))
		}
	}
	need += biggest
	if free := freeSpace(root); free > 0 && int64(free) < need {
		return fmt.Errorf("sulla chiavetta non c'è abbastanza spazio: servono %s, liberi %s", humanBytes(need), humanBytes(int64(free)))
	}
	covers := map[string][]byte{}
	for _, op := range p.Operazioni {
		if op.Cop == "" || covers[op.Cop] != nil {
			continue
		}
		img, err := a.rawRequest("GET", "/agente/copertine/"+op.Cop, nil)
		if err != nil {
			return fmt.Errorf("non riesco a scaricare una copertina dal sito: %v", err)
		}
		covers[op.Cop] = img
	}
	cleanTemp(root)

	applying.Store(true)
	defer applying.Store(false)
	lg := &logger{}
	var esiti []esitoOp
	result := func(op *operazione, err error, avviso, fonte string, size int64) {
		e := esitoOp{N: op.N, OK: err == nil, Avviso: avviso, Fonte: fonte, Byte: size}
		if err != nil {
			e.Errore = err.Error()
			lg.add("ERRORE", "%s: %v", op.A, err)
		}
		esiti = append(esiti, e)
	}
	total, done := len(p.Operazioni), 0
	step := func(op *operazione) {
		done++
		jr.progress("Sistemo la chiavetta", done, total, op.A)
	}
	cur := map[string]string{} // percorso letto -> percorso attuale (relativi)
	dirs := map[string]bool{}
	abs := func(rel string) string { p, _ := safeJoin(root, rel); return p }

	// 1. copia di sicurezza dei file che verranno riscritti
	if p.Backup {
		base := a.o.backupDir
		if base == "" {
			base = defaultBackupBase()
		}
		backup := filepath.Join(base, "RiparaMP3 backup "+time.Now().Format("2006-01-02 15.04.05"))
		n := 0
		for _, op := range p.Operazioni {
			if op.Tipo != opRiscrivi {
				continue
			}
			if err := copyFileTo(abs(op.Da), filepath.Join(backup, filepath.FromSlash(op.Da))); err != nil {
				lg.add("ATTENZIONE", "copia di sicurezza non riuscita: %v", err)
				break
			}
			n++
		}
		if n > 0 {
			lg.lines = append([]string{"Copia di sicurezza: " + backup}, lg.lines...)
		}
	}

	// 2. i file che escono dalle playlist vanno in _Tolti
	for i := range p.Operazioni {
		op := &p.Operazioni[i]
		if op.Tipo != opTogli || stopRequested.Load() {
			continue
		}
		step(op)
		src, dst := abs(op.Da), abs(op.A)
		if exists(dst) {
			dst = freeName(dst)
		}
		err := moveFile(src, dst)
		if err == nil {
			dirs[filepath.Dir(src)] = true
			lg.add("TOLTO", "%s -> %s", op.Da, relSlash(root, dst))
		}
		result(op, err, "", "", 0)
	}

	// 3. rinomine e riscritture; due file che si scambiano il nome passano
	// da un nome temporaneo
	type move struct {
		op       *operazione
		src, dst string
		parked   string
	}
	var pending []*move
	for i := range p.Operazioni {
		op := &p.Operazioni[i]
		if op.Tipo == opRinomina || op.Tipo == opRiscrivi {
			pending = append(pending, &move{op: op, src: abs(op.Da), dst: abs(op.A)})
		}
	}
	for len(pending) > 0 && !stopRequested.Load() {
		var rest []*move
		progressed := false
		for _, m := range pending {
			if stopRequested.Load() {
				rest = append(rest, m)
				continue
			}
			avviso := ""
			if exists(m.dst) && !sameFile(m.src, m.dst) {
				owned := false
				for _, o := range pending {
					if o != m && sameFile(o.src, m.dst) {
						owned = true
						break
					}
				}
				if owned {
					rest = append(rest, m)
					continue
				}
				m.dst = freeName(m.dst)
				avviso = "c'era già un altro file con lo stesso nome"
			}
			step(m.op)
			dirs[filepath.Dir(m.src)] = true
			var err error
			if m.op.Tipo == opRinomina {
				err = moveFile(m.src, m.dst)
			} else {
				var content []byte
				if content, err = buildFromSource(m.src, *m.op.Tag, covers[m.op.Cop]); err == nil {
					var warn string
					warn, err = replaceFile(m.src, m.dst, content, "")
					if warn != "" {
						avviso = warn
					}
				}
			}
			if err == nil {
				cur[m.op.Da] = relSlash(root, m.dst)
				if m.op.Da != relSlash(root, m.dst) {
					lg.add("SISTEMATO", "%s -> %s", m.op.Da, relSlash(root, m.dst))
				} else {
					lg.add("TAG", "%s", m.op.A)
				}
				m.parked = ""
			} else if m.parked != "" {
				rename(m.src, m.parked)
				m.src = m.parked
			}
			result(m.op, err, avviso, "", 0)
			progressed = true
		}
		if !progressed && len(rest) > 0 {
			m := rest[0]
			tmp := tempPath(filepath.Dir(m.src))
			if err := rename(m.src, tmp); err != nil {
				result(m.op, err, "", "", 0)
				rest = rest[1:]
			} else {
				m.parked, m.src = m.src, tmp
			}
		}
		pending = rest
	}
	for _, m := range pending {
		if m.parked != "" {
			rename(m.src, m.parked)
		}
	}

	// 4. copie: dai dischi o da un altro file della chiavetta
	units := a.units()
	copied := 0
	for i := range p.Operazioni {
		op := &p.Operazioni[i]
		if op.Tipo != opCopia || stopRequested.Load() {
			continue
		}
		step(op)
		dst := abs(op.A)
		avviso := ""
		if exists(dst) {
			dst = freeName(dst)
			avviso = "c'era già un altro file con lo stesso nome"
		}
		var lastErr error = errors.New("nessuna copia disponibile")
		for _, f := range op.Fonti {
			var src string
			from := f.P
			switch f.Tipo {
			case "chiavetta":
				rel := f.P
				if c, ok := cur[f.P]; ok {
					rel = c
				}
				src = abs(rel)
			case "disco":
				for _, du := range units {
					if du.Volume == f.Volume && !du.Rimovibile {
						src, _ = safeJoin(du.Lettera, f.P)
						from = "disco «" + du.nome() + "» " + f.P
					}
				}
				if src == "" {
					lastErr = errors.New("il disco con il brano non è collegato")
					continue
				}
				if st, err := os.Stat(src); err != nil || st.Size() != f.S {
					lastErr = errors.New("il brano sul disco è cambiato o non c'è più")
					continue
				}
			}
			content, err := buildFromSource(src, *op.Tag, covers[op.Cop])
			if err != nil {
				lastErr = err
				continue
			}
			if free := freeSpace(root); free > 0 && free < uint64(len(content))+1<<20 {
				lastErr = errors.New("la chiavetta è piena")
				stopRequested.Store(true)
				break
			}
			if err := writeNew(dst, content); err != nil {
				lastErr = err
				continue
			}
			lastErr = nil
			copied++
			lg.add("COPIATO", "%s (da %s)", relSlash(root, dst), from)
			result(op, nil, avviso, from, int64(len(content)))
			break
		}
		if lastErr != nil {
			result(op, lastErr, "", "", 0)
		}
	}

	// 5. playlist .m3u
	for i := range p.Operazioni {
		op := &p.Operazioni[i]
		if op.Tipo != opM3U || stopRequested.Load() {
			continue
		}
		step(op)
		dst := abs(op.A)
		var err error
		if exists(dst) {
			_, err = replaceFile(dst, dst, op.Testo, "")
		} else {
			err = writeNew(dst, op.Testo)
		}
		if err == nil {
			lg.add("PLAYLIST", "%s", op.A)
		}
		result(op, err, "", "", int64(len(op.Testo)))
	}

	// 6. marcatore, registro, cartelle rimaste vuote
	if len(p.Marcatore) > 0 {
		mp := filepath.Join(root, markerFile)
		if exists(mp) {
			replaceFile(mp, mp, p.Marcatore, "")
		} else {
			writeNew(mp, p.Marcatore)
		}
	}
	removeEmptyDirs(root, dirs)
	header := fmt.Sprintf("RiparaMP3 %s (sito delle playlist) - %s", version, time.Now().Format("02/01/2006 15:04"))
	if stopRequested.Load() {
		header += " (interrotto)"
	}
	lg.save(filepath.Join(root, "RiparaMP3-registro.txt"), header)
	applying.Store(false)
	endProgress()

	errs := 0
	for _, e := range esiti {
		if !e.OK {
			errs++
		}
	}
	if _, err := jr.send(parteEsiti, esiti); err != nil {
		return err
	}
	// 7. si rilegge la chiavetta, così il sito vede com'è adesso
	wasStopped := stopRequested.Load()
	stopRequested.Store(false)
	if _, err := a.sendStick(jr, u); err != nil {
		return err
	}
	stopRequested.Store(wasStopped)
	jr.summary = fmt.Sprintf("%d operazioni fatte, %d brani copiati", len(esiti)-errs, copied)
	if errs > 0 {
		jr.summary += fmt.Sprintf(", %d non riuscite (dettagli nel registro sulla chiavetta)", errs)
	}
	jr.summary += "."
	return nil
}

// emptyTolti cancella la cartella _Tolti della chiavetta (solo su richiesta
// esplicita dal sito).
func (a *agent) emptyTolti(jr *jobRun, raw json.RawMessage) error {
	var p paramScansiona
	json.Unmarshal(raw, &p)
	u, err := a.stickUnit(p.Volume)
	if err != nil {
		return err
	}
	dir := filepath.Join(u.Lettera, toltiDir)
	if !exists(dir) {
		jr.summary = "La cartella _Tolti era già vuota."
		return nil
	}
	var size int64
	n := 0
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			if info, err := d.Info(); err == nil {
				size += info.Size()
			}
			n++
		}
		return nil
	})
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("non riesco a cancellare _Tolti: %v", err)
	}
	jr.summary = fmt.Sprintf("Cancellati %d file da _Tolti: liberati %s.", n, humanBytes(size))
	return nil
}
