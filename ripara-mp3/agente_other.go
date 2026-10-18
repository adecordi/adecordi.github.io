//go:build !windows

package main

// Fuori da Windows l'agente serve solo per le prove: niente installazione.

func singleInstance() bool { return true }

func keepAwake(on bool) {}

func installAgent(a *agent) {}
