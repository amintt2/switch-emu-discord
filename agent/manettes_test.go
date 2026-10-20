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

func dernier(p *fauxPad) XusbReport { return p.recus[len(p.recus)-1] }

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

func TestJ2J3J4BrancheesDansLOrdre(t *testing.T) {
	m, bus, _ := fabriqueManettes()
	m.preparer()
	if len(bus.pads) != 3 {
		t.Fatalf("%d manettes branchées, attendu 3 (J2, J3, J4)", len(bus.pads))
	}
	m.definirPlaces(map[string]int{"b": 2, "c": 4})
	m.appliquer("b", XusbReport{Buttons: 0x1000}, 1)
	m.appliquer("c", XusbReport{Buttons: 0x2000}, 1)
	if dernier(bus.pads[0]).Buttons != 0x1000 || dernier(bus.pads[2]).Buttons != 0x2000 {
		t.Fatal("chaque joueur doit piloter la manette de sa place")
	}
}

func TestSpectateurSansEffet(t *testing.T) {
	m, bus, _ := fabriqueManettes()
	m.preparer()
	m.definirPlaces(map[string]int{"b": 2})
	if p, err := m.appliquer("spectateur", XusbReport{Buttons: 0x1000}, 1); p != 0 || !errors.Is(err, errSpectateur) {
		t.Fatal(p, err)
	}
	for _, p := range bus.pads {
		for _, r := range p.recus {
			if r.Buttons != 0 {
				t.Fatal("un spectateur a appuyé sur un bouton")
			}
		}
	}
}

func TestJ1BrancheeSeulementSiUnAmiLaPrend(t *testing.T) {
	m, bus, _ := fabriqueManettes()
	m.preparer()
	m.definirPlaces(map[string]int{"b": 1})
	if p, err := m.appliquer("b", XusbReport{Buttons: 0x1000}, 1); p != 1 || err != nil {
		t.Fatal(p, err)
	}
	if len(bus.pads) != 4 || dernier(bus.pads[3]).Buttons != 0x1000 {
		t.Fatal("la manette de J1 est branchée après les autres, à la demande")
	}
}

func TestChangementDeJoueurRelacheLaPlace(t *testing.T) {
	m, bus, _ := fabriqueManettes()
	m.preparer()
	m.definirPlaces(map[string]int{"b": 2})
	m.appliquer("b", XusbReport{Buttons: 0x1000}, 1)
	m.definirPlaces(map[string]int{"c": 2}) // Bob part, Chloé prend J2
	if dernier(bus.pads[0]) != (XusbReport{}) {
		t.Fatal("la place doit être relâchée quand elle change de joueur")
	}
	if p, _ := m.appliquer("b", XusbReport{Buttons: 0x1000}, 2); p != 0 {
		t.Fatal("Bob n'a plus de place")
	}
	if p, _ := m.appliquer("c", XusbReport{Buttons: 0x4000}, 1); p != 2 || dernier(bus.pads[0]).Buttons != 0x4000 {
		t.Fatal("Chloé repart d'une séquence neuve sur J2")
	}
}

func TestPlacesInvalidesIgnorees(t *testing.T) {
	m, _, _ := fabriqueManettes()
	m.definirPlaces(map[string]int{"a": 0, "b": 5, "c": 3, "d": 3})
	if m.place("a") != 0 || m.place("b") != 0 {
		t.Fatal("places hors de 1..4 ignorées")
	}
	if (m.place("c") == 3) == (m.place("d") == 3) {
		t.Fatal("une seule personne par place")
	}
}

func TestSansViGEm(t *testing.T) {
	m := nouvellesManettes(nil)
	m.preparer()
	m.definirPlaces(map[string]int{"a": 2})
	if _, err := m.appliquer("a", XusbReport{}, 1); !errors.Is(err, errPasDeViGEm) {
		t.Fatal(err)
	}
	if !m.refuser("a") || m.refuser("a") {
		t.Fatal("on ne prévient qu'une fois")
	}
}

func TestMessagesEnRetardIgnores(t *testing.T) {
	m, bus, now := fabriqueManettes()
	m.preparer()
	m.definirPlaces(map[string]int{"a": 2})
	n := len(bus.pads[0].recus)
	m.appliquer("a", XusbReport{Buttons: 1}, 10)
	m.appliquer("a", XusbReport{Buttons: 2}, 9) // en retard : ignoré
	if got := len(bus.pads[0].recus) - n; got != 1 {
		t.Fatal(got)
	}
	*now = now.Add(time.Second) // page rechargée : la séquence repart de 1
	m.appliquer("a", XusbReport{Buttons: 4}, 1)
	if dernier(bus.pads[0]).Buttons != 4 {
		t.Fatal("la nouvelle séquence doit être acceptée après une pause")
	}
}

func TestLimiteDeDebit(t *testing.T) {
	m, bus, now := fabriqueManettes()
	m.preparer()
	m.definirPlaces(map[string]int{"a": 2})
	n := len(bus.pads[0].recus)
	for i := uint32(1); i <= 200; i++ {
		m.appliquer("a", XusbReport{}, i)
	}
	if got := len(bus.pads[0].recus) - n; got > int(rafaleManette) {
		t.Fatalf("%d messages acceptés d'un coup", got)
	}
	*now = now.Add(time.Second)
	avant := len(bus.pads[0].recus)
	m.appliquer("a", XusbReport{}, 1000)
	if len(bus.pads[0].recus) != avant+1 {
		t.Fatal("après une seconde, le joueur doit pouvoir rejouer")
	}
}

func TestRelacheSiSilence(t *testing.T) {
	m, bus, now := fabriqueManettes()
	m.preparer()
	m.definirPlaces(map[string]int{"a": 2})
	m.appliquer("a", XusbReport{Buttons: 0x1000, ThumbLX: 30000}, 1)
	n := len(bus.pads[0].recus)
	*now = now.Add(delaiRelache / 2)
	m.relacher()
	if len(bus.pads[0].recus) != n {
		t.Fatal("trop tôt")
	}
	*now = now.Add(delaiRelache)
	m.relacher()
	m.relacher()
	if len(bus.pads[0].recus) != n+1 || dernier(bus.pads[0]) != (XusbReport{}) {
		t.Fatal("bouton bloqué")
	}
}

func TestFinDePartie(t *testing.T) {
	m, bus, _ := fabriqueManettes()
	m.preparer()
	m.fermer()
	for _, p := range bus.pads {
		if !p.debranche || dernier(p) != (XusbReport{}) {
			t.Fatal("à la fin : manette relâchée puis débranchée")
		}
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
	m.definirPlaces(map[string]int{"a": 2})
	if p, err := m.appliquer("a", XusbReport{Buttons: 0x1000}, 1); err != nil || p != 2 {
		t.Fatal(p, err)
	}
}
