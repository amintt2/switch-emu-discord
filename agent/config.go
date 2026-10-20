package main

import (
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// Config est enregistrée dans %APPDATA%\SwitchEMU\agent.json. Le jeton ne quitte jamais ce PC
// (il n'est envoyé qu'au serveur, pour ouvrir le canal de contrôle).
type Config struct {
	Serveur string `json:"serveur"`
	Jeton   string `json:"jeton,omitempty"`
	Nom     string `json:"nom,omitempty"`
	// Relais auxquels l'agent accepte de se connecter (préfixes d'URL). Protège contre un serveur
	// compromis qui voudrait envoyer l'image ailleurs.
	RelaisAutorises []string `json:"relaisAutorises"`
	Capture         Capture  `json:"capture"`

	dev bool // -dev : accepte un serveur et un relais en ws://localhost
}

type Capture struct {
	Ecran   int    `json:"ecran"`
	Fenetre string `json:"fenetre,omitempty"` // titre (partiel) d'une fenêtre à capturer ; vide = tout l'écran
	Largeur int    `json:"largeur"`
	Hauteur int    `json:"hauteur"`
	IPS     int    `json:"ips"`
	Kbps    int    `json:"kbps"`
	Codec   string `json:"codec"`
}

func configParDefaut() Config {
	return Config{
		Serveur:         "https://switch.mciut.fr",
		RelaisAutorises: []string{"wss://switch-emu-relais.amin2020e.workers.dev/", "wss://switch.mciut.fr/"},
		Capture:         Capture{Largeur: 1920, Hauteur: 1080, IPS: 60, Kbps: 12000, Codec: "h264_amf"},
	}
}

func cheminConfig() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = "."
	}
	return filepath.Join(dir, "SwitchEMU", "agent.json")
}

func chargerConfig(chemin string) (Config, error) {
	c := configParDefaut()
	b, err := os.ReadFile(chemin)
	if errors.Is(err, os.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return c, err
	}
	return c, nil
}

func (c Config) enregistrer(chemin string) error {
	if err := os.MkdirAll(filepath.Dir(chemin), 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	tmp := chemin + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, chemin)
}

// relaisAutorise vérifie qu'une URL de relais donnée par le serveur est dans la liste blanche.
func (c Config) relaisAutorise(u string) bool {
	p, err := url.Parse(u)
	if err != nil || p.User != nil {
		return false
	}
	// ws:// (non chiffré) n'est accepté que vers ce PC, en mode -dev.
	if p.Scheme != "wss" && !(c.dev && p.Scheme == "ws" && (p.Hostname() == "localhost" || p.Hostname() == "127.0.0.1")) {
		return false
	}
	if c.dev && p.Scheme == "ws" {
		return true
	}
	for _, prefixe := range c.RelaisAutorises {
		if strings.HasPrefix(u, prefixe) {
			return true
		}
	}
	return false
}

// urlWS transforme l'adresse du serveur (https://…) en adresse WebSocket (wss://…).
func urlWS(serveur, chemin string) string {
	return strings.Replace(strings.TrimRight(serveur, "/"), "http", "ws", 1) + chemin
}
