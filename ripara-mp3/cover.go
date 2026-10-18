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
	"regexp"
	"sort"
	"strings"
	"sync"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

// Le copertine vengono salvate al massimo a 600x600 in JPEG baseline: è il
// formato che anche le autoradio meno recenti riescono a mostrare.
const coverMax = 600

// minCoverSide è la dimensione minima perché un'immagine già presente (nel
// file o nella cartella) valga la pena di essere tenuta.
const minCoverSide = 300

type coverStore struct {
	mu     sync.Mutex
	byID   map[string][]byte
	thumbs map[string]string
	dir    string // se non è vuota le copertine stanno su disco (server)
}

func newCoverStore() *coverStore {
	return &coverStore{byID: map[string][]byte{}, thumbs: map[string]string{}}
}

// newDiskCoverStore tiene le copertine in una cartella invece che in
// memoria: il server ne accumula migliaia.
func newDiskCoverStore(dir string) *coverStore {
	os.MkdirAll(dir, 0o755)
	return &coverStore{byID: map[string][]byte{}, thumbs: map[string]string{}, dir: dir}
}

var reCoverID = regexp.MustCompile(`^[0-9a-f]{16}$`)

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
	id := coverID(img)
	if c.dir != "" {
		p := filepath.Join(c.dir, id+".jpg")
		if !exists(p) {
			writeFileAtomic(p, img, 0o644)
		}
		return id
	}
	c.mu.Lock()
	c.byID[id] = img
	c.mu.Unlock()
	return id
}

// putNormalized salva una copertina già normalizzata con il suo
// identificativo (quelle mandate dall'agente).
func (c *coverStore) putNormalized(id string, img []byte) bool {
	if c.dir == "" || !reCoverID.MatchString(id) || coverID(img) != id {
		return false
	}
	if n, err := normalizeCover(img); err != nil || !bytes.Equal(n, img) {
		return false
	}
	p := filepath.Join(c.dir, id+".jpg")
	if !exists(p) {
		writeFileAtomic(p, img, 0o644)
	}
	return true
}

func (c *coverStore) has(id string) bool {
	if c.dir == "" {
		return c.get(id) != nil
	}
	return reCoverID.MatchString(id) && exists(filepath.Join(c.dir, id+".jpg"))
}

// thumbFile restituisce la miniatura JPEG da 160 pixel per il sito.
func (c *coverStore) thumbFile(id string) []byte {
	if c.dir == "" || !reCoverID.MatchString(id) {
		return nil
	}
	p := filepath.Join(c.dir, id+"_160.jpg")
	if b, err := os.ReadFile(p); err == nil {
		return b
	}
	img, _, err := image.Decode(bytes.NewReader(c.get(id)))
	if err != nil {
		return nil
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, resize(img, 160), &jpeg.Options{Quality: 80}); err != nil {
		return nil
	}
	writeFileAtomic(p, buf.Bytes(), 0o644)
	return buf.Bytes()
}

// minSide restituisce il lato più corto della copertina (0 se non c'è).
func (c *coverStore) minSide(id string) int {
	raw := c.get(id)
	if raw == nil {
		return 0
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		return 0
	}
	return min(cfg.Width, cfg.Height)
}

func (c *coverStore) get(id string) []byte {
	if c.dir != "" {
		if !reCoverID.MatchString(id) {
			return nil
		}
		b, _ := os.ReadFile(filepath.Join(c.dir, id+".jpg"))
		return b
	}
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
	c.mu.Unlock()
	raw := c.get(id)
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
	if format == "jpeg" && cfg.Width <= coverMax && cfg.Height <= coverMax && len(raw) <= 200<<10 && !isProgressiveJPEG(raw) {
		return raw, nil
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	// la qualità scende finché il file sta nei 200 KB: così il risultato,
	// normalizzato di nuovo, resta identico e la copertina ha sempre lo
	// stesso identificativo (sul PC, sul sito e dopo essere stata scritta)
	small := resize(img, coverMax)
	var buf bytes.Buffer
	for _, q := range []int{90, 80, 70, 60, 50} {
		buf.Reset()
		if err := jpeg.Encode(&buf, small, &jpeg.Options{Quality: q}); err != nil {
			return nil, err
		}
		if buf.Len() <= 200<<10 {
			break
		}
	}
	return buf.Bytes(), nil
}

// coverID è l'identificativo di una copertina già normalizzata.
func coverID(img []byte) string {
	sum := sha1.Sum(img)
	return hex.EncodeToString(sum[:8])
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
			// le miniature (AlbumArtSmall e simili) sono troppo piccole
			if cfg, _, err := image.DecodeConfig(bytes.NewReader(b)); err == nil && min(cfg.Width, cfg.Height) >= minCoverSide {
				return b
			}
		}
	}
	return nil
}
