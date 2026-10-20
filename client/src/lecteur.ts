// Lecteur : se connecte au relais (Cloudflare d'abord, VPS en repli), décode les images avec WebCodecs
// et les dessine dès qu'elles sont prêtes. En cas de retard, on saute jusqu'à la prochaine image clé
// plutôt que d'accumuler du décalage : pour un jeu, la fluidité compte plus que chaque image.
//
// Stabilité : battements avec le relais (une connexion morte est repérée en quelques secondes),
// reconnexion immédiate, image clé redemandée tant qu'elle n'arrive pas, décodeur logiciel en repli.
import { codecDepuisSPS, Horloge, lireImage } from './protocole.ts';

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
}

export type Etat = 'connexion' | 'attente-image' | 'lecture' | 'coupe' | 'erreur';
export type Diag = (quoi: string, v?: Record<string, string | number | boolean>) => void;

const DELAI_OUVERTURE_MS = 5000;
const SILENCE_MAX_MS = 6000;      // plus rien reçu du relais : la connexion est morte
const BATTEMENT_MS = 2000;
const RELANCE_CLE_MS = 1000;      // image clé redemandée chaque seconde tant qu'elle n'arrive pas
const AGE_MAX_JETON_MS = 4 * 60_000;
const FILE_MAX = 3;               // au-delà, le décodeur ne suit pas : on saute à la prochaine image clé

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
  private dernierMessage = 0;
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

  constructor(
    private canvas: HTMLCanvasElement,
    private dansDiscord: boolean,
    private surEtat: (e: Etat, detail?: string) => void,
    private surMesures: (m: Mesures) => void,
    private demanderJeton: () => Promise<Flux>,
    private diag: Diag = () => {},
  ) {
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })!;
  }

  async demarrer(flux: Flux) {
    this.ferme = false;
    if (typeof VideoDecoder === 'undefined') {
      this.diag('webcodecs-absent');
      this.surEtat('erreur', 'Cet appareil ne sait pas décoder la vidéo (WebCodecs absent). Mets Discord ou ton navigateur à jour.');
      return;
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
      // Le jeton du relais ne dure que 5 min : on en prend un neuf s'il est vieux ou si l'ouverture a échoué.
      if (!r.ouvert || Date.now() - this.jetonRecu > AGE_MAX_JETON_MS) {
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
        debut = Date.now();
        clearTimeout(delai);
        this.relaisActif = nom;
        this.attendreCle = true;
        this.hotePresent = true;
        this.dernierMessage = Date.now();
        this.surEtat('attente-image');
        this.demanderCle();
        this.timers.push(
          window.setInterval(() => this.envoyer({ type: 'ping', t: maintenant() }), 1000),
          window.setInterval(() => this.envoyer({ type: 'battement' }), BATTEMENT_MS),
          window.setInterval(() => this.publierMesures(), 1000),
          window.setInterval(() => {
            // Connexion morte (Wi-Fi coupé, relais redémarré) : on la ferme pour repartir tout de suite.
            if (Date.now() - this.dernierMessage > SILENCE_MAX_MS) { mort = true; ws.close(); return; }
            if (this.attendreCle && this.hotePresent && Date.now() - this.derniereDemandeCle > RELANCE_CLE_MS) this.demanderCle();
          }, 250),
        );
      };
      ws.onmessage = (e) => {
        this.dernierMessage = Date.now();
        if (typeof e.data === 'string') this.surTexte(e.data);
        else this.surImage(e.data);
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

  /** Envoie une commande (manette) à l'hôte, par le relais. */
  envoyerCommande(m: object) {
    this.envoyer(m);
  }

  private envoyer(m: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private demanderCle() {
    this.derniereDemandeCle = Date.now();
    this.envoyer({ type: 'idr' });
  }

  private surTexte(t: string) {
    let m: { type: string; t?: number; s?: number; joueur?: number; raison?: string };
    try { m = JSON.parse(t); } catch { return; }
    if (m.type === 'pong' && m.t !== undefined && m.s !== undefined) {
      this.hotePresent = true;
      this.horloge.ajouter(m.t, maintenant(), m.s);
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
    if (img.cle) this.cles++;
    if (this.attendreCle && !img.cle) return;
    if (img.cle) {
      const codec = codecDepuisSPS(img.donnees);
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
    if (this.erreursDecodeur >= 6) this.surEtat('erreur', `La vidéo ne se décode pas sur cet appareil (${this.codec}). Essaie Discord à jour sur ordinateur.`);
    this.attendreCle = true;
    this.codec = '';
    this.demanderCle();
  }

  private publierMesures() {
    const r = [...this.retards].sort((a, b) => a - b);
    const ping = this.horloge.allerRetour.at(-1);
    this.surMesures({
      relais: this.relaisActif,
      ips: this.images,
      image: r.length && this.horloge.allerRetour.length ? Math.max(0, Math.round(r[Math.floor(r.length / 2)])) : null,
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
    });
    this.images = this.octets = this.jetees = this.cles = 0;
    this.retards = this.retards.slice(-60);
  }

  private nettoyer() {
    this.enLecture = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    try { this.decodeur?.close(); } catch { /* déjà fermé */ }
    this.decodeur = null;
    this.codec = '';
  }
}
