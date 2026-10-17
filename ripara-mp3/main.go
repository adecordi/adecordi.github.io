// RiparaMP3 controlla gli mp3 di una chiavetta, sostituisce quelli rovinati
// con le copie sane trovate sull'hard disk, sistema nomi, tag e copertine e
// crea una pagina elenco.html con tutti i brani.
package main

import (
	"bufio"
	"crypto/sha1"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unicode/utf8"
)

const version = "1.0"

type listFlag []string

func (l *listFlag) String() string     { return strings.Join(*l, ";") }
func (l *listFlag) Set(v string) error { *l = append(*l, v); return nil }

type options struct {
	stick     string
	search    listFlag
	yes       bool
	offline   bool
	noBackup  bool
	backupDir string
	dryRun    bool
	noOpen    bool
	mbURL     string
	caaURL    string
	cacheDir  string
}

func parseFlags() options {
	var o options
	flag.StringVar(&o.stick, "chiavetta", "", "cartella o unità con la musica (es. E:\\)")
	flag.Var(&o.search, "cerca", "cartella dell'hard disk in cui cercare le copie sane (ripetibile)")
	flag.BoolVar(&o.yes, "si", false, "risponde sì a tutte le domande")
	flag.BoolVar(&o.offline, "offline", false, "non usa Internet")
	flag.BoolVar(&o.noBackup, "nobackup", false, "non fa la copia di sicurezza")
	flag.StringVar(&o.backupDir, "backup-dir", "", "cartella in cui creare la copia di sicurezza")
	flag.BoolVar(&o.dryRun, "prova", false, "mostra cosa farebbe senza modificare nulla")
	flag.BoolVar(&o.noOpen, "non-aprire", false, "non apre l'elenco nel browser alla fine")
	flag.StringVar(&o.mbURL, "mb-url", "https://musicbrainz.org", "indirizzo del servizio MusicBrainz")
	flag.StringVar(&o.caaURL, "caa-url", "https://coverartarchive.org", "indirizzo del Cover Art Archive")
	flag.StringVar(&o.cacheDir, "cache-dir", "", "cartella per la cache delle ricerche online")
	flag.Parse()
	return o
}

var (
	applying      atomic.Bool // la chiavetta è in fase di modifica
	stopRequested atomic.Bool
)

// handleInterrupt: durante le modifiche Ctrl+C o la chiusura della finestra
// fanno terminare il file in corso prima di fermarsi; prima delle modifiche
// il programma si chiude subito.
func handleInterrupt() {
	ch := make(chan os.Signal, 2)
	signal.Notify(ch, os.Interrupt, syscall.SIGTERM)
	go func() {
		for range ch {
			if !applying.Load() || stopRequested.Load() {
				fmt.Println("\nInterrotto.")
				os.Exit(130)
			}
			stopRequested.Store(true)
			fmt.Println("\n  Interruzione richiesta: finisco il file in corso e mi fermo...")
		}
	}()
}

func main() {
	opts := parseFlags()
	handleInterrupt()
	u := &ui{r: bufio.NewReader(os.Stdin), yes: opts.yes}
	code := 0
	func() {
		defer func() {
			if r := recover(); r != nil {
				fmt.Printf("\nErrore imprevisto: %v\n", r)
				code = 2
			}
		}()
		if err := run(opts, u); err != nil {
			fmt.Printf("\nERRORE: %v\n", err)
			code = 1
		}
	}()
	if !opts.yes {
		u.pause()
	}
	os.Exit(code)
}

// --- Domande all'utente -------------------------------------------------------

type ui struct {
	r   *bufio.Reader
	yes bool
}

func (u *ui) line(prompt string) string {
	fmt.Print(prompt)
	if u.yes {
		fmt.Println()
		return ""
	}
	s, err := u.r.ReadString('\n')
	if err != nil && s == "" {
		fmt.Println()
	}
	return strings.TrimSpace(s)
}

func (u *ui) yesNo(prompt string, def bool) bool {
	hint := " [S/n] "
	if !def {
		hint = " [s/N] "
	}
	for {
		a := strings.ToLower(u.line(prompt + hint))
		switch a {
		case "":
			return def
		case "s", "si", "sì", "y", "yes":
			return true
		case "n", "no":
			return false
		}
		fmt.Println("  Rispondi S (sì) oppure N (no).")
	}
}

