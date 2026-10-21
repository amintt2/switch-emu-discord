package main

// P2P (hors de Discord) : un ami dans un vrai navigateur reçoit la vidéo en direct par WebRTC (canaux
// de données), sans passer par le relais : moins de latence, surtout sur le même réseau.
// La négociation passe par le relais (offre de l'ami → réponse de l'agent) : seul un membre de la
// salle, avec son jeton de relais, peut l'ouvrir, et son identité (uid) vient du relais, pas de lui.
// Le canal « video » est fiable et ordonné (un morceau perdu est renvoyé : ça coûte un aller-retour,
// pas une image clé entière) ; les images y sont découpées en morceaux : [u32 n° d'image][u16 morceau][u16 nombre][…]
// Le retard ne s'accumule jamais : si plus de quelques images attendent déjà, on saute des images et on
// repart d'une image clé une fois la file vidée (l'ami en est prévenu : sa qualité s'adapte).
// (le son a sa propre numérotation, bit de poids fort à 1 : un son perdu n'oblige pas à une image clé).
// Le canal « ctrl » (fiable) porte les mêmes messages que le relais : ping, idr, qualite, manette.

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"
)

const (
	tailleMorceau   = 16000
	maxP2P          = 8
	attenteImageMax = 96 << 10  // une image normale ne part pas si plus que ça attend déjà (~2-3 images)
	attenteCleMax   = 384 << 10 // une image clé (grosse) a droit à un peu plus
	delaiOuvertP2P  = 15 * time.Second
)

var serveursSTUN = []string{"stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"}

// canalVideo : ce que l'envoi utilise du canal « video » (un faux canal lent sert aux tests).
type canalVideo interface {
	ReadyState() webrtc.DataChannelState
	BufferedAmount() uint64
	Send([]byte) error
}

type lienP2P struct {
	uid         string
	pc          *webrtc.PeerConnection
	ctrl        *webrtc.DataChannel
	video       canalVideo
	couche      atomic.Int32
	numero      uint32 // images ; le son a sa propre suite (bit de poids fort à 1)
	numeroSon   uint32
	besoinCle   atomic.Bool
	cleDemandee bool      // image clé déjà demandée depuis le dernier saut (boucle de la partie seulement)
	dernierSaut time.Time // pour prévenir l'ami au plus 4 fois par seconde
	fini        chan struct{}
	une         sync.Once
	// limite de débit du canal ctrl (messages traités un par un par pion)
	jetons    float64
	majJetons time.Time
}

func (p *lienP2P) fermer() {
	p.une.Do(func() {
		close(p.fini)
		p.pc.Close()
	})
}

func (p *lienP2P) texte(v map[string]any) {
	b, _ := json.Marshal(v)
	if p.ctrl != nil && p.ctrl.ReadyState() == webrtc.DataChannelStateOpen {
		p.ctrl.SendText(string(b))
	}
}

// envoyer découpe un paquet (au format du relais, sans destinataire) et l'envoie. Renvoie false si le
// canal ne suit pas : les images suivantes attendent alors la prochaine image clé.
func (p *lienP2P) envoyer(charge []byte, cle, son bool) bool {
	if p.video.ReadyState() != webrtc.DataChannelStateOpen {
		return false
	}
	tampon := p.video.BufferedAmount()
	if !son {
		if p.besoinCle.Load() {
			if !cle {
				// La file se vide : on demande une image clé (une seule fois), en attendant on saute.
				if tampon < attenteImageMax/2 && !p.cleDemandee {
					p.cleDemandee = true
					return false
				}
				return true
			}
			if tampon > attenteCleMax {
				p.cleDemandee = false // trop plein même pour elle : on en redemandera une
				return true
			}
		} else if tampon > attenteImageMax {
			// L'image partirait en retard : on la saute (et les suivantes jusqu'à une image clé).
			p.besoinCle.Store(true)
			p.cleDemandee = false
			if time.Since(p.dernierSaut) > 250*time.Millisecond {
				p.dernierSaut = time.Now()
				p.texte(map[string]any{"type": "saute"})
			}
			return true
		}
		p.besoinCle.Store(false)
		p.cleDemandee = false
	} else if tampon > 2*attenteImageMax {
		return true // un trou dans le son plutôt que du retard
	}
	var numero uint32
	if son {
		p.numeroSon++
		numero = 0x80000000 | p.numeroSon&0x7FFFFFFF
	} else {
		p.numero++
		numero = p.numero & 0x7FFFFFFF
	}
	total := (len(charge) + tailleMorceau - 1) / tailleMorceau
	for i := 0; i < total; i++ {
		fin := min(len(charge), (i+1)*tailleMorceau)
		morceau := charge[i*tailleMorceau : fin]
		b := make([]byte, 8+len(morceau))
		binary.LittleEndian.PutUint32(b, numero)
		binary.LittleEndian.PutUint16(b[4:], uint16(i))
		binary.LittleEndian.PutUint16(b[6:], uint16(total))
		copy(b[8:], morceau)
		if p.video.Send(b) != nil {
			p.besoinCle.Store(true)
			return false
		}
	}
	return true
}

