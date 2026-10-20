package main

// Une session d'hébergement : le capteur tourne, et chaque image est envoyée UNE fois à chaque relais
// qui a au moins un ami (le relais la distribue). Les connexions aux relais sont sortantes.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"regexp"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

type hebergement struct {
	salle  string
	cancel context.CancelFunc
	fini   chan struct{}
	ordres chan ordreServeur // places, exclure : traités dans la boucle de la partie
}

// transmettre passe un ordre du serveur (places, exclure) à la partie en cours.
func (h *hebergement) transmettre(o ordreServeur) {
	select {
	case h.ordres <- o:
	default:
		log.Printf("ordre %q ignoré : file pleine", o.Type)
	}
}

// lienRelais est la connexion de l'hôte à un relais.
type lienRelais struct {
	url         string
	amis        atomic.Int32
	file        chan []byte // images à envoyer ; pleine = l'envoi ne suit pas
	texte       chan []byte
	jetees      atomic.Int32 // images jetées parce que l'envoi ne suivait pas
	reconnexion atomic.Int32
}

const (
	battementRelais = 10 * time.Second // l'agent envoie un battement, le relais répond
	silenceMax      = 25 * time.Second // rien reçu du relais depuis ce temps : la connexion est morte
)

type depsHebergement struct {
	exeCapteur  string
	capture     Capture
	jetonFrais  func(ctx context.Context, salle string) (string, error) // redemande un jeton au serveur
	signalerErr func(salle, texte string)
	diag        func(quoi string, v map[string]any) // mesures envoyées au journal du serveur
	bus         busManettes // nil si ViGEmBus n'est pas installé
}

func demarrerHebergement(parent context.Context, o ordreServeur, cfg Config, d depsHebergement) *hebergement {
	ctx, cancel := context.WithCancel(parent)
	h := &hebergement{salle: o.Salle, cancel: cancel, fini: make(chan struct{}), ordres: make(chan ordreServeur, 16)}
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

	m := nouvellesManettes(d.bus)
	m.preparer() // J2, J3, J4 branchées dans l'ordre dès le début
	defer m.fermer()
	go func() {
		t := time.NewTicker(250 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				m.relacher()
			}
		}
	}()

	var liens []*lienRelais
	var wg sync.WaitGroup
	premierJeton, dernierJeton := o.Jeton, o.Jeton
	var muJeton sync.Mutex
	jeton := func(ctx context.Context) (string, error) {
		muJeton.Lock()
		defer muJeton.Unlock()
		if premierJeton != "" {
			j := premierJeton
			premierJeton = ""
			return j, nil
		}
		j, err := d.jetonFrais(ctx, o.Salle)
		if err == nil {
			dernierJeton = j
			return j, nil
		}
		// Serveur injoignable : le jeton précédent (valable 2 h) suffit pour revenir sur le relais.
		if dernierJeton != "" {
			return dernierJeton, nil
		}
		return "", err
	}
	for _, u := range o.Relais {
		if !cfg.relaisAutorise(u) {
			log.Printf("relais refusé (pas dans relaisAutorises) : %s", u)
			continue
		}
		l := &lienRelais{url: u, file: make(chan []byte, 3), texte: make(chan []byte, 64)}
		liens = append(liens, l)
		wg.Add(1)
		go func() { defer wg.Done(); l.maintenir(ctx, jeton, k, m) }()
	}
	if len(liens) == 0 {
		d.signalerErr(o.Salle, "aucun relais autorisé")
		return
	}

	envoyees, debut := 0, time.Now()
	images := k.images
	mesure := time.NewTicker(time.Minute)
	defer mesure.Stop()
	dernieres, idrAvant := 0, 0
	for {
		select {
		case <-mesure.C:
			v := map[string]any{"ips": float64(envoyees-dernieres) / 60, "cles": k.imagesCles() - idrAvant}
			for i, l := range liens {
				v[fmt.Sprintf("amis%d", i)] = l.amis.Load()
				v[fmt.Sprintf("jetees%d", i)] = l.jetees.Swap(0)
				v[fmt.Sprintf("reco%d", i)] = l.reconnexion.Swap(0)
			}
			dernieres, idrAvant = envoyees, k.imagesCles()
			d.diag("hebergement", v)
		case <-ctx.Done():
			wg.Wait()
			log.Printf("hébergement de la salle %s : arrêt", o.Salle)
			return
		case o := <-h.ordres:
			switch o.Type {
			case "places":
				m.definirPlaces(o.Places)
				log.Printf("places : %d joueur(s) à distance", len(o.Places))
			case "exclure":
				// Le relais coupe la connexion de la personne retirée.
				b, _ := json.Marshal(map[string]string{"type": "exclure", "uid": o.UID})
				for _, l := range liens {
					select {
					case l.texte <- b:
					default:
					}
				}
			}
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
					l.jetees.Add(1)
					k.demanderIDR() // ce relais ne suit pas : on saute jusqu'à la prochaine image clé
				}
			}
			if envoyees++; envoyees%1800 == 0 {
				log.Printf("%d images envoyées (%.1f i/s)", envoyees, float64(envoyees)/time.Since(debut).Seconds())
			}
		}
	}
}

