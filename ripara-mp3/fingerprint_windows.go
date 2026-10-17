//go:build windows

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"

	_ "embed"
)

// fpcalc.exe ufficiale di Chromaprint 1.5.1 (vedi fpcalc/LICENSE.md).
//
//go:embed fpcalc/fpcalc.exe
var fpcalcExe []byte

const fpcalcSHA256 = "659ea2dba1a12d7df4fe2b6f23f60fd9414ae61aca1b014ee8fa37c5e09b930b"

// embeddedFpcalc estrae fpcalc.exe nella cartella dei dati del programma
// (una volta sola) e ne restituisce il percorso.
func embeddedFpcalc() (string, error) {
	sum := sha256.Sum256(fpcalcExe)
	if hex.EncodeToString(sum[:]) != fpcalcSHA256 {
		return "", errors.New("fpcalc incorporato non valido")
	}
	dir := appCacheDir()
	path := filepath.Join(dir, "fpcalc-1.5.1.exe")
	if b, err := os.ReadFile(path); err == nil && bytes.Equal(b, fpcalcExe) {
		return path, nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, fpcalcExe, 0o755); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return "", err
	}
	return path, nil
}
