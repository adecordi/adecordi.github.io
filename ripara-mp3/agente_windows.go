//go:build windows

package main

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

var instanceMutex windows.Handle

// singleInstance impedisce di aprire due finestre di collegamento insieme.
func singleInstance() bool {
	name, _ := windows.UTF16PtrFromString(`Local\RiparaMP3-Collega`)
	h, err := windows.CreateMutex(nil, false, name)
	if err == windows.ERROR_ALREADY_EXISTS {
		if h != 0 {
			windows.CloseHandle(h)
		}
		return false
	}
	instanceMutex = h
	return true
}

var procSetThreadExecutionState = windows.NewLazySystemDLL("kernel32.dll").NewProc("SetThreadExecutionState")

const (
	esContinuous     = 0x80000000
	esSystemRequired = 0x00000001
)

// keepAwake impedisce al PC di andare in sospensione durante un lavoro. Lo
// stato vale per il thread: la goroutine resta sullo stesso thread finché il
// lavoro non finisce.
func keepAwake(on bool) {
	if on {
		runtime.LockOSThread()
		procSetThreadExecutionState.Call(esContinuous | esSystemRequired)
		return
	}
	procSetThreadExecutionState.Call(esContinuous)
	runtime.UnlockOSThread()
}

const runValue = "RiparaMP3 Collega"

// installAgent copia il programma nella cartella dei programmi dell'utente,
// mette un'icona sul desktop e, la prima volta, chiede se avviarlo con
// Windows.
func installAgent(a *agent) {
	exe, err := os.Executable()
	base := os.Getenv("LOCALAPPDATA")
	if err != nil || base == "" {
		return
	}
	dir := filepath.Join(base, "RiparaMP3")
	target := filepath.Join(dir, "RiparaMP3-Collega.exe")
	if !samePath(exe, target) {
		data, err := os.ReadFile(exe)
		if err != nil {
			return
		}
		if old, err := os.ReadFile(target); err != nil || !bytes.Equal(old, data) {
			if err := writeFileAtomic(target, data, 0o755); err != nil {
				return
			}
		}
		q := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
		ps := "$d=[Environment]::GetFolderPath('Desktop');" +
			"$s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'Musica - collega al sito.lnk'));" +
			"$s.TargetPath=" + q(target) + ";$s.WorkingDirectory=" + q(dir) + ";" +
			"$s.Description='Collega questo PC al sito delle playlist';$s.Save()"
		if exec.Command("powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps).Run() == nil {
			fmt.Println("\nSul desktop c'è l'icona «Musica - collega al sito» per riaprire questa finestra.")
		}
	}
	k, _, err := registry.CreateKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Run`, registry.QUERY_VALUE|registry.SET_VALUE)
	if err != nil {
		return
	}
	defer k.Close()
	if _, _, err := k.GetStringValue(runValue); err == nil || a.cfg.AvvioChiesto {
		return
	}
	u := &ui{r: bufio.NewReader(os.Stdin), yes: a.o.yes}
	if u.yesNo("\nVuoi che il collegamento parta da solo quando accendi il PC?", true) {
		k.SetStringValue(runValue, `"`+target+`"`)
	}
	a.cfg.AvvioChiesto = true
	a.saveCfg()
}
