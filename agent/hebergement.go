package main

// Une session d'hébergement : le capteur tourne, et chaque image est envoyée UNE fois à chaque relais
// qui a au moins un ami (le relais la distribue). Les connexions aux relais sont sortantes.

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

type hebergement struct {
	salle  string
	cancel context.CancelFunc
	fini   chan struct{}
}

// lienRelais est la connexion de l'hôte à un relais.
type lienRelais struct {
	url   string
	amis  atomic.Int32
	file  chan []byte // images à envoyer ; pleine = l'envoi ne suit pas
	texte chan []byte
}

type depsHebergement struct {
	exeCapteur  string
	capture     Capture
	jetonFrais  func(ctx context.Context, salle string) (string, error) // redemande un jeton au serveur
	signalerErr func(salle, texte string)
}

func demarrerHebergement(parent context.Context, o ordreServeur, cfg Config, d depsHebergement) *hebergement {
	ctx, cancel := context.WithCancel(parent)
	h := &hebergement{salle: o.Salle, cancel: cancel, fini: make(chan struct{})}
	go func() {
		defer close(h.fini)
		h.tourner(ctx, o, cfg, d)
	}()
	return h
}

func (h *hebergement) arreter() {
	h.cancel()
	<-h.fini
}

func (h *hebergement) tourner(ctx context.Context, o ordreServeur, cfg Config, d depsHebergement) {
	log.Printf("hébergement de la salle %s : démarrage", o.Salle)
	k, err := lancerCapteur(ctx, d.exeCapteur, d.capture)
	if err != nil {
		log.Print(err)
		d.signalerErr(o.Salle, "capture impossible")
		return
	}
	defer k.arreter()

	var liens []*lienRelais
	var wg sync.WaitGroup
	premierJeton := o.Jeton
	var muJeton sync.Mutex
	jeton := func(ctx context.Context) (string, error) {
		muJeton.Lock()
		defer muJeton.Unlock()
		if premierJeton != "" {
			j := premierJeton
			premierJeton = ""
			return j, nil
		}
		return d.jetonFrais(ctx, o.Salle)
	}
	for _, u := range o.Relais {
		if !cfg.relaisAutorise(u) {
			log.Printf("relais refusé (pas dans relaisAutorises) : %s", u)
			continue
		}
		l := &lienRelais{url: u, file: make(chan []byte, 3), texte: make(chan []byte, 64)}
		liens = append(liens, l)
		wg.Add(1)
		go func() { defer wg.Done(); l.maintenir(ctx, jeton, k) }()
	}
	if len(liens) == 0 {
		d.signalerErr(o.Salle, "aucun relais autorisé")
		return
	}

	envoyees, debut := 0, time.Now()
	images := k.images
	for {
		select {
		case <-ctx.Done():
			wg.Wait()
			log.Printf("hébergement de la salle %s : arrêt", o.Salle)
			return
		case img, ok := <-images:
			if !ok {
				d.signalerErr(o.Salle, "le capteur s'est arrêté")
				images = nil // canal fermé : ne plus le lire
				h.cancel()
				continue
			}
			paquet := encoderImage(0, img.cle, qualiteParDef, img.capture, img.au)
			for _, l := range liens {
				if l.amis.Load() == 0 {
					continue
				}
				select {
				case l.file <- paquet:
				default:
					k.demanderIDR() // ce relais ne suit pas : on saute jusqu'à la prochaine image clé
				}
			}
			if envoyees++; envoyees%1800 == 0 {
				log.Printf("%d images envoyées (%.1f i/s)", envoyees, float64(envoyees)/time.Since(debut).Seconds())
			}
		}
	}
}

// maintenir garde la connexion au relais ouverte (reconnexion avec un jeton neuf si elle tombe).
func (l *lienRelais) maintenir(ctx context.Context, jeton func(context.Context) (string, error), k *capteur) {
	attente := time.Second
	for ctx.Err() == nil {
		j, err := jeton(ctx)
		if err == nil {
			err = l.session(ctx, j, k)
		}
		l.amis.Store(0)
		if ctx.Err() != nil {
			return
		}
		log.Printf("relais %s : %v (nouvel essai dans %s)", l.url, err, attente)
		select {
		case <-ctx.Done():
			return
		case <-time.After(attente):
		}
		if attente < 15*time.Second {
			attente *= 2
		}
	}
}

func (l *lienRelais) session(ctx context.Context, jeton string, k *capteur) error {
	c, _, err := websocket.Dial(ctx, l.url+"?jeton="+jeton, nil)
	if err != nil {
		return err
	}
	defer c.CloseNow()
	c.SetReadLimit(64 << 10)
	log.Printf("relais %s : connecté", l.url)
	sctx, stop := context.WithCancel(ctx)
	defer stop()

	// Écriture : images (binaire) et réponses (texte), avec un délai pour ne jamais bloquer.
	go func() {
		ecrire := func(t websocket.MessageType, b []byte) bool {
			wctx, cancel := context.WithTimeout(sctx, 2*time.Second)
			defer cancel()
			return c.Write(wctx, t, b) == nil
		}
		for {
			select {
			case <-sctx.Done():
				return
			case b := <-l.texte:
				if !ecrire(websocket.MessageText, b) {
					stop()
					return
				}
			case b := <-l.file:
				if !ecrire(websocket.MessageBinary, b) {
					stop()
					return
				}
			}
		}
	}()

	amis := map[uint32]bool{}
	for {
		_, b, err := c.Read(sctx)
		if err != nil {
			return err
		}
		m, err := lireMessageAmi(b)
		if err != nil {
			continue
		}
		switch m.Type {
		case "arrivee":
			amis[m.De] = true
			l.amis.Store(int32(len(amis)))
			log.Printf("relais %s : un ami regarde (%d en tout)", l.url, len(amis))
			k.demanderIDR()
		case "depart":
			delete(amis, m.De)
			l.amis.Store(int32(len(amis)))
		case "idr":
			k.demanderIDR()
		case "ping":
			r, _ := json.Marshal(map[string]any{"type": "pong", "a": m.De, "t": m.T, "s": heureMs(time.Now())})
			select {
			case l.texte <- r:
			default:
			}
		}
		// Les autres types (manette…) arrivent à l'étape 2.
	}
}
