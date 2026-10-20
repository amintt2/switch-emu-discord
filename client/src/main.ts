import './style.css';
import { api, getSession, wsUrl, type Utilisateur } from './api.ts';
import { dansDiscord, seConnecter } from './auth.ts';
import { Lecteur, type Flux, type Stats } from './lecteur.ts';

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
    actions.append(texte('Tu héberges : tes amis voient l’écran de ton PC.'), bouton('Arrêter', () => envoyer({ type: 'arreter' }), true));
  } else if (!salle.hote) {
    if (m.agent === 'en-ligne') {
      actions.append(texte('Ton PC est prêt.'), bouton('Héberger depuis mon PC', () => envoyer({ type: 'heberger' })));
    } else {
      actions.append(texte('Pour héberger, lance l’agent Switch EMU sur ton PC Windows.'));
      if (formulaireOuvert) actions.append(formulaireCode());
      else actions.append(bouton('Lier mon PC', () => { formulaireOuvert = true; afficher(); }, true));
    }
  }

  // La scène
  if (jeSuisHote) voile('Tu héberges la partie', 'Tes amis voient l’écran de ton PC. Joue directement sur ton PC.');
  else if (!salle.hote) voile('Personne n’héberge pour l’instant', 'Celui qui a le jeu sur son PC clique « Héberger depuis mon PC ».');
  else if (salle.hote.absent) voile(`${salle.hote.nom} s’est absenté…`, 'La partie reprend s’il revient dans les 30 secondes.');

  // Le flux
  if (etat.flux && !lecteur) demarrerLecteur(etat.flux);
  else if (!etat.flux && lecteur) { lecteur.arreter(); lecteur = null; $('stats').hidden = true; }
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
  lecteur.demarrer(flux);
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