func (u *ui) pause() {
	fmt.Print("\nPremi Invio per chiudere...")
	u.r.ReadString('\n')
}

// cleanPath toglie le virgolette che Windows aggiunge quando si trascina
// una cartella nella finestra.
func cleanPath(p string) string {
	p = strings.TrimSpace(p)
	p = strings.TrimPrefix(p, "& ")
	p = strings.Trim(p, `"'`)
	if len(p) == 2 && p[1] == ':' {
		p += `\`
	}
	return p
}

var lastProgressLen int

func progress(label string, i, n int, name string) {
	line := fmt.Sprintf("  %s %d/%d", label, i, n)
	if name != "" {
		room := 76 - utf8.RuneCountInString(line)
		if r := []rune(name); len(r) > room && room > 3 {
			name = string(r[:room-1]) + "…"
		}
		line += "  " + name
	}
	pad := lastProgressLen - utf8.RuneCountInString(line)
	if pad < 0 {
		pad = 0
	}
	fmt.Print("\r" + line + strings.Repeat(" ", pad))
	lastProgressLen = utf8.RuneCountInString(line)
}

func endProgress() {
	if lastProgressLen > 0 {
		fmt.Print("\r" + strings.Repeat(" ", lastProgressLen) + "\r")
		lastProgressLen = 0
	}
}

func step(n int, title string) {
	endProgress()
	fmt.Printf("\n%d/5  %s\n", n, title)
}

// --- Flusso principale ----------------------------------------------------------

func chooseStick(o options, u *ui) (string, bool, error) {
	if o.stick != "" {
		return cleanPath(o.stick), false, nil
	}
	drives := listDrives()
	var removable []driveInfo
	for _, d := range drives {
		if d.removable {
			removable = append(removable, d)
		}
	}
	describe := func(d driveInfo) string {
		s := d.root
		if d.label != "" {
			s += "  " + d.label
		}
		if d.size > 0 {
			s += fmt.Sprintf("  (%s, liberi %s)", humanBytes(int64(d.size)), humanBytes(int64(d.free)))
		}
		return s
	}
	if len(removable) == 1 {
		if u.yesNo("Ho trovato la chiavetta "+describe(removable[0])+". Uso questa?", true) {
			return removable[0].root, true, nil
		}
	} else if len(removable) > 1 {
		fmt.Println("Chiavette collegate:")
		for i, d := range removable {
			fmt.Printf("  %d) %s\n", i+1, describe(d))
		}
	} else {
		fmt.Println("Non trovo chiavette collegate.")
	}
	for tries := 0; tries < 5; tries++ {
		a := u.line("Scrivi il numero della chiavetta, oppure trascina qui la cartella con la musica e premi Invio: ")
		if a == "" && u.yes {
			break
		}
		if n, err := strconv.Atoi(a); err == nil && n >= 1 && n <= len(removable) {
			return removable[n-1].root, true, nil
		}
		p := cleanPath(a)
		if st, err := os.Stat(p); err == nil && st.IsDir() {
			for _, d := range removable {
				if isUnder(p, []string{d.root}) {
					return p, true, nil
				}
			}
			return p, false, nil
		}
		fmt.Println("  Cartella non trovata, riprova.")
	}
	return "", false, fmt.Errorf("nessuna chiavetta scelta")
}

func defaultSearchRoots(stick string) []string {
	var roots []string
	for _, d := range listDrives() {
		if d.removable || isUnder(stick, []string{d.root}) {
			continue
		}
		roots = append(roots, d.root)
	}
	if runtime.GOOS != "windows" || len(roots) == 0 {
		if home, err := os.UserHomeDir(); err == nil && !isUnder(stick, []string{home}) {
			roots = []string{home}
		}
	}
	return roots
}

func run(o options, u *ui) error {
	fmt.Printf("RiparaMP3 %s - controlla e sistema la musica sulla chiavetta\n", version)
	fmt.Println(strings.Repeat("=", 62))
	fmt.Println()

	root, isRemovable, err := chooseStick(o, u)
	if err != nil {
		return err
	}
	root, _ = filepath.Abs(root)
	if st, err := os.Stat(root); err != nil || !st.IsDir() {
		return fmt.Errorf("la cartella %s non esiste", root)
	}
	if !isRemovable && o.stick == "" {
		fmt.Printf("\nAttenzione: %s non risulta una chiavetta. Tutti gli mp3 che contiene, anche nelle\nsottocartelle, verranno rinominati e spostati direttamente in %s.\n", root, root)
		if !u.yesNo("Sei sicuro di voler continuare?", false) {
			return nil
		}
	}

	songs, _ := listStick(root)
	if len(songs) == 0 {
		fmt.Printf("\nNon ho trovato file mp3 in %s.\n", root)
		return nil
	}
	var total int64
	for _, s := range songs {
		total += s.size
	}
	fmt.Printf("\nIn %s ci sono %d file mp3 (%s).\n\n", root, len(songs), humanBytes(total))

	backupRoot := ""
	if !o.noBackup && !o.dryRun {
		base := o.backupDir
		if base == "" {
			base = defaultBackupBase()
		}
		os.MkdirAll(base, 0o755)
		if free := freeSpace(base); free > 0 && free < uint64(total)+100<<20 {
			fmt.Printf("Sul disco del PC non c'è spazio per la copia di sicurezza (servono %s, liberi %s).\n",
				humanBytes(total), humanBytes(int64(free)))
			if !u.yesNo("Continuo senza copia di sicurezza?", false) {
				return nil
			}
		} else if u.yesNo("Prima di modificare la chiavetta faccio una copia di sicurezza sul PC (consigliato). Va bene?", true) {
			backupRoot = filepath.Join(base, "RiparaMP3 backup "+time.Now().Format("2006-01-02 15.04.05"))
			if exists(backupRoot) {
				backupRoot = freeName(backupRoot)
			}
			fmt.Printf("  La copia verrà salvata in: %s\n", backupRoot)
		}
	}
	online := !o.offline && u.yesNo("Cerco su Internet (MusicBrainz) album, anno e copertine che mancano?", true)

	// 1. Controllo
	covers := newCoverStore()
	lg := &logger{}
	start := time.Now()
	header := fmt.Sprintf("RiparaMP3 %s - %s", version, start.Format("02/01/2006 15:04"))
	logPath := filepath.Join(root, "RiparaMP3-registro.txt")
	logSaved := false
	defer func() {
		// in caso di errore imprevisto il registro viene salvato lo stesso
		if !logSaved && applying.Load() {
			lg.save(logPath, header+" (interrotto)")
		}
	}()
	if backupRoot != "" {
		step(1, "Copia di sicurezza e controllo dei brani")
	} else {
		step(1, "Controllo dei brani")
	}
	var damaged []*song
	for i, s := range songs {
		progress("Controllo", i+1, len(songs), s.origRel)
		if err := s.load(backupRoot, covers); err != nil {
			endProgress()
			return fmt.Errorf("la copia di sicurezza non è riuscita (%v). Nessuna modifica è stata fatta alla chiavetta", err)
		}
		if s.status == stBad {
			damaged = append(damaged, s)
		}
	}
	endProgress()
	sane := 0
	for _, s := range songs {
		if s.status == stOK {
			sane++
		}
	}
	fmt.Printf("  Sani: %d   Rovinati: %d\n", sane, len(damaged))
	for _, s := range damaged {
		lg.add("DIFETTOSO", "%s: %s", s.origRel, strings.Join(s.info.Problems, "; "))
	}

	// 2. Ricerca delle copie sane
	hdTags := map[*song]*songTags{}
	hdCovers := map[*song]string{}
	if len(damaged) > 0 {
		step(2, "Ricerca delle copie sane sull'hard disk")
		roots := []string(o.search)
		if len(roots) == 0 {
			roots = defaultSearchRoots(root)
			if !u.yes {
				fmt.Printf("  Cerco in: %s\n", strings.Join(roots, ", "))
				a := u.line("  Premi Invio per confermare, oppure trascina qui una cartella in cui cercare: ")
				if p := cleanPath(a); p != "" {
					if st, err := os.Stat(p); err == nil && st.IsDir() {
						roots = []string{p}
					} else {
						fmt.Println("  Cartella non trovata: cerco nei dischi indicati sopra.")
					}
				}
			}
		}
		exclude := []string{root}
		if backupRoot != "" {
			exclude = append(exclude, backupRoot)
		}
		idx := buildHDIndex(roots, exclude, func(dirs, mp3s int, dir string) {
			progress("Cartelle esplorate:", dirs, dirs, fmt.Sprintf("(%d mp3 trovati)", mp3s))
		})
		endProgress()
		fmt.Printf("  Sull'hard disk ci sono %d mp3.\n", len(idx.files))
		found := 0
		for i, s := range damaged {
			progress("Cerco", i+1, len(damaged), s.origRel)
			s.computeTags(root, nil)
			if data, err := s.readSource(); err == nil && s.info.Frames > 0 {
				s.payload = audioPayload(data, s.info)
			}
			if m := idx.findGoodCopy(s); m != nil {
				s.status = stHD
				s.hdPath = m.file.path
				s.hdSim = m.similarity
				s.audioHash = sha1.Sum(audioPayload(m.data, m.info))
				_, t := readTags(m.data)
				if len(t.Picture) > 0 {
					hdCovers[s] = covers.add(t.Picture)
				}
				t.Picture = nil
				hdTags[s] = &t
				found++
			} else if s.info.cuttable() {
				s.status = stRip
			}
			s.payload = nil
		}
		endProgress()
		fmt.Printf("  Copie sane trovate: %d su %d\n", found, len(damaged))
	} else {
		step(2, "Ricerca delle copie sane sull'hard disk")
		fmt.Println("  Nessun brano rovinato: non serve cercare.")
	}

	// 3. Nomi e tag
	step(3, "Preparazione di nomi, tag e copertine")
	for _, s := range songs {
		if s.status == stAlt {
			continue
		}
		s.computeTags(root, hdTags[s])
		s.coverID = s.origCoverID
		if s.coverID == "" && hdCovers[s] != "" {
			s.coverID = hdCovers[s]
			s.coverSource = "hd"
		}
	}
	folderCovers(songs, covers)
	shareCovers(songs)
	planTargets(root, songs)
	lookups := map[string][]*song{}
	for _, s := range songs {
		s.computeNeedWrite()
		if online && s.needsLookup() {
			k := cacheKey(s.final.Artist, s.final.Title)
			lookups[k] = append(lookups[k], s)
		}
	}
	printSummary(root, songs)
	if online && len(lookups) > 0 {
		fmt.Printf("\n  Poi cerco online le informazioni mancanti per %d brani (circa %s).\n",
			len(lookups), formatDuration(float64(len(lookups))*1.3))
	}
	if o.dryRun {
		printPlan(root, songs)
		fmt.Println("\nModalità prova: nessuna modifica è stata fatta.")
		return nil
	}
	fmt.Println()
	if !u.yesNo("Procedo con le modifiche sulla chiavetta?", true) {
		fmt.Println("Nessuna modifica è stata fatta.")
		return nil
	}

	// 4. Ricerca online
	step(4, "Ricerca online di album, anni e copertine")
	if online && len(lookups) > 0 {
		cache := o.cacheDir
		if cache == "" {
			cache = appCacheDir()
		}
		mb := newMBClient(o.mbURL, o.caaURL, cache)
		keys := make([]string, 0, len(lookups))
		for k := range lookups {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		foundN := 0
		for i, k := range keys {
			group := lookups[k]
			s := group[0]
			progress("Cerco", i+1, len(keys), s.displayName())
			r, err := mb.lookup(s.final.Artist, s.final.Title, s.info.Duration)
			if err != nil {
				if mb.offline {
					endProgress()
					fmt.Println("  Internet non raggiungibile: continuo senza le informazioni online.")
					break
				}
				continue
			}
			if !r.Found {
				continue
			}
			foundN++
			var coverID string
			for _, g := range group {
				g.applyMB(r)
				if g.coverID == "" {
					if coverID == "" {
						coverID = covers.add(mb.cover(r))
					}
					if coverID != "" {
						g.coverID = coverID
						g.coverSource = "online"
					}
				}
			}
			if i%20 == 19 {
				mb.save()
			}
		}
		mb.save()
		endProgress()
		fmt.Printf("  Brani riconosciuti: %d su %d\n", foundN, len(keys))
		shareCovers(songs)
		planTargets(root, songs)
		for _, s := range songs {
			s.computeNeedWrite()
		}
	} else if !online {
		fmt.Println("  Ricerca online disattivata.")
	} else {
		fmt.Println("  Non manca nessuna informazione.")
	}

	// 5. Modifiche
	step(5, "Sistemazione dei file sulla chiavetta")
	applying.Store(true)
	applyAll(root, songs, covers, lg, func(i, n int, name string) { progress("File", i, n, name) })
	applying.Store(false)
	endProgress()
	if stopRequested.Load() {
		fmt.Println("  Interrotto: i file non ancora sistemati sono rimasti come erano.")
	}
	for _, s := range songs {
		if s.status == stBad && s.err == "" {
			lg.add("NON RIPARATO", "%s: copia sana non trovata", relPath(root, s.path))
		}
	}
	report, err := writeReport(root, songs, covers, time.Now())
	if err != nil {
		fmt.Printf("  Non riesco a scrivere l'elenco: %v\n", err)
	}
	if backupRoot != "" {
		lg.lines = append([]string{"Copia di sicurezza: " + backupRoot}, lg.lines...)
	}
	logSaved = true
	if err := lg.save(logPath, header); err != nil {
		fmt.Printf("  Non riesco a scrivere il registro: %v\n", err)
	}
	printFinal(songs, report, logPath, backupRoot)
	if report != "" && !o.noOpen && !o.yes {
		openInBrowser(report)
	}
	return nil
}

func printSummary(root string, songs []*song) {
	var ok, hd, rip, bad, alt, rename, tags, dups int
	for _, s := range songs {
		switch s.status {
		case stOK:
			ok++
		case stHD:
			hd++
		case stRip:
			rip++
		case stBad:
			bad++
		case stAlt:
			alt++
		}
		if s.dup {
			dups++
		} else if s.status != stAlt && filepath.Clean(s.path) != filepath.Clean(s.target) {
			rename++
		}
		if s.needWrite && s.status != stHD && s.status != stRip {
			tags++
		}
	}
	fmt.Printf("  Brani sani:                      %d\n", ok)
	if hd+rip+bad > 0 {
		fmt.Printf("  Rovinati, recuperati dall'HD:    %d\n", hd)
		fmt.Printf("  Rovinati, da riparare in parte:  %d\n", rip)
		if bad > 0 {
			fmt.Printf("  Rovinati, non riparabili:        %d\n", bad)
		}
	}
	if alt > 0 {
		fmt.Printf("  Non mp3 (lasciati come sono):    %d\n", alt)
	}
	fmt.Printf("  Da rinominare:                   %d\n", rename)
	fmt.Printf("  Con tag o copertina da sistemare: %d\n", tags)
	if dups > 0 {
		fmt.Printf("  Doppioni (vanno in _Doppioni):   %d\n", dups)
	}
}

func printPlan(root string, songs []*song) {
	fmt.Println("\nOperazioni previste:")
	for _, s := range songs {
		from := relPath(root, s.path)
		to := relPath(root, s.target)
		var what []string
		switch s.status {
		case stHD:
			what = append(what, "sostituito con "+s.hdPath)
		case stRip:
			what = append(what, "riparato")
		case stBad:
			what = append(what, "non riparabile")
		case stAlt:
			what = append(what, "non mp3, lasciato com'è")
		}
		if s.needWrite && s.status != stHD && s.status != stRip {
			what = append(what, "tag")
		}
		if s.dup {
			what = append(what, "doppione")
		}
		if from == to && len(what) == 0 {
			continue
		}
		line := "  " + from
		if from != to {
			line += " -> " + to
		}
		if len(what) > 0 {
			line += "  [" + strings.Join(what, ", ") + "]"
		}
		fmt.Println(line)
	}
}

func printFinal(songs []*song, report, logPath, backupRoot string) {
	var ok, hd, rip, bad, errs int
	for _, s := range songs {
		st, _ := reportStatus(s)
		switch st {
		case stOK:
			ok++
		case stHD:
			hd++
		case stRip:
			rip++
		case stBad:
			bad++
		}
		if s.err != "" {
			errs++
		}
	}
	fmt.Println("\nFatto!")
	fmt.Printf("  Brani sani: %d", ok)
	if hd > 0 {
		fmt.Printf("   Recuperati dall'HD: %d", hd)
	}
	if rip > 0 {
		fmt.Printf("   Riparati in parte: %d", rip)
	}
	if bad > 0 {
		fmt.Printf("   Ancora difettosi: %d", bad)
	}
	fmt.Println()
	if errs > 0 {
		fmt.Printf("  %d file non sono stati modificati per un errore: i dettagli sono nel registro.\n", errs)
	}
	if report != "" {
		fmt.Printf("  Elenco dei brani: %s\n", report)
	}
	fmt.Printf("  Registro delle operazioni: %s\n", logPath)
	if backupRoot != "" {
		fmt.Printf("  Copia di sicurezza: %s\n", backupRoot)
	}
}
