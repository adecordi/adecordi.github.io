package main

import (
	"bytes"
	"encoding/binary"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/dhowden/tag"
	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/unicode/norm"
)

type songTags struct {
	Title       string `json:"title,omitempty"`
	Artist      string `json:"artist,omitempty"`
	Album       string `json:"album,omitempty"`
	AlbumArtist string `json:"album_artist,omitempty"`
	Genre       string `json:"genre,omitempty"`
	Composer    string `json:"composer,omitempty"`
	Comment     string `json:"comment,omitempty"`
	Lyrics      string `json:"lyrics,omitempty"`
	LyricsLang  string `json:"lyrics_lang,omitempty"`
	Year        int    `json:"year,omitempty"`
	Track       int    `json:"track,omitempty"`
	TrackTotal  int    `json:"track_total,omitempty"`
	Disc        int    `json:"disc,omitempty"`
	DiscTotal   int    `json:"disc_total,omitempty"`
	Picture     []byte `json:"-"`
	Format      string `json:"format,omitempty"`
	HasV1       bool   `json:"v1,omitempty"`
	Compilation bool   `json:"comp,omitempty"` // flag "compilation" di iTunes (TCMP)
}

// --- Lettura -----------------------------------------------------------------

// readTags legge i tag del file. raw contiene solo i campi ID3v2 così come
// sono scritti; t unisce anche l'ID3v1 e corregge i problemi di codifica.
func readTags(b []byte) (raw, t songTags) {
	if len(b) >= 10 && string(b[:3]) == "ID3" {
		if m, err := tag.ReadFrom(bytes.NewReader(b)); err == nil {
			raw.Format = string(m.Format())
			raw.Title = m.Title()
			raw.Artist = m.Artist()
			raw.Album = m.Album()
			raw.AlbumArtist = m.AlbumArtist()
			raw.Composer = m.Composer()
			raw.Genre = m.Genre()
			raw.Year = m.Year()
			raw.Track, raw.TrackTotal = m.Track()
			raw.Disc, raw.DiscTotal = m.Disc()
			var front, other []byte
			for _, k := range []string{"TCMP", "TCP"} {
				if v, ok := m.Raw()[k].(string); ok && strings.TrimSpace(v) == "1" {
					raw.Compilation = true
				}
			}
			for k, v := range m.Raw() {
				switch x := v.(type) {
				case *tag.Picture:
					if x.Type == "Cover (front)" && front == nil {
						front = x.Data
					} else if other == nil {
						other = x.Data
					}
				case *tag.Comm:
					switch {
					case strings.HasPrefix(k, "USLT") || strings.HasPrefix(k, "ULT"):
						if raw.Lyrics == "" {
							raw.Lyrics = strings.TrimSpace(x.Text)
							raw.LyricsLang = x.Language
						}
					case strings.HasPrefix(k, "COMM") || strings.HasPrefix(k, "COM"):
						if raw.Comment == "" && x.Description == "" {
							raw.Comment = x.Text
						}
					}
				}
			}
			if front != nil {
				raw.Picture = front
			} else {
				raw.Picture = other
			}
		}
	}
	t = raw
	if v1, ok := readID3v1(b); ok {
		raw.HasV1, t.HasV1 = true, true
		if raw.Format == "" {
			raw.Format, t.Format = "ID3v1", "ID3v1"
		}
		if t.Title == "" {
			t.Title = v1.Title
		}
		if t.Artist == "" {
			t.Artist = v1.Artist
		}
		if t.Album == "" {
			t.Album = v1.Album
		}
		if t.Year == 0 {
			t.Year = v1.Year
		}
		if t.Track == 0 {
			t.Track = v1.Track
		}
		if t.Genre == "" {
			t.Genre = v1.Genre
		}
	}
	t.Title = fixText(t.Title)
	t.Artist = fixText(t.Artist)
	t.Album = fixText(t.Album)
	t.AlbumArtist = fixText(t.AlbumArtist)
	t.Composer = fixText(t.Composer)
	t.Genre = cleanGenre(fixText(t.Genre))
	t.Comment = fixText(t.Comment)
	t.Lyrics = fixText(t.Lyrics)
	if t.Year < 1000 || t.Year > 2100 {
		t.Year = 0
	}
	return raw, t
}

