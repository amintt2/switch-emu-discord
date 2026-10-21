package main

// Configuration automatique des manettes de Ryubing : Player 2, 3 et 4 sont reliés aux manettes
// virtuelles de J2, J3 et J4. Chaque place a son propre identifiant (PID 0x5302…0x5304), et Ryubing
// nomme une manette « <rang>-<GUID SDL> » : l'identifiant de J2 est donc toujours le même, quel que
// soit l'ordre dans lequel les amis arrivent. L'hôte n'a plus à chercher qui est quelle manette.
//
// On ne touche qu'aux entrées Player2 à Player4 du fichier de Ryubing (Player1 reste la manette de
// l'hôte), seulement quand Ryubing est fermé, après une sauvegarde du fichier d'origine.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// idRyubing : identifiant que Ryubing (SDL3, pilote XInput) donne à la manette virtuelle d'une place.
// GUID SDL sans CRC : bus USB 0003, vendeur 045e, produit (petit-boutiste), version 0x0114, pilote 'x'.
func idRyubing(p int) string {
	pid := pidPlace(p)
	return fmt.Sprintf("0-00000003-045e-0000-%02x%02x-000014017801", pid&0xff, pid>>8)
}

// Modèle : la configuration de manette par défaut de Ryubing (Pro Controller, disposition Xbox).
const modeleManetteRyubing = `{"left_joycon_stick":{"joystick":"Left","invert_stick_x":false,"invert_stick_y":false,"rotate90_cw":false,"stick_button":"LeftStick"},"right_joycon_stick":{"joystick":"Right","invert_stick_x":false,"invert_stick_y":false,"rotate90_cw":false,"stick_button":"RightStick"},"deadzone_left":0.1,"deadzone_right":0.1,"range_left":1,"range_right":1,"trigger_threshold":0.5,"motion":{"motion_backend":"GamepadDriver","sensitivity":100,"gyro_deadzone":1,"enable_motion":true},"rumble":{"strong_rumble":1,"weak_rumble":1,"enable_rumble":true,"use_hdrumble":false},"led":{"enable_led":false,"turn_off_led":false,"use_rainbow":false,"led_color":0},"left_joycon":{"button_minus":"Back","button_l":"LeftShoulder","button_zl":"LeftTrigger","button_sl":"SingleLeftTrigger0","button_sr":"SingleRightTrigger0","dpad_up":"DpadUp","dpad_down":"DpadDown","dpad_left":"DpadLeft","dpad_right":"DpadRight"},"right_joycon":{"button_plus":"Start","button_r":"RightShoulder","button_zr":"RightTrigger","button_sl":"SingleLeftTrigger1","button_sr":"SingleRightTrigger1","button_x":"Y","button_b":"A","button_y":"X","button_a":"B"},"version":1,"backend":"GamepadSDL3","controller_type":"ProController","enable_dynamic_gamepad_swap":false}`

// cheminConfigRyubing : dossier « portable » à côté de Ryujinx.exe s'il existe, sinon %APPDATA%\Ryujinx.
func cheminConfigRyubing(exe string) string {
	if exe != "" {
		if info, err := os.Stat(filepath.Join(filepath.Dir(exe), "portable")); err == nil && info.IsDir() {
			return filepath.Join(filepath.Dir(exe), "portable", "Config.json")
		}
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "Ryujinx", "Config.json")
}

// relierManettes renvoie la configuration avec Player2..4 reliés aux manettes virtuelles, et si elle a changé.
func relierManettes(brut []byte) ([]byte, bool, error) {
	var cfg map[string]json.RawMessage
	if err := json.Unmarshal(brut, &cfg); err != nil {
		return nil, false, fmt.Errorf("configuration de Ryubing illisible : %w", err)
	}
	var entrees []json.RawMessage
	if r, ok := cfg["input_config"]; ok {
		if err := json.Unmarshal(r, &entrees); err != nil {
			return nil, false, fmt.Errorf("manettes de Ryubing illisibles : %w", err)
		}
	}
	var garder []json.RawMessage
	deja := map[string]string{}
	for _, e := range entrees {
		var t struct {
			Joueur string `json:"player_index"`
			ID     string `json:"id"`
		}
		json.Unmarshal(e, &t)
		if t.Joueur == "Player2" || t.Joueur == "Player3" || t.Joueur == "Player4" {
			var tout map[string]any
			json.Unmarshal(e, &tout)
			b, _ := json.Marshal(tout) // forme canonique (clés triées) pour comparer
			deja[t.Joueur] = string(b)
			continue
		}
		garder = append(garder, e)
	}
	change := false
	for p := 2; p <= nbPlaces; p++ {
		var e map[string]any
		json.Unmarshal([]byte(modeleManetteRyubing), &e)
		joueur := fmt.Sprintf("Player%d", p)
		e["id"], e["name"], e["player_index"] = idRyubing(p), fmt.Sprintf("Switch EMU J%d", p), joueur
		b, _ := json.Marshal(e)
		garder = append(garder, b)
		if deja[joueur] != string(b) {
			change = true
		}
	}
	if !change {
		return brut, false, nil
	}
	nouvelles, _ := json.Marshal(garder)
	cfg["input_config"] = nouvelles
	out, err := json.MarshalIndent(cfg, "", "  ")
	return out, true, err
}

// configurerRyubing relie Player2..4 aux manettes de J2..J4 dans la configuration de Ryubing.
func configurerRyubing(exe string) error {
	if ryubingOuvert() {
		return errors.New("Ryubing est ouvert : ses manettes seront reliées au prochain lancement depuis l'Activité")
	}
	chemin := cheminConfigRyubing(exe)
	brut, err := os.ReadFile(chemin)
	if errors.Is(err, os.ErrNotExist) {
		return nil // Ryubing n'a jamais été lancé : rien à adapter
	}
	if err != nil {
		return err
	}
	out, change, err := relierManettes(brut)
	if err != nil || !change {
		return err
	}
	sauvegarde := chemin + ".avant-switch-emu"
	if _, err := os.Stat(sauvegarde); errors.Is(err, os.ErrNotExist) {
		if err := os.WriteFile(sauvegarde, brut, 0o644); err != nil {
			return err
		}
	}
	tmp := chemin + ".nouveau"
	if err := os.WriteFile(tmp, out, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, chemin)
}

// ryubingOuvert : Ryujinx.exe tourne déjà (il réécrirait sa configuration en partant).
func ryubingOuvert() bool {
	p, _ := trouverRyubing()
	return p != 0
}
