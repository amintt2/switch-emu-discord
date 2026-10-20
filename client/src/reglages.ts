// Réglages des touches de chaque joueur (enregistrés sur son appareil) : quelle touche du clavier et quel
// bouton ou axe de sa manette produisent chaque commande de la manette Xbox virtuelle sur le PC de l'hôte.
//
// Une « source » de manette s'écrit "b3" (bouton 3) ou "a1-" / "a1+" (axe 1, côté négatif ou positif) :
// ça couvre les manettes en disposition « standard » comme les manettes génériques, dont la croix ou
// les gâchettes sont souvent des axes. Chaque modèle de manette (identifiant du navigateur) peut avoir
// son propre profil.

export type Sortie =
  | 'a' | 'b' | 'x' | 'y' | 'lb' | 'rb' | 'lt' | 'rt' | 'start' | 'back' | 'l3' | 'r3'
  | 'haut' | 'bas' | 'gauche' | 'droite'
  | 'ly+' | 'ly-' | 'lx-' | 'lx+' | 'ry+' | 'ry-' | 'rx-' | 'rx+';

export type Profil = Partial<Record<Sortie, string>>;

export interface Reglages {
  version: 2;
  /** commande -> event.code (position physique de la touche) */
  clavier: Partial<Record<Sortie, string>>;
  /** "standard" (toutes les manettes reconnues) ou identifiant d'un modèle -> profil */
  manettes: Record<string, Profil>;
}

/** Libellés : nom Xbox / nom Switch. */
export const LIBELLES: Record<Sortie, string> = {
  a: 'A (bas)', b: 'B (droite)', x: 'X (gauche)', y: 'Y (haut)',
  lb: 'LB / L', rb: 'RB / R', lt: 'LT / ZL', rt: 'RT / ZR',
  start: 'Start / +', back: 'Select / −', l3: 'Clic stick gauche', r3: 'Clic stick droit',
  haut: 'Croix haut', bas: 'Croix bas', gauche: 'Croix gauche', droite: 'Croix droite',
  'ly+': 'Stick gauche haut', 'ly-': 'Stick gauche bas', 'lx-': 'Stick gauche gauche', 'lx+': 'Stick gauche droite',
  'ry+': 'Stick droit haut', 'ry-': 'Stick droit bas', 'rx-': 'Stick droit gauche', 'rx+': 'Stick droit droite',
};
export const SORTIES = Object.keys(LIBELLES) as Sortie[];

export const PROFIL_STANDARD: Profil = {
  a: 'b0', b: 'b1', x: 'b2', y: 'b3', lb: 'b4', rb: 'b5', lt: 'b6', rt: 'b7',
  back: 'b8', start: 'b9', l3: 'b10', r3: 'b11', haut: 'b12', bas: 'b13', gauche: 'b14', droite: 'b15',
  'lx-': 'a0-', 'lx+': 'a0+', 'ly+': 'a1-', 'ly-': 'a1+', 'rx-': 'a2-', 'rx+': 'a2+', 'ry+': 'a3-', 'ry-': 'a3+',
};

export const CLAVIER_DEFAUT: Partial<Record<Sortie, string>> = {
  'ly+': 'KeyW', 'ly-': 'KeyS', 'lx-': 'KeyA', 'lx+': 'KeyD',
  haut: 'ArrowUp', bas: 'ArrowDown', gauche: 'ArrowLeft', droite: 'ArrowRight',
  a: 'KeyK', b: 'KeyL', x: 'KeyJ', y: 'KeyI',
  lb: 'KeyU', rb: 'KeyO', lt: 'KeyY', rt: 'KeyP',
  start: 'Enter', back: 'Backspace', l3: 'KeyF', r3: 'KeyH',
  'ry+': 'Numpad8', 'ry-': 'Numpad5', 'rx-': 'Numpad4', 'rx+': 'Numpad6',
};

export const reglagesDefaut = (): Reglages => ({ version: 2, clavier: { ...CLAVIER_DEFAUT }, manettes: { standard: { ...PROFIL_STANDARD } } });

