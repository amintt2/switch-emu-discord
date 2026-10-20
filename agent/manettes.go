package main

// Manettes virtuelles (ViGEm) des joueurs à distance, une par place J1 à J4.
// Le serveur dit qui joue sur quelle place ; un spectateur n'a aucun effet sur le jeu.
// La manette d'une place est branchée quand quelqu'un la prend, et reste branchée s'il se déconnecte
// ou laisse sa place (il peut revenir, un autre peut la reprendre) ; elle n'est débranchée que si
// l'hôte retire la personne, ou à la fin de la partie.
// Chaque place a son propre identifiant de manette (PID 0x5301 à 0x5304) : Ryubing reconnaît
// toujours « la manette de J2 » quel que soit l'ordre de branchement (voir ryubing.go).
// J1 est normalement l'hôte sur son PC (sa vraie manette) : pas de manette virtuelle pour lui.

import (
	"encoding/json"
	"errors"
	"log"
	"sync"
	"time"
)

const (
	nbPlaces = 4
	// Limite de débit par place : 250 messages/s en moyenne, rafales de 50.
	debitManette  = 250.0
	rafaleManette = 50.0
	// Sans nouvelles d'un joueur pendant ce temps, sa manette est relâchée (pas de bouton bloqué).
	delaiRelache = time.Second
	// Boutons XUSB valides (0x0800 n'existe pas).
	masqueBoutons = 0xF7FF
)

var (
	errPasDeViGEm = errors.New("manettes virtuelles indisponibles sur le PC de l'hôte (pilote ViGEmBus absent)")
	errSpectateur = errors.New("spectateur : pas de place")
)

type padVirtuel interface {
	Submit(XusbReport) error
	Unplug() error
}

type busManettes interface {
	brancher(place int) (padVirtuel, error)
}

// pidPlace est l'identifiant de produit USB de la manette virtuelle d'une place (vendeur Microsoft).
func pidPlace(p int) uint16 { return 0x5300 + uint16(p) }

// busViGEm adapte le client ViGEm à l'interface (permet de tester sans pilote).
type busViGEm struct{ v *ViGEm }

func (b busViGEm) brancher(place int) (padVirtuel, error) { return b.v.PlugX360(pidPlace(place)) }

// messageManette est l'état complet de la manette d'un joueur (envoyé à chaque changement et toutes les 100 ms).
type messageManette struct {
	S  uint32 `json:"s"` // numéro de séquence
	B  int    `json:"b"` // boutons, bits XUSB
	LT int    `json:"lt"`
	RT int    `json:"rt"`
	LX int    `json:"lx"`
	LY int    `json:"ly"`
	RX int    `json:"rx"`
	RY int    `json:"ry"`
}

func borne(v, min, max int) int {
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
}

// lireManette lit et valide un message : toute valeur hors limites est ramenée dans les bornes.
func lireManette(b []byte) (XusbReport, uint32, error) {
	var m messageManette
	if len(b) > tailleMaxTexte || json.Unmarshal(b, &m) != nil {
		return XusbReport{}, 0, errMessage
	}
	return XusbReport{
		Buttons:      uint16(m.B & masqueBoutons),
		LeftTrigger:  uint8(borne(m.LT, 0, 255)),
		RightTrigger: uint8(borne(m.RT, 0, 255)),
		ThumbLX:      int16(borne(m.LX, -32768, 32767)),
		ThumbLY:      int16(borne(m.LY, -32768, 32767)),
		ThumbRX:      int16(borne(m.RX, -32768, 32767)),
		ThumbRY:      int16(borne(m.RY, -32768, 32767)),
	}, m.S, nil
}

type etatPlace struct {
	uid       string
	seq       uint32
	dernier   time.Time
	relache   bool
	jetons    float64
	majJetons time.Time
	ignores   int
	erreurs   int
}

type manettes struct {
	mu     sync.Mutex
	bus    busManettes // nil si ViGEm absent
	pads   [nbPlaces + 1]padVirtuel
	etats  [nbPlaces + 1]etatPlace
	places map[string]int // uid -> place (joueurs à distance)
	refus  map[string]bool
	now    func() time.Time
}

func nouvellesManettes(bus busManettes) *manettes {
	return &manettes{bus: bus, places: map[string]int{}, refus: map[string]bool{}, now: time.Now}
}

func (m *manettes) brancherPlace(p int) error {
	if m.pads[p] != nil {
		return nil
	}
	pad, err := m.bus.brancher(p)
	if err != nil {
		return err
	}
	m.pads[p] = pad
	log.Printf("manette virtuelle de J%d branchée", p)
	return nil
}

