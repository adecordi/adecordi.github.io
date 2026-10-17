package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"strings"
)

// Analisi strutturale dei file MP3: individua i punti in cui il flusso di
// frame MPEG è rovinato (tipico dei settori danneggiati di una chiavetta) e
// permette di ricostruire un flusso pulito.

type frameHeader struct {
	version    int // 1 = MPEG1, 2 = MPEG2, 25 = MPEG2.5
	layer      int // 1, 2, 3
	crc        bool
	bitrate    int // kbps
	sampleRate int
	padding    int
	channels   int
	length     int
	samples    int
}

var (
	bitratesV1 = [3][16]int{
		{0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, -1},
		{0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, -1},
		{0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, -1},
	}
	bitratesV2 = [3][16]int{
		{0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, -1},
		{0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1},
		{0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1},
	}
	sampleRates = map[int][3]int{
		1:  {44100, 48000, 32000},
		2:  {22050, 24000, 16000},
		25: {11025, 12000, 8000},
	}
)

func parseHeader(b []byte) (frameHeader, bool) {
	var h frameHeader
	if len(b) < 4 || b[0] != 0xFF || b[1]&0xE0 != 0xE0 {
		return h, false
	}
	switch (b[1] >> 3) & 3 {
	case 0:
		h.version = 25
	case 2:
		h.version = 2
	case 3:
		h.version = 1
	default:
		return h, false
	}
	switch (b[1] >> 1) & 3 {
	case 1:
		h.layer = 3
	case 2:
		h.layer = 2
	case 3:
		h.layer = 1
	default:
		return h, false
	}
	h.crc = b[1]&1 == 0
	bi := int(b[2] >> 4)
	si := int(b[2]>>2) & 3
	if bi == 0 || bi == 15 || si == 3 {
		// bitrate "free format" non gestito
		return h, false
	}
	if b[3]&3 == 2 {
		// enfasi riservata
		return h, false
	}
	if h.version == 1 {
		h.bitrate = bitratesV1[h.layer-1][bi]
	} else {
		h.bitrate = bitratesV2[h.layer-1][bi]
	}
	h.sampleRate = sampleRates[h.version][si]
	h.padding = int(b[2]>>1) & 1
	if b[3]>>6 == 3 {
		h.channels = 1
	} else {
		h.channels = 2
	}
	br := h.bitrate * 1000
	switch h.layer {
	case 1:
		h.length = (12*br/h.sampleRate + h.padding) * 4
		h.samples = 384
	case 2:
		h.length = 144*br/h.sampleRate + h.padding
		h.samples = 1152
	case 3:
		if h.version == 1 {
			h.length = 144*br/h.sampleRate + h.padding
			h.samples = 1152
		} else {
			h.length = 72*br/h.sampleRate + h.padding
			h.samples = 576
		}
	}
	if h.length < 24 {
		return h, false
	}
	return h, true
}

func (h frameHeader) sideInfoSize() int {
	if h.layer != 3 {
		return 0
	}
	if h.version == 1 {
		if h.channels == 1 {
			return 17
		}
		return 32
	}
	if h.channels == 1 {
		return 9
	}
	return 17
}

func (h frameHeader) sameStream(o frameHeader) bool {
	return h.version == o.version && h.layer == o.layer && h.sampleRate == o.sampleRate
}

// --- Tag ai bordi del file --------------------------------------------------

func id3v2Size(b []byte) int {
	if len(b) < 10 || string(b[:3]) != "ID3" || b[3] == 0xFF || b[4] == 0xFF {
		return 0
	}
	if (b[6]|b[7]|b[8]|b[9])&0x80 != 0 {
		return 0
	}
	n := 10 + (int(b[6])<<21 | int(b[7])<<14 | int(b[8])<<7 | int(b[9]))
	if b[5]&0x10 != 0 {
		n += 10
	}
	return n
}

