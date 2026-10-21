// Lecteur : se connecte au relais (Cloudflare d'abord, VPS en repli), décode les images avec WebCodecs
// et les dessine dès qu'elles sont prêtes. En cas de retard, on saute jusqu'à la prochaine image clé
// plutôt que d'accumuler du décalage : pour un jeu, la fluidité compte plus que chaque image.
//
// Stabilité : battements avec le relais (une connexion morte est repérée en quelques secondes),
// reconnexion immédiate, image clé redemandée tant qu'elle n'arrive pas, décodeur logiciel en repli.
import { codecDepuisSPS, Horloge, lireImage } from './protocole.ts';
import { Adaptation, BASSE, COMPAT, type Choix } from './qualite.ts';
import { Direct } from './direct.ts';

export interface Relais { nom: string; discord: string; web: string }
export interface Flux { relais: Relais[]; jeton: string }

/** Mesures publiées chaque seconde (menu debug). */
export interface Mesures {
  relais: string;
  ips: number;                // images affichées par seconde
  image: number | null;       // retard capture → affichage (ms, médiane)
  pingPc: number | null;      // aller-retour jusqu'au PC de l'hôte (ms)
  debit: number;              // kbit/s reçus
  largeur: number;
  hauteur: number;
  codec: string;
  decodeur: string;
  jetees: number;             // images sautées (retard) sur la dernière seconde
  cles: number;               // images clés reçues sur la dernière seconde
  reconnexions: number;       // depuis le début
  file: number;               // images en attente dans le décodeur
  qualite: string;            // « 1080p (auto) »…
}

export type Etat = 'connexion' | 'attente-image' | 'lecture' | 'coupe' | 'erreur';
export type Diag = (quoi: string, v?: Record<string, string | number | boolean>) => void;

const DELAI_OUVERTURE_MS = 5000;
const SILENCE_MAX_MS = 6000;      // plus rien reçu du relais : la connexion est morte
const BATTEMENT_MS = 2000;
const RELANCE_CLE_MS = 1000;      // image clé redemandée chaque seconde tant qu'elle n'arrive pas
const AGE_MAX_JETON_MS = 4 * 60_000;
const DIRECT_APRES_MS = 2000;     // hors Discord : connexion directe tentée 2 s après la connexion au PC de l'hôte
const SILENCE_DIRECT_MS = 3000;   // plus rien en direct : retour par le relais
const FILE_MAX = 3;               // au-delà, le décodeur ne suit pas : on saute à la prochaine image clé

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Formats vidéo testés au démarrage (pour savoir quoi proposer quand le H.264 manque). */
const CODECS_TESTES: Record<string, string> = {
  avc1080: 'avc1.4d042a', avc720: 'avc1.4d0420', avcBase: 'avc1.42e01f', avcHigh: 'avc1.640028',
  vp8: 'vp8', vp9: 'vp09.00.10.08', av1: 'av01.0.04M.08', hevc: 'hev1.1.6.L120.90',
};

/** Ce que ce navigateur sait décoder (matériel ou logiciel). */
export async function codecsSupportes(): Promise<Record<string, boolean>> {
  const r: Record<string, boolean> = {};
  await Promise.all(Object.entries(CODECS_TESTES).map(async ([nom, codec]) => {
    try {
      r[nom] = !!(await VideoDecoder.isConfigSupported({ codec, optimizeForLatency: true })).supported;
    } catch { r[nom] = false; }
  }));
  return r;
}
const maintenant = () => performance.timeOrigin + performance.now();

