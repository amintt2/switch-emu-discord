// Menu debug : images par seconde, latence, pings (PC de l'hôte et serveur) avec leur courbe sur une minute.
import type { Mesures } from './lecteur.ts';

const POINTS = 60;

interface Serie { nom: string; couleur: string; valeurs: (number | null)[] }

export class PanneauDebug {
  readonly racine: HTMLElement;
  private lignes: HTMLElement;
  private graphe: HTMLCanvasElement;
  private series: Serie[];

  constructor() {
    this.racine = document.createElement('div');
    this.racine.className = 'debug';
    this.racine.hidden = true;
    this.lignes = document.createElement('dl');
    this.graphe = document.createElement('canvas');
    this.graphe.width = 520;
    this.graphe.height = 150;
    const legende = document.createElement('div');
    legende.className = 'legende';
    const css = getComputedStyle(document.documentElement);
    this.series = [
      { nom: 'ping PC', couleur: css.getPropertyValue('--accent-2').trim() || '#00a2e8', valeurs: [] },
      { nom: 'ping serveur', couleur: css.getPropertyValue('--ok').trim() || '#3ecf8e', valeurs: [] },
      { nom: 'latence image', couleur: '#f5c451', valeurs: [] },
    ];
    for (const s of this.series) {
      const l = document.createElement('span');
      l.style.setProperty('--c', s.couleur);
      l.textContent = s.nom;
      legende.append(l);
    }
    this.racine.append(this.lignes, this.graphe, legende);
  }

  get ouvert() { return !this.racine.hidden; }
  set ouvert(v: boolean) { this.racine.hidden = !v; }

  /** Ligne « Son » (fournie par la page). */
  son = '…';

  maj(m: Mesures | null, pingServeur: number | null) {
    const valeurs = [m?.pingPc ?? null, pingServeur, m?.image ?? null];
    this.series.forEach((s, i) => { s.valeurs.push(valeurs[i]); if (s.valeurs.length > POINTS) s.valeurs.shift(); });
    if (!this.ouvert) return;
    const ms = (v: number | null | undefined) => (v === null || v === undefined ? '…' : `${v} ms`);
    const lignes: [string, string, string?][] = [
      ['Images/s', m ? String(m.ips) : '…', m && m.ips < 50 && m.ips > 0 ? 'moyen' : ''],
      ['Latence image', ms(m?.image), qualite(m?.image, 60, 100)],
      ['Ping PC hôte', ms(m?.pingPc), qualite(m?.pingPc, 60, 120)],
      ['Ping serveur', ms(pingServeur), qualite(pingServeur, 80, 160)],
      ['Débit', m ? `${(m.debit / 1000).toFixed(1)} Mbit/s` : '…'],
      ['Qualité', m?.qualite || '…'],
      ['Image', m && m.largeur ? `${m.largeur}×${m.hauteur}` : '…'],
      ['Décodeur', m ? `${m.codec || '…'} (${m.decodeur}), file ${m.file}` : '…'],
      ['Sautées / clés', m ? `${m.jetees} / ${m.cles}` : '…', m && m.jetees ? 'moyen' : ''],
      ['Son', this.son],
      ['Relais', m?.relais || '…'],
      ['Reconnexions', m ? String(m.reconnexions) : '…', m && m.reconnexions ? 'moyen' : ''],
    ];
    this.lignes.replaceChildren(...lignes.flatMap(([k, v, c]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      if (c) dd.className = c;
      return [dt, dd];
    }));
    this.dessiner();
  }

  private dessiner() {
    const g = this.graphe.getContext('2d')!;
    const { width: l, height: h } = this.graphe;
    g.clearRect(0, 0, l, h);
    const toutes = this.series.flatMap((s) => s.valeurs.filter((v): v is number => v !== null));
    const max = Math.max(100, ...toutes) * 1.15;
    // Repères : 50 ms, 100 ms, puis chaque 100 ms
    g.font = '18px ui-monospace, monospace';
    g.fillStyle = 'rgba(255,255,255,.45)';
    g.strokeStyle = 'rgba(255,255,255,.12)';
    g.lineWidth = 1;
    for (const r of [50, 100, 200, 300, 500, 1000].filter((r) => r < max)) {
      const y = h - (r / max) * h;
      g.beginPath(); g.moveTo(0, y); g.lineTo(l, y); g.stroke();
      g.fillText(`${r}`, 4, y - 4);
    }
    g.lineWidth = 3;
    for (const s of this.series) {
      g.strokeStyle = s.couleur;
      g.beginPath();
      let enCours = false;
      s.valeurs.forEach((v, i) => {
        const x = (i + POINTS - s.valeurs.length) * (l / (POINTS - 1));
        if (v === null) { enCours = false; return; }
        const y = h - (Math.min(v, max) / max) * h;
        if (enCours) g.lineTo(x, y); else g.moveTo(x, y);
        enCours = true;
      });
      g.stroke();
    }
  }
}

function qualite(v: number | null | undefined, bon: number, moyen: number) {
  if (v === null || v === undefined) return '';
  return v <= bon ? 'bon' : v <= moyen ? 'moyen' : 'mauvais';
}
