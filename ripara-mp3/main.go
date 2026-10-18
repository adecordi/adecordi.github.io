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

// version si può impostare alla compilazione con -ldflags "-X main.version=...".
var version = "1.4"

type listFlag []string

func (l *listFlag) String() string     { return strings.Join(*l, ";") }
func (l *listFlag) Set(v string) error { *l = append(*l, v); return nil }

type options struct {
	stick       string
	search      listFlag
	yes         bool
	offline     bool
	noBackup    bool
	backupDir   string
	dryRun      bool
	noOpen      bool
	mbURL       string
	caaURL      string
	deezerURL   string
	itunesURL   string
	keepCovers  bool
	acoustidKey string
	acoustidURL string
	fpcalc      string
	noIdentify  bool
	cacheDir    string

	// sito e agente
	server    bool
	agent     bool
	site      string
	listen    string
	dataDir   string
	users     string
	keysDir   string
	exePath   string
	songrec   string
	noInstall bool
	libCopy   string
	lrclibURL string
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
	flag.StringVar(&o.deezerURL, "deezer-url", "https://api.deezer.com", "indirizzo del servizio Deezer")
	flag.StringVar(&o.itunesURL, "itunes-url", "https://itunes.apple.com", "indirizzo del servizio iTunes Search")
	flag.BoolVar(&o.keepCovers, "tieni-copertine", false, "tiene le copertine già presenti nei file")
	flag.StringVar(&o.acoustidKey, "acoustid-key", "", "chiave AcoustID per riconoscere i brani dall'audio")
	flag.StringVar(&o.acoustidURL, "acoustid-url", "https://api.acoustid.org", "indirizzo del servizio AcoustID")
	flag.StringVar(&o.fpcalc, "fpcalc", "", "percorso di fpcalc (Chromaprint)")
	flag.BoolVar(&o.noIdentify, "non-riconoscere", false, "non riconosce i brani dall'audio")
	flag.StringVar(&o.cacheDir, "cache-dir", "", "cartella per la cache delle ricerche online")
	flag.BoolVar(&o.server, "server", false, "avvia il sito delle playlist (sulla VPS)")
	flag.BoolVar(&o.agent, "collega", false, "collega questo PC al sito delle playlist")
	flag.StringVar(&o.site, "sito", "", "indirizzo del sito delle playlist")
	flag.StringVar(&o.listen, "indirizzo", "127.0.0.1:8036", "indirizzo su cui il sito resta in ascolto")
	flag.StringVar(&o.dataDir, "dati", "", "cartella dei dati del sito")
	flag.StringVar(&o.users, "utenti", "", "utenti della portineria ammessi al sito, separati da virgole")
	flag.StringVar(&o.keysDir, "chiavi", "", "cartella con le chiavi dei servizi (acoustid.key, gemini.key, groq.key)")
	flag.StringVar(&o.exePath, "exe", "", "programma per Windows da scaricare dal sito")
	flag.StringVar(&o.songrec, "songrec", "songrec", "programma songrec per riconoscere i brani dal microfono")
	flag.BoolVar(&o.noInstall, "non-installare", false, "non copia il programma e non crea collegamenti")
	flag.StringVar(&o.libCopy, "copia-libreria", "", "cartella in cui tenere una copia della libreria (per il backup)")
	flag.StringVar(&o.lrclibURL, "lrclib-url", "https://lrclib.net", "indirizzo del servizio dei testi (LRCLIB)")
	flag.Parse()
	return o
}

