package main

import (
	"encoding/binary"
	"testing"

	"github.com/pion/webrtc/v4"
)

type fauxCanal struct {
	attente uint64 // octets « en attente » (la connexion directe ne suit pas)
	envoyes [][]byte
}

func (c *fauxCanal) ReadyState() webrtc.DataChannelState { return webrtc.DataChannelStateOpen }
func (c *fauxCanal) BufferedAmount() uint64              { return c.attente }
func (c *fauxCanal) Send(b []byte) error                 { c.envoyes = append(c.envoyes, b); return nil }

func numeros(c *fauxCanal) []uint32 {
	var r []uint32
	for _, b := range c.envoyes {
		if binary.LittleEndian.Uint16(b[4:]) == 0 {
			r = append(r, binary.LittleEndian.Uint32(b))
		}
	}
	return r
}

// Connexion directe trop lente : on saute des images au lieu d'accumuler du retard, puis on repart
// d'une image clé, demandée une seule fois, quand la file s'est vidée.
func TestP2PNAccumulePasDeRetard(t *testing.T) {
	c := &fauxCanal{}
	p := &lienP2P{video: c, fini: make(chan struct{})}
	image := make([]byte, 1000)

	if !p.envoyer(image, true, false) || !p.envoyer(image, false, false) {
		t.Fatal("connexion qui suit : tout part")
	}
	c.attente = attenteImageMax + 1 // la file se remplit
	if !p.envoyer(image, false, false) || len(c.envoyes) != 2 {
		t.Fatal("image sautée (pas mise en file), sans demander d'image clé tout de suite")
	}
	if !p.envoyer(image, false, false) || len(c.envoyes) != 2 {
		t.Fatal("les images suivantes sont sautées aussi")
	}
	c.attente = attenteImageMax / 4 // la file s'est vidée
	if p.envoyer(image, false, false) {
		t.Fatal("file vidée : on demande une image clé (false)")
	}
	if !p.envoyer(image, false, false) {
		t.Fatal("une seule demande d'image clé")
	}
	if !p.envoyer(image, true, false) || len(c.envoyes) != 3 {
		t.Fatal("l'image clé repart")
	}
	if got := numeros(c); len(got) != 3 || got[2] != got[1]+1 {
		t.Fatalf("numéros sans trou (l'ami ne croit pas avoir perdu une image) : %v", got)
	}
}

// Écran immobile : après un saut, plus aucune image ne vient ; l'image clé est redemandée quand même.
func TestP2PRelanceCleEcranImmobile(t *testing.T) {
	c := &fauxCanal{}
	p := &lienP2P{video: c, fini: make(chan struct{})}
	c.attente = attenteImageMax + 1
	p.envoyer(make([]byte, 100), false, false) // sautée
	if p.relancerCle() {
		t.Fatal("file encore pleine : on attend")
	}
	c.attente = 0
	if !p.relancerCle() || p.relancerCle() {
		t.Fatal("file vidée : une (seule) demande d'image clé")
	}
	if !p.envoyer(make([]byte, 100), true, false) || len(c.envoyes) != 1 || p.relancerCle() {
		t.Fatal("l'image clé part, plus rien à relancer")
	}
}

func TestP2PDecoupageEnMorceaux(t *testing.T) {
	c := &fauxCanal{}
	p := &lienP2P{video: c, fini: make(chan struct{})}
	p.envoyer(make([]byte, 2*tailleMorceau+5), true, false)
	if len(c.envoyes) != 3 || binary.LittleEndian.Uint16(c.envoyes[2][6:]) != 3 {
		t.Fatal("une grande image part en 3 morceaux numérotés")
	}
	p.envoyer(make([]byte, 10), false, true)
	if n := binary.LittleEndian.Uint32(c.envoyes[3]); n&0x80000000 == 0 {
		t.Fatal("le son a sa propre numérotation (bit de poids fort)")
	}
}