// audioBounds restituisce l'intervallo del file che sta fra i tag iniziali
// (ID3v2) e quelli finali (APE, Lyrics3, ID3v1).
func audioBounds(b []byte) (start, end int, hasV1 bool) {
	for {
		n := id3v2Size(b[start:])
		if n == 0 || start+n > len(b) {
			break
		}
		start += n
	}
	end = len(b)
	for i := 0; i < 4; i++ {
		changed := false
		if end-start >= 128 && string(b[end-128:end-125]) == "TAG" {
			end -= 128
			hasV1 = true
			changed = true
		}
		if end-start >= 15 && string(b[end-9:end]) == "LYRICS200" {
			if size, ok := parseDigits(b[end-15 : end-9]); ok {
				s := end - 15 - size
				if s >= start && s+11 <= end && bytes.HasPrefix(b[s:], []byte("LYRICSBEGIN")) {
					end = s
					changed = true
				}
			}
		}
		if end-start >= 32 && string(b[end-32:end-24]) == "APETAGEX" {
			size := int(binary.LittleEndian.Uint32(b[end-20:]))
			flags := binary.LittleEndian.Uint32(b[end-12:])
			if flags&(1<<31) != 0 {
				size += 32
			}
			if size > 0 && end-size >= start {
				end -= size
				changed = true
			}
		}
		if !changed {
			break
		}
	}
	return start, end, hasV1
}

func parseDigits(b []byte) (int, bool) {
	n := 0
	for _, c := range b {
		if c < '0' || c > '9' {
			return 0, false
		}
		n = n*10 + int(c-'0')
	}
	return n, len(b) > 0
}

// --- Scansione dei frame ----------------------------------------------------

type frameRef struct{ off, size int }

type gapRef struct{ off, size int }

type frameScan struct {
	sig       frameHeader
	frames    []frameRef
	leadJunk  int
	gaps      []gapRef
	tailJunk  int
	truncated int // byte mancanti all'ultimo frame incompleto
	noFrames  bool
}

func headerAt(b []byte, pos, end int, sig *frameHeader) (frameHeader, bool) {
	if pos < 0 || pos+4 > end {
		return frameHeader{}, false
	}
	h, ok := parseHeader(b[pos : pos+4])
	if !ok || (sig != nil && !sig.sameStream(h)) {
		return h, false
	}
	return h, true
}

// findSync cerca la prima posizione da cui partono `need` frame consecutivi
// validi (o che arrivano esattamente alla fine dei dati).
func findSync(b []byte, from, end int, sig *frameHeader, need int) (int, frameHeader, bool) {
	for p := from; p+4 <= end; p++ {
		i := bytes.IndexByte(b[p:end], 0xFF)
		if i < 0 {
			break
		}
		p += i
		h, ok := headerAt(b, p, end, sig)
		if !ok {
			continue
		}
		q := p + h.length
		good := true
		for k := 1; k < need; k++ {
			if q > end-4 {
				// arrivati alla fine dei dati
				break
			}
			h2, ok2 := headerAt(b, q, end, &h)
			if !ok2 {
				good = false
				break
			}
			q += h2.length
		}
		if good {
			return p, h, true
		}
	}
	return 0, frameHeader{}, false
}

func scanFrames(b []byte, start, end int) frameScan {
	var s frameScan
	p, h, ok := findSync(b, start, end, nil, 4)
	if !ok {
		p, h, ok = findSync(b, start, end, nil, 2)
	}
	if !ok {
		s.noFrames = true
		return s
	}
	s.sig = h
	s.leadJunk = p - start
	pos := p
	for pos < end {
		fh, ok := headerAt(b, pos, end, &s.sig)
		if ok {
			if pos+fh.length > end {
				s.truncated = pos + fh.length - end
				s.tailJunk = end - pos
				break
			}
			s.frames = append(s.frames, frameRef{pos, fh.length})
			pos += fh.length
			continue
		}
		np, _, found := findSync(b, pos+1, end, &s.sig, 3)
		if !found {
			s.tailJunk = end - pos
			break
		}
		s.gaps = append(s.gaps, gapRef{pos, np - pos})
		pos = np
	}
	return s
}