// agentMode dice se il programma deve fare da agente: lo chiede l'opzione,
// il nome del file (RiparaMP3-Collega.exe) o il biglietto scaricato dal sito.
func agentMode(o options) bool {
	if o.agent {
		return true
	}
	exe, _ := os.Executable()
	if strings.Contains(strings.ToLower(filepath.Base(exe)), "collega") {
		return true
	}
	_, ok := readOverlay(exe)
	return ok
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
	if opts.server {
		if err := runServer(opts); err != nil {
			fmt.Fprintln(os.Stderr, "ERRORE:", err)
			os.Exit(1)
		}
		return
	}
	if agentMode(opts) {
		os.Exit(runAgentMain(opts))
	}
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
	if exists(filepath.Join(root, markerFile)) {
		fmt.Printf("\nLa chiavetta %s è organizzata a playlist dal sito: questo programma metterebbe tutti\n", root)
		fmt.Println("i brani nella cartella principale e le playlist andrebbero perse. Per sistemarla usa il")
		fmt.Println("sito delle playlist (pulsante «Leggi la chiavetta» e poi «Prepara la copia»).")
		return nil
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
	online := !o.offline && u.yesNo("Cerco su Internet album, anni e copertine e riconosco i brani dall'audio?", true)
	cache := o.cacheDir
	if cache == "" {
		cache = appCacheDir()
	}
	idKey := ""
	if online && !o.noIdentify {
		idKey = acoustidKey(o, u, cache)
	}

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
	replaceCovers := online && !o.keepCovers
	for _, s := range songs {
		if s.status == stAlt {
			continue
		}
		s.computeTags(root, hdTags[s])
		// copertina di ripiego: quella già nel file o nella copia sull'hard
		// disk, purché non sia una miniatura
		switch {
		case covers.minSide(s.origCoverID) >= minCoverSide:
			s.fallback = s.origCoverID
		case covers.minSide(hdCovers[s]) >= minCoverSide:
			s.fallback = hdCovers[s]
		}
	}
	folderCovers(songs, covers)
	for _, s := range songs {
		s.coverID = s.fallback
		if !replaceCovers && s.origCoverID != "" {
			s.coverID = s.origCoverID
		}
	}
	markCompilations(songs)
	shareCovers(songs)
	planTargets(root, songs)
	lookups := map[string][]*song{}
	albums := map[string]bool{}
	for _, s := range songs {
		s.computeNeedWrite()
		if online && s.needsLookup() {
			k := cacheKey(s.final.Artist, s.final.Title)
			lookups[k] = append(lookups[k], s)
		}
		if replaceCovers && s.final.Album != "" && s.status != stAlt && s.status != stBad {
			albums[normKey(coverArtist(s.final))+"|"+albumMatchKey(s.final.Album)] = true
		}
	}
	printSummary(root, songs)
	if idKey != "" {
		n := 0
		for _, s := range songs {
			if !s.dup && (s.status == stOK || s.status == stHD || s.status == stRip) {
				n++
			}
		}
		fmt.Printf("\n  Riconoscerò dall'audio %d brani (circa %s la prima volta).", n, formatDuration(float64(n)*1.5))
	}
	if online && (len(lookups) > 0 || len(albums) > 0) {
		fmt.Printf("\n  Poi cerco online le informazioni mancanti per %d brani e le copertine ufficiali\n  di circa %d album (circa %s).\n",
			len(lookups), len(albums), formatDuration(float64(len(lookups))*1.3+float64(len(albums))*0.6))
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
	if online {
		mb := newMBClient(o.mbURL, cache)
		if idKey != "" {
			identifyStep(o, cache, idKey, songs, mb, lg)
		}
		// ricerca testuale per i brani non riconosciuti dall'audio
		lookups = map[string][]*song{}
		for _, s := range songs {
			if s.needsLookup() {
				k := cacheKey(s.final.Artist, s.final.Title)
				lookups[k] = append(lookups[k], s)
			}
		}
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
				if mb.web.isOffline() {
					break
				}
				continue
			}
			if !r.Found {
				continue
			}
			foundN++
			for _, g := range group {
				g.applyMB(r)
			}
			if i%20 == 19 {
				mb.save()
			}
		}
		mb.save()
		endProgress()
		if mb.web.isOffline() {
			fmt.Println("  Internet non raggiungibile: continuo senza le informazioni online.")
		} else {
			if len(keys) > 0 {
				fmt.Printf("  Trovati su MusicBrainz: %d su %d\n", foundN, len(keys))
			}
			art := newArtFinder(o.deezerURL, o.itunesURL, o.caaURL, cache)
			assignCovers(songs, art, covers, replaceCovers, func(i, n int, name string) { progress("Copertine", i, n, name) })
			endProgress()
			if mb.web.errorCount()+art.errors() > 0 {
				fmt.Println("  Attenzione: alcuni servizi online non hanno risposto. Rilancia il programma più tardi")
				fmt.Println("  per completare album e copertine (quello che è già stato trovato resta in memoria).")
			}
		}
		newCovers, fixedAlbums := 0, 0
		for _, s := range songs {
			if s.albumFrom != "" {
				fixedAlbums++
				lg.add("ALBUM", "%s: %q -> %q", s.displayName(), s.albumFrom, s.final.Album)
				if s.coverID == s.fallback {
					// la copertina vecchia era quella della raccolta
					s.coverID = ""
				}
			}
			if s.coverID != "" && s.coverID != s.origCoverID && s.status != stAlt && s.status != stBad && !s.dup {
				newCovers++
			}
		}
		fmt.Printf("  Copertine nuove: %d   Album di compilation corretti: %d\n", newCovers, fixedAlbums)
		shareCovers(songs)
		planTargets(root, songs)
		for _, s := range songs {
			s.computeNeedWrite()
		}
	} else {
		fmt.Println("  Ricerca online disattivata.")
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

// acoustidKey legge la chiave AcoustID dall'opzione, da quella salvata o,
// la prima volta, chiedendola all'utente.
func acoustidKey(o options, u *ui, cache string) string {
	keyFile := filepath.Join(cache, "acoustid-key.txt")
	save := func(k string) {
		os.MkdirAll(cache, 0o755)
		os.WriteFile(keyFile, []byte(k+"\n"), 0o600)
	}
	if k := strings.TrimSpace(o.acoustidKey); k != "" {
		save(k)
		return k
	}
	if b, err := os.ReadFile(keyFile); err == nil {
		if k := strings.TrimSpace(string(b)); k != "" {
			return k
		}
	}
	if u.yes {
		return ""
	}
	fmt.Println()
	fmt.Println("Per riconoscere i brani dall'audio (anche quelli con i tag sbagliati) serve una")
	fmt.Println("chiave gratuita di AcoustID. Si ottiene così:")
	fmt.Println("  1. apri https://acoustid.org/new-application e accedi (va bene anche un account Google);")
	fmt.Println("  2. compila il modulo (nome: RiparaMP3, versione: " + version + ", la tua email) e conferma;")
	fmt.Println("  3. copia la \"API key\" che compare.")
	fmt.Println("La chiave viene ricordata: la chiederò solo questa volta.")
	k := cleanPath(u.line("Incolla qui la chiave (tasto destro o Ctrl+V) e premi Invio, oppure solo Invio per saltare: "))
	if k != "" {
		save(k)
	}
	return k
}

// identifyStep riconosce i brani dall'audio e annota i cambi nel registro.
func identifyStep(o options, cache, key string, songs []*song, mb *mbClient, lg *logger) {
	bin, err := fpcalcBinary(o.fpcalc)
	if err != nil {
		fmt.Printf("  Riconoscimento dall'audio non disponibile: %v\n", err)
		return
	}
	ac := newAcoustIDClient(o.acoustidURL, key, cache)
	found, total := identifySongs(songs, ac, mb, bin, progress)
	endProgress()
	if ac.badKey {
		os.Remove(filepath.Join(cache, "acoustid-key.txt"))
		fmt.Println("  La chiave AcoustID non è valida: controlla di averla copiata tutta.")
		fmt.Println("  Alla prossima esecuzione te la chiederò di nuovo.")
		return
	}
	if ac.web.isOffline() {
		fmt.Println("  AcoustID non raggiungibile: continuo senza il riconoscimento dall'audio.")
	}
	fmt.Printf("  Brani riconosciuti dall'audio: %d su %d\n", found, total)
	for _, s := range songs {
		if s.idFrom != "" {
			lg.add("RICONOSCIUTO", "%s -> %s (album %q)", s.idFrom, s.displayName(), s.final.Album)
		}
	}
}
