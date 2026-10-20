import './style.css';
import { api, getSession, wsUrl, type Utilisateur } from './api.ts';
import { dansDiscord, seConnecter } from './auth.ts';
import { Lecteur, type Flux, type Stats } from './lecteur.ts';
import { EnvoiManette } from './envoi.ts';
import { ouvrirReglages } from './ecranReglages.ts';
import { charger, enregistrer, type Reglages } from './reglages.ts';

interface Participant extends Utilisateur { hote: boolean }
interface EtatSalle {
  salle: { participants: Participant[]; hote: { uid: string; nom: string; absent: boolean } | null };
  moi: { agent: 'en-ligne' | 'absent' };
  flux: Flux | null;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let moi: Utilisateur;
let ws: WebSocket | null = null;
let etat: EtatSalle | null = null;
let lecteur: Lecteur | null = null;
let attenteJeton: ((f: Flux) => void) | null = null;
let formulaireOuvert = false;
let apercu = false;  // l'hôte peut regarder son propre flux (et jouer depuis cet appareil)
let envoiManette: EnvoiManette | null = null;
let maPlace: { joueur: number; raison?: string } | null = null;
let reglages: Reglages = charger();

function toast(texte: string) {
  const t = $('toast');
  t.textContent = texte;
  t.hidden = false;
  clearTimeout((toast as any).timer);
  (toast as any).timer = setTimeout(() => (t.hidden = true), 5000);
}

function voile(titre: string | null, texte = '') {
  const v = $('voile');
  if (titre === null) { v.hidden = true; return; }
  v.hidden = false;
  $('message').innerHTML = '';
  const b = document.createElement('strong');
  b.textContent = titre;
  $('message').append(b, document.createTextNode(texte));
}

function avatar(p: Utilisateur) {
  const d = document.createElement('span');
  d.className = 'avatar';
  if (p.avatar) {
    const img = document.createElement('img');
    img.src = p.avatar;
    img.alt = '';
    img.onerror = () => { img.remove(); d.textContent = p.nom.slice(0, 1).toUpperCase(); };
    d.append(img);
  } else d.textContent = p.nom.slice(0, 1).toUpperCase();
  return d;
}

function afficher() {
  if (!etat) return;
  const { salle, moi: m } = etat;
  const ul = $('participants');
  ul.replaceChildren(...salle.participants.map((p) => {
    const li = document.createElement('li');
    const nom = document.createElement('span');
    nom.className = 'nom';
    nom.textContent = p.uid === moi.uid ? `${p.nom} (toi)` : p.nom;
    li.append(avatar(p), nom);
    if (p.hote) { const b = document.createElement('span'); b.className = 'badge'; b.textContent = 'Hôte'; li.append(b); }
    return li;
  }));

  const actions = $('actions');
  actions.replaceChildren();
  const jeSuisHote = salle.hote?.uid === moi.uid;
  if (jeSuisHote) {
    actions.append(
      texte('Tu héberges : tes amis voient l’écran de ton PC.'),
      bouton(apercu ? 'Masquer l’aperçu' : 'Voir l’aperçu', () => { apercu = !apercu; afficher(); }, true),
      bouton('Arrêter', () => { apercu = false; envoyer({ type: 'arreter' }); }, true),
    );
  } else if (!salle.hote) {
    if (m.agent === 'en-ligne') {
      actions.append(texte('Ton PC est prêt.'), bouton('Héberger depuis mon PC', () => envoyer({ type: 'heberger' })));
    } else {
      actions.append(texte('Pour héberger, lance l’agent Switch EMU sur ton PC Windows.'));
      if (formulaireOuvert) actions.append(formulaireCode());
      else actions.append(bouton('Lier mon PC', () => { formulaireOuvert = true; afficher(); }, true));
    }
  }

  if (lecteur) actions.prepend(blocManette());

  // La scène
  if (jeSuisHote && !apercu) voile('Tu héberges la partie', 'Tes amis voient l’écran de ton PC. Joue directement sur ton PC. « Voir l’aperçu » montre ce qu’ils reçoivent.');
  else if (!salle.hote) voile('Personne n’héberge pour l’instant', 'Celui qui a le jeu sur son PC clique « Héberger depuis mon PC ».');
  else if (salle.hote.absent) voile(`${salle.hote.nom} s’est absenté…`, 'La partie reprend s’il revient dans les 30 secondes.');

  // Le flux
  const regarder = etat.flux && (!jeSuisHote || apercu);
  if (regarder && !lecteur) demarrerLecteur(etat.flux!);
  else if (!regarder && lecteur) arreterLecteur();
  if (etat.flux && attenteJeton) { attenteJeton(etat.flux); attenteJeton = null; }
}

function texte(t: string) { const p = document.createElement('p'); p.textContent = t; return p; }
function bouton(t: string, action: () => void, secondaire = false) {
  const b = document.createElement('button');
  b.textContent = t;
  if (secondaire) b.className = 'secondaire';
  b.onclick = action;
  return b;
}

function formulaireCode() {
  const f = document.createElement('form');
  f.className = 'code';
  const input = document.createElement('input');
  input.placeholder = 'ABCD-EFGH';
  input.maxLength = 9;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'Code affiché par l’agent');
  const ok = document.createElement('button');
  ok.textContent = 'Lier';
  f.append(input, ok);
  f.onsubmit = async (e) => {
    e.preventDefault();
    ok.disabled = true;
    try {
      await api('/api/jumelage', { method: 'POST', body: JSON.stringify({ code: input.value }) });
      formulaireOuvert = false;
      toast('PC lié ! Il apparaît dans quelques secondes.');
    } catch (err) { toast((err as Error).message); }
    ok.disabled = false;
  };
  setTimeout(() => input.focus());
  return f;
}

