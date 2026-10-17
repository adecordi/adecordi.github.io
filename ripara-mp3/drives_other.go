//go:build !windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"golang.org/x/sys/unix"
)

type driveInfo struct {
	root      string
	label     string
	removable bool
	size      uint64
	free      uint64
}

func listDrives() []driveInfo {
	var out []driveInfo
	user := os.Getenv("USER")
	for _, base := range []string{"/media/" + user, "/run/media/" + user, "/Volumes"} {
		entries, err := os.ReadDir(base)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() && e.Name() != "Macintosh HD" {
				p := filepath.Join(base, e.Name())
				out = append(out, driveInfo{root: p, label: e.Name(), removable: true, free: freeSpace(p)})
			}
		}
	}
	if home, err := os.UserHomeDir(); err == nil {
		out = append(out, driveInfo{root: home, label: "home", free: freeSpace(home)})
	}
	return out
}

func freeSpace(path string) uint64 {
	var st unix.Statfs_t
	if err := unix.Statfs(path, &st); err != nil {
		return 0
	}
	return st.Bavail * uint64(st.Bsize)
}

func openInBrowser(path string) {
	if runtime.GOOS == "darwin" {
		exec.Command("open", path).Start()
		return
	}
	exec.Command("xdg-open", path).Start()
}

func defaultBackupBase() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Music")
}

func appCacheDir() string {
	dir, err := os.UserCacheDir()
	if err != nil {
		dir = os.TempDir()
	}
	return filepath.Join(dir, "RiparaMP3")
}
