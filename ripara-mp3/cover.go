package main

import (
	"bytes"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"image"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

// Le copertine vengono salvate al massimo a 500x500 in JPEG baseline: è il
// formato che anche le autoradio più vecchie riescono a mostrare.
const coverMax = 500

type coverStore struct {
	mu     sync.Mutex
	byID   map[string][]byte
	thumbs map[string]string
}

func newCoverStore() *coverStore {
	return &coverStore{byID: map[string][]byte{}, thumbs: map[string]string{}}
}

// add normalizza un'immagine e restituisce il suo identificativo ("" se non
// è un'immagine valida).
func (c *coverStore) add(raw []byte) string {
	if len(raw) == 0 {
		return ""
	}
	img, err := normalizeCover(raw)
	if err != nil {
		return ""
	}
	sum := sha1.Sum(img)
	id := hex.EncodeToString(sum[:8])
	c.mu.Lock()
	c.byID[id] = img
	c.mu.Unlock()
	return id
}

func (c *coverStore) get(id string) []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.byID[id]
}

func (c *coverStore) thumb(id string) string {
	c.mu.Lock()
	if t, ok := c.thumbs[id]; ok {
		c.mu.Unlock()
		return t
	}
	raw := c.byID[id]
	c.mu.Unlock()
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return ""
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, resize(img, 96), &jpeg.Options{Quality: 80}); err != nil {
		return ""
	}
	t := "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(buf.Bytes())
	c.mu.Lock()
	c.thumbs[id] = t
	c.mu.Unlock()
	return t
}

func normalizeCover(raw []byte) ([]byte, error) {
	cfg, format, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	if cfg.Width < 16 || cfg.Height < 16 {
		return nil, image.ErrFormat
	}
	if format == "jpeg" && cfg.Width <= coverMax && cfg.Height <= coverMax && len(raw) <= 300<<10 && !isProgressiveJPEG(raw) {
		return raw, nil
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, resize(img, coverMax), &jpeg.Options{Quality: 90}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func resize(img image.Image, max int) image.Image {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= max && h <= max {
		dst := image.NewRGBA(image.Rect(0, 0, w, h))
		draw.Draw(dst, dst.Bounds(), img, b.Min, draw.Src)
		return dst
	}
	if w >= h {
		h = h * max / w
		w = max
	} else {
		w = w * max / h
		h = max
	}
	if w < 1 {
		w = 1
	}
	if h < 1 {
		h = 1
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.CatmullRom.Scale(dst, dst.Bounds(), img, b, draw.Src, nil)
	return dst
}

func isProgressiveJPEG(b []byte) bool {
	if len(b) < 4 || b[0] != 0xFF || b[1] != 0xD8 {
		return false
	}
	p := 2
	for p+4 <= len(b) {
		if b[p] != 0xFF {
			return false
		}
		m := b[p+1]
		if m == 0xC2 || m == 0xC6 || m == 0xCA || m == 0xCE {
			return true
		}
		if m == 0xC0 || m == 0xC1 || m == 0xDA {
			return false
		}
		if m == 0xD8 || (m >= 0xD0 && m <= 0xD7) || m == 0x01 || m == 0xFF {
			p += 2
			continue
		}
		seg := int(b[p+2])<<8 | int(b[p+3])
		p += 2 + seg
	}
	return false
}

// folderCover cerca nella cartella un'immagine di copertina (cover.jpg,
// folder.jpg, AlbumArt*_Large.jpg ...).
func folderCover(dir string) []byte {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	type cand struct {
		name string
		rank int
	}
	var cands []cand
	var images []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		n := strings.ToLower(e.Name())
		ext := filepath.Ext(n)
		if ext != ".jpg" && ext != ".jpeg" && ext != ".png" {
			continue
		}
		images = append(images, e.Name())
		base := strings.TrimSuffix(n, ext)
		switch {
		case base == "cover" || base == "folder" || base == "front" || base == "copertina":
			cands = append(cands, cand{e.Name(), 0})
		case strings.HasPrefix(base, "albumart") && strings.HasSuffix(base, "large"):
			cands = append(cands, cand{e.Name(), 1})
		case strings.Contains(base, "cover") || strings.Contains(base, "front") || strings.Contains(base, "folder"):
			cands = append(cands, cand{e.Name(), 2})
		case strings.HasPrefix(base, "albumart"):
			cands = append(cands, cand{e.Name(), 3})
		}
	}
	if len(cands) == 0 && len(images) == 1 {
		cands = append(cands, cand{images[0], 4})
	}
	sort.Slice(cands, func(i, j int) bool { return cands[i].rank < cands[j].rank })
	for _, c := range cands {
		if b, err := os.ReadFile(filepath.Join(dir, c.name)); err == nil {
			if _, _, err := image.DecodeConfig(bytes.NewReader(b)); err == nil {
				return b
			}
		}
	}
	return nil
}
