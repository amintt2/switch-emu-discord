package main

// Manettes des amis : chaque ami qui envoie des commandes reçoit une manette Xbox 360 virtuelle (ViGEm)
// sur le PC de l'hôte. J1 est la manette de l'hôte ; les amis prennent J2, J3, J4 dans l'ordre d'arrivée.
// Les manettes restent branchées toute la session : l'émulateur les distingue par ordre de branchement,
// un ami qui se reconnecte retrouve donc la même.

import (
	"encoding/json"
	"errors"
	"sync"
	"time"
)

const (
	maxManettesAmis = 3
	premierePlace   = 2 // J1 = l'hôte
	// Limite de débit par ami : 250 messages/s en moyenne, rafales de 50.
	debitManette  = 250.0
	rafaleManette = 50.0
	// Sans nouvelles d'un ami pendant ce temps, sa manette est relâchée (pas de bouton bloqué).
	delaiRelache = time.Second
	// Boutons XUSB valides (0x0800 n'existe pas).
	masqueBoutons = 0xF7FF
)

var (
	errPasDeViGEm = errors.New("manettes virtuelles indisponibles sur le PC de l'hôte (pilote ViGEmBus absent)")
	errComplet    = errors.New("toutes les manettes sont prises")
)

type padVirtuel interface {
	Submit(XusbReport) error
	Unplug() error
}

type busManettes interface {
	brancher() (padVirtuel, error)
}

// busViGEm adapte le client ViGEm à l'interface (permet de tester sans pilote).
type busViGEm struct{ v *ViGEm }

func (b busViGEm) brancher() (padVirtuel, error) { return b.v.PlugX360() }

// messageManette est l'état complet de la manette d'un ami (envoyé à chaque changement et toutes les 100 ms).
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

type joueur struct {
	pad       padVirtuel
	place     int
	seq       uint32
	dernier   time.Time
	relache   bool
	jetons    float64
	majJetons time.Time
	ignores   int
	erreurs   int
	prevenu   bool
}

type manettes struct {
	mu      sync.Mutex
	bus     busManettes // nil si ViGEm absent
	joueurs map[string]*joueur
	refus   map[string]bool // amis déjà prévenus qu'ils n'ont pas de manette
	now     func() time.Time
}

func nouvellesManettes(bus busManettes) *manettes {
	return &manettes{bus: bus, joueurs: map[string]*joueur{}, refus: map[string]bool{}, now: time.Now}
}

// appliquer envoie l'état d'un ami à sa manette virtuelle (créée au premier message).
// nouveau = true quand l'ami vient d'obtenir sa place (pour le prévenir).
func (m *manettes) appliquer(uid string, r XusbReport, seq uint32) (place int, nouveau bool, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now()
	j := m.joueurs[uid]
	if j == nil {
		if m.bus == nil {
			return 0, false, errPasDeViGEm
		}
		if len(m.joueurs) >= maxManettesAmis {
			return 0, false, errComplet
		}
		pad, err := m.bus.brancher()
		if err != nil {
			return 0, false, err
		}
		j = &joueur{pad: pad, place: premierePlace + len(m.joueurs), jetons: rafaleManette, majJetons: now}
		m.joueurs[uid] = j
		nouveau = true
	}
	// Limite de débit (seau à jetons).
	j.jetons += now.Sub(j.majJetons).Seconds() * debitManette
	if j.jetons > rafaleManette {
		j.jetons = rafaleManette
	}
	j.majJetons = now
	if j.jetons < 1 {
		j.ignores++
		return j.place, nouveau, nil
	}
	j.jetons--
	// Messages en retard ignorés ; une séquence qui recommence (page rechargée) est acceptée après une pause.
	if seq <= j.seq && now.Sub(j.dernier) < 500*time.Millisecond {
		return j.place, nouveau, nil
	}
	j.seq, j.dernier, j.relache = seq, now, false
	// ViGEm répond parfois « aucune donnée » alors que l'état est bien appliqué (vu en XInput) :
	// une erreur d'envoi ne retire pas la manette à l'ami.
	if err := j.pad.Submit(r); err != nil {
		j.erreurs++
	}
	return j.place, nouveau, nil
}

// place renvoie la place (J2…) de l'ami, ou 0 s'il n'a pas encore de manette.
func (m *manettes) place(uid string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	if j := m.joueurs[uid]; j != nil {
		return j.place
	}
	return 0
}

// refuser dit si l'ami doit être prévenu d'un refus (une seule fois par ami).
func (m *manettes) refuser(uid string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.refus[uid] {
		return false
	}
	m.refus[uid] = true
	return true
}

// relacher remet au repos les manettes des amis silencieux depuis trop longtemps.
func (m *manettes) relacher() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, j := range m.joueurs {
		if !j.relache && m.now().Sub(j.dernier) > delaiRelache {
			j.relache = true
			j.pad.Submit(XusbReport{})
		}
	}
}

// fermer débranche toutes les manettes (fin de l'hébergement).
func (m *manettes) fermer() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for uid, j := range m.joueurs {
		j.pad.Submit(XusbReport{})
		j.pad.Unplug()
		delete(m.joueurs, uid)
	}
}
