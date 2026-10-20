import './style.css';
import { api, getSession, wsUrl, type Utilisateur } from './api.ts';
import { dansDiscord, seConnecter, type Identite } from './auth.ts';
import { Lecteur, type Etat, type Flux, type Mesures } from './lecteur.ts';
import { PanneauDebug } from './debug.ts';
import { EnvoiManette } from './envoi.ts';
import { nomTouche, ouvrirReglages } from './ecranReglages.ts';
import { charger, enregistrer, type Entree, type Reglages } from './reglages.ts';

interface Participant extends Utilisateur { hote: boolean; place: number }
interface Place { uid: string; nom: string; local: boolean; absent: boolean }
interface EtatSalle {
  salle: { participants: Participant[]; hote: { uid: string; nom: string; absent: boolean } | null; places: (Place | null)[]; jeu: string | null };
  moi: { agent: 'en-ligne' | 'absent'; jeux?: { id: string; titre: string }[] };
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
let manetteIndisponible = '';
let spectateurVoulu = false;  // le joueur a choisi de regarder : on ne lui donne pas de place tout seul
let confirmerRetrait = '';    // uid en attente de confirmation (deuxième clic)
let reglages: Reglages = charger();
let etatLecteur: { e: Etat; detail?: string } = { e: 'connexion' };
let serveurPerdu = false;     // la connexion à la salle est tombée (la vidéo, elle, peut continuer)
let pingServeur: number | null = null;
let derniereMesure: Mesures | null = null;
let identite: Identite | null = null;
let regarderAilleurs = false; // la partie est ouverte dans le navigateur : pas de vidéo ici
let connecteDepuis = 0;      // dernière (re)connexion à la salle
let arretPrevu = 0;           // minuteur : la vidéo s'arrête si la partie ne reprend pas
let placeAvant = 0;           // ma place, pour la reprendre après un redémarrage du serveur
const debug = new PanneauDebug();

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

/** Petit bandeau en haut de la vidéo : ne la cache pas (reconnexions, hôte absent…). */
function bandeau(texte: string | null) {
  const b = $('bandeau');
  b.hidden = texte === null;
  if (texte !== null) b.textContent = texte;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...enfants: (Node | string)[]): HTMLElementTagNameMap[K] {
  const n = Object.assign(document.createElement(tag), props) as HTMLElementTagNameMap[K];
  n.append(...enfants);
  return n;
}
const texte = (t: string) => el('p', { textContent: t });
const bouton = (t: string, action: () => void, secondaire = false) =>
  el('button', { textContent: t, className: secondaire ? 'secondaire' : '', type: 'button', onclick: action });

function avatar(p: { nom: string; avatar?: string | null }) {
  const d = el('span', { className: 'avatar' });
  if (p.avatar) {
    const img = el('img', { src: p.avatar, alt: '' });
    img.onerror = () => { img.remove(); d.textContent = p.nom.slice(0, 1).toUpperCase(); };
    d.append(img);
  } else d.textContent = p.nom.slice(0, 1).toUpperCase();
  return d;
}

const maPlace = () => (etat ? etat.salle.places.findIndex((p) => p?.uid === moi.uid) + 1 : 0);
const jeSuisHote = () => etat?.salle.hote?.uid === moi.uid;
/** Je joue depuis cet appareil : une place, et pas « J1 sur mon PC » pour l'hôte. */
const jeJoueIci = () => {
  const n = maPlace();
  return n > 0 && !etat!.salle.places[n - 1]!.local;
};

function prendrePlace(n: number) {
  spectateurVoulu = n === 0;
  envoyer({ type: 'place', joueur: n });
}

function afficher() {
  if (!etat) return;
  const { salle, moi: m } = etat;
  const hote = jeSuisHote();

  // Les places J1 à J4 (pendant une partie)
  $('bloc-places').hidden = !salle.hote;
  $('places').replaceChildren(...salle.places.map((p, i) => {
    const n = i + 1;
    const li = el('li', { className: p?.uid === moi.uid ? 'moi' : '' }, el('span', { className: 'joueur', textContent: `J${n}` }));
    if (!p) {
      li.append(el('span', { className: 'nom libre', textContent: 'Libre' }), bouton('Prendre', () => prendrePlace(n), true));
    } else {
      const qui = p.uid === moi.uid ? 'Toi' : p.nom;
      const ou = p.local ? (p.uid === moi.uid ? ' (sur ton PC)' : ' (sur son PC)') : '';
      li.append(el('span', { className: 'nom', textContent: qui + ou + (p.absent ? ' — déconnecté' : '') }));
      if (p.uid === moi.uid) li.append(bouton(p.local ? 'Laisser J1' : 'Quitter', () => prendrePlace(0), true));
    }
    return li;
  }));

  // Les participants (l'hôte peut retirer quelqu'un, avec un deuxième clic pour confirmer)
  $('participants').replaceChildren(...salle.participants.map((p) => {
    const li = el('li', {}, avatar(p), el('span', { className: 'nom', textContent: p.uid === moi.uid ? `${p.nom} (toi)` : p.nom }));
    if (p.hote) li.append(el('span', { className: 'badge', textContent: 'Hôte' }));
    else if (p.place) li.append(el('span', { className: 'badge joue', textContent: `J${p.place}` }));
    if (hote && p.uid !== moi.uid) {
      const confirmer = confirmerRetrait === p.uid;
      const b = bouton(confirmer ? 'Confirmer ?' : 'Retirer', () => {
        if (!confirmer) {
          confirmerRetrait = p.uid;
          afficher();
          setTimeout(() => { if (confirmerRetrait === p.uid) { confirmerRetrait = ''; afficher(); } }, 4000);
          return;
        }
        confirmerRetrait = '';
        envoyer({ type: 'exclure', uid: p.uid });
      }, !confirmer);
      b.classList.add('retirer');
      li.append(b);
    }
    return li;
  }));

  const actions = $('actions');
  actions.replaceChildren();
  if (hote) {
    actions.append(choixDuJeu(salle.jeu, m.jeux || []));
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

  // Le flux
  const regarder = etat.flux && (!hote || apercu) && !regarderAilleurs;
  if (regarder) { clearTimeout(arretPrevu); arretPrevu = 0; }
  if (regarder && !lecteur) demarrerLecteur(etat.flux!);
  else if (!regarder && lecteur && !arretPrevu) {
    // Juste après une reconnexion au serveur (redémarrage), la partie reprend en quelques secondes :
    // on garde la vidéo, qui passe par le relais, plutôt que de tout couper.
    if (Date.now() - connecteDepuis < 10_000 && !hote) arretPrevu = window.setTimeout(() => { arretPrevu = 0; if (!etat?.flux) { arreterLecteur(); afficher(); } }, 8000);
    else arreterLecteur();
  }

  // Après un redémarrage du serveur, les places sont perdues : on reprend la sienne si elle est libre.
  const n = maPlace();
  if (n) placeAvant = n;
  else if (placeAvant && salle.hote && !spectateurVoulu && !salle.places[placeAvant - 1]) {
    envoyer({ type: 'place', joueur: placeAvant });
    placeAvant = 0;
  }
  if (etat.flux && attenteJeton) { attenteJeton(etat.flux); attenteJeton = null; }
  majScene();
}

/** Ce qui recouvre la vidéo (voile) ou s'affiche par-dessus sans la cacher (bandeau). */
function majScene() {
  const salle = etat?.salle;
  const enLecture = !!lecteur && etatLecteur.e === 'lecture';
  if (serveurPerdu) bandeau(enLecture ? 'Connexion au serveur perdue, reconnexion… (la partie continue)' : 'Connexion au serveur perdue, reconnexion…');
  else if (salle?.hote?.absent && !jeSuisHote()) bandeau(`${salle.hote.nom} se reconnecte… la partie continue.`);
  else if (arretPrevu) bandeau('Le serveur redémarre, la partie reprend…');
  else bandeau(null);

  if (!salle) return;
  const nom = salle.hote?.nom || 'l’hôte';
  if (arretPrevu && lecteur) { if (etatLecteur.e === 'lecture') voile(null); }
  else if (regarderAilleurs) voile('La partie est ouverte dans ton navigateur', 'F11 pour le plein écran. « Regarder ici » pour revenir dans Discord.');
  else if (jeSuisHote() && !apercu) voile('Tu héberges la partie', 'Tes amis voient l’écran de ton PC. Joue directement sur ton PC. « Voir l’aperçu » montre ce qu’ils reçoivent.');
  else if (!salle.hote) voile('Personne n’héberge pour l’instant', 'Celui qui a le jeu sur son PC clique « Héberger depuis mon PC ».');
  else if (!lecteur) voile(`Connexion au PC de ${nom}…`);
  else {
    const { e, detail } = etatLecteur;
    if (e === 'lecture') voile(null);
    else if (e === 'connexion') voile(`Connexion au PC de ${nom}…`, detail || '');
    else if (e === 'attente-image') voile(`Connecté au PC de ${nom}`, detail || 'L’image arrive…');
    else if (e === 'erreur') voile('La vidéo ne peut pas s’afficher', detail || '');
    else voile('Connexion coupée', detail || 'Reconnexion…');
  }
}

/** Mesures et erreurs envoyées au journal du serveur (pour comprendre une coupure après coup). */
function envoyerDiag(quoi: string, v: Record<string, string | number | boolean> = {}) {
  envoyer({ type: 'diag', quoi, ...v });
}

/** L'hôte choisit un jeu de sa bibliothèque : son agent lance Ryubing en plein écran. */
function choixDuJeu(enCours: string | null, jeux: { id: string; titre: string }[]) {
  const d = el('div', { className: 'jeu' }, el('strong', { textContent: enCours ? `En cours : ${enCours}` : 'Jeu' }));
  if (!jeux.length) {
    d.append(texte('Aucun jeu dans ta bibliothèque : ajoute ton dossier de jeux dans la fenêtre de l’agent, sur ton PC.'));
    return d;
  }
  const choix = el('select', {});
  for (const j of jeux) choix.append(el('option', { value: j.id, textContent: j.titre }));
  d.append(choix, el('div', { className: 'ligne-boutons' },
    bouton(enCours ? 'Changer de jeu' : 'Lancer', () => envoyer({ type: 'lancer', jeu: choix.value })),
    ...(enCours ? [bouton('Fermer le jeu', () => envoyer({ type: 'fermer-jeu' }), true)] : [])));
  return d;
}

function formulaireCode() {
  const input = el('input', { placeholder: 'ABCD-EFGH', maxLength: 9, autocomplete: 'off' });
  input.setAttribute('aria-label', 'Code affiché par l’agent');
  const ok = el('button', { textContent: 'Lier' });
  const f = el('form', { className: 'code' }, input, ok);
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

function afficherJeuEnCours() {
  const t = etat?.salle.jeu;
  $('jeu-en-cours').textContent = t ? `· ${t}` : '';
}

function demarrerLecteur(flux: Flux) {
  const canvas = $<HTMLCanvasElement>('ecran');
  etatLecteur = { e: 'connexion' };
  lecteur = new Lecteur(
    canvas,
    dansDiscord(),
    (e, detail) => { etatLecteur = { e, detail }; majScene(); },
    (m) => { derniereMesure = m; afficherStats(m); },
    () => new Promise<Flux>((resolve, reject) => {
      attenteJeton = resolve;
      envoyer({ type: 'jeton' });
      setTimeout(() => reject(new Error('pas de jeton')), 4000);
    }),
    envoyerDiag,
  );
  envoyerDiag('lecteur', { discord: dansDiscord(), webcodecs: typeof VideoDecoder !== 'undefined', ecran: `${screen.width}x${screen.height}`, dpr: devicePixelRatio });
  lecteur.surManetteIndisponible = (raison) => { manetteIndisponible = raison; majManette(); };
  envoiManette = new EnvoiManette((m) => lecteur?.envoyerCommande(m), () => reglages, () => majManette());
  envoiManette.peutJouer = jeJoueIci;
  // Un spectateur touche sa manette : on lui donne la première place libre (sauf s'il a choisi de regarder).
  envoiManette.surEnvieDeJouer = () => {
    if (spectateurVoulu || !etat) return;
    const libre = etat.salle.places.findIndex((p) => !p) + 1;
    if (libre) envoyer({ type: 'place', joueur: libre });
    else toast('Toutes les places sont prises : tu regardes en spectateur.');
  };
  envoiManette.demarrer();
  lecteur.demarrer(flux);
  afficher();
}

function arreterLecteur() {
  envoiManette?.arreter();
  envoiManette = null;
  manetteIndisponible = '';
  lecteur?.arreter();
  lecteur = null;
  derniereMesure = null;
  $('stats').hidden = true;
}

/** Encadré « ta manette » : place, avec quoi tu joues, manette détectée, réglages. */
function blocManette() {
  const d = el('div', { id: 'manette', className: 'manette' });
  remplirManette(d);
  return d;
}

function majManette() {
  const d = document.getElementById('manette');
  if (d) remplirManette(d);
}

function remplirManette(d: HTMLElement) {
  const manettes = envoiManette?.manettes ?? [];
  const n = maPlace();
  const enfants: Node[] = [];
  if (manetteIndisponible) {
    enfants.push(el('strong', { textContent: 'Pas de manette pour toi' }), texte(manetteIndisponible));
  } else if (n && jeJoueIci()) {
    const entree = reglages.entree ?? 'tout';
    const avec = entree === 'clavier' ? 'au clavier' : manettes.length ? `avec ${manettes.map((m) => m.nom).join(', ')}` : 'au clavier (ou branche une manette)';
    enfants.push(el('strong', { textContent: `Tu joues : J${n}` }), texte(`Tu joues ${avec}.`));
  } else if (n) {
    enfants.push(el('strong', { textContent: `J${n} : ta manette sur ton PC` }), texte('Joue directement sur ton PC. Prends une autre place pour jouer depuis cet appareil.'));
  } else {
    enfants.push(el('strong', { textContent: 'Tu regardes' }),
      texte(manettes.length ? `${manettes[0].nom} détectée : appuie sur un bouton pour prendre une place.` : 'Prends une place libre, ou appuie sur un bouton de ta manette.'));
  }

  // Jouer avec : manette, clavier, ou les deux.
  const choix = el('select', { onchange: () => { reglages = { ...reglages, entree: choix.value as Entree }; enregistrer(reglages); majManette(); } });
  for (const [v, t] of [['tout', 'Manette et clavier'], ['manette', 'Manette seulement'], ['clavier', 'Clavier seulement']] as const) {
    choix.append(el('option', { value: v, textContent: t, selected: (reglages.entree ?? 'tout') === v }));
  }
  enfants.push(el('label', { className: 'jouer-avec' }, 'Jouer avec ', choix));

  if (reglages.entree !== 'manette') {
    const k = (s: Parameters<typeof nomTouche>[0]) => el('kbd', { textContent: nomTouche(s) });
    const c = reglages.clavier;
    const plan = el('details', { open: reglages.entree === 'clavier' }, el('summary', { textContent: 'Plan du clavier' }),
      el('p', {}, 'Stick : ', k(c['ly+']), k(c['lx-']), k(c['ly-']), k(c['lx+']), ' · Croix : ', k(c.haut), k(c.gauche), k(c.bas), k(c.droite)),
      el('p', {}, 'A ', k(c.a), ' · B ', k(c.b), ' · X ', k(c.x), ' · Y ', k(c.y)),
      el('p', {}, 'L ', k(c.lb), ' · R ', k(c.rb), ' · ZL ', k(c.lt), ' · ZR ', k(c.rt)),
      el('p', {}, '+ ', k(c.start), ' · − ', k(c.back)));
    enfants.push(plan);
  }
  const inconnue = manettes.find((m) => !m.standard && !m.profilPerso);
  if (inconnue && reglages.entree !== 'clavier') {
    enfants.push(el('p', { className: 'alerte', textContent: `« ${inconnue.nom} » n’est pas reconnue automatiquement : configure ses boutons.` }));
  }
  enfants.push(bouton('Personnaliser les touches', () => envoiManette && ouvrirReglages(envoiManette, () => reglages, (r) => { reglages = r; enregistrer(r); majManette(); }), true));
  d.replaceChildren(...enfants);
}

function afficherStats(m: Mesures) {
  const e = $('stats');
  e.hidden = false;
  e.classList.toggle('lent', (m.image ?? 0) > 80 || (m.ips > 0 && m.ips < 45));
  e.replaceChildren(el('b', { textContent: m.image === null ? '…' : `${m.image} ms` }), ' · ', el('b', { textContent: `${m.ips} i/s` }));
}

function ouvrirDebug(v: boolean) {
  debug.ouvert = v;
  $('bouton-debug').classList.toggle('actif', v);
  try { localStorage.setItem('switch-emu.debug', v ? '1' : ''); } catch { /* stockage indisponible */ }
  debug.maj(derniereMesure, pingServeur);
}

function envoyer(m: object) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

function connecterSalle(essai = 0) {
  const s = new WebSocket(wsUrl(`/api/salle?session=${encodeURIComponent(getSession())}`));
  ws = s;
  let dernierMessage = Date.now();
  // Ping toutes les 2 s : mesure le ping du serveur, et garde la connexion active (Discord coupe
  // les connexions silencieuses). Sans réponse depuis 8 s, la connexion est morte : on repart.
  const minuteur = window.setInterval(() => {
    if (s.readyState !== WebSocket.OPEN) return;
    if (Date.now() - dernierMessage > 8000) { s.close(); return; }
    s.send(JSON.stringify({ type: 'ping', t: performance.now() }));
  }, 2000);
  s.onopen = () => {
    essai = 0;
    dernierMessage = connecteDepuis = Date.now();
    if (serveurPerdu) { serveurPerdu = false; majScene(); }
  };
  s.onmessage = (e) => {
    dernierMessage = Date.now();
    const m = JSON.parse(e.data);
    if (m.type === 'pong') pingServeur = Math.round(performance.now() - m.t);
    else if (m.type === 'etat') { etat = m; afficher(); majManette(); afficherJeuEnCours(); }
    else if (m.type === 'erreur') toast(m.texte);
  };
  s.onclose = (e) => {
    clearInterval(minuteur);
    pingServeur = null;
    if (ws !== s) return;
    if (e.code === 4001) { voile('Session expirée', 'Relance l’Activité.'); return; }
    if (e.code === 4003) {
      arreterLecteur();
      voile('Tu as été retiré de la partie', 'L’hôte t’a retiré. Tu pourras revenir dans quelques minutes.');
      $('bloc-places').hidden = true;
      $('participants').replaceChildren();
      $('actions').replaceChildren();
      return;
    }
    serveurPerdu = true;
    if (!lecteur) voile('Connexion au serveur perdue', 'Reconnexion…');
    majScene();
    setTimeout(() => connecterSalle(essai + 1), essai === 0 ? 300 : Math.min(5000, 500 * 2 ** essai));
  };
}

// Menu debug, résumé envoyé au journal du serveur, bouton « Agrandir »
$('scene').append(debug.racine);
$('bouton-debug').onclick = () => ouvrirDebug(!debug.ouvert);
$('stats').onclick = () => ouvrirDebug(!debug.ouvert);
try { if (localStorage.getItem('switch-emu.debug')) ouvrirDebug(true); } catch { /* stockage indisponible */ }
setInterval(() => debug.maj(derniereMesure, pingServeur), 1000);
setInterval(() => {
  const m = derniereMesure;
  if (m) envoyerDiag('resume', { ips: m.ips, image: m.image ?? -1, pingPc: m.pingPc ?? -1, pingServeur: pingServeur ?? -1, debit: m.debit, relais: m.relais, jetees: m.jetees, reco: m.reconnexions, codec: m.codec, decodeur: m.decodeur, taille: `${m.largeur}x${m.hauteur}` });
}, 30_000);
/** Plein écran si c'est permis (navigateur), sinon la vidéo prend toute la fenêtre de l'Activité. */
async function basculerPleinEcran() {
  const app = $('app');
  if (document.fullscreenElement) { await document.exitFullscreen(); return; }
  if (app.classList.contains('grand')) { app.classList.remove('grand'); $('bouton-grand').textContent = 'Plein écran'; return; }
  try {
    await $('scene').requestFullscreen();
  } catch {
    app.classList.add('grand');
    $('bouton-grand').textContent = 'Réduire';
    if (dansDiscord()) toast('Discord ne permet pas le vrai plein écran : « Ouvrir dans le navigateur », puis F11.');
  }
}
$('bouton-grand').onclick = basculerPleinEcran;
$('ecran').ondblclick = basculerPleinEcran;

// « Ouvrir dans le navigateur » : même partie, même compte, dans un vrai navigateur (F11 pour le plein écran).
// Ici, la vidéo s'arrête pour ne pas la recevoir deux fois.
$('bouton-navigateur').hidden = !dansDiscord();
$('bouton-navigateur').onclick = async () => {
  if (regarderAilleurs) { regarderAilleurs = false; $('bouton-navigateur').textContent = 'Ouvrir dans le navigateur'; afficher(); return; }
  try {
    const { url } = await api<{ url: string }>('/api/passage', { method: 'POST' });
    await identite?.sdk?.commands.openExternalLink({ url });
    regarderAilleurs = true;
    $('bouton-navigateur').textContent = 'Regarder ici';
    afficher();
  } catch (e) { toast((e as Error).message || 'Impossible d’ouvrir le navigateur.'); }
};

async function main() {
  try {
    const id = await seConnecter();
    identite = id;
    moi = id.user;
    voile('Connecté', `Bonjour ${moi.nom} !`);
    connecterSalle();
  } catch (e) {
    voile('Impossible de démarrer', (e as Error).message);
  }
}
main();
