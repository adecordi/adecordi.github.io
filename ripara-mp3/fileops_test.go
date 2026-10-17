package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLyrics3NegativeSize(t *testing.T) {
	// un campo dimensione rovinato non deve far bloccare il programma
	for _, tail := range []string{"-99999LYRICS200", "-00020LYRICS200", "999999LYRICS200", "00001xLYRICS200"} {
		b := append(bytes.Repeat([]byte{0x55}, 900), tail...)
		analyzeMP3(b, 0)
		audioBounds(b)
	}
}

func failingRename(t *testing.T, failOn func(from, to string) bool) {
	t.Helper()
	orig := renameFn
	renameFn = func(a, b string) error {
		if failOn(a, b) {
			return errors.New("bloccato dall'antivirus")
		}
		return orig(a, b)
	}
	t.Cleanup(func() { renameFn = orig })
}

func listDir(t *testing.T, dir string) []string {
	t.Helper()
	var out []string
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		out = append(out, e.Name())
	}
	return out
}

func TestReplaceFileKeepsOriginalOnFailure(t *testing.T) {
	dir := t.TempDir()
	old := filepath.Join(dir, "Brano.mp3")
	os.WriteFile(old, []byte("originale"), 0o644)
	failingRename(t, func(from, to string) bool { return strings.Contains(from, ".riparamp3-") })
	for _, target := range []string{old, filepath.Join(dir, "Artista - Brano.mp3")} {
		if _, err := replaceFile(old, target, []byte("nuovo"), ""); err == nil {
			t.Fatal("doveva fallire")
		}
		if b, _ := os.ReadFile(old); string(b) != "originale" {
			t.Fatalf("l'originale è stato perso (%q)", b)
		}
		if got := listDir(t, dir); len(got) != 1 || got[0] != "Brano.mp3" {
			t.Fatalf("file rimasti: %v", got)
		}
	}
}

func TestReplaceFileKeep(t *testing.T) {
	dir := t.TempDir()
	old := filepath.Join(dir, "x.mp3")
	os.WriteFile(old, []byte("illeggibile"), 0o644)
	keep := filepath.Join(dir, "_Rovinati", "x.mp3")
	if _, err := replaceFile(old, old, []byte("riparato"), keep); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(old); string(b) != "riparato" {
		t.Errorf("contenuto %q", b)
	}
	if b, _ := os.ReadFile(keep); string(b) != "illeggibile" {
		t.Errorf("originale conservato %q", b)
	}
}

func TestReplaceFileOldNotRemovable(t *testing.T) {
	dir := t.TempDir()
	old := filepath.Join(dir, "vecchio.mp3")
	os.WriteFile(old, []byte("a"), 0o644)
	orig := removeFn
	removeFn = func(string) error { return errors.New("file aperto in un altro programma") }
	defer func() { removeFn = orig }()
	target := filepath.Join(dir, "nuovo.mp3")
	warn, err := replaceFile(old, target, []byte("b"), "")
	if err != nil || warn == "" {
		t.Fatalf("err %v warn %q: deve riuscire con un avviso", err, warn)
	}
	if b, _ := os.ReadFile(target); string(b) != "b" {
		t.Error("il file nuovo non è al suo posto")
	}
}

func TestMoveFileCaseOnlyRestoresOnFailure(t *testing.T) {
	dir := t.TempDir()
	old := filepath.Join(dir, "a.mp3")
	os.WriteFile(old, []byte("x"), 0o644)
	// su Linux i nomi distinguono le maiuscole: un collegamento fisso
	// riproduce la situazione di Windows (due nomi, stesso file)
	upper := filepath.Join(dir, "A.mp3")
	if err := os.Link(old, upper); err != nil {
		t.Skip(err)
	}
	os.Remove(upper)
	os.Link(old, upper)
	failingRename(t, func(from, to string) bool { return strings.Contains(from, ".riparamp3-") && to == upper })
	if err := moveFile(old, upper); err == nil {
		t.Fatal("doveva fallire")
	}
	if b, err := os.ReadFile(old); err != nil || string(b) != "x" {
		t.Error("il file non è tornato al suo nome")
	}
	for _, n := range listDir(t, dir) {
		if strings.HasPrefix(n, ".") {
			t.Errorf("file temporaneo rimasto: %s", n)
		}
	}
}

