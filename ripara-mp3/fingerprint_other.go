//go:build !windows

package main

import "errors"

// Fuori da Windows fpcalc non è incorporato: si usa quello installato.
func embeddedFpcalc() (string, error) {
	return "", errors.New("fpcalc non incorporato")
}