var reJeton = regexp.MustCompile(`jeton=[^\s"&]+`)

// sansJeton retire les jetons des messages d'erreur avant de les écrire dans le journal.
func sansJeton(err error) string {
	if err == nil {
		return ""
	}
	return reJeton.ReplaceAllString(err.Error(), "jeton=…")
}

// maintenir garde la connexion au relais ouverte (reconnexion avec un jeton neuf si elle tombe).
func (l *lienRelais) maintenir(ctx context.Context, jeton func(context.Context) (string, error), k *capteur, m *manettes) {
	attente := 300 * time.Millisecond
	for ctx.Err() == nil {
		debut := time.Now()
		j, err := jeton(ctx)
		if err == nil {
			err = l.session(ctx, j, k, m)
		}
		l.amis.Store(0)
		if ctx.Err() != nil {
			return
		}
		// Une connexion qui a tenu un moment : on revient tout de suite, sans attente qui s'allonge.
		if time.Since(debut) > 20*time.Second {
			attente = 300 * time.Millisecond
		}
		l.reconnexion.Add(1)
		log.Printf("relais %s : %s (nouvel essai dans %s)", l.url, sansJeton(err), attente)
		select {
		case <-ctx.Done():
			return
		case <-time.After(attente):
		}
		if attente < 8*time.Second {
			attente *= 2
		}
	}
}

func (l *lienRelais) session(ctx context.Context, jeton string, k *capteur, man *manettes) error {
	dctx, annuler := context.WithTimeout(ctx, 10*time.Second)
	c, _, err := websocket.Dial(dctx, l.url+"?jeton="+jeton, nil)
	annuler()
	if err != nil {
		return err
	}
	defer c.CloseNow()
	c.SetReadLimit(64 << 10)
	log.Printf("relais %s : connecté", l.url)
	sctx, stop := context.WithCancel(ctx)
	defer stop()

	// Battements : si le relais ne répond plus (Wi-Fi coupé, relais redémarré), on se reconnecte vite.
	var dernierRecu atomic.Int64
	dernierRecu.Store(time.Now().UnixNano())
	battement, _ := json.Marshal(map[string]string{"type": "battement"})
	go func() {
		t := time.NewTicker(battementRelais)
		defer t.Stop()
		for {
			select {
			case <-sctx.Done():
				return
			case <-t.C:
				if time.Since(time.Unix(0, dernierRecu.Load())) > silenceMax {
					log.Printf("relais %s : plus de nouvelles depuis %s, reconnexion", l.url, silenceMax)
					stop()
					return
				}
				select {
				case l.texte <- battement:
				default:
				}
			}
		}
	}()

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

	envoyerTexte := func(v map[string]any) {
		b, _ := json.Marshal(v)
		select {
		case l.texte <- b:
		default:
		}
	}
	amis := map[uint32]bool{}
	for {
		_, b, err := c.Read(sctx)
		if err != nil {
			return err
		}
		dernierRecu.Store(time.Now().UnixNano())
		msg, err := lireMessageAmi(b)
		if err != nil {
			continue
		}
		switch msg.Type {
		case "arrivee":
			amis[msg.De] = true
			l.amis.Store(int32(len(amis)))
			log.Printf("relais %s : un ami regarde (%d en tout)", l.url, len(amis))
			k.demanderIDR()
		case "depart":
			delete(amis, msg.De)
			l.amis.Store(int32(len(amis)))
		case "idr":
			k.demanderIDR()
		case "manette":
			r, seq, err := lireManette(b)
			if err != nil {
				continue
			}
			// Les spectateurs n'ont pas de place : leurs commandes sont ignorées.
			if _, err := man.appliquer(msg.UID, r, seq); err != nil && !errors.Is(err, errSpectateur) && man.refuser(msg.UID) {
				log.Printf("manette refusée : %v", err)
				envoyerTexte(map[string]any{"type": "manette-indisponible", "a": msg.De, "raison": err.Error()})
			}
		case "ping":
			envoyerTexte(map[string]any{"type": "pong", "a": msg.De, "t": msg.T, "s": heureMs(time.Now())})
		}
	}
}
