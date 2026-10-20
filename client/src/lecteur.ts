// Lecteur : se connecte au relais (Cloudflare d'abord, VPS en repli), décode les images avec WebCodecs
// et les dessine dès qu'elles sont prêtes. En cas de retard, on saute jusqu'à la prochaine image clé
// plutôt que d'accumuler du décalage : pour un jeu, la fluidité compte plus que chaque image.
import { codecDepuisSPS, Horloge, lireImage } from './protocole.ts';

export interface Relais { nom: string; discord: string; web: string }
export interface Flux { relais: Relais[]; jeton: string }
export interface Stats { relais: string; image: number | null; allerRetour: number | null; ips: number }

type Etat = 'connexion' | 'attente-image' | 'lecture' | 'coupe';

export class Lecteur {
  private ws: WebSocket | null = null;
  private decodeur: VideoDecoder | null = null;
  private codec = '';
  private attendreCle = true;
  private ferme = false;
  private horloge = new Horloge();
  private retards: number[] = [];
  private images = 0;
  private enLecture = false;
  private pingTimer = 0;
  private statsTimer = 0;
  private relaisActif = '';
  private ctx: CanvasRenderingContext2D;

  constructor(
    private canvas: HTMLCanvasElement,
    private dansDiscord: boolean,
    private surEtat: (e: Etat, detail?: string) => void,
    private surStats: (s: Stats) => void,
    private demanderJeton: () => Promise<Flux>,
  ) {
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })!;
  }

  async demarrer(flux: Flux) {
    this.ferme = false;
    let essai = 0;
    while (!this.ferme) {
      const ok = await this.essayerRelais(flux);
      if (this.ferme) return;
      this.surEtat('coupe', ok ? 'Connexion perdue, reconnexion…' : 'Relais injoignable, nouvel essai…');
      await new Promise((r) => setTimeout(r, Math.min(8000, 1000 * 2 ** essai++)));
      if (ok) essai = 0;
      try { flux = await this.demanderJeton(); } catch { /* on réessaie avec l'ancien */ }
    }
  }

  arreter() {
    this.ferme = true;
    this.ws?.close();
    this.nettoyer();
  }

  /** Essaie chaque relais dans l'ordre. Renvoie true si une session a eu lieu (puis s'est coupée). */
  private async essayerRelais(flux: Flux) {
    for (const r of flux.relais) {
      const base = this.dansDiscord ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${r.discord}` : r.web;
      const ouvert = await this.session(`${base}?jeton=${encodeURIComponent(flux.jeton)}`, r.nom);
      if (ouvert || this.ferme) return ouvert;
    }
    return false;
  }

  private session(url: string, nom: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.surEtat('connexion');
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      let ouvert = false;
      const delai = setTimeout(() => { if (!ouvert) ws.close(); }, 6000);
      ws.onopen = () => {
        ouvert = true;
        clearTimeout(delai);
        this.relaisActif = nom;
        this.attendreCle = true;
        this.surEtat('attente-image');
        this.envoyer({ type: 'idr' });
        this.pingTimer = window.setInterval(() => this.envoyer({ type: 'ping', t: performance.timeOrigin + performance.now() }), 1000);
        this.statsTimer = window.setInterval(() => this.publierStats(), 1000);
      };
      ws.onmessage = (e) => (typeof e.data === 'string' ? this.surTexte(e.data) : this.surImage(e.data));
      ws.onclose = () => {
        clearTimeout(delai);
        this.nettoyer();
        resolve(ouvert);
      };
    });
  }

  private envoyer(m: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private surTexte(t: string) {
    let m: { type: string; t?: number; s?: number };
    try { m = JSON.parse(t); } catch { return; }
    if (m.type === 'pong' && m.t !== undefined && m.s !== undefined) {
      this.horloge.ajouter(m.t, performance.timeOrigin + performance.now(), m.s);
    } else if (m.type === 'hote-parti' || m.type === 'pas-d-hote') {
      this.surEtat('attente-image', 'Le PC de l’hôte n’envoie pas encore d’image…');
    }
  }

  private surImage(buf: ArrayBuffer) {
    const img = lireImage(buf);
    if (!img) return;
    if (this.attendreCle && !img.cle) return;
    if (img.cle) {
      const codec = codecDepuisSPS(img.donnees);
      if (codec && (codec !== this.codec || !this.decodeur || this.decodeur.state === 'closed')) this.configurer(codec);
    }
    const d = this.decodeur;
    if (!d || d.state !== 'configured') return;
    // Le décodeur prend du retard : on jette et on repart d'une image clé.
    if (!img.cle && d.decodeQueueSize > 2) {
      this.attendreCle = true;
      this.envoyer({ type: 'idr' });
      return;
    }
    this.attendreCle = false;
    try {
      d.decode(new EncodedVideoChunk({ type: img.cle ? 'key' : 'delta', timestamp: img.heureHote * 1000, data: img.donnees }));
    } catch {
      this.repartir();
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
        const retard = this.horloge.retard(f.timestamp / 1000, performance.timeOrigin + performance.now());
        f.close();
        this.retards.push(retard);
        if (this.retards.length > 120) this.retards.shift();
        this.images++;
        if (!this.enLecture) { this.enLecture = true; this.surEtat('lecture'); }
      },
      error: () => this.repartir(),
    });
    this.decodeur.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
  }

  private repartir() {
    this.attendreCle = true;
    this.codec = '';
    this.envoyer({ type: 'idr' });
  }

  private publierStats() {
    const r = [...this.retards].sort((a, b) => a - b);
    this.surStats({
      relais: this.relaisActif,
      image: r.length && this.horloge.allerRetour.length ? Math.max(0, Math.round(r[Math.floor(r.length / 2)])) : null,
      allerRetour: this.horloge.mediane() === null ? null : Math.round(this.horloge.mediane()!),
      ips: this.images,
    });
    this.images = 0;  // compté sur une seconde : images par seconde
  }

  private nettoyer() {
    this.enLecture = false;
    clearInterval(this.pingTimer);
    clearInterval(this.statsTimer);
    try { this.decodeur?.close(); } catch { /* déjà fermé */ }
    this.decodeur = null;
    this.codec = '';
  }
}
