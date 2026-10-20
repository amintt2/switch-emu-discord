package main

// Format des messages entre l'agent, le relais et les amis (voir serveur/src/relais.js).
//
// Image envoyée au relais : [u32 destinataire, 0 = tout le monde][charge]
// Charge reçue par l'ami  : [u8 drapeaux (bit0 = image clé)][u8 qualité][f64 heure de l'hôte en ms][Annex B]

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"math"
	"time"
)

const (
	enteteImage    = 4 + 1 + 1 + 8
	drapeauCle     = 1
	qualiteParDef  = 0 // une seule qualité à l'étape 1 ; l'étape 5 en ajoutera d'autres
	tailleMaxTexte = 4096
)

func heureMs(t time.Time) float64 { return float64(t.UnixNano()) / 1e6 }

// encoderImage prépare une image pour le relais (une seule copie, le relais la distribue).
func encoderImage(dest uint32, cle bool, qualite uint8, t time.Time, au []byte) []byte {
	b := make([]byte, enteteImage+len(au))
	binary.LittleEndian.PutUint32(b, dest)
	if cle {
		b[4] = drapeauCle
	}
	b[5] = qualite
	binary.LittleEndian.PutUint64(b[6:], math.Float64bits(heureMs(t)))
	copy(b[enteteImage:], au)
	return b
}

// messageAmi est ce qu'un ami peut envoyer à l'hôte, via le relais ("de" et "uid" sont ajoutés par le relais).
type messageAmi struct {
	Type string  `json:"type"`
	De   uint32  `json:"de"`
	UID  string  `json:"uid"`
	T    float64 `json:"t"`
}

var errMessage = errors.New("message invalide")

func lireMessageAmi(b []byte) (messageAmi, error) {
	var m messageAmi
	if len(b) > tailleMaxTexte || json.Unmarshal(b, &m) != nil || m.Type == "" {
		return m, errMessage
	}
	return m, nil
}

// ordreServeur est un ordre reçu du serveur sur le canal de contrôle.
// L'agent n'exécute RIEN d'autre que ces quelques ordres connus.
type ordreServeur struct {
	Type   string   `json:"type"`
	Salle  string   `json:"salle"`
	Relais []string `json:"relais"`
	Jeton  string   `json:"jeton"`
	Nom    string   `json:"nom"`
}
