package main

import (
	"crypto/sha1"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
)

// Tipi condivisi fra l'agente (il programma sul PC con la chiavetta) e il
// server (il sito). L'agente fa solo richieste in uscita: chiede al sito se
// c'è un lavoro da fare, lo esegue e manda i risultati a pezzi.

const protoVersion = 1

const (
	markerFile    = "RiparaMP3-playlist.json" // sulla chiavetta organizzata a playlist
	toltiDir      = "_Tolti"                  // file usciti dalle playlist, mai cancellati
	altriBraniDir = "Altri brani"             // brani che stanno solo in playlist .m3u
)

// Tipi di lavoro.
const (
	lvScansiona = "scansiona_chiavetta"
	lvIndicizza = "indicizza_hd"
	lvCopia     = "copia"
	lvSvuota    = "svuota_tolti"
)

// unita è un disco o una chiavetta collegati al PC.
type unita struct {
	Lettera    string `json:"lettera"` // radice: "E:\" oppure la cartella indicata a mano
	Etichetta  string `json:"etichetta,omitempty"`
	Volume     string `json:"volume"` // numero di serie del volume
	FS         string `json:"fs,omitempty"`
	Rimovibile bool   `json:"rimovibile,omitempty"`
	Dimensione uint64 `json:"dimensione,omitempty"`
	Liberi     uint64 `json:"liberi,omitempty"`
}

func (u unita) nome() string {
	if u.Etichetta != "" {
		return u.Etichetta
	}
	return u.Lettera
}

// battito: l'agente si fa vivo e chiede se c'è un lavoro.
type battito struct {
	Proto    int     `json:"proto"`
	Versione string  `json:"versione"`
	PC       string  `json:"pc"`
	InCorso  string  `json:"in_corso,omitempty"`
	Unita    []unita `json:"unita"`
}

type lavoroAgente struct {
	ID    string          `json:"id"`
	Tipo  string          `json:"tipo"`
	Param json.RawMessage `json:"param,omitempty"`
}

type rispostaBattito struct {
	Lavoro *lavoroAgente `json:"lavoro"`
}

type paramScansiona struct {
	Volume string `json:"volume,omitempty"` // vuoto: l'unica chiavetta collegata
}

type paramIndicizza struct {
	Volumi []string `json:"volumi,omitempty"` // vuoto: tutti i dischi fissi
}

type avanzamento struct {
	Fase     string `json:"fase"`
	Fatti    int    `json:"fatti"`
	Totale   int    `json:"totale"`
	Corrente string `json:"corrente,omitempty"`
}

type rispostaAvanzamento struct {
	Annulla bool `json:"annulla"`
}

// Tipi di parte dei risultati.
const (
	parteChiavetta = "chiavetta"      // voci: infoChiavetta
	parteFileChiav = "file_chiavetta" // voci: []fileChiavetta
	parteFineChiav = "chiavetta_fine" // la lettura della chiavetta è completa
	parteDisco     = "file_disco"     // voci: pezzoIndice
	parteEsiti     = "esito_op"       // voci: []esitoOp
)

type parteLavoro struct {
	N    int             `json:"n"`
	Tipo string          `json:"tipo"`
	Voci json.RawMessage `json:"voci"`
}

type rispostaParte struct {
	CopertineMancanti []string `json:"copertine_mancanti,omitempty"`
}

type fineLavoro struct {
	Esito     string `json:"esito"` // fatto, errore, annullato
	Messaggio string `json:"messaggio,omitempty"`
	Parti     int    `json:"parti"`
}

type infoChiavetta struct {
	Unita     unita           `json:"unita"`
	Marcatore json.RawMessage `json:"marcatore,omitempty"`
}

// fileChiavetta è un file della chiavetta come lo vede l'agente.
type fileChiavetta struct {
	P        string   `json:"p"` // percorso relativo, con "/"
	S        int64    `json:"s"`
	M        int64    `json:"m"`            // ultima modifica (unix)
	H        string   `json:"h,omitempty"`  // sha256 del file
	AU       string   `json:"au,omitempty"` // sha1 dell'audio, senza tag
	Dur      float64  `json:"dur,omitempty"`
	Kbps     int      `json:"kbps,omitempty"`
	Rov      bool     `json:"rov,omitempty"` // rovinato
	Problemi []string `json:"problemi,omitempty"`
	Fmt      string   `json:"fmt,omitempty"` // altro formato; "m3u" per le playlist
	Tag      songTags `json:"tag"`           // tag letti e ripuliti
	Raw      songTags `json:"raw"`           // tag così come sono scritti
	Cop      string   `json:"cop,omitempty"` // copertina incorporata
	CopLato  int      `json:"cop_lato,omitempty"`
	FP       string   `json:"fp,omitempty"` // impronta audio (Chromaprint)
}

