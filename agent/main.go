// Agent Switch EMU : tourne sur le PC de l'hôte. Il se connecte EN SORTANT au serveur (aucun port à
// ouvrir), et quand l'hôte clique « Héberger » dans l'Activité, il capture l'écran et l'envoie au relais.
//
//	agent.exe [-serveur https://switch.mciut.fr] [-capteur chemin\capteur.exe] [-dejumeler]
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"time"

	"github.com/coder/websocket"
)

var version = "dev"

func main() {
	chemin := flag.String("config", cheminConfig(), "fichier de configuration")
	serveur := flag.String("serveur", "", "adresse du serveur (remplace celle de la configuration)")
	exeCapteur := flag.String("capteur", "", "chemin de capteur.exe (par défaut : à côté de l'agent)")
	dejumeler := flag.Bool("dejumeler", false, "oublie le compte lié et redemande un code")
	dev := flag.Bool("dev", false, "essais en local : accepte un relais en ws://localhost")
	flag.Parse()
	log.SetFlags(log.Ltime)

	cfg, err := chargerConfig(*chemin)
	if err != nil {
		log.Fatalf("configuration illisible (%s) : %v", *chemin, err)
	}
	if *serveur != "" {
		cfg.Serveur = *serveur
	}
	cfg.dev = *dev
	if *dejumeler {
		cfg.Jeton, cfg.Nom = "", ""
	}
	if *exeCapteur == "" {
		self, _ := os.Executable()
		*exeCapteur = filepath.Join(filepath.Dir(self), "capteur.exe")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	fmt.Printf("Switch EMU — agent %s\n", version)
	if cfg.Jeton == "" {
		var jeton, nom string
		for {
			jeton, nom, err = jumeler(ctx, cfg.Serveur, func(code string) {
				fmt.Printf("\n  Code de jumelage :  %s\n\n", code)
				fmt.Println("  Dans Discord, ouvre l'Activité Switch EMU, clique « Lier mon PC » et tape ce code.")
				fmt.Println("  (il est valable 10 minutes ; un nouveau code s'affichera ensuite)")
			})
			if err == nil || ctx.Err() != nil {
				break
			}
			log.Printf("%v — nouveau code dans 5 s", err)
			time.Sleep(5 * time.Second)
		}
		if err != nil {
			log.Fatal(err)
		}
		cfg.Jeton, cfg.Nom = jeton, nom
		if err := cfg.enregistrer(*chemin); err != nil {
			log.Fatalf("impossible d'enregistrer la configuration : %v", err)
		}
		fmt.Printf("PC lié au compte Discord de %s.\n", nom)
	}
	controler(ctx, cfg, *chemin, *exeCapteur)
}

// controler garde la connexion de contrôle ouverte et exécute les ordres connus du serveur.
func controler(ctx context.Context, cfg Config, chemin, exeCapteur string) {
	attente := time.Second
	for ctx.Err() == nil {
		err := sessionControle(ctx, cfg, exeCapteur)
		if errors.Is(err, errNonJumele) {
			log.Printf("le serveur ne reconnaît plus ce PC : relance l'agent avec -dejumeler pour obtenir un nouveau code")
			return
		}
		if ctx.Err() != nil {
			return
		}
		log.Printf("serveur injoignable (%v), nouvel essai dans %s", err, attente)
		select {
		case <-ctx.Done():
			return
		case <-time.After(attente):
		}
		if attente < 30*time.Second {
			attente *= 2
		}
	}
}

var errNonJumele = errors.New("agent non jumelé")

func sessionControle(ctx context.Context, cfg Config, exeCapteur string) error {
	h := http.Header{}
	h.Set("Authorization", "Bearer "+cfg.Jeton)
	c, _, err := websocket.Dial(ctx, urlWS(cfg.Serveur, "/api/agent"), &websocket.DialOptions{HTTPHeader: h})
	if err != nil {
		return err
	}
	defer c.CloseNow()
	c.SetReadLimit(64 << 10)

	var mu sync.Mutex
	envoyer := func(v any) {
		b, _ := json.Marshal(v)
		mu.Lock()
		defer mu.Unlock()
		wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		c.Write(wctx, websocket.MessageText, b)
	}
	// Réponses aux demandes de jeton (reconnexion à un relais).
	jetons := make(chan ordreServeur, 4)
	deps := depsHebergement{
		exeCapteur: exeCapteur,
		capture:    cfg.Capture,
		jetonFrais: func(jctx context.Context, salle string) (string, error) {
			envoyer(map[string]string{"type": "jeton", "salle": salle})
			select {
			case o := <-jetons:
				return o.Jeton, nil
			case <-time.After(10 * time.Second):
				return "", errors.New("pas de jeton du serveur")
			case <-jctx.Done():
				return "", jctx.Err()
			}
		},
		signalerErr: func(salle, texte string) { envoyer(map[string]string{"type": "etat", "salle": salle, "erreur": texte}) },
	}
	var courant *hebergement
	defer func() {
		if courant != nil {
			courant.arreter()
		}
	}()

	for {
		_, b, err := c.Read(ctx)
		if err != nil {
			if websocket.CloseStatus(err) == 4001 {
				return errNonJumele
			}
			return err
		}
		var o ordreServeur
		if json.Unmarshal(b, &o) != nil {
			continue
		}
		switch o.Type {
		case "bienvenue":
			log.Printf("connecté au serveur (compte : %s). En attente : clique « Héberger » dans l'Activité.", o.Nom)
		case "heberger":
			if courant != nil {
				courant.arreter()
			}
			courant = demarrerHebergement(ctx, o, cfg, deps)
		case "arreter":
			if courant != nil && courant.salle == o.Salle {
				courant.arreter()
				courant = nil
			}
		case "jeton":
			select {
			case jetons <- o:
			default:
			}
		default:
			log.Printf("ordre inconnu ignoré : %q", o.Type)
		}
	}
}