func readID3v1(b []byte) (songTags, bool) {
	var t songTags
	if len(b) < 128 {
		return t, false
	}
	v := b[len(b)-128:]
	if string(v[:3]) != "TAG" {
		return t, false
	}
	field := func(p []byte) string {
		if i := bytes.IndexByte(p, 0); i >= 0 {
			p = p[:i]
		}
		var sb strings.Builder
		for _, c := range p {
			sb.WriteRune(charmap.Windows1252.DecodeByte(c))
		}
		return strings.TrimSpace(sb.String())
	}
	t.Title = field(v[3:33])
	t.Artist = field(v[33:63])
	t.Album = field(v[63:93])
	t.Year, _ = strconv.Atoi(field(v[93:97]))
	if v[125] == 0 && v[126] != 0 {
		t.Track = int(v[126])
	}
	if int(v[127]) < len(id3v1Genres) {
		t.Genre = id3v1Genres[v[127]]
	}
	return t, true
}

var genreNum = regexp.MustCompile(`^\((\d+)\)(.*)$`)

func cleanGenre(g string) string {
	g = strings.TrimSpace(g)
	if m := genreNum.FindStringSubmatch(g); m != nil {
		if rest := strings.TrimSpace(m[2]); rest != "" {
			return rest
		}
		g = m[1]
	}
	if n, err := strconv.Atoi(g); err == nil {
		if n >= 0 && n < len(id3v1Genres) {
			return id3v1Genres[n]
		}
		return ""
	}
	return g
}

// --- Pulizia dei testi -------------------------------------------------------

// fixText corregge i problemi di codifica più comuni: caratteri di controllo,
// testo Windows-1252 letto come Latin-1 e UTF-8 interpretato due volte
// ("PerchÃ©" -> "Perché").
func fixText(s string) string {
	if s == "" {
		return s
	}
	s = strings.Map(func(r rune) rune {
		if r >= 0x80 && r <= 0x9F {
			if d := charmap.Windows1252.DecodeByte(byte(r)); d != utf8.RuneError && (d < 0x80 || d > 0x9F) {
				return d
			}
			return -1
		}
		if r == 0 || r == utf8.RuneError || (r < 0x20 && r != '\n' && r != '\t') {
			return -1
		}
		return r
	}, s)
	if strings.ContainsAny(s, "ÃÂâ") {
		if enc, err := charmap.Windows1252.NewEncoder().String(s); err == nil && utf8.ValidString(enc) && enc != s {
			multi := false
			for _, r := range enc {
				if r >= 0x80 {
					multi = true
					break
				}
			}
			if multi {
				s = enc
			}
		}
	}
	return strings.TrimSpace(norm.NFC.String(s))
}

var (
	reURL       = regexp.MustCompile(`(?i)(?:https?://|www\.)[^\s\])}]+`)
	reDomain    = regexp.MustCompile(`(?i)\b[a-z0-9][a-z0-9-]{2,}\.(?:com|net|org|info|biz|ru|to|cc|tv|ws|fm|xyz|club|eu|io)\b(?:/\S*)?`)
	reBrackets  = regexp.MustCompile(`[\(\[\{]([^\(\)\[\]\{\}]*)[\)\]\}]`)
	reEmptyBr   = regexp.MustCompile(`[\(\[\{]\s*[\)\]\}]`)
	reSpaces    = regexp.MustCompile(`\s+`)
	reYouTube   = regexp.MustCompile(`(?i)\s*-\s*youtube\s*$`)
	reBitrate   = regexp.MustCompile(`(?i)^\d{2,3}(k|kb|kbs|kbps|kbit)?$`)
	reLeadNum   = regexp.MustCompile(`^\(?(\d{1,3})(?:[-.](\d{1,3}))?\)?(\s*)([-._)]?)(\s*)`)
	reParens    = regexp.MustCompile(`\s*[\(\[][^\)\]]*[\)\]]`)
	reJunkTitle = regexp.MustCompile(`(?i)^((track|traccia|brano|pista|audio ?track|registrazione|new recording)\s*#?\s*\d+|untitled|senza titolo|unknown|sconosciuto|titolo sconosciuto|unknown title)$`)
)

