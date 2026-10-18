//go:build windows

package main

import (
	"fmt"
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
	serial    string // numero di serie del volume, "XXXX-XXXX"
	fs        string // file system (FAT32, NTFS...)
}

// listDrivesFn è listDrives; le prove la sostituiscono con dischi finti.
var listDrivesFn = listDrives

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
		var label, fsName [261]uint16
		var serial uint32
		if err := windows.GetVolumeInformation(p, &label[0], uint32(len(label)), &serial, nil, nil, &fsName[0], uint32(len(fsName))); err != nil {
			continue
		}
		var free, total, totalFree uint64
		windows.GetDiskFreeSpaceEx(p, &free, &total, &totalFree)
		out = append(out, driveInfo{root: root, label: windows.UTF16ToString(label[:]), removable: t == windows.DRIVE_REMOVABLE,
			size: total, free: free, serial: fmt.Sprintf("%04X-%04X", serial>>16, serial&0xFFFF), fs: windows.UTF16ToString(fsName[:])})
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