// relancerCle : une image a été sautée et la file s'est vidée, mais aucune image n'est venue demander
// l'image clé (écran immobile : le capteur n'envoie plus rien). Appelée régulièrement par la partie ;
// renvoie true s'il faut demander une image clé maintenant (une seule fois).
func (p *lienP2P) relancerCle() bool {
	if !p.besoinCle.Load() || p.cleDemandee || p.video.BufferedAmount() >= attenteImageMax/2 {
		return false
	}
	p.cleDemandee = true
	return true
}

// accepterP2P répond à l'offre WebRTC d'un ami (reçue par le relais) et attend l'ouverture des canaux.
func accepterP2P(ctx context.Context, offre, uid string, repondre func(sdp string), surMessage func(p *lienP2P, b []byte)) (*lienP2P, error) {
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{ICEServers: []webrtc.ICEServer{{URLs: serveursSTUN}}})
	if err != nil {
		return nil, err
	}
	p := &lienP2P{uid: uid, pc: pc, fini: make(chan struct{})}
	pret := make(chan struct{})
	var une sync.Once
	var mu sync.Mutex
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		// Exactement un canal de chaque sorte : un doublon est refusé (pas deux lecteurs en parallèle).
		mu.Lock()
		switch {
		case dc.Label() == "ctrl" && p.ctrl == nil:
			p.ctrl = dc
			dc.OnMessage(func(m webrtc.DataChannelMessage) {
				if len(m.Data) <= tailleMaxTexte {
					surMessage(p, m.Data)
				}
			})
		case dc.Label() == "video" && p.video == nil:
			p.video = dc
		default:
			mu.Unlock()
			dc.Close()
			return
		}
		mu.Unlock()
		dc.OnOpen(func() {
			mu.Lock()
			ok := p.ctrl != nil && p.video != nil && p.ctrl.ReadyState() == webrtc.DataChannelStateOpen && p.video.ReadyState() == webrtc.DataChannelStateOpen
			mu.Unlock()
			if ok {
				une.Do(func() { close(pret) })
			}
		})
	})
	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		if st == webrtc.PeerConnectionStateFailed || st == webrtc.PeerConnectionStateClosed {
			p.fermer()
		}
	})
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offre}); err != nil {
		pc.Close()
		return nil, err
	}
	reponse, err := pc.CreateAnswer(nil)
	if err != nil {
		pc.Close()
		return nil, err
	}
	collecte := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(reponse); err != nil {
		pc.Close()
		return nil, err
	}
	select {
	case <-collecte:
	case <-time.After(5 * time.Second): // on répond avec les candidats déjà trouvés
	case <-ctx.Done():
		pc.Close()
		return nil, ctx.Err()
	}
	repondre(pc.LocalDescription().SDP)
	select {
	case <-pret:
	case <-p.fini:
		return nil, errors.New("connexion directe impossible")
	case <-time.After(delaiOuvertP2P):
		p.fermer()
		return nil, errors.New("connexion directe : délai dépassé")
	case <-ctx.Done():
		p.fermer()
		return nil, ctx.Err()
	}
	if paire, err := pc.SCTP().Transport().ICETransport().GetSelectedCandidatePair(); err == nil && paire != nil {
		log.Printf("P2P : connexion directe avec un ami (%s -> %s)", paire.Local.Typ, paire.Remote.Typ)
	}
	return p, nil
}

// messageP2P traite un message du canal « ctrl » d'un ami en direct (mêmes règles que par le relais).
func messageP2P(p *lienP2P, b []byte, diff *diffusion) {
	// Limite de débit du canal : 300 messages/s en moyenne (pings, manette…), au-delà ils sont ignorés.
	now := time.Now()
	p.jetons = min(300, p.jetons+now.Sub(p.majJetons).Seconds()*300)
	p.majJetons = now
	if p.jetons < 1 {
		return
	}
	p.jetons--
	msg, err := lireMessageAmi(b)
	if err != nil {
		return
	}
	switch msg.Type {
	case "battement":
		p.texte(map[string]any{"type": "battement"})
	case "ping":
		p.texte(map[string]any{"type": "pong", "t": msg.T, "s": heureMs(time.Now())})
	case "idr":
		diff.demanderIDR(int(p.couche.Load()))
	case "qualite":
		if msg.Q >= 0 && msg.Q < nbCouches {
			p.couche.Store(int32(msg.Q))
			diff.signalerBesoin()
			diff.demanderIDR(msg.Q)
		}
	case "manette":
		r, seq, err := lireManette(b)
		if err != nil {
			return
		}
		// L'uid est celui donné par le relais à l'ouverture : un ami ne peut pas jouer à la place d'un autre.
		if _, err := diff.man.appliquer(p.uid, r, seq); err != nil && !errors.Is(err, errSpectateur) && diff.man.refuser(p.uid) {
			p.texte(map[string]any{"type": "manette-indisponible", "raison": err.Error()})
		}
	}
}
