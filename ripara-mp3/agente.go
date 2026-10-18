package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"
)

// L'agente gira sul PC dove si collegano la chiavetta e i dischi con la
// musica. Non apre porte: è lui a chiedere al sito se c'è qualcosa da fare
// (leggere la chiavetta, cercare gli mp3 nei dischi, copiare i brani).

type agentConfig struct {
	Sito         string `json:"sito"`
	Token        string `json:"token"`
	AvvioChiesto bool   `json:"avvio_chiesto,omitempty"`
}

type agent struct {
	o       options
	cache   string
	cfgPath string
	cfg     agentConfig
	client  *http.Client
	pc      string
	inCorso atomic.Value // id del lavoro in corso
	errMsg  string       // ultimo errore di collegamento mostrato
}

func newAgent(o options) *agent {
	cache := o.cacheDir
	if cache == "" {
		cache = appCacheDir()
	}
	a := &agent{o: o, cache: cache, cfgPath: filepath.Join(cache, "agente.json"), client: &http.Client{}}
	a.inCorso.Store("")
	readJSON(a.cfgPath, &a.cfg)
	a.pc, _ = os.Hostname()
	return a
}

func (a *agent) saveCfg() error {
	b, _ := json.MarshalIndent(a.cfg, "", " ")
	return writeFileAtomic(a.cfgPath, b, 0o600)
}

func runAgentMain(o options) int {
	handleInterrupt()
	err := runAgent(o)
	if err != nil {
		endProgress()
		fmt.Printf("\nERRORE: %v\n", err)
		if !o.yes {
			(&ui{r: bufio.NewReader(os.Stdin)}).pause()
		}
		return 1
	}
	return 0
}

func runAgent(o options) error {
	fmt.Printf("RiparaMP3 %s - collegamento al sito delle playlist\n", version)
	fmt.Println(strings.Repeat("=", 62))
	if !singleInstance() {
		fmt.Println("\nIl collegamento è già aperto in un'altra finestra: puoi chiudere questa.")
		time.Sleep(5 * time.Second)
		return nil
	}
	a := newAgent(o)
	exe, _ := os.Executable()
	ov, hasOv := readOverlay(exe)
	switch {
	case o.site != "":
		a.cfg.Sito = o.site
	case a.cfg.Sito == "" && hasOv:
		a.cfg.Sito = ov.Sito
	}
	a.cfg.Sito = strings.TrimRight(a.cfg.Sito, "/")
	if a.cfg.Sito == "" {
		return errors.New("manca l'indirizzo del sito: scarica il programma dal sito delle playlist")
	}
	if a.cfg.Token == "" && hasOv && ov.Biglietto != "" {
		if err := a.redeemTicket(ov.Biglietto); err != nil {
			fmt.Printf("\nIl collegamento automatico non è riuscito (%v).\n", err)
		}
	}
	if a.cfg.Token == "" {
		if err := a.pairWithCode(); err != nil {
			return err
		}
	}
	if !o.noInstall {
		installAgent(a)
	}
	return a.loop()
}

// --- Richieste al sito ------------------------------------------------------------

type apiError struct {
	status int
	msg    string
}

func (e *apiError) Error() string {
	if e.msg != "" {
		return e.msg
	}
	return fmt.Sprintf("il sito ha risposto %d", e.status)
}

func statusOf(err error) int {
	var ae *apiError
	if errors.As(err, &ae) {
		return ae.status
	}
	return 0
}

// call manda una richiesta JSON al sito e legge la risposta in out. I corpi
// grandi viaggiano compressi.
func (a *agent) call(method, path string, in, out any, timeout time.Duration) error {
	var body io.Reader
	gz := false
	if in != nil {
		js, err := json.Marshal(in)
		if err != nil {
			return err
		}
		if len(js) > 8<<10 {
			var buf bytes.Buffer
			zw := gzip.NewWriter(&buf)
			zw.Write(js)
			zw.Close()
			body, gz = &buf, true
		} else {
			body = bytes.NewReader(js)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, a.cfg.Sito+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent)
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if gz {
		req.Header.Set("Content-Encoding", "gzip")
	}
	if a.cfg.Token != "" {
		req.Header.Set("Authorization", "Bearer "+a.cfg.Token)
	}
	resp, err := a.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Errore string `json:"errore"`
		}
		json.Unmarshal(data, &e)
		return &apiError{resp.StatusCode, e.Errore}
	}
	if out != nil {
		return json.Unmarshal(data, out)
	}
	return nil
}

// rawRequest manda o riceve dati binari (le copertine).
func (a *agent) rawRequest(method, path string, data []byte) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	var body io.Reader
	if data != nil {
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, a.cfg.Sito+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	if data != nil {
		req.Header.Set("Content-Type", "image/jpeg")
	}
	req.Header.Set("Authorization", "Bearer "+a.cfg.Token)
	resp, err := a.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	out, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, &apiError{status: resp.StatusCode}
	}
	return out, nil
}

