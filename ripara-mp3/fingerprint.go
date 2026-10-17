package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os/exec"
	"strings"
)

// Impronta audio con fpcalc (Chromaprint). L'audio viene passato a fpcalc
// attraverso lo standard input: così non ci sono problemi con i nomi dei
// file che contengono lettere accentate e si può usare anche l'audio
// riparato, che esiste solo in memoria.

// fpcalcBinary restituisce il percorso di fpcalc: quello indicato con
// --fpcalc, quello incorporato nel programma (Windows) o quello installato.
func fpcalcBinary(override string) (string, error) {
	if override != "" {
		return override, nil
	}
	if p, err := embeddedFpcalc(); err == nil {
		return p, nil
	}
	if p, err := exec.LookPath("fpcalc"); err == nil {
		return p, nil
	}
	return "", errors.New("fpcalc non trovato")
}

// fingerprintAudio calcola l'impronta dei primi 120 secondi.
func fingerprintAudio(bin string, audio []byte) (string, error) {
	cmd := exec.Command(bin, "-json", "-length", "120", "-")
	cmd.Stdin = bytes.NewReader(audio)
	out, err := cmd.Output()
	var res struct {
		Fingerprint string `json:"fingerprint"`
	}
	if jerr := json.Unmarshal(bytes.TrimSpace(out), &res); jerr != nil || res.Fingerprint == "" {
		if err == nil {
			err = errors.New("impronta non calcolata")
		}
		return "", err
	}
	return strings.TrimSpace(res.Fingerprint), nil
}
