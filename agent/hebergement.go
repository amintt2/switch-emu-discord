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

	mu    sync.Mutex
	man   *manettes
	noms  map[string]string // uid -> pseudo Discord
	place map[int]string    // place -> dernier joueur (même déconnecté)
}

// infoManette : une ligne de la fenêtre de l'agent (« J2 : Bob, manette branchée »).
type infoManette struct {
	Place    int    `json:"place"`
	Nom      string `json:"nom"`
	Branchee bool   `json:"branchee"`
}

func (h *hebergement) etatManettes() []infoManette {
	h.mu.Lock()
	m := h.man
	noms, place := map[string]string{}, map[int]string{}
	for k, v := range h.noms {
		noms[k] = v
	}
	for k, v := range h.place {
		place[k] = v
	}
	h.mu.Unlock()
	if m == nil {
		return nil
	}
	branchees := map[int]bool{}
	for _, p := range m.branchees() {
		branchees[p] = true
	}
	var r []infoManette
	for p := 1; p <= nbPlaces; p++ {
		if uid := place[p]; uid != "" || branchees[p] {
			r = append(r, infoManette{Place: p, Nom: noms[uid], Branchee: branchees[p]})
		}
	}
	return r
}

// placesBranchees : pour le serveur (l'Activité montre quelles manettes sont prêtes).
func (h *hebergement) placesBranchees() []int {
	h.mu.Lock()
	m := h.man
	h.mu.Unlock()
	if m == nil {
		return []int{}
	}
	return append([]int{}, m.branchees()...)
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
	son         chan []byte // son du jeu (file à part : il ne retarde pas les images)
	texte       chan []byte
	jetees      atomic.Int32 // images jetées parce que l'envoi ne suivait pas
	reconnexion atomic.Int32
	parCouche   [nbCouches]atomic.Int32 // amis de ce relais par couche vidéo

	muAmis sync.Mutex
	idsDe  map[string]map[uint32]bool // uid Discord -> connexions sur ce relais (pour lui écrire à lui seul)
}

// versJoueur envoie un message aux connexions d'un joueur sur ce relais (vibration de sa manette).
func (l *lienRelais) versJoueur(uid string, v map[string]any) {
	l.muAmis.Lock()
	ids := make([]uint32, 0, len(l.idsDe[uid]))
	for id := range l.idsDe[uid] {
		ids = append(ids, id)
	}
	l.muAmis.Unlock()
	for _, id := range ids {
		v["a"] = id
		b, _ := json.Marshal(v)
		select {
		case l.texte <- b:
		default:
		}
	}
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
	manettes    func(salle string, places []int)    // manettes virtuelles branchées (montrées dans l'Activité)
	bus         busManettes                         // nil si ViGEmBus n'est pas installé
}