// --- Header Xing / Info / LAME ---------------------------------------------

type xingInfo struct {
	frameOff   int // inizio del frame che contiene l'header
	frameLen   int
	tagOff     int // posizione di "Xing"/"Info"
	flags      uint32
	frames     int
	bytes      int
	framesOff  int
	bytesOff   int
	tocOff     int
	lameOff    int // posizione della stringa encoder, -1 se assente
	musicLen   uint32
	musicCRC   uint16
	tagCRC     uint16
	tagCRCOK   bool
	tagCRCMode int // come è stato calcolato il CRC del tag (per ricalcolarlo)
	vbri       bool
}

func parseXing(b []byte, f frameRef, h frameHeader) *xingInfo {
	fr := b[f.off : f.off+f.size]
	x := &xingInfo{frameOff: f.off, frameLen: f.size, lameOff: -1}
	o := 4 + h.sideInfoSize()
	if h.crc {
		o += 2
	}
	if o+8 <= len(fr) && (string(fr[o:o+4]) == "Xing" || string(fr[o:o+4]) == "Info") {
		x.tagOff = f.off + o
		x.flags = binary.BigEndian.Uint32(fr[o+4:])
		p := o + 8
		if x.flags&1 != 0 && p+4 <= len(fr) {
			x.framesOff = f.off + p
			x.frames = int(binary.BigEndian.Uint32(fr[p:]))
			p += 4
		}
		if x.flags&2 != 0 && p+4 <= len(fr) {
			x.bytesOff = f.off + p
			x.bytes = int(binary.BigEndian.Uint32(fr[p:]))
			p += 4
		}
		if x.flags&4 != 0 && p+100 <= len(fr) {
			x.tocOff = f.off + p
			p += 100
		}
		if x.flags&8 != 0 {
			p += 4
		}
		if p+36 <= len(fr) && isEncoderString(fr[p:p+9]) {
			x.lameOff = f.off + p
			x.musicLen = binary.BigEndian.Uint32(fr[p+28:])
			x.musicCRC = binary.BigEndian.Uint16(fr[p+32:])
			x.tagCRC = binary.BigEndian.Uint16(fr[p+34:])
			// LAME calcola il CRC su tutto il frame fino al campo stesso;
			// ffmpeg sempre sui primi 190 byte, con il campo azzerato.
			switch x.tagCRC {
			case crc16ARC(fr[:p+34], 0):
				x.tagCRCOK, x.tagCRCMode = true, crcLAME
			case ffmpegTagCRC(fr, p+34):
				x.tagCRCOK, x.tagCRCMode = true, crcFFmpeg
			}
		}
		return x
	}
	if 36+18 <= len(fr) && string(fr[36:40]) == "VBRI" {
		x.vbri = true
		x.tagOff = f.off + 36
		x.bytes = int(binary.BigEndian.Uint32(fr[46:]))
		x.frames = int(binary.BigEndian.Uint32(fr[50:]))
		x.flags = 3
		return x
	}
	return nil
}

const (
	crcLAME = iota + 1
	crcFFmpeg
)

func ffmpegTagCRC(frame []byte, field int) uint16 {
	z := make([]byte, 190)
	copy(z, frame)
	if field+2 <= len(z) {
		z[field], z[field+1] = 0, 0
	}
	return crc16ARC(z, 0)
}

