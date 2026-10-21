// Connexion directe (P2P, WebRTC) avec le PC de l'hôte, hors de Discord seulement (Discord bloque
// WebRTC dans les Activités). La négociation passe par le relais. Canaux :
//   « ctrl »  : fiable, mêmes messages que par le relais (ping, idr, qualite, manette) ;
//   « video » : non ordonné, abandon après 80 ms ; images découpées en morceaux
//               [u32 n° (bit 31 = son)][u16 morceau][u16 nombre][données].

export const SERVEURS_STUN = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'];
const DUREE_VIE_MS = 80;

/** Remet les morceaux bout à bout ; signale une image perdue (le décodeur devra repartir d'une image clé). */
export class Assembleur {
  private enCours = new Map<number, { total: number; recus: number; parts: (Uint8Array | null)[] }>();
  private derniereImage = 0;
  private livrer: (paquet: ArrayBuffer) => void;
  private surPerte: () => void;

  constructor(livrer: (paquet: ArrayBuffer) => void, surPerte: () => void) {
    this.livrer = livrer;
    this.surPerte = surPerte;
  }

  recevoir(buf: ArrayBuffer) {
    if (buf.byteLength < 8) return;
    const v = new DataView(buf);
    const numero = v.getUint32(0, true), i = v.getUint16(4, true), total = v.getUint16(6, true);
    if (!total || i >= total) return;
    const son = (numero & 0x80000000) !== 0;
    if (!son && numero <= this.derniereImage) return;  // arrivée trop tard : déjà dépassée
    let e = this.enCours.get(numero);
    if (!e) {
      if (total === 1) return this.complet(numero, son, [new Uint8Array(buf, 8)]);
      e = { total, recus: 0, parts: new Array(total).fill(null) };
      this.enCours.set(numero, e);
      if (this.enCours.size > 8) this.enCours.delete(this.enCours.keys().next().value!);  // morceaux orphelins
    }
    if (e.parts[i]) return;
    e.parts[i] = new Uint8Array(buf, 8);
    if (++e.recus === e.total) {
      this.enCours.delete(numero);
      this.complet(numero, son, e.parts as Uint8Array[]);
    }
  }

  private complet(numero: number, son: boolean, parts: Uint8Array[]) {
    if (!son) {
      if (this.derniereImage && numero !== this.derniereImage + 1) this.surPerte();  // une image manque
      this.derniereImage = numero;
      for (const n of this.enCours.keys()) if (!(n & 0x80000000) && n < numero) this.enCours.delete(n);
    }
    const taille = parts.reduce((t, p) => t + p.byteLength, 0);
    const out = new Uint8Array(taille);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.byteLength; }
    this.livrer(out.buffer);
  }
}

export class Direct {
  private pc: RTCPeerConnection;
  private ctrl: RTCDataChannel;
  private video: RTCDataChannel;
  private assembleur: Assembleur;
  ouvert = false;
  dernierMessage = 0;
  surOuvert: () => void = () => {};
  surFin: (etaitOuvert: boolean) => void = () => {};

  constructor(surPaquet: (b: ArrayBuffer) => void, surTexte: (t: string) => void, surPerte: () => void) {
    this.pc = new RTCPeerConnection({ iceServers: [{ urls: SERVEURS_STUN }] });
    this.ctrl = this.pc.createDataChannel('ctrl');
    this.video = this.pc.createDataChannel('video', { ordered: false, maxPacketLifeTime: DUREE_VIE_MS });
    this.video.binaryType = 'arraybuffer';
    this.assembleur = new Assembleur(surPaquet, surPerte);
    this.video.onmessage = (e) => { this.dernierMessage = Date.now(); this.assembleur.recevoir(e.data); };
    this.ctrl.onmessage = (e) => { this.dernierMessage = Date.now(); if (typeof e.data === 'string') surTexte(e.data); };
    const ouvert = () => {
      if (this.ouvert || this.ctrl.readyState !== 'open' || this.video.readyState !== 'open') return;
      this.ouvert = true;
      this.dernierMessage = Date.now();
      this.surOuvert();
    };
    this.ctrl.onopen = ouvert;
    this.video.onopen = ouvert;
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === 'failed' || this.pc.connectionState === 'closed') this.fermer();
    };
  }

  /** Prépare l'offre (avec ses candidats : on attend la fin de leur collecte, 2 s au plus). */
  async offre(): Promise<string> {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await new Promise<void>((r) => {
      if (this.pc.iceGatheringState === 'complete') return r();
      const t = setTimeout(r, 2000);
      this.pc.onicegatheringstatechange = () => { if (this.pc.iceGatheringState === 'complete') { clearTimeout(t); r(); } };
    });
    return this.pc.localDescription!.sdp;
  }

  async reponse(sdp: string) {
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
  }

  envoyer(m: object) {
    if (this.ctrl.readyState === 'open') this.ctrl.send(JSON.stringify(m));
  }

  private fini = false;
  fermer() {
    if (this.fini) return;
    this.fini = true;
    const etait = this.ouvert;
    this.ouvert = false;
    try { this.pc.close(); } catch { /* déjà fermée */ }
    this.surFin(etait);
  }
}