var strongJunk = map[string]bool{
	"official": true, "ufficiale": true, "oficial": true, "officiel": true, "video": true,
	"videoclip": true, "lyric": true, "lyrics": true, "testo": true, "hq": true, "hd": true,
	"mp3": true, "kbps": true, "download": true, "youtube": true, "visualizer": true,
	"1080p": true, "720p": true, "4k": true,
}

var weakJunk = map[string]bool{
	"music": true, "audio": true, "clip": true, "free": true, "full": true, "with": true,
	"con": true, "high": true, "quality": true, "version": true, "versione": true,
	"new": true, "best": true, "sound": true, "and": true, "e": true, "the": true,
}

func isJunkGroup(content string) bool {
	words := strings.FieldsFunc(strings.ToLower(content), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
	if len(words) == 0 {
		return true
	}
	strong := false
	for _, w := range words {
		switch {
		case strongJunk[w]:
			strong = true
		case weakJunk[w], reBitrate.MatchString(w):
		default:
			return false
		}
	}
	return strong
}

func isSpam(s string) bool {
	l := strings.ToLower(s)
	return reURL.MatchString(s) || reDomain.MatchString(s) || strings.Contains(l, "downloaded from") ||
		strings.Contains(l, "ripped by") || strings.Contains(l, "scaricato da")
}

func removeJunk(s string) string {
	s = reURL.ReplaceAllString(s, " ")
	s = reDomain.ReplaceAllString(s, " ")
	s = reYouTube.ReplaceAllString(s, "")
	s = reBrackets.ReplaceAllStringFunc(s, func(m string) string {
		if isJunkGroup(m[1 : len(m)-1]) {
			return " "
		}
		return m
	})
	s = reEmptyBr.ReplaceAllString(s, " ")
	return tidy(s)
}

func tidy(s string) string {
	s = reSpaces.ReplaceAllString(s, " ")
	s = strings.ReplaceAll(s, " ,", ",")
	return strings.Trim(s, " -_.~,;")
}

// cleanField pulisce un campo di testo (titolo, artista, album).
func cleanField(s string) string {
	s = fixText(s)
	if s == "" {
		return s
	}
	s = removeJunk(s)
	return fixCase(s)
}

var smallWords = map[string]bool{
	"a": true, "an": true, "and": true, "as": true, "at": true, "but": true, "by": true,
	"for": true, "from": true, "in": true, "into": true, "nor": true, "of": true, "on": true,
	"or": true, "the": true, "to": true, "vs": true, "with": true, "feat": true, "ft": true,
	"ad": true, "al": true, "alla": true, "alle": true, "ai": true, "agli": true, "che": true,
	"col": true, "con": true, "da": true, "dai": true, "dal": true, "dalla": true, "de": true,
	"dei": true, "del": true, "della": true, "delle": true, "di": true, "e": true, "ed": true,
	"è": true, "gli": true, "i": true, "il": true, "la": true, "le": true, "lo": true,
	"nel": true, "nella": true, "o": true, "per": true, "su": true, "sul": true,
	"sulla": true, "tra": true, "fra": true, "un": true, "una": true, "uno": true,
}

var romanNumerals = map[string]bool{
	"ii": true, "iii": true, "iv": true, "vi": true, "vii": true, "viii": true, "ix": true,
	"xi": true, "xii": true, "xiii": true,
}

// fixCase sistema maiuscole/minuscole solo se il testo è tutto maiuscolo o
// tutto minuscolo; le grafie miste vengono lasciate come sono.
func fixCase(s string) string {
	letters, upper, lower := 0, 0, 0
	for _, r := range s {
		if unicode.IsLetter(r) {
			letters++
			if unicode.IsUpper(r) {
				upper++
			} else if unicode.IsLower(r) {
				lower++
			}
		}
	}
	if letters < 2 {
		return s
	}
	words := strings.Fields(s)
	if upper == letters {
		if len(words) < 2 && letters <= 5 {
			return s
		}
		return titleCase(s)
	}
	if lower == letters {
		return titleCase(s)
	}
	return s
}

func titleCase(s string) string {
	words := strings.Fields(strings.ToLower(s))
	for i, w := range words {
		core := strings.TrimFunc(w, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) })
		if romanNumerals[core] {
			words[i] = strings.ToUpper(w)
			continue
		}
		startsGroup := strings.IndexAny(w, "([{\"") == 0
		if i > 0 && i < len(words)-1 && smallWords[core] && !startsGroup && !strings.HasSuffix(words[i-1], "-") {
			continue
		}
		words[i] = capitalizeFirst(w)
	}
	return strings.Join(words, " ")
}

