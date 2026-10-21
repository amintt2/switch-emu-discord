// Qualité adaptative : 1080p tant que la connexion suit, 720p dès qu'elle peine. La fluidité passe
// avant la définition. On redescend vite (3 mauvaises secondes sur 5) et on remonte prudemment
// (30 s sans souci, puis deux fois plus longtemps à chaque essai raté).

export type Choix = 'auto' | '1080' | '720';
export const HAUTE = 0;
export const BASSE = 1;

export interface Seconde {
  image: number | null;   // retard capture → affichage (ms)
  jetees: number;         // images sautées
  ips: number;
}

const FENETRE = 5;
const MAUVAISES_MAX = 3;
const MARGE_MS = 45;          // retard au-dessus du meilleur retard récent : la connexion sature
const ESSAI_MIN_S = 30;
const ESSAI_MAX_S = 240;
const ECHEC_RAPIDE_S = 15;    // redescendre si vite après être remonté = essai raté

export class Adaptation {
  couche = HAUTE;
  private recentes: boolean[] = [];
  private meilleurs: number[] = [];
  private bonnesDepuis = 0;   // secondes sans souci en 720p
  private attente = ESSAI_MIN_S;
  private remonteeIl = Infinity;

  choix: Choix;

  constructor(choix: Choix = 'auto') {
    this.choix = choix;
    if (choix === '720') this.couche = BASSE;
  }

  definir(choix: Choix) {
    this.choix = choix;
    if (choix !== 'auto') this.couche = choix === '720' ? BASSE : HAUTE;
    this.recentes = [];
    this.bonnesDepuis = 0;
  }

  /** Une seconde de mesures ; renvoie la couche voulue. */
  seconde(s: Seconde): number {
    if (this.choix !== 'auto') return this.couche;
    this.remonteeIl++;
    if (s.image !== null) {
      this.meilleurs.push(s.image);
      if (this.meilleurs.length > 20) this.meilleurs.shift();
    }
    const base = this.meilleurs.length ? Math.min(...this.meilleurs) : 0;
    const mauvaise = s.jetees > 0 || (s.image !== null && s.image > base + MARGE_MS);
    this.recentes.push(mauvaise);
    if (this.recentes.length > FENETRE) this.recentes.shift();

    if (this.couche === HAUTE) {
      if (this.recentes.filter(Boolean).length >= MAUVAISES_MAX) {
        // Redescendu juste après être remonté : on attendra plus longtemps avant le prochain essai.
        this.attente = this.remonteeIl <= ECHEC_RAPIDE_S ? Math.min(ESSAI_MAX_S, this.attente * 2) : ESSAI_MIN_S;
        this.passer(BASSE);
      }
    } else {
      this.bonnesDepuis = mauvaise ? 0 : this.bonnesDepuis + 1;
      if (this.bonnesDepuis >= this.attente) {
        this.remonteeIl = 0;
        this.passer(HAUTE);
      }
    }
    return this.couche;
  }

  private passer(c: number) {
    this.couche = c;
    this.recentes = [];
    this.bonnesDepuis = 0;
    this.meilleurs = [];  // l'autre couche a son propre retard de base
  }
}
