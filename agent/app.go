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

	// La partie hébergée vit en dehors de la connexion au serveur : la vidéo passe par les relais,
	// une coupure avec le serveur ne l'arrête pas.
	courant   *hebergement
	jetons    chan ordreServeur // réponses du serveur aux demandes de jeton de relais
	horsLigne time.Time         // depuis quand le serveur est injoignable (zéro si connecté)
}

// sansServeurMax : sans nouvelles du serveur depuis ce temps, la partie s'arrête.
const sansServeurMax = 10 * time.Minute

func nouvelAgent(chemin string, cfg Config, exeCapteur string, bus busManettes) *Agent {
	a := &Agent{chemin: chemin, cfg: cfg, exeCapteur: exeCapteur, bus: bus, relancer: make(chan struct{}, 1), jetons: make(chan ordreServeur, 4)}
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
		a.arreterHebergement("")
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
	ryujinx, manuel := a.cfg.Ryujinx, a.cfg.RyubingManuel
	a.mu.Unlock()
	if j == nil {
		return errors.New("jeu inconnu")
	}
	a.fermerJeu()
	// Ryubing doit être fermé pour qu'on relie ses manettes (sinon il réécrirait son fichier).
	for i := 0; i < 30 && ryubingOuvert(); i++ {
		time.Sleep(100 * time.Millisecond)
	}
	if !manuel {
		if err := configurerRyubing(ryujinx); err != nil {
			log.Printf("manettes de Ryubing : %v", err)
		} else {
			log.Printf("manettes de Ryubing : Player2 à Player4 reliés aux manettes de J2 à J4")
		}
	}
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
	defer a.arreterHebergement("")
	go a.surveillerHorsLigne(ctx)
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
		debut := time.Now()
		err := a.session(sctx, ctx, cfg)
		stop()
		a.mu.Lock()
		a.connecte, a.envoyer = false, nil
		if a.horsLigne.IsZero() {
			a.horsLigne = time.Now()
		}
		if err != nil {
			a.derniere = err.Error()
		}
		a.mu.Unlock()
		if time.Since(debut) > 30*time.Second {
			attente = time.Second // la connexion avait tenu : on revient vite
		}
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
		log.Printf("connexion au serveur perdue (%v), nouvel essai dans %s", err, attente)
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

// surveillerHorsLigne arrête la partie si le serveur reste injoignable trop longtemps.
func (a *Agent) surveillerHorsLigne(ctx context.Context) {
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			a.mu.Lock()
			trop := !a.horsLigne.IsZero() && time.Since(a.horsLigne) > sansServeurMax && a.courant != nil
			a.mu.Unlock()
			if trop {
				log.Printf("serveur injoignable depuis %s : la partie s'arrête", sansServeurMax)
				a.arreterHebergement("")
			}
		}
	}
}

// deps sont les services du serveur dont la partie a besoin, quelle que soit la connexion du moment.
func (a *Agent) deps() depsHebergement {
	envoyer := func(v any) bool {
		a.mu.Lock()
		e := a.envoyer
		a.mu.Unlock()
		if e != nil {
			e(v)
		}
		return e != nil
	}
	return depsHebergement{
		exeCapteur: a.exeCapteur,
		capture:    a.config().Capture,
		bus:        a.bus,
		jetonFrais: func(jctx context.Context, salle string) (string, error) {
			for len(a.jetons) > 0 { // réponses en retard d'une demande précédente
				<-a.jetons
			}
			if !envoyer(map[string]string{"type": "jeton", "salle": salle}) {
				return "", errors.New("serveur injoignable")
			}
			select {
			case o := <-a.jetons:
				return o.Jeton, nil
			case <-time.After(5 * time.Second):
				return "", errors.New("pas de jeton du serveur")
			case <-jctx.Done():
				return "", jctx.Err()
			}
		},
		signalerErr: func(salle, texte string) { envoyer(map[string]string{"type": "etat", "salle": salle, "erreur": texte}) },
		diag: func(quoi string, v map[string]any) {
			v["type"], v["quoi"] = "diag", quoi
			envoyer(v)
		},
		manettes: func(salle string, places []int) {
			envoyer(map[string]any{"type": "manettes", "salle": salle, "places": places})
		},
	}
}