// branchees renvoie les places dont la manette virtuelle est branchée.
func (m *manettes) branchees() []int {
	m.mu.Lock()
	defer m.mu.Unlock()
	var r []int
	for p := 1; p <= nbPlaces; p++ {
		if m.pads[p] != nil {
			r = append(r, p)
		}
	}
	return r
}

// retirer : l'hôte a retiré cette personne de la partie, sa manette est débranchée.
func (m *manettes) retirer(uid string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for p := 1; p <= nbPlaces; p++ {
		if m.etats[p].uid != uid && m.places[uid] != p {
			continue
		}
		if m.pads[p] != nil {
			m.pads[p].Submit(XusbReport{})
			m.pads[p].Unplug()
			m.pads[p] = nil
			log.Printf("manette virtuelle de J%d débranchée (joueur retiré)", p)
		}
		m.etats[p] = etatPlace{}
	}
	delete(m.places, uid)
}

// definirPlaces applique la répartition envoyée par le serveur. Une place qui change de joueur est relâchée ;
// la manette d'une place prise est branchée tout de suite (l'hôte la voit avant que l'ami appuie).
func (m *manettes) definirPlaces(nouvelles map[string]int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	propres := map[string]int{}
	occupant := [nbPlaces + 1]string{}
	for uid, p := range nouvelles {
		if p >= 1 && p <= nbPlaces && occupant[p] == "" {
			propres[uid] = p
			occupant[p] = uid
		}
	}
	for p := 1; p <= nbPlaces; p++ {
		if m.etats[p].uid != occupant[p] {
			if m.pads[p] != nil {
				m.pads[p].Submit(XusbReport{})
			}
			// Une place libérée garde le nom de son dernier joueur : s'il est retiré, sa manette est débranchée.
			if occupant[p] != "" {
				m.etats[p] = etatPlace{uid: occupant[p], jetons: rafaleManette, majJetons: m.now(), relache: true}
			}
		}
		if occupant[p] != "" && m.bus != nil {
			if err := m.brancherPlace(p); err != nil {
				log.Printf("manette J%d : %v", p, err)
			}
		}
	}
	m.places = propres
}

// place renvoie la place (1 à 4) d'un joueur à distance, ou 0 pour un spectateur.
func (m *manettes) place(uid string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.places[uid]
}

// appliquer envoie l'état d'un joueur à la manette virtuelle de sa place.
func (m *manettes) appliquer(uid string, r XusbReport, seq uint32) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p := m.places[uid]
	if p == 0 {
		return 0, errSpectateur
	}
	if m.bus == nil {
		return p, errPasDeViGEm
	}
	if err := m.brancherPlace(p); err != nil { // J1 laissé à un ami : branchée à la demande
		return p, err
	}
	e := &m.etats[p]
	now := m.now()
	// Limite de débit (seau à jetons).
	e.jetons += now.Sub(e.majJetons).Seconds() * debitManette
	if e.jetons > rafaleManette {
		e.jetons = rafaleManette
	}
	e.majJetons = now
	if e.jetons < 1 {
		e.ignores++
		return p, nil
	}
	e.jetons--
	// Messages en retard ignorés ; une séquence qui recommence (page rechargée) est acceptée après une pause.
	if seq <= e.seq && now.Sub(e.dernier) < 500*time.Millisecond {
		return p, nil
	}
	e.seq, e.dernier, e.relache = seq, now, false
	// ViGEm répond parfois « aucune donnée » alors que l'état est bien appliqué (vu en XInput) :
	// une erreur d'envoi ne retire pas la manette au joueur.
	if err := m.pads[p].Submit(r); err != nil {
		e.erreurs++
	}
	return p, nil
}

// refuser dit si le joueur doit être prévenu d'un refus (une seule fois par joueur).
func (m *manettes) refuser(uid string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.refus[uid] {
		return false
	}
	m.refus[uid] = true
	return true
}

// relacher remet au repos les manettes des joueurs silencieux depuis trop longtemps.
func (m *manettes) relacher() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for p := 1; p <= nbPlaces; p++ {
		e := &m.etats[p]
		if m.pads[p] != nil && !e.relache && m.now().Sub(e.dernier) > delaiRelache {
			e.relache = true
			m.pads[p].Submit(XusbReport{})
		}
	}
}

// fermer débranche toutes les manettes (fin de la partie).
func (m *manettes) fermer() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for p := 1; p <= nbPlaces; p++ {
		if m.pads[p] != nil {
			m.pads[p].Submit(XusbReport{})
			m.pads[p].Unplug()
			m.pads[p] = nil
		}
	}
}