export class Lecteur {
  private ws: WebSocket | null = null;
  private decodeur: VideoDecoder | null = null;
  private codec = '';
  private logiciel = false;       // repli après des erreurs du décodeur matériel
  private erreursDecodeur = 0;
  private attendreCle = true;
  private derniereDemandeCle = 0;
  private ferme = false;
  private horloge = new Horloge();
  private retards: number[] = [];
  private enLecture = false;
  private hotePresent = true;
  // Heure du plus vieux message resté sans réponse (0 = rien en attente), par le relais et en direct.
  // On juge une connexion morte sur un battement ou un ping sans réponse, pas sur un simple silence :
  // un onglet en arrière-plan n'a plus ses minuteurs qu'une fois par minute.
  private battementSansReponse = 0;
  private pingDirectSansReponse = 0;
  private timers: number[] = [];
  private relaisActif = '';
  private jetonRecu = Date.now();
  private ctx: CanvasRenderingContext2D;
  // compteurs sur la seconde en cours
  private images = 0;
  private octets = 0;
  private jetees = 0;
  private cles = 0;
  private reconnexions = 0;
  private adaptation: Adaptation;
  private changementCouche = 0;
  private hoteSansCouches = false;  // agent ancien : une seule qualité, pas d'adaptation
  private compat = false;           // pas de H.264 ici : couche VP8, sans adaptation
  private codecs: Record<string, boolean> = {};

  /** Couche vidéo voulue : la VP8 si le H.264 manque, sinon celle de l'adaptation. */
  private get couche() { return this.compat ? COMPAT : this.adaptation.couche; }