func isEncoderString(b []byte) bool {
	s := string(b)
	for _, p := range []string{"LAME", "Lavf", "Lavc", "L3.9", "GOGO"} {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}

// crc16ARC è il CRC-16 usato da LAME (polinomio 0x8005 riflesso).
func crc16ARC(data []byte, crc uint16) uint16 {
	for _, c := range data {
		crc ^= uint16(c)
		for i := 0; i < 8; i++ {
			if crc&1 != 0 {
				crc = crc>>1 ^ 0xA001
			} else {
				crc >>= 1
			}
		}
	}
	return crc
}

// crc16MPEG è il CRC opzionale dei frame MPEG (polinomio 0x8005, init 0xFFFF).
func crc16MPEG(data []byte, crc uint16) uint16 {
	for _, c := range data {
		crc ^= uint16(c) << 8
		for i := 0; i < 8; i++ {
			if crc&0x8000 != 0 {
				crc = crc<<1 ^ 0x8005
			} else {
				crc <<= 1
			}
		}
	}
	return crc
}

// --- Side info Layer III ----------------------------------------------------

type bitReader struct {
	b   []byte
	pos int
}

func (r *bitReader) read(n int) int {
	v := 0
	for i := 0; i < n; i++ {
		byteIdx := r.pos >> 3
		bit := 0
		if byteIdx < len(r.b) {
			bit = int(r.b[byteIdx]>>(7-uint(r.pos&7))) & 1
		}
		v = v<<1 | bit
		r.pos++
	}
	return v
}

// checkSideInfo verifica la coerenza delle informazioni laterali di un frame
// Layer III. Restituisce main_data_begin e se i valori sono plausibili.
func checkSideInfo(fr []byte, h frameHeader) (mainDataBegin, part23 int, ok bool) {
	o := 4
	if h.crc {
		o += 2
	}
	si := h.sideInfoSize()
	if o+si > len(fr) {
		return 0, 0, false
	}
	r := &bitReader{b: fr[o : o+si]}
	granules := 2
	if h.version == 1 {
		mainDataBegin = r.read(9)
		if h.channels == 1 {
			r.read(5)
		} else {
			r.read(3)
		}
		r.read(4 * h.channels)
	} else {
		granules = 1
		mainDataBegin = r.read(8)
		r.read(h.channels)
	}
	ok = true
	for g := 0; g < granules; g++ {
		for ch := 0; ch < h.channels; ch++ {
			part23 += r.read(12)
			if r.read(9) > 288 {
				ok = false
			}
			r.read(8)
			if h.version == 1 {
				r.read(4)
			} else {
				r.read(9)
			}
			if r.read(1) == 1 {
				if r.read(2) == 0 {
					ok = false
				}
				r.read(1 + 10 + 9)
			} else {
				r.read(15 + 4 + 3)
			}
			if h.version == 1 {
				r.read(3)
			} else {
				r.read(2)
			}
		}
	}
	return mainDataBegin, part23, ok
}

// --- Analisi complessiva ----------------------------------------------------

type mp3Info struct {
	Format      string // "" per mp3, altrimenti il formato riconosciuto
	AudioStart  int
	AudioEnd    int
	HasV1       bool
	FirstFrame  int
	PayloadEnd  int
	Frames      int
	Duration    float64
	Bitrate     int
	SampleRate  int
	Channels    int
	Gaps        int
	JunkBytes   int
	TailJunk    int
	LeadJunk    int
	Truncated   bool
	CRCErrors   int
	SideErrors  int
	MusicCRCBad bool
	MissingSec  float64
	LostSec     float64
	ReadErrors  int
	Defective   bool
	Problems    []string
	Repairable  bool
	hasXing     bool
	xingIsVBR   bool
	totalFrames int
}

func analyzeMP3(b []byte, readErrors int) *mp3Info {
	in := &mp3Info{ReadErrors: readErrors}
	if readErrors > 0 {
		in.Defective = true
		in.Problems = append(in.Problems, fmt.Sprintf("errori di lettura dalla chiavetta (%d blocchi illeggibili)", readErrors))
	}
	if f := otherFormat(b); f != "" {
		in.Format = f
		return in
	}
	in.AudioStart, in.AudioEnd, in.HasV1 = audioBounds(b)
	s := scanFrames(b, in.AudioStart, in.AudioEnd)
	if s.noFrames || len(s.frames) < 3 {
		in.Defective = true
		if mostlyBlank(b[in.AudioStart:in.AudioEnd]) {
			in.Problems = append(in.Problems, "file illeggibile: i dati sono vuoti o azzerati")
		} else {
			in.Problems = append(in.Problems, "nessun dato audio valido trovato")
		}
		return in
	}
	in.SampleRate = s.sig.sampleRate
	in.Channels = s.sig.channels
	in.FirstFrame = s.frames[0].off
	last := s.frames[len(s.frames)-1]
	in.PayloadEnd = last.off + last.size
	in.LeadJunk = s.leadJunk
	in.TailJunk = s.tailJunk
	in.Gaps = len(s.gaps)
	for _, g := range s.gaps {
		in.JunkBytes += g.size
	}
	in.totalFrames = len(s.frames)

	audioFrames := s.frames
	var xi *xingInfo
	if fh, ok := parseHeader(b[s.frames[0].off:]); ok {
		xi = parseXing(b, s.frames[0], fh)
	}
	if xi != nil {
		in.hasXing = true
		in.xingIsVBR = !xi.vbri && string(b[xi.tagOff:xi.tagOff+4]) == "Xing"
		audioFrames = s.frames[1:]
	}
	in.Frames = len(audioFrames)
	in.Duration = float64(in.Frames*s.sig.samples) / float64(s.sig.sampleRate)
	audioBytes := 0
	for _, f := range audioFrames {
		audioBytes += f.size
	}
	if in.Duration > 0 {
		in.Bitrate = int(float64(audioBytes)*8/in.Duration/1000 + 0.5)
	}

	// Controlli frame per frame.
	reservoir := 0
	gapIdx := 0
	afterGap := true
	for i, f := range s.frames {
		for gapIdx < len(s.gaps) && s.gaps[gapIdx].off < f.off {
			gapIdx++
			afterGap = true
		}
		fh, _ := parseHeader(b[f.off:])
		fr := b[f.off : f.off+f.size]
		if fh.layer == 3 {
			if fh.crc {
				si := fh.sideInfoSize()
				if 6+si <= len(fr) {
					want := binary.BigEndian.Uint16(fr[4:6])
					got := crc16MPEG(fr[6:6+si], crc16MPEG(fr[2:4], 0xFFFF))
					if want != got {
						in.CRCErrors++
					}
				}
			}
			mdb, part23, ok := checkSideInfo(fr, fh)
			mainSize := f.size - 4 - fh.sideInfoSize()
			if fh.crc {
				mainSize -= 2
			}
			isXingFrame := i == 0 && xi != nil
			if !isXingFrame {
				if !ok {
					in.SideErrors++
				} else if !afterGap && i > 1 && mdb > reservoir {
					in.SideErrors++
				} else if !afterGap && part23 > (mdb+mainSize)*8 {
					in.SideErrors++
				}
			}
			if afterGap && !isXingFrame {
				afterGap = false
				reservoir = 0
			}
			reservoir += mainSize
			if reservoir > 4096 {
				reservoir = 4096
			}
		}
	}
	if s.truncated > 0 {
		in.Truncated = true
	}

	// Header Xing: frame mancanti alla fine e CRC dei dati musicali.
	if xi != nil {
		if xi.flags&1 != 0 && xi.frames > in.Frames && in.Gaps == 0 {
			missing := xi.frames - in.Frames
			if missing > 2 && float64(missing) > float64(xi.frames)*0.01 {
				in.MissingSec = float64(missing*s.sig.samples) / float64(s.sig.sampleRate)
			}
		}
		if xi.lameOff >= 0 && xi.tagCRCOK && xi.musicLen > 0 {
			musicEnd := xi.frameOff + int(xi.musicLen)
			if musicEnd == in.PayloadEnd {
				start := xi.frameOff + xi.frameLen
				if crc16ARC(b[start:musicEnd], 0) != xi.musicCRC {
					in.MusicCRCBad = true
				}
			} else if musicEnd > in.PayloadEnd && in.Gaps == 0 && in.MissingSec == 0 {
				missingBytes := musicEnd - in.PayloadEnd
				if in.Bitrate > 0 && missingBytes > 4*s.frames[len(s.frames)-1].size {
					in.MissingSec = float64(missingBytes) * 8 / float64(in.Bitrate*1000)
				}
			}
		}
	}

	if in.Gaps > 0 {
		in.Defective = true
		in.Problems = append(in.Problems, fmt.Sprintf("%d %s (%s di dati non validi)",
			in.Gaps, plural(in.Gaps, "punto rovinato", "punti rovinati"), humanBytes(int64(in.JunkBytes))))
	}
	if in.LeadJunk >= 1024 && (in.AudioStart == 0 || !mostlyBlank(b[in.AudioStart:in.FirstFrame])) {
		in.Defective = true
		in.Problems = append(in.Problems, fmt.Sprintf("inizio del file rovinato (%s)", humanBytes(int64(in.LeadJunk))))
	}
	if in.TailJunk >= 4096 && !looksLikeText(b[in.PayloadEnd:in.AudioEnd]) {
		in.Defective = true
		in.Problems = append(in.Problems, fmt.Sprintf("parte finale rovinata (%s)", humanBytes(int64(in.TailJunk))))
	}
	if in.MissingSec > 0 {
		in.Defective = true
		in.Problems = append(in.Problems, fmt.Sprintf("file troncato: mancano circa %s alla fine", formatDuration(in.MissingSec)))
	}
	if in.MusicCRCBad {
		in.Defective = true
		in.Problems = append(in.Problems, "dati audio alterati (il controllo CRC non corrisponde)")
	}
	if in.CRCErrors > 0 && in.CRCErrors*2 < len(s.frames) {
		in.Defective = true
		in.Problems = append(in.Problems, fmt.Sprintf("%d frame con CRC errato", in.CRCErrors))
	}
	if in.SideErrors >= 3 {
		in.Defective = true
		in.Problems = append(in.Problems, fmt.Sprintf("%d frame con informazioni non valide", in.SideErrors))
	}
	if in.Bitrate > 0 {
		in.LostSec = float64(in.JunkBytes+in.TailJunk) * 8 / float64(in.Bitrate*1000)
	}
	in.Repairable = in.Frames >= 10
	return in
}

// cuttable dice se il danno consiste in parti da togliere (blocchi rovinati,
// inizio o fine illeggibili): solo in quel caso la riparazione serve.
func (in *mp3Info) cuttable() bool {
	return in.Repairable && (in.Gaps > 0 || in.TailJunk >= 4096 || in.LeadJunk >= 1024 || in.ReadErrors > 0)
}

// audioPayload restituisce i frame audio così come sono, senza tag e senza
// eventuali byte estranei all'inizio o alla fine.
func audioPayload(b []byte, in *mp3Info) []byte {
	return b[in.FirstFrame:in.PayloadEnd]
}

// repairPayload ricostruisce il flusso audio tenendo solo i frame integri e
// aggiorna l'header Xing/LAME (numero di frame, byte, indice, CRC).
func repairPayload(b []byte) ([]byte, int, error) {
	start, end, _ := audioBounds(b)
	s := scanFrames(b, start, end)
	if s.noFrames || len(s.frames) < 10 {
		return nil, 0, fmt.Errorf("troppo pochi dati audio integri")
	}
	var out bytes.Buffer
	offsets := make([]int, 0, len(s.frames))
	for _, f := range s.frames {
		offsets = append(offsets, out.Len())
		out.Write(b[f.off : f.off+f.size])
	}
	p := out.Bytes()
	kept := len(p)
	removed := (end - start) - kept
	if removed == 0 {
		// niente da togliere: il file resta com'è, compresi i CRC, che così
		// continuano a segnalare l'eventuale danno
		return p, 0, nil
	}

	fh, _ := parseHeader(b[s.frames[0].off:])
	xi := parseXing(b, s.frames[0], fh)
	if xi != nil && !xi.vbri {
		rel := func(abs int) int { return abs - xi.frameOff }
		nAudio := len(s.frames) - 1
		if xi.framesOff > 0 {
			binary.BigEndian.PutUint32(p[rel(xi.framesOff):], uint32(nAudio))
		}
		if xi.bytesOff > 0 {
			binary.BigEndian.PutUint32(p[rel(xi.bytesOff):], uint32(len(p)))
		}
		if xi.tocOff > 0 && nAudio > 0 {
			toc := p[rel(xi.tocOff) : rel(xi.tocOff)+100]
			for i := 0; i < 100; i++ {
				idx := 1 + i*nAudio/100
				v := offsets[idx] * 256 / len(p)
				if v > 255 {
					v = 255
				}
				toc[i] = byte(v)
			}
		}
		if xi.lameOff >= 0 {
			lo := rel(xi.lameOff)
			binary.BigEndian.PutUint32(p[lo+28:], uint32(len(p)))
			binary.BigEndian.PutUint16(p[lo+32:], crc16ARC(p[xi.frameLen:], 0))
			field := lo + 34
			if xi.tagCRCMode == crcFFmpeg {
				binary.BigEndian.PutUint16(p[field:], ffmpegTagCRC(p[:xi.frameLen], field))
			} else {
				binary.BigEndian.PutUint16(p[field:], crc16ARC(p[:field], 0))
			}
		}
	}
	return p, removed, nil
}

func otherFormat(b []byte) string {
	switch {
	case len(b) >= 12 && string(b[4:8]) == "ftyp":
		return "M4A/AAC"
	case len(b) >= 4 && string(b[:4]) == "fLaC":
		return "FLAC"
	case len(b) >= 4 && string(b[:4]) == "OggS":
		return "OGG"
	case len(b) >= 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WAVE":
		return "WAV"
	case len(b) >= 4 && bytes.Equal(b[:4], []byte{0x30, 0x26, 0xB2, 0x75}):
		return "WMA"
	}
	return ""
}

func mostlyBlank(b []byte) bool {
	if len(b) == 0 {
		return true
	}
	blank := 0
	for _, c := range b {
		if c == 0 || c == 0xFF {
			blank++
		}
	}
	return blank*10 >= len(b)*9
}

func looksLikeText(b []byte) bool {
	if len(b) == 0 {
		return true
	}
	printable := 0
	zeros := 0
	for _, c := range b {
		switch {
		case c == 0:
			zeros++
		case c == '\n' || c == '\r' || c == '\t' || (c >= 0x20 && c < 0x7F):
			printable++
		}
	}
	// un'area quasi tutta a zero non è un tag ma un pezzo di file perso
	return printable > 0 && zeros*2 < len(b) && (printable+zeros)*10 >= len(b)*9
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

func humanBytes(n int64) string {
	switch {
	case n >= 1<<30:
		return strings.Replace(fmt.Sprintf("%.1f GB", float64(n)/(1<<30)), ".", ",", 1)
	case n >= 1<<20:
		return strings.Replace(fmt.Sprintf("%.1f MB", float64(n)/(1<<20)), ".", ",", 1)
	case n >= 1<<10:
		return fmt.Sprintf("%d KB", n>>10)
	}
	return fmt.Sprintf("%d byte", n)
}

func formatDuration(sec float64) string {
	s := int(sec + 0.5)
	if s >= 3600 {
		return fmt.Sprintf("%d h %02d min", s/3600, (s%3600)/60)
	}
	if s >= 60 {
		return fmt.Sprintf("%d min %02d s", s/60, s%60)
	}
	return fmt.Sprintf("%d s", s)
}
