package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTitreDepuisFichier(t *testing.T) {
	cas := map[string]string{
		"Mario Kart 8 Deluxe [0100152000022000][v0].nsp": "Mario Kart 8 Deluxe",
		"Super_Smash_Bros._Ultimate (EUR).xci":           "Super Smash Bros Ultimate",
		"Splatoon 3 {NSP} [US].nsz":                      "Splatoon 3",
		"[0100152000022000].nsp":                         "[0100152000022000].nsp",
	}
	for nom, attendu := range cas {
		if got := titreDepuisFichier(nom); got != attendu {
			t.Errorf("%q → %q, attendu %q", nom, got, attendu)
		}
	}
}

func TestMisesAJourEtDLCEcartees(t *testing.T) {
	jeux := []string{"Mario Kart 8 Deluxe [0100152000022000][v0].nsp", "Smash.xci"}
	autres := []string{
		"Mario Kart 8 Deluxe [0100152000022800][v1179648].nsp", // mise à jour (…800)
		"MK8 Booster Course [0100152000023001].nsp",            // DLC
		"Smash [UPD].nsp",
		"Smash DLC pack.nsp",
	}
	for _, n := range jeux {
		if estMiseAJourOuDLC(n) {
			t.Errorf("jeu écarté à tort : %s", n)
		}
	}
	for _, n := range autres {
		if !estMiseAJourOuDLC(n) {
			t.Errorf("mise à jour/DLC gardée : %s", n)
		}
	}
}

func TestScannerJeux(t *testing.T) {
	dir := t.TempDir()
	ecrire := func(rel string, taille int64) {
		p := filepath.Join(dir, rel)
		os.MkdirAll(filepath.Dir(p), 0o755)
		f, _ := os.Create(p)
		f.Truncate(taille)
		f.Close()
	}
	ecrire("Mario Kart 8 Deluxe [0100152000022000][v0].nsp", tailleMin+1)
	ecrire(`Switch\Smash Ultimate.xci`, tailleMin+1)
	ecrire("Mario Kart 8 Deluxe [0100152000022800][v1179648].nsp", tailleMin+1) // mise à jour
	ecrire("petit.nsp", 1024)                                                   // trop petit
	ecrire("notes.txt", tailleMin+1)
	ecrire(`a\b\c\d\e\trop profond.nsp`, tailleMin+1)
	jeux := scannerJeux([]string{dir, dir}) // un dossier en double ne crée pas de doublons
	if len(jeux) != 2 {
		t.Fatalf("%d jeux : %+v", len(jeux), jeux)
	}
	if jeux[0].Titre != "Mario Kart 8 Deluxe" || jeux[1].Titre != "Smash Ultimate" {
		t.Fatalf("%+v", jeux)
	}
	if jeux[0].ID == jeux[1].ID || len(jeux[0].ID) != 16 {
		t.Fatal("identifiants")
	}
}

func TestCommandeJeuSeulementRyujinx(t *testing.T) {
	dir := t.TempDir()
	faux := filepath.Join(dir, "calc.exe")
	os.WriteFile(faux, []byte("x"), 0o644)
	if _, err := commandeJeu(faux, jeu{Chemin: "x.nsp"}); err == nil {
		t.Fatal("seul Ryujinx.exe peut être lancé")
	}
	vrai := filepath.Join(dir, "Ryujinx.exe")
	os.WriteFile(vrai, []byte("x"), 0o644)
	cmd, err := commandeJeu(vrai, jeu{Chemin: `C:\Jeux\MK8.nsp`})
	if err != nil || len(cmd.Args) != 3 || cmd.Args[1] != "--fullscreen" || cmd.Args[2] != `C:\Jeux\MK8.nsp` {
		t.Fatal(cmd, err)
	}
}
