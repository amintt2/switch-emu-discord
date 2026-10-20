// Écran « Personnaliser les touches » : réglages de la manette (par modèle) et du clavier, avec un assistant
// qui écoute le prochain bouton / axe bougé ou la prochaine touche.
import type { EnvoiManette } from './envoi.ts';
import { instantane, nomSource, sourceBougee } from './manette.ts';
import {
  attribuerSource, attribuerTouche, inverserABXY, inverserStick, LIBELLES, oublierManette, profilPour,
  retablirClavier, SORTIES, type Reglages, type Sortie,
} from './reglages.ts';

let nomsTouches: Map<string, string> | null = null;
// Sur Chrome, on peut afficher la vraie lettre de la touche selon la disposition du clavier (AZERTY…).
(navigator as any).keyboard?.getLayoutMap?.().then((m: Map<string, string>) => (nomsTouches = m)).catch(() => {});

const NOMS: Record<string, string> = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: 'Entrée', Backspace: 'Retour',
  Space: 'Espace', ShiftLeft: 'Maj gauche', ShiftRight: 'Maj droite', ControlLeft: 'Ctrl gauche', Tab: 'Tab',
};
export function nomTouche(code: string | undefined) {
  if (!code) return '—';
  if (NOMS[code]) return NOMS[code];
  const lettre = nomsTouches?.get(code);
  if (lettre) return lettre.toUpperCase();
  return code.replace(/^Key|^Digit/, '').replace(/^Numpad/, 'Pavé ');
}