func (a *Agent) heberger(ctx context.Context, o ordreServeur, cfg Config) {
	a.arreterHebergement("")
	h := demarrerHebergement(ctx, o, cfg, a.deps())
	a.mu.Lock()
	a.courant, a.salle = h, o.Salle
	a.mu.Unlock()
}

// arreterHebergement arrête la partie (seulement celle de cette salle si salle n'est pas vide).
func (a *Agent) arreterHebergement(salle string) {
	a.mu.Lock()
	h := a.courant
	if h == nil || (salle != "" && h.salle != salle) {
		a.mu.Unlock()
		return
	}
	a.courant, a.salle = nil, ""
	a.mu.Unlock()
	h.arreter()
}

func (a *Agent) partie() *hebergement {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.courant
}

var errNonJumele = errors.New("agent non jumelé")

func (a *Agent) session(ctx, partieCtx context.Context, cfg Config) error {
	h := http.Header{}
	h.Set("Authorization", "Bearer "+cfg.Jeton)
	h.Set("X-Agent-Version", version)
	dctx, annuler := context.WithTimeout(ctx, 15*time.Second)
	c, _, err := websocket.Dial(dctx, urlWS(cfg.Serveur, "/api/agent"), &websocket.DialOptions{HTTPHeader: h})
	annuler()
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

	// Ping toutes les 15 s : une connexion morte (Wi-Fi, box) est repérée en moins de 30 s.
	go func() {
		t := time.NewTicker(15 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				pctx, fin := context.WithTimeout(ctx, 10*time.Second)
				err := c.Ping(pctx)
				fin()
				if err != nil && ctx.Err() == nil {
					log.Printf("le serveur ne répond plus au ping : reconnexion")
					c.Close(websocket.StatusGoingAway, "ping sans réponse")
					return
				}
			}
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
			a.mu.Lock()
			a.connecte, a.envoyer, a.derniere, a.horsLigne = true, envoyer, "", time.Time{}
			jeux, actuel, salle := a.jeux, a.jeuActuel, a.salle
			a.mu.Unlock()
			envoyer(map[string]any{"type": "jeux", "jeux": jeux})
			envoyer(map[string]any{"type": "jeu-en-cours", "jeu": actuel})
			if salle != "" {
				// Reconnexion pendant une partie : le serveur reprend là où on en était.
				envoyer(map[string]any{"type": "heberge", "salle": salle})
				if p := a.partie(); p != nil {
					envoyer(map[string]any{"type": "manettes", "salle": salle, "places": p.placesBranchees()})
				}
			}
			log.Printf("connecté au serveur (compte : %s)", o.Nom)
		case "heberger":
			// La partie dépend de l'agent, pas de cette connexion (elle survit à une reconnexion).
			a.heberger(partieCtx, o, cfg)
		case "arreter":
			a.arreterHebergement(o.Salle)
		case "jeton":
			select {
			case a.jetons <- o:
			default:
			}
		case "places", "exclure":
			if p := a.partie(); p != nil && p.salle == o.Salle {
				p.transmettre(o)
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
	var manettes []infoManette
	if a.courant != nil {
		manettes = a.courant.etatManettes()
	}
	return map[string]any{
		"manettes":      manettes,
		"ryubingManuel": a.cfg.RyubingManuel,
		"version":       version,
		"compte":        a.cfg.Nom,
		"lie":           a.cfg.Jeton != "",
		"connecte":      a.connecte,
		"erreur":        a.derniere,
		"jumelage":      a.jumelage,
		"heberge":       a.salle != "",
		"jeuEnCours":    titreActuel,
		"ryujinx":       a.cfg.Ryujinx,
		"dossiersJeux":  a.cfg.DossiersJeux,
		"jeux":          a.jeux,
		"vigem":         a.bus != nil,
		"demarrage":     demarrageWindows(),
		"installe":      estInstalle(),
		"maj":           maj,
		"serveur":       a.cfg.Serveur,
	}
}
