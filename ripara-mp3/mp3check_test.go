package main

import (
	"bytes"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// I test che lavorano su mp3 veri li generano con ffmpeg; se ffmpeg non c'è
// vengono saltati.

var (
	genOnce sync.Once
	genDir  string
	genErr  error
)

type genSpec struct {
	name string
	args []string
}

var genSpecs = []genSpec{
	{"cbr128", []string{"-c:a", "libmp3lame", "-b:a", "128k", "-ac", "2"}},
	{"vbr", []string{"-c:a", "libmp3lame", "-q:a", "2", "-ac", "2"}},
	{"mono64", []string{"-c:a", "libmp3lame", "-b:a", "64k", "-ac", "1"}},
	{"mpeg2", []string{"-c:a", "libmp3lame", "-b:a", "64k", "-ar", "22050"}},
	{"noxing", []string{"-c:a", "libmp3lame", "-b:a", "192k", "-write_xing", "0"}},
	{"shine", []string{"-c:a", "libshine", "-b:a", "128k", "-ac", "2"}},
}

func ffmpegAvailable(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg non disponibile")
	}
}

func genFiles(t *testing.T) string {
	t.Helper()
	ffmpegAvailable(t)
	genOnce.Do(func() {
		genDir, genErr = os.MkdirTemp("", "riparamp3-gen")
		if genErr != nil {
			return
		}
		for _, g := range genSpecs {
			if genErr = encode(filepath.Join(genDir, g.name+".mp3"), 330, 20, g.args...); genErr != nil {
				return
			}
		}
	})
	if genErr != nil {
		t.Fatal(genErr)
	}
	return genDir
}

// encode crea un mp3 di prova (un tono con rumore rosa, che somiglia di più
// alla musica vera di un tono puro).
func encode(out string, freq, seconds int, args ...string) error {
	a := []string{"-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "sine=frequency=" + itoa(freq) + ":duration=" + itoa(seconds),
		"-f", "lavfi", "-i", "anoisesrc=d=" + itoa(seconds) + ":c=pink:a=0.25:seed=" + itoa(freq),
		"-filter_complex", "[0:a][1:a]amix=inputs=2,volume=2[a]", "-map", "[a]"}
	a = append(a, args...)
	a = append(a, out)
	cmd := exec.Command("ffmpeg", a...)
	if b, err := cmd.CombinedOutput(); err != nil {
		return &exec.Error{Name: "ffmpeg " + string(b), Err: err}
	}
	return nil
}

func itoa(n int) string { return strconv.Itoa(n) }

func ffmpegErrors(t *testing.T, data []byte) string {
	t.Helper()
	f := filepath.Join(t.TempDir(), "x.mp3")
	os.WriteFile(f, data, 0o644)
	out, _ := exec.Command("ffmpeg", "-v", "error", "-i", f, "-f", "null", "-").CombinedOutput()
	return strings.TrimSpace(string(out))
}

func load(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(genFiles(t), name+".mp3"))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

type corruption struct {
	name string
	fn   func(b []byte) []byte
}

var corruptions = []corruption{
	{"zeri 4KB", func(b []byte) []byte { clear(b[len(b)/2 : len(b)/2+4096]); return b }},
	{"0xFF 4KB", func(b []byte) []byte {
		for i := len(b) / 3; i < len(b)/3+4096; i++ {
			b[i] = 0xFF
		}
		return b
	}},
	{"casuali 8KB", func(b []byte) []byte {
		r := rand.New(rand.NewSource(1))
		r.Read(b[len(b)/2 : len(b)/2+8192])
		return b
	}},
	{"fine azzerata", func(b []byte) []byte { clear(b[len(b)-65536:]); return b }},
	{"inizio azzerato", func(b []byte) []byte { clear(b[:4096]); return b }},
}

func TestHealthyFiles(t *testing.T) {
	for _, g := range genSpecs {
		b := load(t, g.name)
		in := analyzeMP3(b, 0)
		if in.Defective {
			t.Errorf("%s: segnalato come rovinato: %v", g.name, in.Problems)
		}
		if in.Duration < 19.5 || in.Duration > 20.5 {
			t.Errorf("%s: durata %.2f", g.name, in.Duration)
		}
	}
}

func TestCorruptionsDetected(t *testing.T) {
	for _, g := range genSpecs {
		for _, c := range corruptions {
			b := c.fn(append([]byte(nil), load(t, g.name)...))
			if in := analyzeMP3(b, 0); !in.Defective {
				t.Errorf("%s / %s: non rilevato", g.name, c.name)
			}
		}
	}
}

func TestLameCRCDetectsBitFlip(t *testing.T) {
	for _, name := range []string{"cbr128", "vbr", "mono64", "mpeg2"} {
		b := append([]byte(nil), load(t, name)...)
		b[len(b)/2+200] ^= 0x10
		in := analyzeMP3(b, 0)
		if !in.MusicCRCBad || !in.Defective {
			t.Errorf("%s: bit cambiato non rilevato", name)
		}
	}
}

