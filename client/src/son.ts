// Son du jeu : PCM 16 bits 48 kHz stéréo, par paquets de ~10 ms. Chaque paquet est programmé juste
// après le précédent, avec ~60 ms d'avance pour absorber les irrégularités du réseau. Si le son prend
// du retard (plus de 250 ms d'avance), on jette : le son doit rester calé sur l'image.

const AVANCE_S = 0.06;
const AVANCE_MAX_S = 0.25;

/** PCM entrelacé (16 bits, petit-boutiste) -> deux canaux en flottants. */
export function versCanaux(pcm: Uint8Array): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] {
  const n = Math.floor(pcm.byteLength / 4);
  const v = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const g = new Float32Array(n), d = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    g[i] = v.getInt16(i * 4, true) / 32768;
    d[i] = v.getInt16(i * 4 + 2, true) / 32768;
  }
  return [g, d];
}

/** Où programmer le prochain paquet (secondes) ; null = le jeter (trop de retard accumulé). */
export function programmer(prochain: number, maintenant: number): number | null {
  if (prochain < maintenant + 0.005) return maintenant + AVANCE_S;  // début, ou trou dans le son
  if (prochain > maintenant + AVANCE_MAX_S) return null;
  return prochain;
}

export class Son {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private prochain = 0;
  private volume = 0.8;
  recus = 0;  // paquets reçus (debug)

  constructor() {
    // Les navigateurs ne laissent jouer du son qu'après un geste de la personne.
    const debloquer = () => { void this.ctx?.resume(); };
    addEventListener('pointerdown', debloquer);
    addEventListener('keydown', debloquer);
  }

  /** Le son arrive mais le navigateur attend un clic pour le jouer. */
  get bloque() { return !!this.ctx && this.ctx.state !== 'running' && this.recus > 0; }

  /** Avance du son sur sa lecture (ms), pour le menu debug. */
  get avanceMs() { return this.ctx ? Math.max(0, Math.round((this.prochain - this.ctx.currentTime) * 1000)) : 0; }

  definirVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.gain) this.gain.gain.value = this.volume;
  }

  debloquer() { void this.ctx?.resume(); }

  jouer(pcm: Uint8Array) {
    this.recus++;
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
      } catch {
        this.ctx = new AudioContext({ latencyHint: 'interactive' });  // Safari ancien : sa fréquence à lui
      }
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.ctx.destination);
    }
    const ctx = this.ctx;
    if (ctx.state !== 'running' || !this.volume) return;
    const [g, d] = versCanaux(pcm);
    if (!g.length) return;
    const quand = programmer(this.prochain, ctx.currentTime);
    if (quand === null) return;
    const buf = ctx.createBuffer(2, g.length, 48000);
    buf.copyToChannel(g, 0);
    buf.copyToChannel(d, 1);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain!);
    src.start(quand);
    this.prochain = quand + buf.duration;
  }

  fermer() {
    void this.ctx?.close();
    this.ctx = null;
    this.gain = null;
  }
}