// --- Abbinamento ------------------------------------------------------------------

func (a *agent) redeemTicket(ticket string) error {
	var r esitoAbbina
	if err := a.call("POST", "/agente/biglietto", richiestaBiglietto{ticket, a.pc, version}, &r, 30*time.Second); err != nil {
		return err
	}
	if r.Token == "" {
		return errors.New("il sito non ha dato il permesso")
	}
	a.cfg.Token = r.Token
	fmt.Println("\nQuesto PC è collegato al sito.")
	return a.saveCfg()
}

func (a *agent) pairWithCode() error {
	for {
		var r rispostaAbbina
		if err := a.call("POST", "/agente/abbina", richiestaAbbina{a.pc, version}, &r, 30*time.Second); err != nil {
			fmt.Printf("\nNon riesco a raggiungere il sito %s (%v). Riprovo fra 30 secondi...\n", a.cfg.Sito, err)
			time.Sleep(30 * time.Second)
			continue
		}
		fmt.Printf("\nPer collegare questo PC apri il sito %s, pagina «PC», e scrivi il codice:\n\n", a.cfg.Sito)
		fmt.Printf("        %s %s\n\n", r.Codice[:3], r.Codice[3:])
		fmt.Println("Aspetto la conferma dal sito...")
		for time.Now().Unix() < r.Scade {
			var e esitoAbbina
			if err := a.call("POST", "/agente/abbina/attendi", attesaAbbina{r.Richiesta, r.Segreto}, &e, 45*time.Second); err != nil {
				time.Sleep(5 * time.Second)
				continue
			}
			if e.Stato == "ok" && e.Token != "" {
				a.cfg.Token = e.Token
				fmt.Println("Fatto: questo PC è collegato al sito.")
				return a.saveCfg()
			}
			if e.Stato == "scaduto" {
				break
			}
		}
		fmt.Println("Il codice è scaduto: ne preparo uno nuovo.")
	}
}

// --- Dischi e chiavette -------------------------------------------------------------

// units elenca chiavette e dischi del PC. Con --chiavetta e --cerca si usano
// le cartelle indicate al posto di quelle vere (per le prove).
func (a *agent) units() []unita {
	var out []unita
	if a.o.stick != "" {
		root, _ := filepath.Abs(cleanPath(a.o.stick))
		out = append(out, unita{Lettera: root, Etichetta: filepath.Base(root), Volume: pathSerial(root), Rimovibile: true, Liberi: freeSpace(root)})
	}
	for _, s := range a.o.search {
		root, _ := filepath.Abs(cleanPath(s))
		out = append(out, unita{Lettera: root, Etichetta: filepath.Base(root), Volume: pathSerial(root), Liberi: freeSpace(root)})
	}
	if a.o.stick != "" && len(a.o.search) > 0 {
		return out
	}
	for _, d := range listDrivesFn() {
		if (d.removable && a.o.stick != "") || (!d.removable && len(a.o.search) > 0) {
			continue
		}
		serial := d.serial
		if serial == "" {
			serial = pathSerial(d.root)
		}
		out = append(out, unita{Lettera: d.root, Etichetta: d.label, Volume: serial, FS: d.fs, Rimovibile: d.removable,
			Dimensione: d.size, Liberi: d.free})
	}
	return out
}

func (a *agent) stickUnit(volume string) (unita, error) {
	var rem []unita
	for _, u := range a.units() {
		if u.Rimovibile {
			rem = append(rem, u)
		}
	}
	if volume != "" {
		for _, u := range rem {
			if u.Volume == volume {
				return u, nil
			}
		}
		return unita{}, errors.New("la chiavetta giusta non è collegata a questo PC")
	}
	switch len(rem) {
	case 0:
		return unita{}, errors.New("non trovo chiavette collegate a questo PC")
	case 1:
		return rem[0], nil
	}
	return unita{}, fmt.Errorf("ci sono %d chiavette collegate: lasciane attaccata una sola", len(rem))
}

// --- Ciclo principale ----------------------------------------------------------------

func (a *agent) heartbeat() battito {
	return battito{Proto: protoVersion, Versione: version, PC: a.pc, InCorso: a.inCorso.Load().(string), Unita: a.units()}
}

func (a *agent) loop() error {
	fmt.Printf("\nCollegato al sito %s\n", a.cfg.Sito)
	fmt.Println("Lascia aperta questa finestra: da qui il sito legge la chiavetta, cerca i brani")
	fmt.Println("nei dischi e li copia. Puoi ridurla a icona.")
	backoff := 5 * time.Second
	for {
		var r rispostaBattito
		err := a.call("POST", "/agente/lavoro", a.heartbeat(), &r, 70*time.Second)
		switch st := statusOf(err); {
		case st == http.StatusUnauthorized:
			fmt.Println("\nIl sito non riconosce più questo PC: serve collegarlo di nuovo.")
			a.cfg.Token = ""
			a.saveCfg()
			if err := a.pairWithCode(); err != nil {
				return err
			}
			continue
		case st == http.StatusUpgradeRequired:
			a.showOnce("Questo programma è troppo vecchio: scarica la versione nuova dal sito.")
			time.Sleep(10 * time.Minute)
			continue
		case err != nil:
			a.showOnce(fmt.Sprintf("Il sito non risponde (%v): riprovo.", err))
			time.Sleep(backoff)
			if backoff *= 2; backoff > 2*time.Minute {
				backoff = 2 * time.Minute
			}
			continue
		}
		if a.errMsg != "" {
			fmt.Printf("%s  Di nuovo collegato.\n", time.Now().Format("15:04"))
			a.errMsg = ""
		}
		backoff = 5 * time.Second
		if r.Lavoro != nil {
			a.run(r.Lavoro)
		}
	}
}