func capitalizeFirst(w string) string {
	for i, r := range w {
		if unicode.IsLetter(r) {
			return w[:i] + string(unicode.ToUpper(r)) + w[i+utf8.RuneLen(r):]
		}
		if unicode.IsDigit(r) {
			return w
		}
	}
	return w
}

func isVariousArtists(s string) bool {
	switch normKey(s) {
	case "various artists", "various", "artisti vari", "va", "v a", "aa vv", "aavv", "autori vari", "vari", "compilation", "various artist":
		return true
	}
	return false
}

var reCompilationTitle = regexp.MustCompile(`(?i)\b(greatest hits|best of|the best|very best|collection|anthology|compilation|festivalbar|sanremo|hit ?mania|now that'?s what i call|the essential|essential|gold|platinum|raccolta|il meglio|i successi|grandi successi|successi|top hits|hits? \d{2,4}|hits? of|summer hits|love songs|number ones|singles|vol(ume)?\.? ?\d+|playlist)\b`)

// looksLikeCompilationTitle riconosce i titoli tipici delle raccolte.
func looksLikeCompilationTitle(album string) bool {
	return album != "" && reCompilationTitle.MatchString(album)
}

func isJunkTitle(s string) bool {
	return strings.TrimSpace(s) == "" || reJunkTitle.MatchString(strings.TrimSpace(s))
}

func isJunkArtist(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "", "unknown", "unknown artist", "artista sconosciuto", "sconosciuto", "various",
		"various artists", "artisti vari", "artist", "artista", "va", "v.a.", "<unknown>", "autore sconosciuto":
		return true
	}
	return false
}

func splitDash(s string) []string {
	for _, sep := range []string{" - ", " – ", " — ", " -- "} {
		if strings.Contains(s, sep) {
			parts := strings.Split(s, sep)
			out := parts[:0]
			for _, p := range parts {
				if p = tidy(p); p != "" {
					out = append(out, p)
				}
			}
			return out
		}
	}
	return []string{s}
}

var reYearOnly = regexp.MustCompile(`^(19|20)\d\d$`)

