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

type fauxBus struct {
	pads     []*fauxPad
	parPlace map[int]*fauxPad
}

func (b *fauxBus) brancher(place int) (padVirtuel, error) {
	p := &fauxPad{}
	b.pads = append(b.pads, p)
	if b.parPlace == nil {
		b.parPlace = map[int]*fauxPad{}
	}
	b.parPlace[place] = p
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

func TestUneManetteParPlacePrise(t *testing.T) {
	m, bus, _ := fabriqueManettes()
	m.definirPlaces(map[string]int{})
	if len(bus.pads) != 0 {
		t.Fatal("aucune manette tant que personne ne joue")
	}
	m.definirPlaces(map[string]int{"b": 2, "c": 4})
	if len(bus.pads) != 2 || bus.parPlace[2] == nil || bus.parPlace[4] == nil {
		t.Fatalf("%d manettes branchées, attendu J2 et J4 seulement", len(bus.pads))
	}
	m.appliquer("b", XusbReport{Buttons: 0x1000}, 1)
	m.appliquer("c", XusbReport{Buttons: 0x2000}, 1)
	if dernier(bus.parPlace[2]).Buttons != 0x1000 || dernier(bus.parPlace[4]).Buttons != 0x2000 {
		t.Fatal("chaque joueur doit piloter la manette de sa place")
	}
}

func TestIdentifiantParPlace(t *testing.T) {
	if pidPlace(2) == pidPlace(3) || pidPlace(1) != 0x5301 {
		t.Fatal("chaque place a son PID")
	}
}

func TestManetteGardeeSiDeconnexionDebrancheeSiRetire(t *testing.T) {
	m, bus, _ := fabriqueManettes()
	m.definirPlaces(map[string]int{"b": 2})
	m.appliquer("b", XusbReport{Buttons: 0x1000}, 1)
	m.definirPlaces(map[string]int{}) // Bob se déconnecte, sa place est libérée
	pad := bus.parPlace[2]
	if pad.debranche || dernier(pad) != (XusbReport{}) {
		t.Fatal("la manette reste branchée, au repos")
	}
	m.definirPlaces(map[string]int{"b": 2}) // il revient : même manette
	if len(bus.pads) != 1 {
		t.Fatal("pas de nouvelle manette pour un joueur qui revient")
	}
	m.retirer("b")
	if !pad.debranche {
		t.Fatal("joueur retiré : manette débranchée")
	}
	m.definirPlaces(map[string]int{})
	m.retirer("b")
	if len(bus.pads) != 1 {
		t.Fatal("rien à rebrancher")
	}
}

func TestRetireApresAvoirQuitteSaPlace(t *testing.T) {
	m, bus, _ := fabriqueManettes()
	m.definirPlaces(map[string]int{"b": 3})
	m.definirPlaces(map[string]int{}) // il a quitté sa place puis l'hôte le retire
	m.retirer("b")
	if !bus.parPlace[3].debranche {
		t.Fatal("la manette de son ancienne place est débranchée")
	}
}

func TestSpectateurSansEffet(t *testing.T) {
	m, bus, _ := fabriqueManettes()
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
	m.definirPlaces(map[string]int{"b": 1})
	if p, err := m.appliquer("b", XusbReport{Buttons: 0x1000}, 1); p != 1 || err != nil {
		t.Fatal(p, err)
	}
	if len(bus.pads) != 1 || dernier(bus.parPlace[1]).Buttons != 0x1000 {
		t.Fatal("la manette de J1 est branchée quand un ami prend J1")
	}
}

func TestChangementDeJoueurRelacheLaPlace(t *testing.T) {
	m, bus, _ := fabriqueManettes()
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
	m.definirPlaces(map[string]int{"b": 2, "c": 3})
	m.fermer()
	if len(bus.pads) != 2 {
		t.Fatal(len(bus.pads))
	}
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

func (busCapricieux) brancher(int) (padVirtuel, error) { return &padCapricieux{}, nil }

func TestErreurDEnvoiNeRetirePasLaManette(t *testing.T) {
	m := nouvellesManettes(busCapricieux{})
	m.definirPlaces(map[string]int{"a": 2})
	if p, err := m.appliquer("a", XusbReport{Buttons: 0x1000}, 1); err != nil || p != 2 {
		t.Fatal(p, err)
	}
}
