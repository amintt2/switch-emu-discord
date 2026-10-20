package main

// Agent : l'état de l'application (compte lié, connexion au serveur, partie, jeux) et la connexion de
// contrôle avec le serveur. La fenêtre et l'icône (ui.go) ne font que lire cet état et appeler ses méthodes.

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

type Agent struct {
	mu         sync.Mutex
	chemin     string // fichier de configuration
	cfg        Config
	exeCapteur string
	bus        busManettes

	connecte  bool
	derniere  string // dernière erreur de connexion, pour l'affichage
	salle     string // partie hébergée en ce moment
	jeux      []jeu
	enCours   *exec.Cmd
	jeuActuel string
	jumelage  string // code de jumelage en cours (affiché dans la fenêtre)

	majDispo *versionPubliee
	majEtat  string
	envoyer  func(any) // canal de contrôle courant (nil si déconnecté)
	relancer chan struct{}
	quitter  func()
}

func nouvelAgent(chemin string, cfg Config, exeCapteur string, bus busManettes) *Agent {
	a := &Agent{chemin: chemin, cfg: cfg, exeCapteur: exeCapteur, bus: bus, relancer: make(chan struct{}, 1)}
	if a.cfg.Ryujinx == "" {
		a.cfg.Ryujinx = detecterRyujinx()
	}
	a.jeux = scannerJeux(a.cfg.DossiersJeux)
	return a
}

func (a *Agent) config() Config {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.cfg
}

// modifier change la configuration, l'enregistre, et relance ce qui en dépend.
func (a *Agent) modifier(f func(*Config)) error {
	a.mu.Lock()
	avant := a.cfg
	f(&a.cfg)
	cfg := a.cfg
	a.mu.Unlock()
	if err := cfg.enregistrer(a.chemin); err != nil {
		return err
	}
	if strings.Join(avant.DossiersJeux, "|") != strings.Join(cfg.DossiersJeux, "|") {
		a.rescannerJeux()
	}
	if avant.Jeton != cfg.Jeton || avant.Serveur != cfg.Serveur {
		a.signalerRelance()
	}
	return nil
}

func (a *Agent) signalerRelance() {
	select {
	case a.relancer <- struct{}{}:
	default:
	}
}

func (a *Agent) rescannerJeux() {
	jeux := scannerJeux(a.config().DossiersJeux)
	a.mu.Lock()
	a.jeux = jeux
	envoyer := a.envoyer
	a.mu.Unlock()
	if envoyer != nil {
		envoyer(map[string]any{"type": "jeux", "jeux": jeux})
	}
	log.Printf("%d jeu(x) trouvé(s)", len(jeux))
}

// --- Jumelage par le navigateur : l'agent demande un code, ouvre la page de connexion Discord du serveur,
// et attend que l'utilisateur ait confirmé.

func (a *Agent) jumelerParNavigateur(ouvrir func(url string)) {
	cfg := a.config()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 11*time.Minute)
		defer cancel()
		jeton, nom, err := jumeler(ctx, cfg.Serveur, func(code string) {
			a.mu.Lock()
			a.jumelage = code
			a.mu.Unlock()
			ouvrir(strings.TrimRight(cfg.Serveur, "/") + "/lier.html?code=" + code)
		})
		a.mu.Lock()
		a.jumelage = ""
		a.mu.Unlock()
		if err != nil {
			a.mu.Lock()
			a.derniere = "Jumelage : " + err.Error()
			a.mu.Unlock()
			return
		}
		a.modifier(func(c *Config) { c.Jeton, c.Nom = jeton, nom })
		log.Printf("PC lié au compte Discord de %s", nom)
	}()
}

func (a *Agent) delier() error {
	return a.modifier(func(c *Config) { c.Jeton, c.Nom = "", "" })
}

// --- Jeux : lancer / fermer Ryubing (seulement un jeu de la liste, seulement Ryujinx.exe).

func (a *Agent) lancerJeu(id string) error {
	a.mu.Lock()
	var j *jeu
	for i := range a.jeux {
		if a.jeux[i].ID == id {
			j = &a.jeux[i]
		}
	}
	ryujinx := a.cfg.Ryujinx
	a.mu.Unlock()
	if j == nil {
		return errors.New("jeu inconnu")
	}
	a.fermerJeu()
	cmd, err := commandeJeu(ryujinx, *j)
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	a.mu.Lock()
	a.enCours, a.jeuActuel = cmd, j.ID
	envoyer := a.envoyer
	a.mu.Unlock()
	log.Printf("lancement de %s", j.Titre)
	if envoyer != nil {
		envoyer(map[string]any{"type": "jeu-en-cours", "jeu": j.ID})
	}
	go func() {
		cmd.Wait()
		a.mu.Lock()
		fini := a.enCours == cmd
		if fini {
			a.enCours, a.jeuActuel = nil, ""
		}
		envoyer := a.envoyer
		a.mu.Unlock()
		if fini && envoyer != nil {
			envoyer(map[string]any{"type": "jeu-en-cours", "jeu": ""})
		}
	}()
	return nil
}

