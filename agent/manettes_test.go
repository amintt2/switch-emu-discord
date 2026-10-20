package main

import (
	"errors"
	"testing"
	"time"
)

type fauxPad struct {
	recus     []XusbReport
	debranche bool
}

func (p *fauxPad) Submit(r XusbReport) error { p.recus = append(p.recus, r); return nil }
func (p *fauxPad) Unplug() error             { p.debranche = true; return nil }

type fauxBus struct{ pads []*fauxPad }

func (b *fauxBus) brancher() (padVirtuel, error) {
	p := &fauxPad{}
	b.pads = append(b.pads, p)
	return p, nil
}

func fabriqueManettes() (*manettes, *fauxBus, *time.Time) {
	bus := &fauxBus{}
	m := nouvellesManettes(bus)
	t := time.Unix(1000, 0)
	m.now = func() time.Time { return t }
	return m, bus, &t
}

func TestLireManetteBorne(t *testing.T) {
	r, seq, err := lireManette([]byte(`{"type":"manette","s":7,"b":65535,"lt":999,"rt":-5,"lx":-99999,"ly":40000,"rx":12,"ry":-12}`))
	if err != nil || seq != 7 {
		t.Fatal(err, seq)
	}
	want := XusbReport{Buttons: 0xF7FF, LeftTrigger: 255, RightTrigger: 0, ThumbLX: -32768, ThumbLY: 32767, ThumbRX: 12, ThumbRY: -12}
	if r != want {
		t.Fatalf("%+v", r)
	}
	if _, _, err := lireManette([]byte(`pas du json`)); err == nil {
		t.Fatal("accepté")
	}
}

func TestPlacesDansLOrdreEtLimite(t *testing.T) {
	m, bus, _ := fabriqueManettes()
	for i, uid := range []string{"a", "b", "c"} {
		place, nouveau, err := m.appliquer(uid, XusbReport{Buttons: 0x1000}, 1)
		if err != nil || !nouveau || place != 2+i {
			t.Fatalf("%s : place %d nouveau %v err %v", uid, place, nouveau, err)
		}
	}
	if _, _, err := m.appliquer("d", XusbReport{}, 1); !errors.Is(err, errComplet) {
		t.Fatal("4e ami : il ne reste plus de manette", err)
	}
	// Un ami qui revient garde sa manette.
	if place, nouveau, _ := m.appliquer("a", XusbReport{}, 2); place != 2 || nouveau {
		t.Fatal(place, nouveau)
	}
	if len(bus.pads) != 3 {
		t.Fatal(len(bus.pads))
	}
	m.fermer()
	for _, p := range bus.pads {
		if !p.debranche || p.recus[len(p.recus)-1] != (XusbReport{}) {
			t.Fatal("à la fin : manette relâchée puis débranchée")
		}
	}
}

func TestSansViGEm(t *testing.T) {
	m := nouvellesManettes(nil)
	if _, _, err := m.appliquer("a", XusbReport{}, 1); !errors.Is(err, errPasDeViGEm) {
		t.Fatal(err)
	}
	if !m.refuser("a") || m.refuser("a") {
		t.Fatal("on ne prévient qu'une fois")
	}
}

func TestMessagesEnRetardIgnores(t *testing.T) {
	m, bus, now := fabriqueManettes()
	m.appliquer("a", XusbReport{Buttons: 1}, 10)
	m.appliquer("a", XusbReport{Buttons: 2}, 9) // en retard : ignoré
	if got := len(bus.pads[0].recus); got != 1 {
		t.Fatal(got)
	}
	*now = now.Add(time.Second) // page rechargée : la séquence repart de 1
	m.appliquer("a", XusbReport{Buttons: 4}, 1)
	if bus.pads[0].recus[1].Buttons != 4 {
		t.Fatal("la nouvelle séquence doit être acceptée après une pause")
	}
}

func TestLimiteDeDebit(t *testing.T) {
	m, bus, now := fabriqueManettes()
	for i := uint32(1); i <= 200; i++ { // 200 messages au même instant
		m.appliquer("a", XusbReport{}, i)
	}
	if got := len(bus.pads[0].recus); got > int(rafaleManette) {
		t.Fatalf("%d messages acceptés d'un coup", got)
	}
	*now = now.Add(time.Second)
	avant := len(bus.pads[0].recus)
	m.appliquer("a", XusbReport{}, 1000)
	if len(bus.pads[0].recus) != avant+1 {
		t.Fatal("après une seconde, l'ami doit pouvoir rejouer")
	}
}

func TestRelacheSiSilence(t *testing.T) {
	m, bus, now := fabriqueManettes()
	m.appliquer("a", XusbReport{Buttons: 0x1000, ThumbLX: 30000}, 1)
	*now = now.Add(delaiRelache / 2)
	m.relacher()
	if len(bus.pads[0].recus) != 1 {
		t.Fatal("trop tôt")
	}
	*now = now.Add(delaiRelache)
	m.relacher()
	m.relacher()
	if r := bus.pads[0].recus; len(r) != 2 || r[1] != (XusbReport{}) {
		t.Fatalf("bouton bloqué : %+v", r)
	}
}

type padCapricieux struct{ fauxPad }

func (p *padCapricieux) Submit(r XusbReport) error {
	p.fauxPad.Submit(r)
	return errors.New("Aucune donnée n'est disponible.")
}

type busCapricieux struct{}

func (busCapricieux) brancher() (padVirtuel, error) { return &padCapricieux{}, nil }

func TestErreurDEnvoiNeRetirePasLaManette(t *testing.T) {
	m := nouvellesManettes(busCapricieux{})
	place, nouveau, err := m.appliquer("a", XusbReport{Buttons: 0x1000}, 1)
	if err != nil || !nouveau || place != 2 {
		t.Fatal(place, nouveau, err)
	}
}