func demarrerHebergement(parent context.Context, o ordreServeur, cfg Config, d depsHebergement) *hebergement {
	ctx, cancel := context.WithCancel(parent)
	h := &hebergement{salle: o.Salle, cancel: cancel, fini: make(chan struct{}), ordres: make(chan ordreServeur, 16), noms: map[string]string{}, place: map[int]string{}}
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

// diffusion : ce que les liens avec les relais partagent pendant une partie.
type diffusion struct {
	couches [nbCouches]*couche
	man     *manettes
	besoin  chan struct{}   // un ami a choisi une couche : vérifier qu'elle tourne
	offres  chan demandeP2P // offres de connexion directe (hors Discord), traitées par la boucle de la partie
}

// demandeP2P : un ami propose une connexion directe ; l'uid vient du relais.
type demandeP2P struct {
	uid, sdp string
	couche   int
	repondre func(sdp string)
}

type resultatP2P struct {
	uid string
	id  int
	p   *lienP2P // nil si la négociation a échoué
}

const (
	negociationsMax = 3               // en même temps, tous amis confondus
	entreOffres     = 5 * time.Second // par personne
)

func (d *diffusion) demanderIDR(q int) {
	if q >= 0 && q < nbCouches {
		d.couches[q].demanderIDR()
	}
}

func (d *diffusion) signalerBesoin() {
	select {
	case d.besoin <- struct{}{}:
	default:
	}
}

func (h *hebergement) tourner(ctx context.Context, o ordreServeur, cfg Config, d depsHebergement) {
	log.Printf("hébergement de la salle %s : démarrage", o.Salle)
	ctx, annuler := context.WithCancel(ctx)
	defer annuler()

	sortie := make(chan imageCouche, 8)
	diff := &diffusion{besoin: make(chan struct{}, 1), offres: make(chan demandeP2P, 4)}
	resultats := make(chan resultatP2P, negociationsMax)
	for q := 0; q < nbCouches; q++ {
		diff.couches[q] = &couche{q: q, capture: captureCouche(d.capture, q), exe: d.exeCapteur}
	}
	echecHaute := make(chan struct{})
	var unEchec sync.Once
	diff.couches[coucheHaute].demarrer(ctx, sortie, func() { unEchec.Do(func() { close(echecHaute) }) })
	defer func() {
		for _, c := range diff.couches {
			c.arreter()
		}
	}()

	m := nouvellesManettes(d.bus)
	defer m.fermer()
	diff.man = m
	var liens []*lienRelais
	// Le jeu fait vibrer la manette d'une place : on le dit au joueur assis là (sa manette ou son téléphone).
	m.surVibration = func(p int, fort, faible uint8) {
		uid := m.occupant(p)
		if uid == "" {
			return
		}
		for _, l := range liens {
			l.versJoueur(uid, map[string]any{"type": "vibration", "f": fort, "l": faible})
		}
	}
	h.mu.Lock()
	h.man = m
	h.mu.Unlock()
	signalerManettes := func() { d.manettes(o.Salle, h.placesBranchees()) }
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

	var wg sync.WaitGroup
	defer func() {
		annuler()
		wg.Wait() // liens et négociations s'arrêtent avant les manettes et les capteurs
		for len(resultats) > 0 {
			if r := <-resultats; r.p != nil {
				r.p.fermer() // connexion directe ouverte au dernier moment : personne ne l'a prise
			}
		}
	}()
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
		l := &lienRelais{url: u, file: make(chan []byte, 3), son: make(chan []byte, 16), texte: make(chan []byte, 64)}
		liens = append(liens, l)
		wg.Add(1)
		go func() { defer wg.Done(); l.maintenir(ctx, jeton, diff) }()
	}
	if len(liens) == 0 {
		d.signalerErr(o.Salle, "aucun relais autorisé")
		return
	}

	// Amis en direct (P2P) : la vidéo et le son leur sont envoyés sans passer par le relais.
	directs := map[*lienP2P]bool{}
	finDirect := make(chan *lienP2P, 8)
	negociations := map[string]context.CancelFunc{} // uid -> négociation en cours
	idNego := map[string]int{}
	derniereOffre := map[string]time.Time{}
	exclus := map[string]bool{}
	numeroNego := 0
	defer func() {
		for p := range directs {
			p.fermer()
		}
	}()

	// regardee : combien d'amis (relais et P2P) regardent la couche q.
	regardee := func(q int) int32 {
		var n int32
		for _, l := range liens {
			n += l.parCouche[q].Load()
		}
		for p := range directs {
			if int(p.couche.Load()) == q {
				n++
			}
		}
		return n
	}

	// Son du jeu (Ryubing seul), envoyé à tous les amis.
	sons := make(chan []byte, 16)
	wg.Add(1)
	go func() { defer wg.Done(); suivreSon(ctx, exeSon(d.exeCapteur), sons) }()

	envoyees, debut := 0, time.Now()
	mesure := time.NewTicker(time.Minute)
	defer mesure.Stop()
	entretien := time.NewTicker(5 * time.Second)
	defer entretien.Stop()
	dernieres := 0
	var clesAvant [nbCouches]int
	for {
		select {
		case <-echecHaute:
			d.signalerErr(o.Salle, "le capteur s'est arrêté")
			log.Printf("hébergement de la salle %s : arrêt (capture impossible)", o.Salle)
			return
		case dm := <-diff.offres:
			// Une négociation à la fois par personne, une offre toutes les 5 s au plus, 3 en tout.
			if exclus[dm.uid] || negociations[dm.uid] != nil || len(negociations) >= negociationsMax || time.Since(derniereOffre[dm.uid]) < entreOffres {
				continue
			}
			derniereOffre[dm.uid] = time.Now()
			nctx, annulerNego := context.WithCancel(ctx)
			numeroNego++
			id := numeroNego
			negociations[dm.uid], idNego[dm.uid] = annulerNego, id
			wg.Add(1)
			go func() {
				defer wg.Done()
				p, err := accepterP2P(nctx, dm.sdp, dm.uid, dm.repondre, func(p *lienP2P, b []byte) { messageP2P(p, b, diff) })
				if err != nil {
					if nctx.Err() == nil {
						log.Printf("P2P : %v", err)
					}
					p = nil
				} else {
					p.couche.Store(int32(dm.couche))
				}
				select {
				case resultats <- resultatP2P{dm.uid, id, p}:
				default:
					if p != nil {
						p.fermer()
					}
				}
			}()
		case r := <-resultats:
			if idNego[r.uid] == r.id {
				negociations[r.uid]()
				delete(negociations, r.uid)
				delete(idNego, r.uid)
			} else if r.p != nil {
				r.p.fermer() // négociation annulée (personne retirée) entre-temps
				continue
			}
			if r.p == nil {
				continue
			}
			p := r.p
			// Revérifié ici : retiré pendant la négociation = pas de connexion directe.
			if exclus[p.uid] {
				p.fermer()
				continue
			}
			// Un seul lien direct par personne, et pas plus de maxP2P en tout.
			for autre := range directs {
				if autre.uid == p.uid {
					autre.fermer()
				}
			}
			if len(directs) >= maxP2P {
				p.fermer()
				continue
			}
			directs[p] = true
			go func() {
				select {
				case <-p.fini:
					select {
					case finDirect <- p:
					case <-ctx.Done():
					}
				case <-ctx.Done():
				}
			}()
			diff.demanderIDR(int(p.couche.Load()))
		case p := <-finDirect:
			delete(directs, p)
		case <-diff.besoin:
			if regardee(coucheBasse) > 0 {
				diff.couches[coucheBasse].demarrer(ctx, sortie, func() { log.Printf("couche 720p abandonnée") })
			}
		case <-entretien.C:
			// La couche basse ne tourne que si quelqu'un la regarde.
			b := diff.couches[coucheBasse]
			if b.enMarche() {
				b.mu.Lock()
				if regardee(coucheBasse) > 0 {
					b.inutile = time.Time{}
				} else if b.inutile.IsZero() {
					b.inutile = time.Now()
				}
				arreter := !b.inutile.IsZero() && time.Since(b.inutile) > arretBasseApres
				b.mu.Unlock()
				if arreter {
					log.Printf("couche 720p : plus personne ne la regarde, arrêt")
					b.arreter()
				}
			}
		case <-mesure.C:
			v := map[string]any{"ips": float64(envoyees-dernieres) / 60}
			for q, c := range diff.couches {
				v[fmt.Sprintf("cles%d", q)] = c.imagesCles() - clesAvant[q]
				v[fmt.Sprintf("couche%d", q)] = regardee(q)
				clesAvant[q] = c.imagesCles()
			}
			for i, l := range liens {
				v[fmt.Sprintf("amis%d", i)] = l.amis.Load()
				v[fmt.Sprintf("jetees%d", i)] = l.jetees.Swap(0)
				v[fmt.Sprintf("reco%d", i)] = l.reconnexion.Swap(0)
			}
			dernieres = envoyees
			d.diag("hebergement", v)
		case <-ctx.Done():
			log.Printf("hébergement de la salle %s : arrêt", o.Salle)
			return
		case o := <-h.ordres:
			switch o.Type {
			case "places":
				m.definirPlaces(o.Places)
				h.mu.Lock()
				for uid, nom := range o.Noms {
					h.noms[uid] = nom
				}
				for uid, p := range o.Places {
					if p >= 1 && p <= nbPlaces {
						h.place[p] = uid
					}
				}
				h.mu.Unlock()
				signalerManettes()
				log.Printf("places : %d joueur(s) à distance", len(o.Places))
			case "exclure":
				m.retirer(o.UID)
				h.mu.Lock()
				for p, uid := range h.place {
					if uid == o.UID {
						delete(h.place, p)
					}
				}
				h.mu.Unlock()
				signalerManettes()
				exclus[o.UID] = true
				if annulerNego := negociations[o.UID]; annulerNego != nil {
					annulerNego()
					delete(negociations, o.UID)
					delete(idNego, o.UID)
				}
				for p := range directs {
					if p.uid == o.UID {
						p.fermer()
					}
				}
				// Le relais coupe la connexion de la personne retirée.
				b, _ := json.Marshal(map[string]string{"type": "exclure", "uid": o.UID})
				for _, l := range liens {
					select {
					case l.texte <- b:
					default:
					}
				}
			}
		case pcm := <-sons:
			var paquet []byte
			if len(directs) > 0 {
				paquet = encoderSon(time.Now(), pcm)
				for p := range directs {
					p.envoyer(paquet[4:], false, true)
				}
			}
			for _, l := range liens {
				if l.amis.Load() == 0 {
					continue
				}
				if paquet == nil {
					paquet = encoderSon(time.Now(), pcm)
				}
				select {
				case l.son <- paquet:
				default: // un trou dans le son plutôt que du retard
				}
			}
		case ic := <-sortie:
			q := ic.q
			var paquetTous, paquetCouche []byte
			for _, l := range liens {
				n := l.parCouche[q].Load()
				if n == 0 {
					continue
				}
				// Tous les amis de ce relais regardent cette couche : envoi à tous (marche aussi avec un
				// ancien relais) ; sinon, le relais trie par couche.
				var p []byte
				if n == l.amis.Load() {
					if paquetTous == nil {
						paquetTous = encoderImage(0, ic.img.cle, uint8(q), ic.img.capture, ic.img.au)
					}
					p = paquetTous
				} else {
					if paquetCouche == nil {
						paquetCouche = encoderImage(destCouche+uint32(q), ic.img.cle, uint8(q), ic.img.capture, ic.img.au)
					}
					p = paquetCouche
				}
				select {
				case l.file <- p:
				default:
					l.jetees.Add(1)
					diff.demanderIDR(q) // ce relais ne suit pas : on saute jusqu'à la prochaine image clé
				}
			}
			var direct []byte
			for p := range directs {
				if int(p.couche.Load()) != q {
					continue
				}
				if direct == nil {
					direct = encoderImage(0, ic.img.cle, uint8(q), ic.img.capture, ic.img.au)[4:]
				}
				if !p.envoyer(direct, ic.img.cle, false) {
					diff.demanderIDR(q)
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
func (l *lienRelais) maintenir(ctx context.Context, jeton func(context.Context) (string, error), diff *diffusion) {
	attente := 300 * time.Millisecond
	for ctx.Err() == nil {
		debut := time.Now()
		j, err := jeton(ctx)
		if err == nil {
			err = l.session(ctx, j, diff)
		}
		l.amis.Store(0)
		for q := range l.parCouche {
			l.parCouche[q].Store(0)
		}
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

func (l *lienRelais) session(ctx context.Context, jeton string, diff *diffusion) error {
	man := diff.man
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
			case b := <-l.son:
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
	amis := map[uint32]int{}    // ami -> couche regardée
	pauses := map[uint32]bool{} // amis qui reçoivent la vidéo en direct (P2P) : rien par le relais
	uidDe := map[uint32]string{}
	defer func() {
		l.muAmis.Lock()
		l.idsDe = nil
		l.muAmis.Unlock()
	}()
	suivre := func(id uint32, uid string, present bool) {
		l.muAmis.Lock()
		defer l.muAmis.Unlock()
		if l.idsDe == nil {
			l.idsDe = map[string]map[uint32]bool{}
		}
		if present {
			uidDe[id] = uid
			if l.idsDe[uid] == nil {
				l.idsDe[uid] = map[uint32]bool{}
			}
			l.idsDe[uid][id] = true
			return
		}
		uid = uidDe[id]
		delete(uidDe, id)
		delete(l.idsDe[uid], id)
	}
	compter := func() {
		var n [nbCouches]int32
		for id, q := range amis {
			if !pauses[id] {
				n[q]++
			}
		}
		for q := range n {
			l.parCouche[q].Store(n[q])
		}
		l.amis.Store(int32(len(amis)))
	}
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
			// Le relais rejoue l'état de chacun quand l'hôte se reconnecte : sa couche et sa pause.
			amis[msg.De] = coucheHaute
			if msg.Q > 0 && msg.Q < nbCouches {
				amis[msg.De] = msg.Q
			}
			pauses[msg.De] = msg.P
			compter()
			suivre(msg.De, msg.UID, true)
			diff.signalerBesoin()
			log.Printf("relais %s : un ami regarde (%d en tout)", l.url, len(amis))
			diff.demanderIDR(amis[msg.De])
		case "depart":
			delete(amis, msg.De)
			delete(pauses, msg.De)
			compter()
			suivre(msg.De, "", false)
		case "qualite":
			if _, ok := amis[msg.De]; !ok || msg.Q < 0 || msg.Q >= nbCouches {
				continue
			}
			amis[msg.De] = msg.Q
			compter()
			diff.signalerBesoin()
			diff.demanderIDR(msg.Q)
		case "idr":
			diff.demanderIDR(amis[msg.De])
		case "pause":
			if _, ok := amis[msg.De]; ok {
				pauses[msg.De] = msg.P
				compter()
				if !msg.P {
					diff.demanderIDR(amis[msg.De]) // retour par le relais : il lui faut une image clé
				}
			}
		case "offre":
			// Connexion directe demandée par un ami (navigateur, hors Discord). Son uid vient du relais.
			if _, ok := amis[msg.De]; !ok || msg.UID == "" || msg.SDP == "" {
				continue
			}
			de := msg.De
			select {
			case diff.offres <- demandeP2P{uid: msg.UID, sdp: msg.SDP, couche: amis[msg.De],
				repondre: func(sdp string) { envoyerTexte(map[string]any{"type": "reponse", "a": de, "sdp": sdp}) }}:
			default: // trop de demandes : ignorée
			}
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