export function ouvrirReglages(envoi: EnvoiManette, lire: () => Reglages, ecrire: (r: Reglages) => void) {
  const dlg = document.createElement('dialog');
  dlg.className = 'reglages';
  document.body.append(dlg);
  let onglet: 'manette' | 'clavier' = envoi.manettes.length ? 'manette' : 'clavier';
  let idChoisi = envoi.manettes[0]?.id ?? '';
  let ecoute: (() => void) | null = null;  // arrête l'écoute en cours

  const fermer = () => { ecoute?.(); envoi.enPause = false; dlg.close(); dlg.remove(); };
  dlg.addEventListener('cancel', (e) => { if (ecoute) { e.preventDefault(); ecoute(); rendre(); } });

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...enfants: (Node | string)[]): HTMLElementTagNameMap[K] => {
    const n = Object.assign(document.createElement(tag), props) as HTMLElementTagNameMap[K];
    n.append(...enfants);
    return n;
  };
  const bouton = (texte: string, action: () => void, classe = 'secondaire') => el('button', { textContent: texte, className: classe, type: 'button', onclick: action });

  /** Attend le prochain bouton ou axe bougé sur la manette choisie. */
  function ecouterManette(sortie: Sortie, ensuite?: () => void) {
    ecoute?.();
    const g0 = [...(navigator.getGamepads?.() ?? [])].find((g) => g?.id === idChoisi);
    if (!g0) return;
    const repos = instantane(g0);
    envoi.enPause = true;
    let raf = 0;
    const delai = setTimeout(() => { arret(); rendre(); }, 10_000);
    const arret = () => { cancelAnimationFrame(raf); clearTimeout(delai); envoi.enPause = false; ecoute = null; };
    ecoute = arret;
    const boucle = () => {
      const g = [...(navigator.getGamepads?.() ?? [])].find((x) => x?.id === idChoisi);
      const src = g && sourceBougee(g, repos);
      if (src) {
        arret();
        ecrire(attribuerSource(lire(), idChoisi, sortie, src));
        // On attend que tout soit relâché avant la commande suivante de l'assistant.
        const attendre = () => {
          const g2 = [...(navigator.getGamepads?.() ?? [])].find((x) => x?.id === idChoisi);
          if (g2 && sourceBougee(g2, repos)) { raf = requestAnimationFrame(attendre); return; }
          if (ensuite) ensuite(); else rendre();
        };
        raf = requestAnimationFrame(attendre);
        return;
      }
      raf = requestAnimationFrame(boucle);
    };
    raf = requestAnimationFrame(boucle);
    rendre(sortie);
  }

  function ecouterClavier(sortie: Sortie) {
    ecoute?.();
    envoi.enPause = true;
    const sur = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      arret();
      if (e.code !== 'Escape') ecrire(attribuerTouche(lire(), sortie, e.code));
      rendre();
    };
    const arret = () => { removeEventListener('keydown', sur, true); envoi.enPause = false; ecoute = null; };
    ecoute = arret;
    addEventListener('keydown', sur, true);
    rendre(sortie);
  }

  function assistant(i = 0) {
    if (i >= SORTIES.length) { rendre(); return; }
    ecouterManette(SORTIES[i], () => assistant(i + 1));
  }

  function rendre(enAttente?: Sortie) {
    const r = lire();
    const corps: Node[] = [];
    const onglets = el('div', { className: 'onglets' },
      bouton('Manette', () => { ecoute?.(); onglet = 'manette'; rendre(); }, onglet === 'manette' ? '' : 'secondaire'),
      bouton('Clavier', () => { ecoute?.(); onglet = 'clavier'; rendre(); }, onglet === 'clavier' ? '' : 'secondaire'));
    corps.push(el('h2', { textContent: 'Personnaliser les touches' }), onglets);

    if (onglet === 'manette') {
      if (!envoi.manettes.length) {
        corps.push(el('p', { textContent: 'Aucune manette détectée. Branche-la (ou allume-la), puis appuie sur un bouton : elle apparaîtra ici.' }));
      } else {
        if (!envoi.manettes.some((m) => m.id === idChoisi)) idChoisi = envoi.manettes[0].id;
        const choix = el('select', { onchange: () => { idChoisi = choix.value; rendre(); } });
        for (const m of envoi.manettes) choix.append(el('option', { value: m.id, textContent: m.nom, selected: m.id === idChoisi }));
        const vue = envoi.manettes.find((m) => m.id === idChoisi)!;
        corps.push(choix, el('p', {
          textContent: vue.standard
            ? 'Manette reconnue automatiquement. Tu peux quand même changer ses boutons.'
            : vue.profilPerso ? 'Réglage personnalisé pour cette manette.' : 'Cette manette n’est pas reconnue automatiquement : lance l’assistant pour la configurer.',
        }));
        corps.push(el('div', { className: 'ligne-boutons' },
          bouton('Configurer toute la manette', () => assistant(), vue.standard ? 'secondaire' : ''),
          bouton('Disposition Nintendo (A↔B, X↔Y)', () => { ecrire(inverserABXY(lire(), idChoisi)); rendre(); }),
          bouton('Inverser stick gauche ↕', () => { ecrire(inverserStick(lire(), idChoisi, 'gauche')); rendre(); }),
          bouton('Inverser stick droit ↕', () => { ecrire(inverserStick(lire(), idChoisi, 'droit')); rendre(); }),
          bouton('Revenir au réglage d’origine', () => { ecrire(oublierManette(lire(), idChoisi)); rendre(); })));
        const profil = profilPour(r, idChoisi);
        const table = el('table');
        for (const s of SORTIES) {
          const attente = enAttente === s;
          table.append(el('tr', { className: attente ? 'attente' : '' },
            el('td', { textContent: LIBELLES[s] }),
            el('td', { textContent: attente ? 'Appuie sur un bouton ou bouge un stick…' : nomSource(profil[s]) }),
            el('td', {}, bouton('Changer', () => ecouterManette(s)))));
        }
        corps.push(table);
      }
    } else {
      corps.push(el('p', { textContent: 'Clique « Changer » puis appuie sur la touche voulue (Échap pour annuler).' }));
      const table = el('table');
      for (const s of SORTIES) {
        const attente = enAttente === s;
        table.append(el('tr', { className: attente ? 'attente' : '' },
          el('td', { textContent: LIBELLES[s] }),
          el('td', {}, attente ? 'Appuie sur une touche…' : el('kbd', { textContent: nomTouche(r.clavier[s]) })),
          el('td', {}, bouton('Changer', () => ecouterClavier(s)))));
      }
      corps.push(table, el('div', { className: 'ligne-boutons' }, bouton('Rétablir les touches d’origine', () => { ecrire(retablirClavier(lire())); rendre(); })));
    }
    corps.push(el('div', { className: 'pied' }, bouton('Fermer', fermer, '')));
    dlg.replaceChildren(...corps);
  }

  rendre();
  dlg.showModal();
}