// fileDisco è un mp3 trovato su un disco del PC.
type fileDisco struct {
	P  string  `json:"p"` // percorso relativo alla radice del disco, con "/"
	S  int64   `json:"s"`
	M  int64   `json:"m"`
	A  string  `json:"a,omitempty"`
	T  string  `json:"t,omitempty"`
	Al string  `json:"al,omitempty"`
	Y  int     `json:"y,omitempty"`
	G  string  `json:"g,omitempty"`
	D  float64 `json:"d,omitempty"`
	B  int     `json:"b,omitempty"` // kbps
}

// pezzoIndice è un pezzo dell'indice di un disco.
type pezzoIndice struct {
	Unita  unita       `json:"unita"`
	Inizio bool        `json:"inizio,omitempty"` // primo pezzo: l'indice vecchio va sostituito
	Fine   bool        `json:"fine,omitempty"`
	File   []fileDisco `json:"file"`
}

// paramCopia: il piano confermato sul sito.
type paramCopia struct {
	Volume     string          `json:"volume"`
	Piano      string          `json:"piano"`
	Backup     bool            `json:"backup"`
	Operazioni []operazione    `json:"operazioni"`
	Marcatore  json.RawMessage `json:"marcatore"`
}

// Tipi di operazione.
const (
	opTogli    = "togli"    // sposta in _Tolti
	opRinomina = "rinomina" // solo il nome cambia
	opRiscrivi = "riscrivi" // stesso file, tag o copertina nuovi
	opCopia    = "copia"    // da un disco o da un altro file della chiavetta
	opM3U      = "m3u"      // scrive una playlist .m3u
)

type operazione struct {
	N     int       `json:"n"`
	Tipo  string    `json:"tipo"`
	Da    string    `json:"da,omitempty"` // file della chiavetta (percorso letto)
	S     int64     `json:"s,omitempty"`  // dimensione e data attese di "da"
	M     int64     `json:"m,omitempty"`
	A     string    `json:"a"`
	Tag   *songTags `json:"tag,omitempty"`
	Cop   string    `json:"cop,omitempty"`
	Fonti []fonte   `json:"fonti,omitempty"`
	Testo []byte    `json:"testo,omitempty"` // contenuto della .m3u
	Brano string    `json:"brano,omitempty"`
}

type fonte struct {
	Tipo   string `json:"tipo"` // chiavetta, disco
	Volume string `json:"volume,omitempty"`
	P      string `json:"p"`
	S      int64  `json:"s,omitempty"`
	M      int64  `json:"m,omitempty"`
}

type esitoOp struct {
	N      int    `json:"n"`
	OK     bool   `json:"ok"`
	Errore string `json:"errore,omitempty"`
	Avviso string `json:"avviso,omitempty"`
	Fonte  string `json:"fonte,omitempty"`
	Byte   int64  `json:"byte,omitempty"`
}

// --- Abbinamento -------------------------------------------------------------

type richiestaAbbina struct {
	PC       string `json:"pc"`
	Versione string `json:"versione"`
}

type rispostaAbbina struct {
	Richiesta string `json:"richiesta"`
	Segreto   string `json:"segreto"`
	Codice    string `json:"codice"`
	Scade     int64  `json:"scade"`
}

type attesaAbbina struct {
	Richiesta string `json:"richiesta"`
	Segreto   string `json:"segreto"`
}

type esitoAbbina struct {
	Stato string `json:"stato"` // attesa, ok, scaduto
	Token string `json:"token,omitempty"`
}

type richiestaBiglietto struct {
	Biglietto string `json:"biglietto"`
	PC        string `json:"pc"`
	Versione  string `json:"versione"`
}

// --- Utilità -------------------------------------------------------------------

// pathSerial dà un "numero di serie" stabile a una cartella indicata a mano
// (e ai dischi dei sistemi che non lo hanno).
func pathSerial(p string) string {
	abs, _ := filepath.Abs(p)
	sum := sha1.Sum([]byte(strings.ToLower(abs)))
	return fmt.Sprintf("%X-%X", sum[0:2], sum[2:4])
}

// relSlash: percorso relativo con le barre "/" (uguale su ogni sistema).
func relSlash(root, p string) string {
	r, err := filepath.Rel(root, p)
	if err != nil {
		return filepath.ToSlash(p)
	}
	return filepath.ToSlash(r)
}

// safeJoin unisce la radice e un percorso relativo arrivato dal sito,
// rifiutando tutto quello che uscirebbe dalla radice.
func safeJoin(root, rel string) (string, error) {
	if rel == "" || strings.Contains(rel, "\\") || strings.HasPrefix(rel, "/") || strings.Contains(rel, ":") {
		return "", fmt.Errorf("percorso non valido: %q", rel)
	}
	for _, part := range strings.Split(rel, "/") {
		if part == "" || part == "." || part == ".." {
			return "", fmt.Errorf("percorso non valido: %q", rel)
		}
	}
	p := filepath.Join(root, filepath.FromSlash(rel))
	if !isUnder(p, []string{root}) || samePath(p, root) {
		return "", fmt.Errorf("percorso fuori dalla cartella: %q", rel)
	}
	return p, nil
}
