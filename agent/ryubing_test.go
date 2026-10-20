package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// Identifiant vu par SDL3 pour la manette virtuelle de J2 (relevé sur un vrai PC : PID 0x5302).
func TestIdRyubing(t *testing.T) {
	if got := idRyubing(2); got != "0-00000003-045e-0000-0253-000014017801" {
		t.Fatal(got)
	}
}

func TestRelierManettes(t *testing.T) {
	brut := []byte(`{"version":73,"autre":{"x":1.5},"input_config":[
		{"id":"0-00000003-2dc8-0000-0a31-000014017801","player_index":"Player1","backend":"GamepadSDL3"},
		{"id":"0-00000003-045e-0000-8e02-000014017801","player_index":"Player2","backend":"GamepadSDL3"},
		{"id":"clavier","player_index":"Player5","backend":"WindowKeyboard"}]}`)
	out, change, err := relierManettes(brut)
	if err != nil || !change {
		t.Fatal(err, change)
	}
	var cfg struct {
		Version float64             `json:"version"`
		Autre   struct{ X float64 } `json:"autre"`
		Entrees []struct {
			ID     string `json:"id"`
			Joueur string `json:"player_index"`
			Type   string `json:"controller_type"`
		} `json:"input_config"`
	}
	if err := json.Unmarshal(out, &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.Version != 73 || cfg.Autre.X != 1.5 {
		t.Fatal("le reste de la configuration doit être gardé tel quel")
	}
	ids := map[string]string{}
	for _, e := range cfg.Entrees {
		ids[e.Joueur] = e.ID
	}
	if ids["Player1"] != "0-00000003-2dc8-0000-0a31-000014017801" || ids["Player5"] != "clavier" {
		t.Fatal("Player1 (l'hôte) et les autres entrées ne bougent pas", ids)
	}
	for p := 2; p <= 4; p++ {
		if j := "Player" + string(rune('0'+p)); ids[j] != idRyubing(p) {
			t.Fatal(j, ids[j])
		}
	}
	if len(cfg.Entrees) != 5 {
		t.Fatal(len(cfg.Entrees))
	}
	// Une deuxième fois : rien à changer.
	if _, change, _ := relierManettes(out); change {
		t.Fatal("déjà relié : le fichier ne doit pas être réécrit")
	}
	if _, _, err := relierManettes([]byte("pas du json")); err == nil || !strings.Contains(err.Error(), "illisible") {
		t.Fatal(err)
	}
}