func (a *agent) showOnce(msg string) {
	if msg != a.errMsg {
		fmt.Printf("%s  %s\n", time.Now().Format("15:04"), msg)
		a.errMsg = msg
	}
}

var jobTitles = map[string]string{
	lvScansiona: "Il sito chiede di leggere la chiavetta",
	lvIndicizza: "Il sito chiede di cercare gli mp3 nei dischi",
	lvCopia:     "Il sito chiede di copiare i brani sulla chiavetta",
	lvSvuota:    "Il sito chiede di svuotare la cartella _Tolti della chiavetta",
}

func (a *agent) run(j *lavoroAgente) {
	a.inCorso.Store(j.ID)
	defer a.inCorso.Store("")
	stopRequested.Store(false)
	keepAwake(true)
	defer keepAwake(false)
	jr := &jobRun{a: a, id: j.ID}
	title := jobTitles[j.Tipo]
	if title == "" {
		title = "Lavoro " + j.Tipo
	}
	fmt.Printf("\n%s  %s\n", time.Now().Format("15:04"), title)
	var err error
	func() {
		defer func() {
			if r := recover(); r != nil {
				err = fmt.Errorf("errore imprevisto: %v", r)
			}
		}()
		switch j.Tipo {
		case lvScansiona:
			err = a.scanStick(jr, j.Param)
		case lvIndicizza:
			err = a.indexDisks(jr, j.Param)
		case lvCopia:
			err = a.copyPlan(jr, j.Param)
		case lvSvuota:
			err = a.emptyTolti(jr, j.Param)
		default:
			err = fmt.Errorf("lavoro sconosciuto: %s", j.Tipo)
		}
	}()
	endProgress()
	esito, msg := "fatto", jr.summary
	switch {
	case err != nil:
		esito, msg = "errore", err.Error()
		fmt.Printf("  Non riuscito: %v\n", err)
	case jr.cancelled || stopRequested.Load():
		esito = "annullato"
		fmt.Println("  Fermato dal sito.")
	default:
		fmt.Printf("  Fatto. %s\n", msg)
	}
	stopRequested.Store(false)
	jr.finish(esito, msg)
}

// jobRun tiene il filo di un lavoro: avanzamento, pezzi di risultato, fine.
type jobRun struct {
	a         *agent
	id        string
	n         int
	lastProg  time.Time
	cancelled bool
	summary   string
}

func (r *jobRun) progress(fase string, done, total int, cur string) {
	progress(fase, done, total, cur)
	if time.Since(r.lastProg) < time.Second && done < total {
		return
	}
	r.lastProg = time.Now()
	var resp rispostaAvanzamento
	if err := r.a.call("POST", "/agente/lavori/"+r.id+"/avanzamento", avanzamento{fase, done, total, cur}, &resp, 20*time.Second); err == nil && resp.Annulla {
		r.cancelled = true
		stopRequested.Store(true)
	}
}

// send manda un pezzo di risultato; i pezzi sono numerati, quindi un invio
// ripetuto dopo un errore di rete non fa danni.
func (r *jobRun) send(tipo string, voci any) (*rispostaParte, error) {
	js, err := json.Marshal(voci)
	if err != nil {
		return nil, err
	}
	r.n++
	p := parteLavoro{N: r.n, Tipo: tipo, Voci: js}
	var resp rispostaParte
	for attempt := 0; ; attempt++ {
		err = r.a.call("POST", "/agente/lavori/"+r.id+"/parte", p, &resp, 120*time.Second)
		if err == nil || statusOf(err) != 0 || attempt >= 5 {
			break
		}
		time.Sleep(time.Duration(2<<attempt) * time.Second)
	}
	if err != nil {
		return nil, fmt.Errorf("invio dei risultati non riuscito: %v", err)
	}
	return &resp, nil
}

func (r *jobRun) finish(esito, msg string) {
	for attempt := 0; attempt < 6; attempt++ {
		err := r.a.call("POST", "/agente/lavori/"+r.id+"/fine", fineLavoro{esito, msg, r.n}, nil, 30*time.Second)
		if err == nil || statusOf(err) != 0 {
			return
		}
		time.Sleep(time.Duration(2<<attempt) * time.Second)
	}
}