function demarrerLecteur(flux: Flux) {
  const canvas = $<HTMLCanvasElement>('ecran');
  lecteur = new Lecteur(
    canvas,
    dansDiscord(),
    (e, detail) => {
      const nom = etat?.salle.hote?.nom || 'l’hôte';
      if (e === 'lecture') voile(null);
      else if (e === 'connexion') voile(`Connexion au PC de ${nom}…`, detail || '');
      else if (e === 'attente-image') voile(`Connecté au PC de ${nom}`, detail || 'L’image arrive…');
      else voile('Connexion coupée', detail || '');
    },
    (s: Stats) => afficherStats(s),
    () => new Promise<Flux>((resolve, reject) => {
      attenteJeton = resolve;
      envoyer({ type: 'jeton' });
      setTimeout(() => reject(new Error('pas de jeton')), 8000);
    }),
  );
  lecteur.surPlace = (joueur, raison) => { maPlace = { joueur, raison }; majManette(); };
  envoiManette = new EnvoiManette((m) => lecteur?.envoyerCommande(m), () => reglages, () => majManette());
  envoiManette.demarrer();
  lecteur.demarrer(flux);
  afficher();
}

function arreterLecteur() {
  envoiManette?.arreter();
  envoiManette = null;
  maPlace = null;
  lecteur?.arreter();
  lecteur = null;
  $('stats').hidden = true;
}

/** Encadré « ta manette » : place obtenue, manette détectée, aide pour le clavier. */
function blocManette() {
  const d = document.createElement('div');
  d.id = 'manette';
  d.className = 'manette';
  remplirManette(d);
  return d;
}

function majManette() {
  const d = document.getElementById('manette');
  if (d) remplirManette(d);
}

function remplirManette(d: HTMLElement) {
  const manettes = envoiManette?.manettes ?? [];
  const titre = document.createElement('strong');
  const detail = document.createElement('p');
  if (maPlace && maPlace.joueur > 0) {
    titre.textContent = `Tu joues : J${maPlace.joueur}`;
    detail.textContent = manettes.length ? `Manette : ${manettes.map((m) => m.nom).join(', ')}` : 'Au clavier (ou branche une manette).';
  } else if (maPlace?.raison) {
    titre.textContent = 'Pas de manette pour toi';
    detail.textContent = maPlace.raison;
  } else {
    titre.textContent = 'Pour jouer';
    detail.textContent = manettes.length ? `${manettes[0].nom} détectée : appuie sur un bouton.` : 'Appuie sur un bouton de ta manette, ou sur une touche du clavier.';
  }
  const enfants: Node[] = [titre, detail];
  const inconnue = manettes.find((m) => !m.standard && !m.profilPerso);
  if (inconnue) {
    const p = document.createElement('p');
    p.className = 'alerte';
    p.textContent = `« ${inconnue.nom} » n’est pas reconnue automatiquement : configure ses boutons.`;
    enfants.push(p);
  }
  const perso = document.createElement('button');
  perso.className = 'secondaire';
  perso.textContent = 'Personnaliser les touches';
  perso.onclick = () => envoiManette && ouvrirReglages(envoiManette, () => reglages, (r) => { reglages = r; enregistrer(r); majManette(); });
  enfants.push(perso);
  d.replaceChildren(...enfants);
}

function afficherStats(s: Stats) {
  const el = $('stats');
  el.hidden = false;
  el.classList.toggle('lent', (s.image ?? 0) > 80);
  el.innerHTML = '';
  const part = (label: string, valeur: string) => { const b = document.createElement('b'); b.textContent = valeur; el.append(`${label} `, b, '  '); };
  part('image', s.image === null ? '…' : `${s.image} ms`);
  part('réseau', s.allerRetour === null ? '…' : `${s.allerRetour} ms`);
  part('', `${s.ips} i/s`);
  el.title = `Relais : ${s.relais}. « image » = retard entre la capture sur le PC de l’hôte et l’affichage ici.`;
}

function envoyer(m: object) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

function connecterSalle(essai = 0) {
  ws = new WebSocket(wsUrl(`/api/salle?session=${encodeURIComponent(getSession())}`));
  ws.onopen = () => { essai = 0; };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'etat') { etat = m; afficher(); }
    else if (m.type === 'erreur') toast(m.texte);
  };
  ws.onclose = (e) => {
    if (e.code === 4001) { voile('Session expirée', 'Relance l’Activité.'); return; }
    voile('Connexion au serveur perdue', 'Reconnexion…');
    setTimeout(() => connecterSalle(essai + 1), Math.min(10_000, 1000 * 2 ** essai));
  };
}

async function main() {
  try {
    const id = await seConnecter();
    moi = id.user;
    voile('Connecté', `Bonjour ${moi.nom} !`);
    connecterSalle();
  } catch (e) {
    voile('Impossible de démarrer', (e as Error).message);
  }
}
main();