  /** Le H.264 ne passe pas ici : on demande la couche VP8 (720p, encodée par le PC de l'hôte). */
  private passerCompat(raison: string) {
    if (this.compat) return;
    this.compat = true;
    this.erreursDecodeur = 0;
    this.logiciel = false;
    this.diag('compat', { raison });
    this.changerCouche();
  }
  private direct: Direct | null = null;
  private prochainDirect = 0;
  private attenteDirect = 30_000;
  private ouvertDepuis = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private dansDiscord: boolean,
    private surEtat: (e: Etat, detail?: string) => void,
    private surMesures: (m: Mesures) => void,
    private demanderJeton: () => Promise<Flux>,
    private diag: Diag = () => {},
    choix: Choix | 'compat' = 'auto',
  ) {
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })!;
    this.adaptation = new Adaptation(choix === 'compat' ? 'auto' : choix);
    this.compatChoisie = choix === 'compat';
  }

  private compatChoisie = false;  // la personne a choisi « Compatibilité » (sinon : imposée faute de H.264)

  /** Qualité vidéo : automatique, forcée (1080p / 720p), ou compatibilité (VP8). */
  definirQualite(choix: Choix | 'compat') {
    if (this.hoteSansCouches) return;
    if (choix === 'compat') {
      this.compatChoisie = true;
      if (this.codecs.vp8 !== false) this.passerCompat('choisie');
      return;
    }
    const avant = this.couche;
    if (this.compat) {
      if (!this.compatChoisie || !(this.codecs.avc1080 || this.codecs.avc720)) return;  // imposée : pas de H.264 ici
      this.compat = false;
    }
    this.compatChoisie = false;
    this.adaptation.definir(choix);
    if (this.couche !== avant) this.changerCouche();
  }

  /** On passe sur l'autre couche : le relais nous l'envoie, on repart de sa prochaine image clé. */
  private changerCouche() {
    this.changementCouche = Date.now();
    this.attendreCle = true;
    this.codec = '';
    this.envoyer({ type: 'qualite', q: this.couche });
    this.diag('qualite', { q: this.couche, choix: this.compat ? 'compat' : this.adaptation.choix });
  }

  async demarrer(flux: Flux) {
    this.ferme = false;
    if (typeof VideoDecoder === 'undefined') {
      this.diag('webcodecs-absent');
      this.surEtat('erreur', 'Cet appareil ne sait pas décoder la vidéo (WebCodecs absent). Mets Discord ou ton navigateur à jour.');
      return;
    }
    // Le H.264 manque parfois (certains Discord) : on le dit tout de suite, avec la solution.
    const codecs = this.codecs = await codecsSupportes();
    this.diag('codecs', codecs);
    if (this.ferme) return;
    if (!codecs.avc1080 && !codecs.avc720) {
      // Pas de H.264 : la couche VP8 (720p) si ce lecteur la sait lire, sinon on explique quoi faire.
      if (!codecs.vp8) {
        this.surEtat('erreur', this.dansDiscord
          ? 'Ton Discord ne sait pas décoder la vidéo. Clique « Ouvrir dans le navigateur » en bas de l’écran : dans Chrome ou Edge, ça marche.'
          : 'Ce navigateur ne sait pas décoder la vidéo. Essaie Chrome ou Edge à jour.');
        return;
      }
      this.compat = true;
      this.compatChoisie = false;
      this.diag('compat', { raison: 'pas de H.264' });
    } else if (this.compatChoisie && codecs.vp8) {
      this.compat = true;
    }
    let echecs = 0;
    while (!this.ferme) {
      const r = await this.essayerRelais(flux);
      if (this.ferme) return;
      if (r.ouvert) {
        echecs = 0;
        this.reconnexions++;
        this.diag('relais-coupe', { relais: r.nom, duree: Math.round(r.duree / 1000), code: r.code, mort: r.mort });
        this.surEtat('coupe', 'Connexion perdue, reconnexion…');
      } else {
        echecs++;
        this.surEtat('coupe', 'Relais injoignable, nouvel essai…');
      }
      await pause(r.ouvert ? 150 : Math.min(4000, 250 * 2 ** echecs));
      // Le jeton du relais ne dure que 5 min : on en prend un neuf s'il est vieux, refusé (4001) ou si
      // l'ouverture a échoué.
      if (!r.ouvert || r.code === 4001 || Date.now() - this.jetonRecu > AGE_MAX_JETON_MS) {
        try { flux = await this.demanderJeton(); this.jetonRecu = Date.now(); } catch { /* on réessaie avec l'ancien */ }
      }
    }
  }

  arreter() {
    this.ferme = true;
    this.ws?.close();
    this.nettoyer();
  }

  /** Essaie chaque relais dans l'ordre jusqu'à ce qu'une connexion s'ouvre. */
  private async essayerRelais(flux: Flux) {
    let dernier = { ouvert: false, nom: '', duree: 0, code: 0, mort: false };
    for (const r of flux.relais) {
      const base = this.dansDiscord ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${r.discord}` : r.web;
      dernier = await this.session(`${base}?jeton=${encodeURIComponent(flux.jeton)}`, r.nom);
      if (dernier.ouvert || this.ferme) return dernier;
    }
    return dernier;
  }

  private session(url: string, nom: string): Promise<{ ouvert: boolean; nom: string; duree: number; code: number; mort: boolean }> {
    return new Promise((resolve) => {
      this.surEtat('connexion');
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      let ouvert = false;
      let mort = false;
      let debut = 0;
      const delai = setTimeout(() => { if (!ouvert) ws.close(); }, DELAI_OUVERTURE_MS);
      ws.onopen = () => {
        ouvert = true;
        debut = this.ouvertDepuis = Date.now();
        clearTimeout(delai);
        this.relaisActif = nom;
        this.attendreCle = true;
        this.hotePresent = true;
        this.battementSansReponse = 0;
        this.surEtat('attente-image');
        this.changementCouche = Date.now();
        if (this.couche !== 0) this.envoyer({ type: 'qualite', q: this.couche });
        this.demanderCle();
        this.timers.push(
          window.setInterval(() => {
            if (this.direct?.ouvert && !this.pingDirectSansReponse) this.pingDirectSansReponse = Date.now();
            this.envoyer({ type: 'ping', t: maintenant() });
          }, 1000),
          window.setInterval(() => {
            if (!this.battementSansReponse) this.battementSansReponse = Date.now();
            this.envoyerRelais({ type: 'battement' });
          }, BATTEMENT_MS),
          window.setInterval(() => this.publierMesures(), 1000),
          window.setInterval(() => {
            // Connexion morte (Wi-Fi coupé, relais redémarré) : on la ferme pour repartir tout de suite.
            if (this.battementSansReponse && Date.now() - this.battementSansReponse > SILENCE_MAX_MS) { mort = true; ws.close(); return; }
            if (this.attendreCle && this.hotePresent && Date.now() - this.derniereDemandeCle > RELANCE_CLE_MS) this.demanderCle();
            // Connexion directe (hors Discord) : tentée quand l'image arrive bien, abandonnée si elle se tait.
            if (this.direct?.ouvert && this.pingDirectSansReponse && Date.now() - this.pingDirectSansReponse > SILENCE_DIRECT_MS) this.direct.fermer();
            if (!this.dansDiscord && !this.direct && typeof RTCPeerConnection !== 'undefined' && this.hotePresent
              && this.horloge.allerRetour.length > 0 && Date.now() - this.ouvertDepuis > DIRECT_APRES_MS
              && Date.now() > this.prochainDirect) void this.essayerDirect();
          }, 250),
        );
      };
      ws.onmessage = (e) => {
        this.battementSansReponse = 0;
        if (typeof e.data === 'string') this.surTexte(e.data);
        else if (!this.direct?.ouvert) this.surImage(e.data);  // en direct : les images du relais (en vol) sont ignorées
      };
      ws.onclose = (e) => {
        clearTimeout(delai);
        this.nettoyer();
        resolve({ ouvert, nom, duree: ouvert ? Date.now() - debut : 0, code: e.code, mort });
      };
    });
  }

  /** Le PC de l'hôte ne peut pas créer de manette virtuelle (ViGEmBus absent…). */
  surManetteIndisponible: (raison: string) => void = () => {};

  /** Son du jeu reçu (PCM 16 bits 48 kHz stéréo). */
  surSon: (pcm: Uint8Array) => void = () => {};

  /** Le jeu fait vibrer la manette de ce joueur (moteurs fort et faible, de 0 à 1). */
  surVibration: (fort: number, faible: number) => void = () => {};

  /** Envoie une commande (manette) à l'hôte, par le relais. */
  envoyerCommande(m: object) {
    this.envoyer(m);
  }

  /** Vers l'hôte : en direct si la connexion directe est ouverte, sinon par le relais. */
  private envoyer(m: object) {
    if (this.direct?.ouvert) this.direct.envoyer(m);
    else this.envoyerRelais(m);
  }

  private envoyerRelais(m: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  /** Hors Discord : connexion directe (WebRTC) avec le PC de l'hôte, négociée par le relais. */
  private async essayerDirect() {
    let d: Direct;
    try {
      d = new Direct(
        (b) => { this.pingDirectSansReponse = 0; this.surImage(b); },
        (t) => { this.pingDirectSansReponse = 0; this.surTexte(t); },
        () => { this.attendreCle = true; this.demanderCle(); },  // une image perdue en route
      );
    } catch {
      this.prochainDirect = Infinity;  // WebRTC indisponible ici
      return;
    }
    this.direct = d;
    this.pingDirectSansReponse = 0;  // un nouveau lien ne reprend pas le délai de l'ancien
    d.surOuvert = () => {
      this.pingDirectSansReponse = 0;
      // Le relais n'envoie plus d'images (il garde la négociation et sert de secours) ; on repart d'une image clé.
      this.envoyerRelais({ type: 'pause', p: true });
      this.attendreCle = true;
      this.codec = '';
      this.envoyer({ type: 'qualite', q: this.couche });
      this.demanderCle();
      this.attenteDirect = 30_000;
      this.diag('direct', { ouvert: true });
    };
    d.surFin = (etaitOuvert) => {
      if (this.direct !== d) return;
      this.direct = null;
      this.pingDirectSansReponse = 0;
      if (etaitOuvert) {
        // Retour immédiat par le relais, sur la couche choisie entre-temps.
        this.envoyerRelais({ type: 'qualite', q: this.couche });
        this.envoyerRelais({ type: 'pause', p: false });
        this.attendreCle = true;
        this.codec = '';
        this.demanderCle();
        this.diag('direct', { ouvert: false });
      }
      this.prochainDirect = Date.now() + this.attenteDirect;
      this.attenteDirect = Math.min(300_000, this.attenteDirect * 2);
    };
    setTimeout(() => { if (this.direct === d && !d.ouvert) d.fermer(); }, 15_000);
    try {
      this.envoyerRelais({ type: 'offre', sdp: await d.offre() });
    } catch {
      d.fermer();
    }
  }

  private demanderCle() {
    this.derniereDemandeCle = Date.now();
    this.envoyer({ type: 'idr' });
  }

  private surTexte(t: string) {
    let m: { type: string; t?: number; s?: number; joueur?: number; raison?: string; f?: number; l?: number; sdp?: string };
    try { m = JSON.parse(t); } catch { return; }
    if (m.type === 'pong' && m.t !== undefined && m.s !== undefined) {
      this.hotePresent = true;
      this.horloge.ajouter(m.t, maintenant(), m.s);
    } else if (m.type === 'reponse' && typeof m.sdp === 'string') {
      this.direct?.reponse(m.sdp).catch(() => this.direct?.fermer());
    } else if (m.type === 'vibration') {
      const borne = (v: unknown) => (typeof v === 'number' ? Math.max(0, Math.min(1, v / 255)) : 0);
      this.surVibration(borne(m.f), borne(m.l));
    } else if (m.type === 'manette-indisponible') {
      this.surManetteIndisponible(m.raison ?? 'manette indisponible');
    } else if (m.type === 'hote-parti' || m.type === 'pas-d-hote') {
      this.hotePresent = false;
      this.attendreCle = true;
      if (this.enLecture) { this.enLecture = false; }
      this.surEtat('attente-image', 'Le PC de l’hôte se reconnecte…');
    }
  }

  private surImage(buf: ArrayBuffer) {
    const img = lireImage(buf);
    if (!img) return;
    this.hotePresent = true;
    this.octets += buf.byteLength;
    if (img.son) { this.surSon(img.donnees); return; }
    if (img.qualite !== this.couche) {
      if (Date.now() - this.changementCouche < 3000) return;  // image de l'autre couche, juste après un changement
      // Toujours l'autre couche : le PC de l'hôte n'en a qu'une (agent pas encore à jour). On la prend.
      this.hoteSansCouches = true;
      if (this.compat) {
        this.surEtat('erreur', 'Le PC de l’hôte n’envoie pas encore la vidéo compatible avec ton lecteur : il doit mettre son agent à jour. En attendant, « Ouvrir dans le navigateur ».');
        return;
      }
      this.adaptation.definir(img.qualite === BASSE ? '720' : '1080');
      this.attendreCle = !img.cle;
      this.codec = '';
    }
    if (img.cle) this.cles++;
    if (this.attendreCle && !img.cle) return;
    if (img.cle) {
      const codec = img.qualite === COMPAT ? 'vp8' : codecDepuisSPS(img.donnees);
      if (codec && (codec !== this.codec || !this.decodeur || this.decodeur.state === 'closed')) this.configurer(codec);
    }
    const d = this.decodeur;
    if (!d || d.state !== 'configured') return;
    // Le décodeur prend du retard : on jette et on repart d'une image clé.
    if (!img.cle && d.decodeQueueSize > FILE_MAX) {
      this.jetees++;
      this.attendreCle = true;
      this.demanderCle();
      return;
    }
    this.attendreCle = false;
    try {
      d.decode(new EncodedVideoChunk({ type: img.cle ? 'key' : 'delta', timestamp: img.heureHote * 1000, data: img.donnees }));
    } catch (e) {
      this.surErreurDecodeur(e);
    }
  }

  private configurer(codec: string) {
    try { this.decodeur?.close(); } catch { /* déjà fermé */ }
    this.codec = codec;
    this.decodeur = new VideoDecoder({
      output: (f) => {
        if (this.canvas.width !== f.displayWidth || this.canvas.height !== f.displayHeight) {
          this.canvas.width = f.displayWidth;
          this.canvas.height = f.displayHeight;
        }
        this.ctx.drawImage(f, 0, 0);
        const retard = this.horloge.retard(f.timestamp / 1000, maintenant());
        f.close();
        this.retards.push(retard);
        if (this.retards.length > 120) this.retards.shift();
        this.images++;
        this.erreursDecodeur = 0;
        if (!this.enLecture) { this.enLecture = true; this.surEtat('lecture'); }
      },
      error: (e) => this.surErreurDecodeur(e),
    });
    try {
      // « no-preference » : le navigateur prend le décodeur matériel s'il convient, sinon le logiciel.
      this.decodeur.configure({ codec, optimizeForLatency: true, hardwareAcceleration: this.logiciel ? 'prefer-software' : 'no-preference' });
    } catch (e) {
      this.surErreurDecodeur(e);
    }
  }

  private surErreurDecodeur(e: unknown) {
    this.erreursDecodeur++;
    const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    this.diag('erreur-decodeur', { message, codec: this.codec, logiciel: this.logiciel, n: this.erreursDecodeur });
    if (this.erreursDecodeur >= 2 && !this.logiciel) this.logiciel = true;  // le décodeur matériel n'y arrive pas
    // Le H.264 échoue sans cesse mais le VP8 passe : on bascule sur la couche VP8.
    if (this.erreursDecodeur >= 4 && !this.compat && !this.hoteSansCouches && this.codecs.vp8) {
      this.passerCompat(message);
      return;
    }
    if (this.erreursDecodeur >= 6) this.surEtat('erreur', this.dansDiscord
      ? `Ton Discord ne décode pas cette vidéo (${this.codec}). Clique « Ouvrir dans le navigateur » en bas de l’écran.`
      : `Ce navigateur ne décode pas cette vidéo (${this.codec}). Essaie Chrome ou Edge à jour.`);
    this.attendreCle = true;
    this.codec = '';
    this.demanderCle();
  }

  private publierMesures() {
    const r = [...this.retards].sort((a, b) => a - b);
    const ping = this.horloge.allerRetour.at(-1);
    const image = r.length && this.horloge.allerRetour.length ? Math.max(0, Math.round(r[Math.floor(r.length / 2)])) : null;
    // Qualité adaptative : seulement quand l'image arrive (pas pendant une attente ou une reconnexion).
    if (this.enLecture && this.hotePresent && !this.hoteSansCouches && !this.compat) {
      const avant = this.adaptation.couche;
      if (this.adaptation.seconde({ image, jetees: this.jetees, ips: this.images }) !== avant) this.changerCouche();
    }
    this.surMesures({
      relais: this.direct?.ouvert ? 'direct (P2P)' : this.relaisActif,
      ips: this.images,
      image,
      pingPc: ping === undefined ? null : Math.round(ping),
      debit: Math.round((this.octets * 8) / 1000),
      largeur: this.canvas.width,
      hauteur: this.canvas.height,
      codec: this.codec,
      decodeur: this.logiciel ? 'logiciel' : 'auto',
      jetees: this.jetees,
      cles: this.cles,
      reconnexions: this.reconnexions,
      file: this.decodeur?.decodeQueueSize ?? 0,
      qualite: this.compat ? '720p VP8 (compatibilité)'
        : `${this.adaptation.couche === BASSE ? '720p' : '1080p'} (${this.hoteSansCouches ? 'seule qualité du PC de l’hôte' : this.adaptation.choix === 'auto' ? 'auto' : 'choisie'})`,
    });
    this.images = this.octets = this.jetees = this.cles = 0;
    this.retards = this.retards.slice(-60);
  }

  private nettoyer() {
    this.enLecture = false;
    const d = this.direct;
    this.direct = null;
    d?.fermer();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    try { this.decodeur?.close(); } catch { /* déjà fermé */ }
    this.decodeur = null;
    this.codec = '';
  }
}
