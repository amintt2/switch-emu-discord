package main

import (
	"encoding/binary"
	"testing"
	"time"
)

func TestEncoderSon(t *testing.T) {
	pcm := []byte{1, 2, 3, 4}
	b := encoderSon(time.Unix(0, 0), pcm)
	if binary.LittleEndian.Uint32(b) != 0 || b[4] != drapeauSon || b[4]&drapeauCle != 0 {
		t.Fatal("son : pour tous les amis, drapeau son, jamais image clé")
	}
	if string(b[enteteImage:]) != string(pcm) {
		t.Fatal("PCM recopié tel quel")
	}
}