const CLE = 'switch-emu.reglages';
const SOURCE = /^(b\d{1,2}|a\d{1,2}[+-])$/;
const TOUCHE = /^[A-Za-z0-9]{1,24}$/;

/** Le profil à utiliser pour une manette : le sien s'il existe, sinon le profil standard. */
export function profilPour(r: Reglages, id: string): Profil {
  return r.manettes[id] ?? r.manettes.standard ?? PROFIL_STANDARD;
}

/** Vérifie des réglages lus sur disque : tout ce qui est inconnu ou invalide est écarté. */
export function nettoyer(brut: unknown): Reglages {
  const r = reglagesDefaut();
  if (!brut || typeof brut !== 'object' || (brut as Reglages).version !== 2) return r;
  const b = brut as Reglages;
  if (b.clavier && typeof b.clavier === 'object') {
    r.clavier = {};
    for (const s of SORTIES) if (typeof b.clavier[s] === 'string' && TOUCHE.test(b.clavier[s]!)) r.clavier[s] = b.clavier[s];
  }
  if (b.manettes && typeof b.manettes === 'object') {
    for (const [id, p] of Object.entries(b.manettes).slice(0, 32)) {
      if (id.length > 200 || !p || typeof p !== 'object') continue;
      const propre: Profil = {};
      for (const s of SORTIES) if (typeof p[s] === 'string' && SOURCE.test(p[s]!)) propre[s] = p[s];
      r.manettes[id] = propre;
    }
  }
  return r;
}

export function charger(): Reglages {
  try { return nettoyer(JSON.parse(localStorage.getItem(CLE) || 'null')); } catch { return reglagesDefaut(); }
}

export function enregistrer(r: Reglages) {
  try { localStorage.setItem(CLE, JSON.stringify(r)); } catch { /* stockage indisponible : valable pour cette session */ }
}

/** Attribue une touche du clavier à une commande ; une touche ne sert qu'à une commande à la fois. */
export function attribuerTouche(r: Reglages, sortie: Sortie, code: string): Reglages {
  const clavier = { ...r.clavier };
  for (const s of SORTIES) if (clavier[s] === code) delete clavier[s];
  clavier[sortie] = code;
  return { ...r, clavier };
}

/** Attribue une source (bouton ou demi-axe) d'une manette à une commande ; si elle servait déjà, les deux s'échangent. */
export function attribuerSource(r: Reglages, id: string, sortie: Sortie, source: string): Reglages {
  const p: Profil = { ...profilPour(r, id) };
  const ancienne = p[sortie];
  for (const s of SORTIES) if (s !== sortie && p[s] === source) {
    if (ancienne) p[s] = ancienne;
    else delete p[s];
  }
  p[sortie] = source;
  return { ...r, manettes: { ...r.manettes, [id]: p } };
}

/** Disposition Nintendo : A↔B et X↔Y. */
export function inverserABXY(r: Reglages, id: string): Reglages {
  const p: Profil = { ...profilPour(r, id) };
  [p.a, p.b] = [p.b, p.a];
  [p.x, p.y] = [p.y, p.x];
  return { ...r, manettes: { ...r.manettes, [id]: p } };
}

/** Inverse l'axe vertical d'un stick. */
export function inverserStick(r: Reglages, id: string, stick: 'gauche' | 'droit'): Reglages {
  const p: Profil = { ...profilPour(r, id) };
  const [h, b] = stick === 'gauche' ? (['ly+', 'ly-'] as const) : (['ry+', 'ry-'] as const);
  [p[h], p[b]] = [p[b], p[h]];
  return { ...r, manettes: { ...r.manettes, [id]: p } };
}

export function oublierManette(r: Reglages, id: string): Reglages {
  const manettes = { ...r.manettes };
  delete manettes[id];
  return { ...r, manettes };
}

export function retablirClavier(r: Reglages): Reglages {
  return { ...r, clavier: { ...CLAVIER_DEFAUT } };
}
