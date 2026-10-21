// Manette tactile (téléphone, tablette) : un stick à gauche, A B X Y à droite aux positions de la
// Switch, L / ZL et R / ZR en haut, − et + au milieu. Plusieurs doigts à la fois (Pointer Events).
// Les boutons sont placés comme sur la Switch : A à droite, B en bas, X en haut, Y à gauche. Ryubing
// associe les boutons par position (A Switch = bouton de droite de la manette Xbox), d'où les sorties.
import { BITS, REPOS, type EtatManette } from './manette.ts';
import type { Sortie } from './reglages.ts';

/** Vecteur du stick (axes Xbox) pour un doigt à (dx, dy) pixels du centre, rayon en pixels. */
export function vecteurStick(dx: number, dy: number, rayon: number): { lx: number; ly: number } {
  const d = Math.hypot(dx, dy);
  if (d < rayon * 0.12) return { lx: 0, ly: 0 };  // zone morte au centre
  const k = Math.min(1, d / rayon) / d;
  return { lx: Math.round(dx * k * 32767) || 0, ly: Math.round(-dy * k * 32767) || 0 };  // || 0 : pas de -0
}

interface Bouton { libelle: string; sortie: Sortie; zone: string }
const BOUTONS: Bouton[] = [
  { libelle: 'A', sortie: 'b', zone: 'a' },
  { libelle: 'B', sortie: 'a', zone: 'b' },
  { libelle: 'X', sortie: 'y', zone: 'x' },
  { libelle: 'Y', sortie: 'x', zone: 'y' },
  { libelle: 'L', sortie: 'lb', zone: 'l' },
  { libelle: 'ZL', sortie: 'lt', zone: 'zl' },
  { libelle: 'R', sortie: 'rb', zone: 'r' },
  { libelle: 'ZR', sortie: 'rt', zone: 'zr' },
  { libelle: '−', sortie: 'back', zone: 'moins' },
  { libelle: '+', sortie: 'start', zone: 'plus' },
];

export const appareilTactile = () => matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 1;

export class ManetteTactile {
  readonly racine: HTMLElement;
  private appuyes = new Set<Sortie>();
  private stick = { lx: 0, ly: 0 };
  private doigtStick: number | null = null;
  private centre = { x: 0, y: 0 };
  private rayon = 50;
  private manche: HTMLElement;

  constructor() {
    this.racine = document.createElement('div');
    this.racine.className = 'tactile';
    this.racine.hidden = true;
    const zoneStick = document.createElement('div');
    zoneStick.className = 'stick';
    this.manche = document.createElement('div');
    this.manche.className = 'manche';
    zoneStick.append(this.manche);
    this.racine.append(zoneStick);
    zoneStick.addEventListener('pointerdown', (e) => {
      if (this.doigtStick !== null) return;
      e.preventDefault();
      zoneStick.setPointerCapture(e.pointerId);
      this.doigtStick = e.pointerId;
      const r = zoneStick.getBoundingClientRect();
      this.centre = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      this.rayon = r.width / 2;
      this.bouger(e);
    });
    zoneStick.addEventListener('pointermove', (e) => { if (e.pointerId === this.doigtStick) this.bouger(e); });
    const lacher = (e: PointerEvent) => {
      if (e.pointerId !== this.doigtStick) return;
      this.doigtStick = null;
      this.stick = { lx: 0, ly: 0 };
      this.manche.style.transform = '';
    };
    zoneStick.addEventListener('pointerup', lacher);
    zoneStick.addEventListener('pointercancel', lacher);

    for (const b of BOUTONS) {
      const n = document.createElement('button');
      n.type = 'button';
      n.className = `bouton-tactile ${b.zone}`;
      n.textContent = b.libelle;
      n.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        n.setPointerCapture(e.pointerId);
        this.appuyes.add(b.sortie);
        n.classList.add('appuye');
        navigator.vibrate?.(8);
      });
      const relacher = () => { this.appuyes.delete(b.sortie); n.classList.remove('appuye'); };
      n.addEventListener('pointerup', relacher);
      n.addEventListener('pointercancel', relacher);
      n.addEventListener('lostpointercapture', relacher);
      this.racine.append(n);
    }
    // Pas de menu, de sélection ni de zoom quand on joue avec les doigts.
    this.racine.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get visible() { return !this.racine.hidden; }
  set visible(v: boolean) {
    this.racine.hidden = !v;
    if (!v) { this.appuyes.clear(); this.stick = { lx: 0, ly: 0 }; this.doigtStick = null; }
  }

  /** État de la manette tactile (au repos si elle est cachée). */
  etat(): EtatManette {
    if (!this.visible) return REPOS;
    let b = 0;
    for (const s of this.appuyes) b |= BITS[s] ?? 0;
    return {
      ...REPOS,
      b,
      lt: this.appuyes.has('lt') ? 255 : 0,
      rt: this.appuyes.has('rt') ? 255 : 0,
      lx: this.stick.lx,
      ly: this.stick.ly,
    };
  }

  private bouger(e: PointerEvent) {
    const dx = e.clientX - this.centre.x, dy = e.clientY - this.centre.y;
    this.stick = vecteurStick(dx, dy, this.rayon);
    const d = Math.min(1, Math.hypot(dx, dy) / this.rayon);
    const a = Math.atan2(dy, dx);
    this.manche.style.transform = `translate(${Math.cos(a) * d * this.rayon * 0.6}px, ${Math.sin(a) * d * this.rayon * 0.6}px)`;
  }
}
