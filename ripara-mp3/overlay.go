package main

import (
	"encoding/binary"
	"encoding/json"
	"os"
)

// Il programma scaricato dal sito porta in coda un "biglietto": indirizzo
// del sito e codice usa e getta per collegarsi senza scrivere nulla. In coda
// a un .exe si possono aggiungere dati senza che Windows se ne accorga.

const overlayMagic = "RMP3BIG1"

type overlayData struct {
	Sito      string `json:"sito"`
	Biglietto string `json:"biglietto"`
}

// withOverlay restituisce il programma con il biglietto in coda.
func withOverlay(exe []byte, d overlayData) []byte {
	js, _ := json.Marshal(d)
	out := make([]byte, 0, len(exe)+len(js)+12)
	out = append(out, exe...)
	out = append(out, js...)
	out = binary.LittleEndian.AppendUint32(out, uint32(len(js)))
	return append(out, overlayMagic...)
}

// readOverlay legge il biglietto in coda al programma, se c'è.
func readOverlay(path string) (overlayData, bool) {
	var d overlayData
	f, err := os.Open(path)
	if err != nil {
		return d, false
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.Size() < 12 {
		return d, false
	}
	tail := make([]byte, 12)
	if _, err := f.ReadAt(tail, st.Size()-12); err != nil || string(tail[4:]) != overlayMagic {
		return d, false
	}
	n := int64(binary.LittleEndian.Uint32(tail[:4]))
	if n == 0 || n > 4096 || n > st.Size()-12 {
		return d, false
	}
	js := make([]byte, n)
	if _, err := f.ReadAt(js, st.Size()-12-n); err != nil || json.Unmarshal(js, &d) != nil || d.Sito == "" {
		return d, false
	}
	return d, true
}

// stripOverlay toglie il biglietto (per servire il programma pulito).
func stripOverlay(exe []byte) []byte {
	if len(exe) < 12 || string(exe[len(exe)-8:]) != overlayMagic {
		return exe
	}
	n := int(binary.LittleEndian.Uint32(exe[len(exe)-12 : len(exe)-8]))
	if n <= 0 || n > len(exe)-12 {
		return exe
	}
	return exe[:len(exe)-12-n]
}
