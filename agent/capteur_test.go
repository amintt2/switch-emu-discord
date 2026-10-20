package main

import (
	"bytes"
	"strings"
	"sync"
	"testing"
	"time"
)

type tamponSur struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (t *tamponSur) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.b.Write(p)
}
func (t *tamponSur) Close() error   { return nil }
func (t *tamponSur) String() string { t.mu.Lock(); defer t.mu.Unlock(); return t.b.String() }

// Deux amis arrivent coup sur coup : la deuxième demande d'image clé ne doit pas être perdue.
func TestDemandesIDRRegroupeesPasPerdues(t *testing.T) {
	out := &tamponSur{}
	k := &capteur{stdin: out}
	k.demanderIDR()
	k.demanderIDR()
	k.demanderIDR()
	if n := strings.Count(out.String(), "idr\n"); n != 1 {
		t.Fatalf("%d demandes envoyées tout de suite, attendu 1", n)
	}
	time.Sleep(intervalleIDR + 150*time.Millisecond)
	if n := strings.Count(out.String(), "idr\n"); n != 2 {
		t.Fatalf("%d demandes après le délai, attendu 2 (les demandes en retard sont regroupées)", n)
	}
}
