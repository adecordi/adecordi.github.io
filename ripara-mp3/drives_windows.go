//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"

	"golang.org/x/sys/windows"
)

type driveInfo struct {
	root      string
	label     string
	removable bool
	size      uint64
	free      uint64
}

// listDrives elenca le unità rimovibili e i dischi interni con un volume
// leggibile (i lettori di schede vuoti vengono saltati).
func listDrives() []driveInfo {
	mask, err := windows.GetLogicalDrives()
	if err != nil {
		return nil
	}
	var out []driveInfo
	for i := 0; i < 26; i++ {
		if mask&(1<<uint(i)) == 0 {
			continue
		}
		root := string(rune('A'+i)) + `:\`
		p, _ := windows.UTF16PtrFromString(root)
		t := windows.GetDriveType(p)
		if t != windows.DRIVE_REMOVABLE && t != windows.DRIVE_FIXED {
			continue
		}
		var label [261]uint16
		if err := windows.GetVolumeInformation(p, &label[0], uint32(len(label)), nil, nil, nil, nil, 0); err != nil {
			continue
		}
		var free, total, totalFree uint64
		windows.GetDiskFreeSpaceEx(p, &free, &total, &totalFree)
		out = append(out, driveInfo{root, windows.UTF16ToString(label[:]), t == windows.DRIVE_REMOVABLE, total, free})
	}
	return out
}

func freeSpace(path string) uint64 {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0
	}
	var free, total, totalFree uint64
	if err := windows.GetDiskFreeSpaceEx(p, &free, &total, &totalFree); err != nil {
		return 0
	}
	return free
}

func openInBrowser(path string) {
	exec.Command("rundll32", "url.dll,FileProtocolHandler", path).Start()
}

func defaultBackupBase() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Music")
}

func appCacheDir() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = os.TempDir()
	}
	return filepath.Join(dir, "RiparaMP3")
}
