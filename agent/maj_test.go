package main

import (
	"archive/zip"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func TestVersionPlusRecente(t *testing.T) {
	cas := []struct {
		a, b string
		plus bool
	}{
		{"0.4.10", "0.4.9", true},
		{"agent-v0.5.0", "0.4.12", true},
		{"0.4.0", "0.4.0", false},
		{"0.3.9", "0.4.0", false},
		{"1.0", "0.9.9", true},
		{"0.4.1", "dev", true},
		{"pas-une-version", "0.1.0", false},
	}
	for _, c := range cas {
		if got := versionPlusRecente(c.a, c.b); got != c.plus {
			t.Errorf("%s > %s : %v, attendu %v", c.a, c.b, got, c.plus)
		}
	}
}

func TestManifesteSigne(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	cle := base64.StdEncoding.EncodeToString(pub)
	brut := []byte(`{"version":"0.5.0","fichier":"SwitchEMU-agent.zip","sha256":"` + string(bytes.Repeat([]byte("a"), 64)) + `","taille":123}`)
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, brut))
	m, err := verifierManifeste(brut, sig, cle)
	if err != nil || m.Version != "0.5.0" {
		t.Fatal(m, err)
	}
	// Une seule lettre changée : refusé.
	modifie := bytes.Replace(brut, []byte("0.5.0"), []byte("9.5.0"), 1)
	if _, err := verifierManifeste(modifie, sig, cle); err == nil {
		t.Fatal("manifeste modifié accepté")
	}
	// Signé par une autre clé : refusé.
	_, autre, _ := ed25519.GenerateKey(rand.Reader)
	if _, err := verifierManifeste(brut, base64.StdEncoding.EncodeToString(ed25519.Sign(autre, brut)), cle); err == nil {
		t.Fatal("signature d'une autre clé acceptée")
	}
	// Fichier avec un chemin : refusé.
	piege := []byte(`{"version":"0.5.0","fichier":"..\\..\\x.zip","sha256":"` + string(bytes.Repeat([]byte("a"), 64)) + `","taille":1}`)
	if _, err := verifierManifeste(piege, base64.StdEncoding.EncodeToString(ed25519.Sign(priv, piege)), cle); err == nil {
		t.Fatal("chemin accepté")
	}
}

func TestClePubliqueValide(t *testing.T) {
	pub, err := base64.StdEncoding.DecodeString(clePubliqueMaj)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		t.Fatal("clé publique intégrée invalide")
	}
}

func TestExtraireZipRefuseLesChemins(t *testing.T) {
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	f, _ := w.Create("SwitchEMU.exe")
	f.Write([]byte("exe"))
	w.Close()
	dest := filepath.Join(t.TempDir(), "maj")
	if err := extraireZip(buf.Bytes(), dest); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dest, "SwitchEMU.exe")); string(b) != "exe" {
		t.Fatal("fichier mal extrait")
	}
	buf.Reset()
	w = zip.NewWriter(&buf)
	f, _ = w.Create(`..\..\evil.exe`)
	f.Write([]byte("x"))
	w.Close()
	if err := extraireZip(buf.Bytes(), dest); err == nil {
		t.Fatal("zip slip accepté")
	}
}

func TestAcceptSelonURL(t *testing.T) {
	if accepterPour(urlDerniere) != "application/vnd.github+json" {
		t.Fatal("l'API de GitHub refuse octet-stream (415) : les mises à jour ne marchaient jamais")
	}
	if accepterPour("https://github.com/amintt2/switch-emu-discord/releases/download/agent-v0.5.0/manifest.json") != "application/octet-stream" {
		t.Fatal("fichiers : octet-stream")
	}
}
