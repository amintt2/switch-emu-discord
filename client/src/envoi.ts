// Envoie l'état de la manette du joueur à l'hôte : à chaque changement, et toutes les 100 ms pour qu'il
// sache qu'on est là. Rien n'est envoyé tant que la personne n'a pas touché sa manette ou son clavier :
// un simple spectateur ne prend pas de manette.
import { auRepos, depuisClavier, depuisGamepad, egal, estToucheConnue, fusionner, REPOS, type EtatManette } from './manette.ts';
import { profilPour, type Reglages } from './reglages.ts';

export interface ManetteVue { id: string; nom: string; standard: boolean; profilPerso: boolean }

export class EnvoiManette {
  private touches = new Set<string>();
  private dernier: EtatManette = REPOS;
  private dernierEnvoi = 0;
  private seq = 0;
  private actif = false;
  private timer = 0;
  private raf = 0;
  /** Quand l'assistant de réglage écoute la manette, on n'envoie rien au jeu. */
  enPause = false;
  manettes: ManetteVue[] = [];
  /** Vrai quand le joueur a une place (sinon il est spectateur : rien n'est envoyé). */
  peutJouer: () => boolean = () => true;
  /** Appelé quand un spectateur touche sa manette : on peut lui proposer une place (au plus toutes les 3 s). */
  surEnvieDeJouer: () => void = () => {};
  private derniereEnvie = 0;
  private envoyer: (m: object) => void;
  private reglages: () => Reglages;
  private surChangement: () => void;

  constructor(envoyer: (m: object) => void, reglages: () => Reglages, surChangement: () => void) {
    this.envoyer = envoyer;
    this.reglages = reglages;
    this.surChangement = surChangement;
  }

  demarrer() {
    addEventListener('keydown', this.bas);
    addEventListener('keyup', this.haut);
    addEventListener('blur', this.relacher);
    addEventListener('gamepadconnected', this.surChangement);
    addEventListener('gamepaddisconnected', this.surChangement);
    const boucle = () => { this.tick(); this.raf = requestAnimationFrame(boucle); };
    this.raf = requestAnimationFrame(boucle);
    this.timer = window.setInterval(() => this.tick(), 50);  // continue même si l'affichage ralentit
  }

  arreter() {
    removeEventListener('keydown', this.bas);
    removeEventListener('keyup', this.haut);
    removeEventListener('blur', this.relacher);
    removeEventListener('gamepadconnected', this.surChangement);
    removeEventListener('gamepaddisconnected', this.surChangement);
    cancelAnimationFrame(this.raf);
    clearInterval(this.timer);
    if (this.actif) this.envoyer({ type: 'manette', s: ++this.seq, ...REPOS });
  }

  private bas = (e: KeyboardEvent) => {
    if (this.enPause || (e.target as HTMLElement)?.tagName === 'INPUT') return;
    if (this.reglages().entree === 'manette') return;
    if (!estToucheConnue(e.code, this.reglages().clavier)) return;
    e.preventDefault();
    this.touches.add(e.code);
    this.tick();
  };
  private haut = (e: KeyboardEvent) => { this.touches.delete(e.code); this.tick(); };
  private relacher = () => { this.touches.clear(); this.tick(); };

  private tick() {
    const r = this.reglages();
    const entree = r.entree ?? 'tout';
    const sources = entree === 'manette' ? [] : [depuisClavier(this.touches, r.clavier)];
    const vues: ManetteVue[] = [];
    for (const g of navigator.getGamepads?.() ?? []) {
      if (!g || !g.connected) continue;
      if (entree !== 'clavier') sources.push(depuisGamepad(g, profilPour(r, g.id)));
      vues.push({ id: g.id, nom: g.id.replace(/\s*\(.*\)\s*$/, '') || 'Manette', standard: g.mapping === 'standard', profilPerso: !!r.manettes[g.id] });
    }
    if (vues.map((v) => v.id).join() !== this.manettes.map((v) => v.id).join()) {
      this.manettes = vues;
      this.surChangement();
    }
    if (this.enPause) return;
    const etat = fusionner(...sources);
    if (!this.peutJouer()) {
      // Spectateur : on n'envoie rien. S'il touche sa manette, on peut lui proposer une place.
      if (!auRepos(etat) && performance.now() - this.derniereEnvie > 3000) {
        this.derniereEnvie = performance.now();
        this.surEnvieDeJouer();
      }
      if (this.actif) { this.actif = false; this.envoyer({ type: 'manette', s: ++this.seq, ...REPOS }); }
      return;
    }
    if (!this.actif) {
      if (auRepos(etat)) return;
      this.actif = true;
      this.surChangement();
    }
    const now = performance.now();
    if (egal(etat, this.dernier) && now - this.dernierEnvoi < 100) return;
    this.dernier = etat;
    this.dernierEnvoi = now;
    this.envoyer({ type: 'manette', s: ++this.seq, ...etat });
  }
}