func TestTruncationWithXing(t *testing.T) {
	for _, name := range []string{"cbr128", "vbr", "mpeg2"} {
		b := load(t, name)
		in := analyzeMP3(b[:len(b)*6/10], 0)
		if !in.Defective || in.MissingSec < 7 {
			t.Errorf("%s: troncamento non rilevato (mancano %.1f s)", name, in.MissingSec)
		}
	}
}

func TestRepair(t *testing.T) {
	for _, g := range genSpecs {
		for _, c := range corruptions[:3] {
			b := c.fn(append([]byte(nil), load(t, g.name)...))
			p, removed, err := repairPayload(b)
			if err != nil {
				t.Fatalf("%s / %s: %v", g.name, c.name, err)
			}
			if removed < 3000 {
				t.Errorf("%s / %s: tolti solo %d byte", g.name, c.name, removed)
			}
			full := append(buildID3v23(songTags{Title: "x"}), p...)
			in := analyzeMP3(full, 0)
			if in.Gaps > 0 || in.MusicCRCBad || in.MissingSec > 0 {
				t.Errorf("%s / %s: dopo la riparazione: %v", g.name, c.name, in.Problems)
			}
			if xi := parseXingOf(full); xi != nil && xi.lameOff >= 0 && !xi.tagCRCOK {
				t.Errorf("%s / %s: CRC dell'header LAME non aggiornato", g.name, c.name)
			}
			if e := ffmpegErrors(t, full); e != "" {
				t.Errorf("%s / %s: ffmpeg segnala errori dopo la riparazione:\n%s", g.name, c.name, e)
			}
		}
	}
}

func parseXingOf(b []byte) *xingInfo {
	st, en, _ := audioBounds(b)
	s := scanFrames(b, st, en)
	if s.noFrames {
		return nil
	}
	h, _ := parseHeader(b[s.frames[0].off:])
	return parseXing(b, s.frames[0], h)
}

func TestOtherFormats(t *testing.T) {
	ffmpegAvailable(t)
	dir := t.TempDir()
	m4a := filepath.Join(dir, "a.mp3")
	if err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=duration=2", "-c:a", "aac", "-f", "ipod", m4a).Run(); err != nil {
		t.Skip("aac non disponibile")
	}
	b, _ := os.ReadFile(m4a)
	if in := analyzeMP3(b, 0); in.Format != "M4A/AAC" || in.Defective {
		t.Errorf("formato %q, rovinato %v", in.Format, in.Defective)
	}
	if in := analyzeMP3(make([]byte, 200000), 0); !in.Defective {
		t.Error("un file tutto a zero deve risultare rovinato")
	}
}

func TestTagsRoundTrip(t *testing.T) {
	payload := load(t, "cbr128")
	in := analyzeMP3(payload, 0)
	cover := testJPEG(t, 800, 600)
	norm, err := normalizeCover(cover)
	if err != nil {
		t.Fatal(err)
	}
	want := songTags{Title: "Perché no", Artist: "Lucio Battisti", Album: "Ελληνικά", Year: 1979,
		Track: 3, TrackTotal: 10, Genre: "Pop", Lyrics: "Testo\ndella canzone", Picture: norm}
	var out bytes.Buffer
	out.Write(buildID3v23(want))
	out.Write(audioPayload(payload, in))
	out.Write(buildID3v1(want))
	raw, got := readTags(out.Bytes())
	if raw.Format != "ID3v2.3" || !got.HasV1 {
		t.Errorf("formato %q, v1 %v", raw.Format, got.HasV1)
	}
	if got.Title != want.Title || got.Artist != want.Artist || got.Album != want.Album || got.Year != want.Year ||
		got.Track != want.Track || got.TrackTotal != want.TrackTotal || got.Genre != want.Genre || got.Lyrics != want.Lyrics {
		t.Errorf("tag riletti diversi:\n got %+v\nwant %+v", got, want)
	}
	if !bytes.Equal(got.Picture, norm) {
		t.Error("copertina diversa")
	}
	if chk := analyzeMP3(out.Bytes(), 0); chk.Defective {
		t.Errorf("file con i nuovi tag segnalato rovinato: %v", chk.Problems)
	}
	if _, err := exec.LookPath("ffprobe"); err == nil {
		f := filepath.Join(t.TempDir(), "t.mp3")
		os.WriteFile(f, out.Bytes(), 0o644)
		o, _ := exec.Command("ffprobe", "-v", "error", "-show_entries", "format_tags=title,artist,album", "-show_entries", "stream=codec_name,width", "-of", "default=nw=1", f).Output()
		s := string(o)
		for _, w := range []string{"title=Perché no", "artist=Lucio Battisti", "album=Ελληνικά", "codec_name=mjpeg", "width=600"} {
			if !strings.Contains(s, w) {
				t.Errorf("ffprobe non legge %q:\n%s", w, s)
			}
		}
	}
}
