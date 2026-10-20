package main

import (
	"encoding/binary"
	"math"
	"path/filepath"
	"testing"
	"time"
)

func TestEncoderImage(t *testing.T) {
	at := time.UnixMilli(1_700_000_000_123)
	b := encoderImage(0, true, 2, at, []byte{0, 0, 0, 1, 9})
	if len(b) != enteteImage+5 {
		t.Fatalf("taille %d", len(b))
	}
	if binary.LittleEndian.Uint32(b) != 0 {
		t.Fatal("destinataire : 0 = tout le monde")
	}
	if b[4] != drapeauCle || b[5] != 2 {
		t.Fatalf("drapeaux %d qualité %d", b[4], b[5])
	}
	if ms := math.Float64frombits(binary.LittleEndian.Uint64(b[6:])); ms != 1_700_000_000_123 {
		t.Fatalf("heure %v", ms)
	}
}

func TestLireMessageAmi(t *testing.T) {
	m, err := lireMessageAmi([]byte(`{"type":"ping","de":3,"uid":"42","t":12.5}`))
	if err != nil || m.Type != "ping" || m.De != 3 || m.UID != "42" || m.T != 12.5 {
		t.Fatalf("%+v %v", m, err)
	}
	for _, mauvais := range []string{`pas du json`, `{}`, string(make([]byte, tailleMaxTexte+1))} {
		if _, err := lireMessageAmi([]byte(mauvais)); err == nil {
			t.Fatalf("accepté : %q", mauvais[:min(20, len(mauvais))])
		}
	}
}

func TestRelaisAutorise(t *testing.T) {
	c := configParDefaut()
	ok := []string{"wss://switch-emu-relais.amin2020e.workers.dev/relais", "wss://switch.mciut.fr/relais"}
	ko := []string{
		"ws://switch.mciut.fr/relais",               // pas chiffré
		"wss://evil.example/relais",                 // pas dans la liste
		"wss://switch.mciut.fr.evil.example/relais", // préfixe trompeur
		"wss://user:pass@switch.mciut.fr/relais",    // identifiants dans l'URL
		"https://switch.mciut.fr/relais",
	}
	for _, u := range ok {
		if !c.relaisAutorise(u) {
			t.Errorf("refusé à tort : %s", u)
		}
	}
	for _, u := range ko {
		if c.relaisAutorise(u) {
			t.Errorf("accepté à tort : %s", u)
		}
	}
}

func TestConfigEnregistrerCharger(t *testing.T) {
	chemin := filepath.Join(t.TempDir(), "sous", "agent.json")
	c := configParDefaut()
	c.Jeton, c.Nom = "abc.def", "Alice"
	if err := c.enregistrer(chemin); err != nil {
		t.Fatal(err)
	}
	lu, err := chargerConfig(chemin)
	if err != nil || lu.Jeton != "abc.def" || lu.Nom != "Alice" || lu.Capture.IPS != 60 {
		t.Fatalf("%+v %v", lu, err)
	}
	vide, err := chargerConfig(filepath.Join(t.TempDir(), "absent.json"))
	if err != nil || vide.Serveur == "" {
		t.Fatal("sans fichier, on doit avoir la configuration par défaut")
	}
}

func TestURLWS(t *testing.T) {
	if got := urlWS("https://switch.mciut.fr/", "/api/agent"); got != "wss://switch.mciut.fr/api/agent" {
		t.Fatal(got)
	}
	if got := urlWS("http://localhost:3000", "/api/agent"); got != "ws://localhost:3000/api/agent" {
		t.Fatal(got)
	}
}

func TestRelaisLocalSeulementEnDev(t *testing.T) {
	c := configParDefaut()
	if c.relaisAutorise("ws://localhost:3000/relais") {
		t.Fatal("ws://localhost accepté hors mode dev")
	}
	c.dev = true
	if !c.relaisAutorise("ws://localhost:3000/relais") || c.relaisAutorise("ws://evil.example/relais") {
		t.Fatal("en dev, seul ws://localhost doit être accepté en plus")
	}
}
