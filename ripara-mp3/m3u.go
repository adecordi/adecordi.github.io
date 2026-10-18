package main

import (
	"strconv"
	"strings"

	"golang.org/x/text/encoding/charmap"
)

// Playlist .m3u per l'autoradio: percorsi relativi con "\", righe CRLF e
// testo Windows-1252, come se le aspettano gli apparecchi meno recenti. Solo
// se un nome ha caratteri che Windows-1252 non conosce si scrive una .m3u8
// in UTF-8.

type m3uEntry struct {
	Path    string // relativo alla chiavetta, con "/"
	Seconds int
	Title   string
}

func m3uFile(name string, entries []m3uEntry) (string, []byte) {
	var sb strings.Builder
	sb.WriteString("#EXTM3U\r\n")
	for _, e := range entries {
		title := strings.NewReplacer("\r", " ", "\n", " ").Replace(e.Title)
		sb.WriteString("#EXTINF:" + strconv.Itoa(e.Seconds) + "," + title + "\r\n")
		sb.WriteString(strings.ReplaceAll(e.Path, "/", `\`) + "\r\n")
	}
	base := safeFileName(name, 60)
	text := sb.String()
	if enc, err := charmap.Windows1252.NewEncoder().String(text); err == nil {
		return base + ".m3u", []byte(enc)
	}
	return base + ".m3u8", []byte(text)
}
