// Lit la manette (Gamepad API) et le clavier selon les réglages du joueur, et produit l'état d'une
// manette Xbox 360 (bits XUSB) que l'agent applique à la manette virtuelle de ce joueur.
import { PROFIL_STANDARD, SORTIES, type Profil, type Sortie } from './reglages.ts';

export interface EtatManette { b: number; lt: number; rt: number; lx: number; ly: number; rx: number; ry: number }
export const REPOS: EtatManette = { b: 0, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 };

// Bits XUSB des commandes qui sont des boutons.
export const BITS: Partial<Record<Sortie, number>> = {
  haut: 0x0001, bas: 0x0002, gauche: 0x0004, droite: 0x0008,
  start: 0x0010, back: 0x0020, l3: 0x0040, r3: 0x0080,
  lb: 0x0100, rb: 0x0200,
  a: 0x1000, b: 0x2000, x: 0x4000, y: 0x8000,
};
const ZONE_MORTE = 0.08;
const SEUIL_BOUTON = 0.5;

export interface GamepadLike {
  id?: string;
  mapping?: string;
  buttons: ReadonlyArray<{ pressed: boolean; value: number }>;
  axes: ReadonlyArray<number>;
}

/** Valeur 0..1 d'une source : "b3" = bouton 3, "a1-" / "a1+" = moitié négative / positive de l'axe 1. */
export function valeurSource(g: GamepadLike, source: string | undefined): number {
  if (!source) return 0;
  const n = Number(source.slice(1).replace(/[+-]$/, ''));
  if (source[0] === 'b') {
    const btn = g.buttons[n];
    if (!btn) return 0;
    // Gâchettes analogiques : la valeur compte (pressed passe à vrai dès qu'on effleure la gâchette).
    return btn.value > 0 ? Math.min(1, btn.value) : btn.pressed ? 1 : 0;
  }
  const v = g.axes[n] ?? 0;
  return Math.max(0, Math.min(1, source.endsWith('-') ? -v : v));
}

const axe = (plus: number, moins: number) => {
  const v = plus - moins;
  return Math.abs(v) < ZONE_MORTE ? 0 : Math.round(Math.max(-1, Math.min(1, v)) * 32767);
};

export function depuisGamepad(g: GamepadLike, profil: Profil = PROFIL_STANDARD): EtatManette {
  const v = (s: Sortie) => valeurSource(g, profil[s]);
  let b = 0;
  for (const [s, bit] of Object.entries(BITS) as [Sortie, number][]) if (v(s) > SEUIL_BOUTON) b |= bit;
  return {
    b,
    lt: Math.round(v('lt') * 255),
    rt: Math.round(v('rt') * 255),
    lx: axe(v('lx+'), v('lx-')),
    ly: axe(v('ly+'), v('ly-')),
    rx: axe(v('rx+'), v('rx-')),
    ry: axe(v('ry+'), v('ry-')),
  };
}

/** Clavier : par position physique des touches (event.code) — ZQSD en AZERTY = KeyW/A/S/D. */
export function depuisClavier(touches: ReadonlySet<string>, clavier: Partial<Record<Sortie, string>>): EtatManette {
  const appuye = (s: Sortie) => (clavier[s] && touches.has(clavier[s]!) ? 1 : 0);
  let b = 0;
  for (const [s, bit] of Object.entries(BITS) as [Sortie, number][]) if (appuye(s)) b |= bit;
  return {
    b,
    lt: appuye('lt') * 255,
    rt: appuye('rt') * 255,
    lx: axe(appuye('lx+'), appuye('lx-')),
    ly: axe(appuye('ly+'), appuye('ly-')),
    rx: axe(appuye('rx+'), appuye('rx-')),
    ry: axe(appuye('ry+'), appuye('ry-')),
  };
}

/** Pour l'assistant : quel bouton ou demi-axe a bougé par rapport à la position de repos ? */
export function sourceBougee(g: GamepadLike, repos: GamepadLike): string | null {
  for (let i = 0; i < g.buttons.length; i++) {
    const avant = repos.buttons[i] ? Math.max(repos.buttons[i].pressed ? 1 : 0, repos.buttons[i].value) : 0;
    if (valeurSource(g, `b${i}`) > 0.6 && avant < 0.3) return `b${i}`;
  }
  for (let i = 0; i < g.axes.length; i++) {
    const d = (g.axes[i] ?? 0) - (repos.axes[i] ?? 0);
    if (Math.abs(d) > 0.6) return `a${i}${d < 0 ? '-' : '+'}`;
  }
  return null;
}

/** Copie figée de l'état d'une manette (les objets Gamepad changent en direct). */
export const instantane = (g: GamepadLike): GamepadLike => ({
  id: g.id, mapping: g.mapping,
  buttons: g.buttons.map((b) => ({ pressed: b.pressed, value: b.value })),
  axes: [...g.axes],
});

/** Nom lisible d'une source, pour l'écran de réglages. */
export function nomSource(source: string | undefined) {
  if (!source) return '—';
  return source[0] === 'b' ? `Bouton ${source.slice(1)}` : `Axe ${source.slice(1, -1)} ${source.endsWith('-') ? '−' : '+'}`;
}

/** Combine plusieurs sources (manettes + clavier) : boutons cumulés, axes et gâchettes au plus fort. */
export function fusionner(...etats: EtatManette[]): EtatManette {
  const r = { ...REPOS };
  for (const e of etats) {
    r.b |= e.b;
    r.lt = Math.max(r.lt, e.lt);
    r.rt = Math.max(r.rt, e.rt);
    for (const k of ['lx', 'ly', 'rx', 'ry'] as const) if (Math.abs(e[k]) > Math.abs(r[k])) r[k] = e[k];
  }
  return r;
}

export const egal = (a: EtatManette, b: EtatManette) =>
  a.b === b.b && a.lt === b.lt && a.rt === b.rt && a.lx === b.lx && a.ly === b.ly && a.rx === b.rx && a.ry === b.ry;
export const auRepos = (e: EtatManette) => egal(e, REPOS);

export const estToucheConnue = (code: string, clavier: Partial<Record<Sortie, string>>) =>
  SORTIES.some((s) => clavier[s] === code);