func TestInterruptedRenameCycleLeavesNoTempFiles(t *testing.T) {
	dir := t.TempDir()
	names := []string{"Uno.mp3", "Due.mp3", "Tre.mp3"}
	var songs []*song
	for i, n := range names {
		p := filepath.Join(dir, n)
		os.WriteFile(p, []byte(n), 0o644)
		// rotazione: Uno -> Due, Due -> Tre, Tre -> Uno
		songs = append(songs, &song{path: p, origRel: n, status: stOK, target: filepath.Join(dir, names[(i+1)%3])})
	}
	defer stopRequested.Store(false)
	lg := &logger{}
	applyAll(dir, songs, newCoverStore(), lg, func(i, n int, name string) { stopRequested.Store(true) })
	got := listDir(t, dir)
	for _, n := range got {
		if strings.HasPrefix(n, ".") {
			t.Fatalf("file temporaneo rimasto: %v", got)
		}
	}
	if len(got) != 3 {
		t.Fatalf("file: %v", got)
	}
	for _, s := range songs {
		b, err := os.ReadFile(s.path)
		if err != nil || string(b) != s.origRel {
			t.Errorf("%s: percorso %s contenuto %q", s.origRel, s.path, b)
		}
		if st, _ := reportStatus(s); st != stOK {
			t.Errorf("%s: stato %s", s.origRel, st)
		}
	}
}

func TestRenameCycleCompletes(t *testing.T) {
	dir := t.TempDir()
	names := []string{"Uno.mp3", "Due.mp3", "Tre.mp3"}
	var songs []*song
	for i, n := range names {
		p := filepath.Join(dir, n)
		os.WriteFile(p, []byte(n), 0o644)
		songs = append(songs, &song{path: p, origRel: n, status: stOK, target: filepath.Join(dir, names[(i+1)%3])})
	}
	applyAll(dir, songs, newCoverStore(), &logger{}, nil)
	for i, n := range names {
		b, _ := os.ReadFile(filepath.Join(dir, names[(i+1)%3]))
		if string(b) != n {
			t.Errorf("%s contiene %q invece di %q", names[(i+1)%3], b, n)
		}
	}
	if got := listDir(t, dir); len(got) != 3 {
		t.Errorf("file: %v", got)
	}
}

func TestUnappliedReportedAsNotFixed(t *testing.T) {
	s := &song{status: stHD, info: &mp3Info{Problems: []string{"1 punto rovinato"}}}
	if st, note := reportStatus(s); st != stBad || !strings.Contains(note, "interrotta") {
		t.Errorf("%s %q", st, note)
	}
	s.applied = true
	if st, _ := reportStatus(s); st != stHD {
		t.Errorf("dopo la sostituzione: %s", st)
	}
}

func TestRemoveEmptyDirsStaysInsideRoot(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "Musica")
	sibling := filepath.Join(base, "Musica2", "vuota")
	inside := filepath.Join(root, "a", "b")
	os.MkdirAll(sibling, 0o755)
	os.MkdirAll(inside, 0o755)
	os.WriteFile(filepath.Join(root, "a", "nota.txt"), []byte("x"), 0o644)
	removeEmptyDirs(root, map[string]bool{sibling: true, inside: true})
	if !exists(sibling) {
		t.Error("cancellata una cartella fuori dalla chiavetta")
	}
	if exists(inside) {
		t.Error("cartella vuota non tolta")
	}
	if !exists(filepath.Join(root, "a")) {
		t.Error("tolta una cartella non vuota")
	}
}

func TestFreshReadAfterReadErrors(t *testing.T) {
	b := load(t, "cbr128")
	dir := t.TempDir()
	p := filepath.Join(dir, "x.mp3")
	os.WriteFile(p, b, 0o644)
	// la prima lettura aveva dato errori: la copia di sicurezza ha degli zeri
	zeroed := append([]byte(nil), b...)
	clear(zeroed[len(b)/2 : len(b)/2+4096])
	s := &song{path: p, status: stRip, readErrors: 1, info: analyzeMP3(zeroed, 1)}
	out, err := s.buildContent(newCoverStore())
	if err != nil {
		t.Fatal(err)
	}
	in := analyzeMP3(out, 0)
	if s.status != stOK || in.Defective || !bytes.Equal(audioPayload(out, in), audioPayload(b, analyzeMP3(b, 0))) {
		t.Errorf("rilettura riuscita non usata: stato %s, %v", s.status, in.Problems)
	}
}

func TestRepairWithNothingToCut(t *testing.T) {
	b := append([]byte(nil), load(t, "cbr128")...)
	b[len(b)/2+200] ^= 0x10
	p, removed, err := repairPayload(b)
	if err != nil || removed != 0 {
		t.Fatalf("removed %d err %v", removed, err)
	}
	if in := analyzeMP3(p, 0); !in.Defective {
		t.Error("la riparazione ha nascosto un danno che non ha tolto")
	}
	if analyzeMP3(b, 0).cuttable() {
		t.Error("un bit cambiato non è riparabile togliendo parti")
	}
}
