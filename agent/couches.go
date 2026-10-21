package main

// Couches vidéo : la même image en deux qualités, chaque ami reçoit celle que permet sa connexion.
//   haute : 1080p (réglage de capture, ~12 Mbit/s), toujours encodée ;
//   basse : 720p ~5 Mbit/s, encodée seulement quand un ami la regarde.
// Chaque couche est un capteur à part (Windows accepte plusieurs captures de l'écran à la fois),
// relancé s'il s'arrête. Le relais envoie la couche q aux amis qui l'ont choisie (destination destCouche+q).

import (
	"context"
	"log"
	"sync"
	"time"
)

const (
	coucheHaute = 0
	coucheBasse = 1
	nbCouches   = 2

	destCouche = 0xFFFFFF00 // + couche : tous les amis de cette couche (le relais trie)

	kbpsBasse         = 5000
	arretBasseApres   = 30 * time.Second // couche basse arrêtée quand plus personne ne la regarde
	relancesMaxParMin = 4
)

// captureCouche : réglages du capteur d'une couche.
func captureCouche(base Capture, q int) Capture {
	if q == coucheBasse {
		c := base
		c.Largeur, c.Hauteur, c.Kbps = 1280, 720, kbpsBasse
		return c
	}
	return base
}

type imageCouche struct {
	q   int
	img image
}

type couche struct {
	q       int
	capture Capture
	exe     string

	mu      sync.Mutex
	k       *capteur
	cles    int // images clés des capteurs précédents (relancés)
	cancel  context.CancelFunc
	finie   chan struct{}
	inutile time.Time // depuis quand personne ne la regarde (couche basse)
}

func (c *couche) demanderIDR() {
	c.mu.Lock()
	k := c.k
	c.mu.Unlock()
	if k != nil {
		k.demanderIDR()
	}
}

func (c *couche) imagesCles() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.k != nil {
		return c.cles + c.k.imagesCles()
	}
	return c.cles
}

func (c *couche) enMarche() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.cancel != nil
}

// demarrer lance le capteur de la couche (s'il ne tourne pas déjà). echec est appelé si le capteur
// s'arrête trop souvent : la couche abandonne.
func (c *couche) demarrer(parent context.Context, sortie chan<- imageCouche, echec func()) {
	c.mu.Lock()
	if c.cancel != nil {
		c.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(parent)
	c.cancel, c.finie, c.inutile = cancel, make(chan struct{}), time.Time{}
	finie := c.finie
	c.mu.Unlock()
	go func() {
		defer close(finie)
		if !c.tourner(ctx, sortie) && ctx.Err() == nil {
			echec()
		}
		c.mu.Lock()
		c.cancel = nil
		c.mu.Unlock()
	}()
}

// arreter arrête le capteur de la couche et attend sa fin.
func (c *couche) arreter() {
	c.mu.Lock()
	cancel, finie := c.cancel, c.finie
	c.mu.Unlock()
	if cancel != nil {
		cancel()
		<-finie
	}
}

// tourner fait tourner le capteur et le relance s'il s'arrête. Renvoie false s'il s'arrête trop souvent.
func (c *couche) tourner(ctx context.Context, sortie chan<- imageCouche) bool {
	var relances []time.Time
	for ctx.Err() == nil {
		k, err := lancerCapteur(ctx, c.exe, c.capture)
		if err != nil {
			log.Printf("couche %d : %v", c.q, err)
		} else {
			c.mu.Lock()
			c.k = k
			c.mu.Unlock()
			for img := range k.images {
				select {
				case sortie <- imageCouche{c.q, img}:
				case <-ctx.Done():
				}
			}
			k.arreter()
			c.mu.Lock()
			c.cles += k.imagesCles()
			c.k = nil
			c.mu.Unlock()
		}
		if ctx.Err() != nil {
			return true
		}
		// Le capteur s'est arrêté (pilote, changement d'écran…) : on le relance, mais pas sans fin.
		maintenant := time.Now()
		var recentes []time.Time
		for _, t := range relances {
			if maintenant.Sub(t) < time.Minute {
				recentes = append(recentes, t)
			}
		}
		relances = append(recentes, maintenant)
		if len(relances) > relancesMaxParMin {
			log.Printf("couche %d : le capteur s'arrête sans cesse, abandon", c.q)
			return false
		}
		log.Printf("couche %d : le capteur s'est arrêté, relance", c.q)
		select {
		case <-ctx.Done():
			return true
		case <-time.After(time.Second):
		}
	}
	return true
}