// parseFileName ricava artista, titolo e numero di traccia dal nome del file.
func parseFileName(path string) (artist, title string, track int) {
	base := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	base = fixText(base)
	base = strings.ReplaceAll(base, "%20", " ")
	if !strings.Contains(base, " ") || strings.Count(base, "_") >= 2 {
		base = strings.ReplaceAll(base, "_", " ")
	}
	if !strings.Contains(base, " ") && strings.Contains(base, ".") {
		segs := strings.Split(base, ".")
		long := true
		for _, sg := range segs {
			if len(sg) < 2 {
				long = false
			}
		}
		if long {
			base = strings.Join(segs, " ")
		}
	}
	base = removeJunk(base)
	base, track = stripLeadTrack(base)
	parts := splitDash(base)
	if len(parts) == 1 && strings.Count(base, "-") == 1 {
		if p := strings.Split(base, "-"); strings.Contains(p[0], " ") || strings.Contains(p[1], " ") {
			parts = []string{tidy(p[0]), tidy(p[1])}
		}
	}
	// scarta eventuali numeri di traccia rimasti in mezzo
	clean := parts[:0]
	for _, p := range parts {
		if n, err := strconv.Atoi(p); err == nil && n < 100 && len(parts) > 2 {
			if track == 0 {
				track = n
			}
			continue
		}
		if p != "" {
			clean = append(clean, p)
		}
	}
	parts = clean
	// "Artista - Titolo - Anno", il nome che dà il sito delle playlist
	if len(parts) == 3 && reYearOnly.MatchString(parts[2]) {
		parts = parts[:2]
	}
	switch {
	case len(parts) == 0:
		return "", "", track
	case len(parts) == 1:
		title = parts[0]
	case len(parts) == 2:
		artist, title = parts[0], parts[1]
	default:
		artist, title = parts[0], strings.Join(parts[2:], " - ")
	}
	return fixCase(artist), fixCase(title), track
}

// stripLeadTrack toglie un numero di traccia iniziale ("01 - ", "1-05 ",
// "03. ") senza toccare nomi che iniziano con un numero, come "883 - ...".
func stripLeadTrack(s string) (string, int) {
	m := reLeadNum.FindStringSubmatch(s)
	if m == nil {
		return s, 0
	}
	rest := s[len(m[0]):]
	if strings.TrimSpace(rest) == "" || (m[3] == "" && m[4] == "" && m[5] == "") {
		return s, 0
	}
	num := m[1]
	if m[2] != "" {
		num = m[2]
	}
	leadingZero := len(m[1]) >= 2 && m[1][0] == '0'
	switch {
	case m[2] != "":
	case m[4] == "":
		if !leadingZero {
			return s, 0
		}
	case m[4] == "-":
		if !leadingZero && len(m[1]) == 3 && !strings.Contains(rest, " - ") {
			return s, 0
		}
	}
	n, _ := strconv.Atoi(num)
	return tidy(rest), n
}

// normKey produce una chiave di confronto: minuscole, senza accenti né
// punteggiatura.
func normKey(s string) string {
	s = strings.ToLower(fixText(s))
	s = strings.ReplaceAll(s, "&", " and ")
	var sb strings.Builder
	for _, r := range norm.NFD.String(s) {
		switch {
		case unicode.Is(unicode.Mn, r):
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			sb.WriteRune(r)
		default:
			sb.WriteRune(' ')
		}
	}
	k := strings.Join(strings.Fields(sb.String()), " ")
	k = strings.TrimPrefix(k, "the ")
	return k
}

func stripParens(s string) string {
	return tidy(reParens.ReplaceAllString(s, ""))
}

// --- Nomi di file ------------------------------------------------------------

var reservedNames = map[string]bool{
	"con": true, "prn": true, "aux": true, "nul": true,
	"com1": true, "com2": true, "com3": true, "com4": true, "com5": true, "com6": true, "com7": true, "com8": true, "com9": true,
	"lpt1": true, "lpt2": true, "lpt3": true, "lpt4": true, "lpt5": true, "lpt6": true, "lpt7": true, "lpt8": true, "lpt9": true,
}

// safeFileName rende un testo utilizzabile come nome di file su FAT32/NTFS.
func safeFileName(s string, maxLen int) string {
	s = strings.NewReplacer("/", "-", "\\", "-", ":", " -", "|", "-", "\"", "'",
		"*", "", "?", "", "<", "", ">", "").Replace(s)
	s = strings.Map(func(r rune) rune {
		if r < 0x20 {
			return -1
		}
		return r
	}, s)
	s = reSpaces.ReplaceAllString(s, " ")
	s = strings.TrimRight(strings.TrimSpace(s), ". ")
	if utf8.RuneCountInString(s) > maxLen {
		r := []rune(s)[:maxLen]
		cut := string(r)
		if i := strings.LastIndex(cut, " "); i > maxLen/2 {
			cut = cut[:i]
		}
		s = strings.TrimRight(strings.TrimSpace(cut), ". -")
	}
	if s == "" {
		s = "Senza titolo"
	}
	base := strings.ToLower(s)
	if i := strings.IndexByte(base, '.'); i >= 0 {
		base = base[:i]
	}
	if reservedNames[base] {
		s += "_"
	}
	return s
}

