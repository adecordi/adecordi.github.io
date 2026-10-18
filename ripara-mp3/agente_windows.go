//go:build windows

package main

import (
	"bufio"
	"fmt"
	"os"
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

// installAgent non installa niente: il programma resta dove è stato
// scaricato. La versione 1.3 si copiava nella cartella dei programmi,
// creava un collegamento con PowerShell e si metteva fra i programmi
// all'avvio: sono proprio le mosse che gli antivirus guardano con sospetto.
// Qui si toglie quello che aveva lasciato e l'avvio con Windows si offre
// solo come domanda, con risposta predefinita «no».
func installAgent(a *agent) {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	exe = strings.TrimPrefix(exe, `\\?\`) // Windows lo aggiunge ai percorsi lunghi
	if base := os.Getenv("LOCALAPPDATA"); base != "" {
		old := filepath.Join(base, "RiparaMP3", "RiparaMP3-Collega.exe")
		if exists(old) && !samePath(old, exe) {
			os.Remove(old)
		}
	}
	if desk, err := windows.KnownFolderPath(windows.FOLDERID_Desktop, 0); err == nil {
		os.Remove(filepath.Join(desk, "Musica - collega al sito.lnk"))
	}
	k, _, err := registry.CreateKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Run`, registry.QUERY_VALUE|registry.SET_VALUE)
	if err != nil {
		return
	}
	defer k.Close()
	if v, _, err := k.GetStringValue(runValue); err == nil && !samePath(strings.Trim(v, `"`), exe) {
		k.DeleteValue(runValue)
		a.cfg.AvvioChiesto = false
	}
	fmt.Printf("\nPer collegarti un'altra volta fai doppio clic su questo file:\n  %s\n", exe)
	if a.cfg.AvvioChiesto {
		return
	}
	u := &ui{r: bufio.NewReader(os.Stdin), yes: a.o.yes}
	if u.yesNo("\nVuoi che il collegamento parta da solo quando accendi il PC?", false) {
		k.SetStringValue(runValue, `"`+exe+`"`)
	}
	a.cfg.AvvioChiesto = true
	a.saveCfg()
}
