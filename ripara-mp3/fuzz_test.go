package main

import "testing"

// FuzzAnalyze verifica che nessun file, per quanto rovinato, faccia bloccare
// l'analisi, la riparazione o la lettura dei tag.
func FuzzAnalyze(f *testing.F) {
	f.Add([]byte("ID3\x03\x00\x00\x00\x00\x00\x10"))
	f.Add([]byte("\xff\xfb\x90\x64" + string(make([]byte, 600)) + "-00020LYRICS200"))
	f.Add(append(make([]byte, 200), "APETAGEX\xd0\x07\x00\x00\xff\xff\xff\x7f\x00\x00\x00\x80\x00\x00\x00\x00\x00\x00\x00\x00TAG"...))
	f.Fuzz(func(t *testing.T, b []byte) {
		analyzeMP3(b, 0)
		repairPayload(b)
		readTags(b)
		estimateDuration(b, int64(len(b)))
	})
}