// playlistFileName è il nome (senza estensione) di un brano nelle cartelle
// delle playlist: "Artista - Titolo - Anno", senza l'anno se non si conosce.
func playlistFileName(t songTags) string {
	name := t.Title
	if t.Artist != "" {
		name = t.Artist + " - " + t.Title
	}
	if t.Year > 0 {
		name += " - " + strconv.Itoa(t.Year)
	}
	return safeFileName(name, 140)
}

// --- Scrittura ---------------------------------------------------------------

func isLatin1(s string) bool {
	for _, r := range s {
		if r > 0xFF {
			return false
		}
	}
	return true
}

func encodeID3Text(s string, terminate bool) (enc byte, data []byte) {
	if isLatin1(s) {
		for _, r := range s {
			data = append(data, byte(r))
		}
		if terminate {
			data = append(data, 0)
		}
		return 0, data
	}
	data = []byte{0xFF, 0xFE}
	for _, u := range utf16.Encode([]rune(s)) {
		data = append(data, byte(u), byte(u>>8))
	}
	if terminate {
		data = append(data, 0, 0)
	}
	return 1, data
}

func writeFrame(w *bytes.Buffer, id string, data []byte) {
	w.WriteString(id)
	var sz [4]byte
	binary.BigEndian.PutUint32(sz[:], uint32(len(data)))
	w.Write(sz[:])
	w.Write([]byte{0, 0})
	w.Write(data)
}

// buildID3v23 crea un tag ID3v2.3: è la versione letta da più lettori,
// autoradio comprese. Il testo è in ISO-8859-1 quando possibile, altrimenti
// in UTF-16.
func buildID3v23(t songTags) []byte {
	var fr bytes.Buffer
	text := func(id, v string) {
		if v == "" {
			return
		}
		enc, d := encodeID3Text(v, false)
		writeFrame(&fr, id, append([]byte{enc}, d...))
	}
	text("TIT2", t.Title)
	text("TPE1", t.Artist)
	text("TALB", t.Album)
	text("TPE2", t.AlbumArtist)
	text("TCOM", t.Composer)
	text("TCON", t.Genre)
	if t.Year > 0 {
		text("TYER", strconv.Itoa(t.Year))
	}
	if t.Track > 0 {
		v := strconv.Itoa(t.Track)
		if t.TrackTotal > 0 {
			v += "/" + strconv.Itoa(t.TrackTotal)
		}
		text("TRCK", v)
	}
	if t.Disc > 0 {
		v := strconv.Itoa(t.Disc)
		if t.DiscTotal > 0 {
			v += "/" + strconv.Itoa(t.DiscTotal)
		}
		text("TPOS", v)
	}
	langText := func(id, lang, v string) {
		if v == "" {
			return
		}
		if len(lang) != 3 {
			lang = "ita"
		}
		enc, body := encodeID3Text(v, false)
		d := append([]byte{enc}, lang...)
		if enc == 0 {
			d = append(d, 0)
		} else {
			d = append(d, 0xFF, 0xFE, 0, 0)
		}
		writeFrame(&fr, id, append(d, body...))
	}
	langText("COMM", "ita", t.Comment)
	langText("USLT", t.LyricsLang, t.Lyrics)
	if len(t.Picture) > 0 {
		d := []byte{0}
		d = append(d, "image/jpeg"...)
		d = append(d, 0, 3, 0)
		d = append(d, t.Picture...)
		writeFrame(&fr, "APIC", d)
	}
	const padding = 2048
	size := fr.Len() + padding
	out := make([]byte, 0, 10+size)
	out = append(out, 'I', 'D', '3', 3, 0, 0,
		byte(size>>21&0x7F), byte(size>>14&0x7F), byte(size>>7&0x7F), byte(size&0x7F))
	out = append(out, fr.Bytes()...)
	out = append(out, make([]byte, padding)...)
	return out
}