func (a *Agent) fermerJeu() {
	a.mu.Lock()
	cmd := a.enCours
	a.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		cmd.Process.Kill()
	}
}

// --- Connexion de contrôle avec le serveur

// boucle garde la connexion ouverte tant qu'un compte est lié ; elle repart à chaque changement de compte.
func (a *Agent) boucle(ctx context.Context) {
	attente := time.Second
	for ctx.Err() == nil {
		cfg := a.config()
		if cfg.Jeton == "" {
			select {
			case <-ctx.Done():
				return
			case <-a.relancer:
				continue
			}
		}
		sctx, stop := context.WithCancel(ctx)
		go func() {
			select {
			case <-a.relancer:
				stop()
			case <-sctx.Done():
			}
		}()
		err := a.session(sctx, cfg)
		stop()
		a.mu.Lock()
		a.connecte, a.envoyer = false, nil
		if err != nil {
			a.derniere = err.Error()
		}
		a.mu.Unlock()
		if ctx.Err() != nil {
			return
		}
		if errors.Is(err, errNonJumele) {
			log.Printf("le serveur ne reconnaît plus ce PC : relie-le depuis la fenêtre de l'agent")
			a.delier()
			continue
		}
		if sctx.Err() != nil && err != nil && errors.Is(err, context.Canceled) {
			attente = time.Second // relance volontaire (compte changé)
			continue
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

func (a *Agent) session(ctx context.Context, cfg Config) error {
	h := http.Header{}
	h.Set("Authorization", "Bearer "+cfg.Jeton)
	c, _, err := websocket.Dial(ctx, urlWS(cfg.Serveur, "/api/agent"), &websocket.DialOptions{HTTPHeader: h})
	if err != nil {
		return err
	}
	defer c.CloseNow()
	c.SetReadLimit(256 << 10)

	var mu sync.Mutex
	envoyer := func(v any) {
		b, _ := json.Marshal(v)
		mu.Lock()
		defer mu.Unlock()
		wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		c.Write(wctx, websocket.MessageText, b)
	}
	jetons := make(chan ordreServeur, 4)
	deps := depsHebergement{
		exeCapteur: a.exeCapteur,
		capture:    cfg.Capture,
		bus:        a.bus,
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
		a.mu.Lock()
		a.salle = ""
		a.mu.Unlock()
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
			a.mu.Lock()
			a.connecte, a.envoyer, a.derniere = true, envoyer, ""
			jeux, actuel := a.jeux, a.jeuActuel
			a.mu.Unlock()
			envoyer(map[string]any{"type": "jeux", "jeux": jeux})
			envoyer(map[string]any{"type": "jeu-en-cours", "jeu": actuel})
			log.Printf("connecté au serveur (compte : %s)", o.Nom)
		case "heberger":
			if courant != nil {
				courant.arreter()
			}
			courant = demarrerHebergement(ctx, o, cfg, deps)
			a.mu.Lock()
			a.salle = o.Salle
			a.mu.Unlock()
		case "arreter":
			if courant != nil && courant.salle == o.Salle {
				courant.arreter()
				courant = nil
				a.mu.Lock()
				a.salle = ""
				a.mu.Unlock()
			}
		case "jeton":
			select {
			case jetons <- o:
			default:
			}
		case "places", "exclure":
			if courant != nil && courant.salle == o.Salle {
				courant.transmettre(o)
			}
		case "lancer":
			if err := a.lancerJeu(o.Jeu); err != nil {
				envoyer(map[string]string{"type": "etat", "salle": o.Salle, "erreur": err.Error()})
			}
		case "fermer-jeu":
			a.fermerJeu()
		default:
			log.Printf("ordre inconnu ignoré : %q", o.Type)
		}
	}
}

// etatUI est ce que montre la fenêtre de l'agent.
func (a *Agent) etatUI() map[string]any {
	a.mu.Lock()
	defer a.mu.Unlock()
	titreActuel := ""
	for _, j := range a.jeux {
		if j.ID == a.jeuActuel {
			titreActuel = j.Titre
		}
	}
	maj := map[string]any{"etat": a.majEtat}
	if a.majDispo != nil {
		maj["version"] = a.majDispo.m.Version
	}
	return map[string]any{
		"version":      version,
		"compte":       a.cfg.Nom,
		"lie":          a.cfg.Jeton != "",
		"connecte":     a.connecte,
		"erreur":       a.derniere,
		"jumelage":     a.jumelage,
		"heberge":      a.salle != "",
		"jeuEnCours":   titreActuel,
		"ryujinx":      a.cfg.Ryujinx,
		"dossiersJeux": a.cfg.DossiersJeux,
		"jeux":         a.jeux,
		"vigem":        a.bus != nil,
		"demarrage":    demarrageWindows(),
		"installe":     estInstalle(),
		"maj":          maj,
		"serveur":      a.cfg.Serveur,
	}
}