func toWindows1252(s string, n int) []byte {
	out := make([]byte, 0, n)
	for _, r := range s {
		if len(out) == n {
			break
		}
		if b, ok := charmap.Windows1252.EncodeRune(r); ok {
			out = append(out, b)
			continue
		}
		// prova senza accenti
		if base := []rune(norm.NFD.String(string(r))); len(base) > 0 {
			if b, ok := charmap.Windows1252.EncodeRune(base[0]); ok {
				out = append(out, b)
				continue
			}
		}
		out = append(out, '?')
	}
	return out
}

func buildID3v1(t songTags) []byte {
	b := make([]byte, 128)
	copy(b, "TAG")
	copy(b[3:33], toWindows1252(t.Title, 30))
	copy(b[33:63], toWindows1252(t.Artist, 30))
	copy(b[63:93], toWindows1252(t.Album, 30))
	if t.Year > 0 {
		copy(b[93:97], strconv.Itoa(t.Year))
	}
	if t.Track > 0 && t.Track < 256 {
		b[126] = byte(t.Track)
	}
	b[127] = 255
	for i, g := range id3v1Genres {
		if strings.EqualFold(g, t.Genre) {
			b[127] = byte(i)
			break
		}
	}
	return b
}

var id3v1Genres = []string{
	"Blues", "Classic Rock", "Country", "Dance", "Disco", "Funk", "Grunge", "Hip-Hop", "Jazz", "Metal",
	"New Age", "Oldies", "Other", "Pop", "R&B", "Rap", "Reggae", "Rock", "Techno", "Industrial",
	"Alternative", "Ska", "Death Metal", "Pranks", "Soundtrack", "Euro-Techno", "Ambient", "Trip-Hop", "Vocal", "Jazz+Funk",
	"Fusion", "Trance", "Classical", "Instrumental", "Acid", "House", "Game", "Sound Clip", "Gospel", "Noise",
	"AlternRock", "Bass", "Soul", "Punk", "Space", "Meditative", "Instrumental Pop", "Instrumental Rock", "Ethnic", "Gothic",
	"Darkwave", "Techno-Industrial", "Electronic", "Pop-Folk", "Eurodance", "Dream", "Southern Rock", "Comedy", "Cult", "Gangsta",
	"Top 40", "Christian Rap", "Pop/Funk", "Jungle", "Native American", "Cabaret", "New Wave", "Psychadelic", "Rave", "Showtunes",
	"Trailer", "Lo-Fi", "Tribal", "Acid Punk", "Acid Jazz", "Polka", "Retro", "Musical", "Rock & Roll", "Hard Rock",
	"Folk", "Folk-Rock", "National Folk", "Swing", "Fast Fusion", "Bebob", "Latin", "Revival", "Celtic", "Bluegrass",
	"Avantgarde", "Gothic Rock", "Progressive Rock", "Psychedelic Rock", "Symphonic Rock", "Slow Rock", "Big Band", "Chorus", "Easy Listening", "Acoustic",
	"Humour", "Speech", "Chanson", "Opera", "Chamber Music", "Sonata", "Symphony", "Booty Bass", "Primus", "Porn Groove",
	"Satire", "Slow Jam", "Club", "Tango", "Samba", "Folklore", "Ballad", "Power Ballad", "Rhythmic Soul", "Freestyle",
	"Duet", "Punk Rock", "Drum Solo", "A capella", "Euro-House", "Dance Hall", "Goa", "Drum & Bass", "Club-House", "Hardcore",
	"Terror", "Indie", "BritPop", "Negerpunk", "Polsk Punk", "Beat", "Christian Gangsta Rap", "Heavy Metal", "Black Metal", "Crossover",
	"Contemporary Christian", "Christian Rock", "Merengue", "Salsa", "Thrash Metal", "Anime", "JPop", "Synthpop",
}
