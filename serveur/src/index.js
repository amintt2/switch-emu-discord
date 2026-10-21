import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';

import { assertConfig, config, listeRelais, salleDepuisInstance } from './config.js';
import { signer, verifier } from './jetons.js';
import { exchangeCode, fetchUser } from './discord.js';
import { ECHELLE_DELAIS, Salles } from './salles.js';
import { Agents, normaliserCode } from './agents.js';
import { Relais } from './relais.js';

const SESSION_MS = 24 * 3600_000;
const JETON_RELAIS_MS = 5 * 60_000;
const JETON_RELAIS_HOTE_MS = 2 * 3600_000;  // l'agent le réutilise si le serveur ne répond plus
const DELAI_AGENT_MS = 90_000 * ECHELLE_DELAIS;    // l'agent a ce temps pour revenir avant que la partie s'arrête (coupure de la box…)
const DELAI_REPRISE_MS = 60_000 * ECHELLE_DELAIS;  // après un redémarrage du serveur : l'hôte a ce temps pour revenir dans sa salle
const BATTEMENT_MS = 15_000 * ECHELLE_DELAIS;
const TICK_MS = Math.max(100, 2000 * ECHELLE_DELAIS);

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  disableRequestLogging: process.env.LOG_REQUESTS !== '1',
  trustProxy: true,
});
assertConfig(app.log);
await app.register(fastifyWebsocket, { options: { maxPayload: 1 << 20 } });

const agents = new Agents({ secret: config.agentSecret });
const salles = new Salles({ agentEnLigne: (uid) => agents.enLigne(uid) });
const relais = new Relais({ secret: config.relaySecret });
/** salle -> Set<{ ws, uid }> (les joueurs connectés à /api/salle) */
const joueurs = new Map();

const session = (token) => {
  const s = verifier(config.sessionSecret, token);
  return s && !s.passage && typeof s.uid === 'string' && typeof s.salle === 'string' ? s : null;
};
/** Jetons de passage déjà utilisés (id -> expiration) : chacun ne sert qu'une fois. */
const passagesUtilises = new Map();
const jetonRelais = (salle, role, uid) => signer(config.relaySecret, { salle, role, uid }, role === 'hote' ? JETON_RELAIS_HOTE_MS : JETON_RELAIS_MS);
/** Identifiant court pour les journaux (les identifiants de salle sont déjà des empreintes). */
const court = (salle) => String(salle).slice(0, 9);
/** uid -> minuteur : l'agent s'est déconnecté, la partie s'arrête s'il ne revient pas à temps. */
const departsAgent = new Map();
/** uid -> { salle, jusqua } : l'agent dit héberger une salle que le serveur ne connaît plus (redémarrage). */
const reprises = new Map();

/** Envoie à chaque joueur de la salle ce qu'il doit voir (avec son propre jeton pour regarder). */
function diffuser(salleId) {
  const vue = salles.vue(salleId);
  const hoteUid = vue.hote?.uid;
  vue.jeu = hoteUid ? agents.jeuEnCours(hoteUid)?.titre || null : null;
  vue.manettes = hoteUid ? manettesBranchees.get(hoteUid) || [] : [];
  for (const j of joueurs.get(salleId) || []) {
    if (j.ws.readyState !== 1) continue;
    const moi = { agent: agents.enLigne(j.uid) ? 'en-ligne' : 'absent' };
    if (j.uid === hoteUid) moi.jeux = agents.jeuxDe(hoteUid);  // la liste de jeux ne va qu'à l'hôte
    // L'hôte reçoit aussi un accès : il peut afficher l'aperçu de ce que voient ses amis.
    // Le flux continue pendant une absence de l'hôte (son onglet se reconnecte) : c'est son PC qui l'envoie.
    const flux = vue.hote
      ? { relais: listeRelais().map((r) => ({ nom: r.nom, discord: r.discord, web: r.web })), jeton: jetonRelais(salleId, 'ami', j.uid) }
      : null;
    j.ws.send(JSON.stringify({ type: 'etat', salle: vue, moi, flux }));
  }
}

/** Dit à l'agent de l'hôte qui joue sur quelle place (les amis à distance seulement). */
function envoyerPlaces(salleId) {
  const s = salles.get(salleId);
  if (!s?.hote) return;
  const places = salles.placesDistantes(salleId);
  const noms = Object.fromEntries(s.places.filter((pl) => pl && places[pl.uid]).map((pl) => [pl.uid, pl.nom]));
  agents.envoyer(s.hote, { type: 'places', salle: salleId, places, noms });
}
/** uid de l'hôte -> places dont la manette virtuelle est branchée sur son PC (envoyé par son agent). */
const manettesBranchees = new Map();

/** Démarre ou arrête le flux sur le PC de l'hôte. */
function commanderAgent(uid, salleId, heberger) {
  if (heberger) {
    agents.envoyer(uid, {
      type: 'heberger', salle: salleId,
      relais: listeRelais().map((r) => r.agent),
      jeton: jetonRelais(salleId, 'hote', uid),
    });
  } else agents.envoyer(uid, { type: 'arreter', salle: salleId });
}

/** uid -> salle : parties arrêtées (par l'hôte, ou parce qu'il est parti) ; l'agent ne doit pas les reprendre. */
const arretees = new Map();

/** Arrête la partie de l'hôte uid dans cette salle, et le dit à son agent (ou le lui redira à son retour). */
function arreterPartie(uid, salleId) {
  arretees.set(uid, salleId);
  commanderAgent(uid, salleId, false);
}

/** Renvoie à l'agent les places et les exclusions : des ordres ont pu se perdre pendant une coupure. */
function resynchroniser(uid, salleId) {
  envoyerPlaces(salleId);
  for (const exclu of salles.get(salleId)?.exclus.keys() ?? []) agents.envoyer(uid, { type: 'exclure', salle: salleId, uid: exclu });
}

/**
 * Un agent revenu dit héberger une salle. Si le serveur la connaît encore, on resynchronise ; s'il l'a
 * oubliée (redémarrage), la salle est reprise dès que son propriétaire y est.
 */
function reprendre(uid, salleId) {
  const s = salles.get(salleId);
  if (s?.hote === uid) { resynchroniser(uid, salleId); return true; }
  if (!s?.participants.has(uid) || s.hote) return false;
  if (salles.heberger(salleId, uid).erreur) return false;
  app.log.info({ uid, salle: court(salleId) }, 'hébergement repris');
  diffuser(salleId);
  resynchroniser(uid, salleId);
  return true;
}

setInterval(() => {
  // Un hôte parti depuis trop longtemps : la partie s'arrête, son agent aussi.
  const hotes = new Map([...salles.salles.values()].filter((s) => s.hote).map((s) => [s.id, s.hote]));
  for (const id of salles.tick()) {
    // (pas un arrêt voulu : si l'hôte et son agent reviennent, la partie peut reprendre)
    const avant = hotes.get(id);
    if (avant && salles.get(id)?.hote !== avant) commanderAgent(avant, id, false);
    diffuser(id);
    envoyerPlaces(id);
  }
  for (const [uid, r] of reprises) {
    if (reprendre(uid, r.salle)) reprises.delete(uid);
    else if (Date.now() > r.jusqua) { reprises.delete(uid); commanderAgent(uid, r.salle, false); }
  }
}, TICK_MS).unref();

// Battements : une connexion qui ne répond plus est fermée (et l'autre côté se reconnecte).
// Les pings applicatifs des pages gardent aussi la connexion active à travers le proxy de Discord.
setInterval(() => {
  for (const ws of app.websocketServer?.clients ?? []) {
    if (ws.vivant === false) { ws.terminate(); continue; }
    ws.vivant = false;
    try { ws.ping(); } catch { /* déjà fermée */ }
  }
}, BATTEMENT_MS).unref();
const suivreVie = (ws) => {
  ws.vivant = true;
  ws.on('pong', () => { ws.vivant = true; });
  ws.on('message', () => { ws.vivant = true; });
};

/** Les pages envoient des mesures et des erreurs : on les écrit dans le journal (texte court, nombres). */
function nettoyerDiag(m) {
  const r = {};
  for (const [k, v] of Object.entries(m || {}).slice(0, 24)) {
    if (!/^[a-zA-Z][a-zA-Z0-9]{0,19}$/.test(k) || k === 'type') continue;
    if (typeof v === 'number' && Number.isFinite(v)) r[k] = Math.round(v * 10) / 10;
    else if (typeof v === 'boolean') r[k] = v;
    else if (typeof v === 'string') r[k] = v.slice(0, 160);
  }
  return r;
}

// ------------------------------------------------------------------ connexion des joueurs

app.get('/api/config', async () => ({ clientId: config.discord.clientId || null, browserMode: config.allowBrowserMode }));

app.post('/api/token', async (request, reply) => {
  const { code, instanceId } = request.body || {};
  if (typeof code !== 'string' || typeof instanceId !== 'string' || !instanceId || instanceId.length > 256) {
    return reply.code(400).send({ error: 'code et instanceId requis' });
  }
  if (!config.discord.clientId || !config.discord.clientSecret) {
    return reply.code(503).send({ error: 'Connexion Discord non configurée sur le serveur' });
  }
  const accessToken = await exchangeCode(code);
  const user = await fetchUser(accessToken);
  // Une salle par instance d'Activité : tous ceux qui ont rejoint la même Activité.
  const s = signer(config.sessionSecret, { ...user, salle: salleDepuisInstance(instanceId) }, SESSION_MS);
  return { access_token: accessToken, session: s, user };
});

// « Ouvrir dans le navigateur » : l'Activité demande un jeton de passage (2 min, une seule fois),
// le navigateur l'échange contre une session dans la même salle, sans se reconnecter à Discord.
const PASSAGE_MS = 2 * 60_000;
// Les jetons consommés ne sont gardés qu'en mémoire : un jeton émis avant ce démarrage est refusé.
const DEMARRAGE = Date.now();
app.post('/api/passage', async (request, reply) => {
  const s = session((request.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  if (!s) return reply.code(401).send({ error: 'Session invalide ou expirée' });
  const { uid, nom, avatar, salle } = s;
  const p = signer(config.sessionSecret, { passage: true, id: randomBytes(12).toString('base64url'), ne: Date.now(), uid, nom, avatar, salle }, PASSAGE_MS);
  return { url: `${config.publicUrl}/?passage=${encodeURIComponent(p)}` };
});

app.post('/api/passage/echange', async (request, reply) => {
  const p = verifier(config.sessionSecret, request.body?.passage);
  if (!p?.passage || typeof p.id !== 'string' || !(p.ne >= DEMARRAGE) || passagesUtilises.has(p.id)) {
    return reply.code(400).send({ error: 'Lien expiré : rouvre-le depuis l’Activité dans Discord.' });
  }
  for (const [id, fin] of passagesUtilises) if (fin < Date.now()) passagesUtilises.delete(id);
  passagesUtilises.set(p.id, p.exp);
  const user = { uid: p.uid, nom: p.nom, avatar: p.avatar };
  return { session: signer(config.sessionSecret, { ...user, salle: p.salle }, SESSION_MS), user };
});

// La page ouverte dans le navigateur garde sa session dans l'onglet : après F5, elle vérifie qu'elle vaut encore.
app.get('/api/moi', async (request, reply) => {
  const s = session((request.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  if (!s) return reply.code(401).send({ error: 'Session expirée : rouvre la partie depuis l’Activité dans Discord.' });
  return { user: { uid: s.uid, nom: s.nom, avatar: s.avatar ?? null } };
});

app.post('/api/dev-session', async (request, reply) => {
  if (!config.allowBrowserMode) return reply.code(404).send({ error: 'introuvable' });
  const { nom, salle } = request.body || {};
  const user = { uid: `dev-${String(nom || 'invite').slice(0, 32)}`, nom: String(nom || 'Invité').slice(0, 32), avatar: null };
  const s = signer(config.sessionSecret, { ...user, salle: salleDepuisInstance(`dev:${salle || 'test'}`) }, SESSION_MS);
  return { session: s, user };
});

// ------------------------------------------------------------------ jumelage de l'agent

// Limite simple par adresse IP : une demande de code toutes les 5 s.
const derniereDemande = new Map();
app.post('/api/agent/jumelage', async (request, reply) => {
  const t = derniereDemande.get(request.ip) || 0;
  if (Date.now() - t < 5000) return reply.code(429).send({ error: 'Trop de demandes, réessaie dans quelques secondes.' });
  derniereDemande.set(request.ip, Date.now());
  if (derniereDemande.size > 10_000) derniereDemande.clear();
  return agents.demanderJumelage();
});

app.get('/api/agent/jumelage/:secret', async (request, reply) => {
  const r = agents.recuperer(String(request.params.secret));
  if (!r) return reply.code(404).send({ error: 'Code expiré : relance le jumelage.' });
  return r;
});

// Jumelage par le navigateur : l'agent ouvre /lier.html?code=…, la personne se connecte avec Discord,
// et le code est confirmé pour son compte (plus besoin de le recopier).
const redirectionOAuth = `${config.publicUrl}/api/oauth/rappel`;
app.get('/api/oauth/debut', async (request, reply) => {
  const code = normaliserCode(request.query.code);
  if (!code || !config.discord.clientId) return reply.redirect('/lier.html?erreur=code');
  const state = signer(config.sessionSecret, { lier: code }, 10 * 60_000);
  const url = new URL('https://discord.com/oauth2/authorize');
  url.search = new URLSearchParams({ client_id: config.discord.clientId, response_type: 'code', redirect_uri: redirectionOAuth, scope: 'identify', state, prompt: 'none' });
  return reply.redirect(url.toString());
});

app.get('/api/oauth/rappel', async (request, reply) => {
  const etat = verifier(config.sessionSecret, request.query.state);
  if (!etat?.lier || typeof request.query.code !== 'string') return reply.redirect('/lier.html?erreur=session');
  try {
    const user = await fetchUser(await exchangeCode(request.query.code, redirectionOAuth));
    const r = agents.confirmer(etat.lier, user);
    if (r.erreur) return reply.redirect(`/lier.html?erreur=${encodeURIComponent(r.erreur)}`);
    return reply.redirect(`/lier.html?ok=1&nom=${encodeURIComponent(user.nom)}`);
  } catch (e) {
    request.log.warn(e, 'connexion Discord (navigateur) refusée');
    return reply.redirect('/lier.html?erreur=discord');
  }
});

app.post('/api/jumelage', async (request, reply) => {
  const s = session((request.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  if (!s) return reply.code(401).send({ error: 'Session invalide ou expirée' });
  const r = agents.confirmer(request.body?.code, s);
  if (r.erreur) return reply.code(400).send({ error: r.erreur });
  return r;
});

// ------------------------------------------------------------------ WebSockets

app.register(async (scope) => {
  // Les joueurs : état de la salle, héberger / arrêter.
  scope.get('/api/salle', { websocket: true }, (ws, request) => {
    const s = session(request.query.session);
    if (!s) return ws.close(4001, 'session invalide');
    const moi = { ws, uid: s.uid };
    if (salles.rejoindre(s.salle, s).exclu) return ws.close(4003, 'retiré par l’hôte');
    suivreVie(ws);
    const debut = Date.now();
    const log = app.log.child({ uid: s.uid, salle: court(s.salle) });
    log.info({ ua: String(request.headers['user-agent'] || '').slice(0, 160) }, 'joueur connecté');
    if (!joueurs.has(s.salle)) joueurs.set(s.salle, new Set());
    joueurs.get(s.salle).add(moi);
    const r = reprises.get(s.uid);
    if (r?.salle === s.salle && reprendre(s.uid, s.salle)) reprises.delete(s.uid);
    diffuser(s.salle);
    let diags = 0;
    const limiteDiag = setInterval(() => { diags = 0; }, 60_000);

    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m?.type === 'ping') {
        return ws.send(JSON.stringify({ type: 'pong', t: Number(m.t) || 0 }));
      } else if (m?.type === 'diag') {
        if (++diags <= 12) log.info({ diag: nettoyerDiag(m) }, `diag ${typeof m.quoi === 'string' ? m.quoi.slice(0, 30) : ''}`);
        return;
      } else if (m?.type === 'heberger') {
        const r = salles.heberger(s.salle, s.uid);
        if (r.erreur) return ws.send(JSON.stringify({ type: 'erreur', texte: r.erreur }));
        arretees.delete(s.uid);
        commanderAgent(s.uid, s.salle, true);
        envoyerPlaces(s.salle);
        diffuser(s.salle);
      } else if (m?.type === 'arreter') {
        if (salles.arreter(s.salle, s.uid)) { arreterPartie(s.uid, s.salle); diffuser(s.salle); }
      } else if (m?.type === 'place') {
        const r = salles.prendrePlace(s.salle, s.uid, Number(m.joueur));
        if (r.erreur) return ws.send(JSON.stringify({ type: 'erreur', texte: r.erreur }));
        diffuser(s.salle);
        envoyerPlaces(s.salle);
      } else if (m?.type === 'exclure' && typeof m.uid === 'string') {
        const r = salles.exclure(s.salle, s.uid, m.uid);
        if (r.erreur) return ws.send(JSON.stringify({ type: 'erreur', texte: r.erreur }));
        // On coupe tout : la page de la personne, et sa vidéo au relais (via l'agent).
        for (const j of joueurs.get(s.salle) || []) if (j.uid === m.uid) j.ws.close(4003, 'retiré par l’hôte');
        agents.envoyer(s.uid, { type: 'exclure', salle: s.salle, uid: m.uid });
        diffuser(s.salle);
        envoyerPlaces(s.salle);
      } else if (m?.type === 'lancer' || m?.type === 'fermer-jeu') {
        // Seul l'hôte choisit le jeu, et seulement dans la liste envoyée par son agent.
        if (salles.get(s.salle)?.hote !== s.uid) return ws.send(JSON.stringify({ type: 'erreur', texte: 'Seul l’hôte choisit le jeu.' }));
        if (m.type === 'fermer-jeu') return agents.envoyer(s.uid, { type: 'fermer-jeu' });
        if (typeof m.jeu !== 'string' || !agents.aLeJeu(s.uid, m.jeu)) return ws.send(JSON.stringify({ type: 'erreur', texte: 'Jeu inconnu.' }));
        agents.envoyer(s.uid, { type: 'lancer', salle: s.salle, jeu: m.jeu });
      } else if (m?.type === 'jeton') {
        diffuser(s.salle);  // renvoie un état avec un jeton neuf (pour se reconnecter au relais)
      }
    });
    ws.on('close', (code) => {
      clearInterval(limiteDiag);
      log.info({ code, duree: Math.round((Date.now() - debut) / 1000) }, 'joueur déconnecté');
      joueurs.get(s.salle)?.delete(moi);
      if (!joueurs.get(s.salle)?.size) joueurs.delete(s.salle);
      if (salles.quitter(s.salle, s.uid)) { diffuser(s.salle); envoyerPlaces(s.salle); }
    });
  });

  // L'agent de l'hôte : connexion sortante depuis son PC, il ne reçoit que des ordres connus.
  scope.get('/api/agent', { websocket: true }, (ws, request) => {
    const a = agents.verifierJeton((request.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!a) return ws.close(4001, 'agent non jumelé');
    const ancienne = agents.connecter(a.uid, ws);
    ancienne?.close(4000, 'un autre agent s’est connecté avec ce compte');
    suivreVie(ws);
    clearTimeout(departsAgent.get(a.uid));
    departsAgent.delete(a.uid);
    const debut = Date.now();
    ws.send(JSON.stringify({ type: 'bienvenue', nom: a.nom }));
    app.log.info({ uid: a.uid, version: String(request.headers['x-agent-version'] || '?').slice(0, 20) }, 'agent connecté');
    for (const id of joueurs.keys()) diffuser(id);  // « Héberger » devient possible

    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      // Après une reconnexion, l'agent dit quelle salle il héberge encore.
      if (m?.type === 'heberge' && m.salle === '') {
        // L'agent (redémarré) n'héberge rien : une reprise en attente n'a plus d'objet, et on relance les
        // parties que le serveur croit en cours (avec leurs places et leurs exclusions).
        reprises.delete(a.uid);
        for (const s of salles.salles.values()) {
          if (s.hote !== a.uid || arretees.get(a.uid) === s.id) continue;
          app.log.info({ uid: a.uid, salle: court(s.id) }, 'agent redémarré : la partie est relancée');
          commanderAgent(a.uid, s.id, true);
          resynchroniser(a.uid, s.id);
        }
        return;
      }
      if (m?.type === 'heberge' && typeof m.salle === 'string' && m.salle.length <= 64) {
        // Arrêtée pendant la coupure (« Arrêter », ou l'hôte est parti) : on le redit à l'agent.
        if (arretees.get(a.uid) === m.salle) return commanderAgent(a.uid, m.salle, false);
        if (!reprendre(a.uid, m.salle)) reprises.set(a.uid, { salle: m.salle, jusqua: Date.now() + DELAI_REPRISE_MS });
        return;
      }
      // La capture s'est arrêtée sur le PC de l'hôte : la partie s'arrête pour tout le monde.
      if (m?.type === 'fin' && typeof m.salle === 'string' && m.salle.length <= 64) {
        if (reprises.get(a.uid)?.salle === m.salle) reprises.delete(a.uid);
        if (salles.get(m.salle)?.hote === a.uid) {
          salles.arreter(m.salle, a.uid);
          arretees.set(a.uid, m.salle);
          diffuser(m.salle);
        }
        return ws.send(JSON.stringify({ type: 'fin-ok', salle: m.salle }));  // l'agent arrête de le redire
      }
      if (m?.type === 'manettes' && Array.isArray(m.places)) {
        manettesBranchees.set(a.uid, [...new Set(m.places.filter((n) => Number.isInteger(n) && n >= 1 && n <= 4))].sort());
        for (const s of salles.salles.values()) if (s.hote === a.uid) diffuser(s.id);
        return;
      }
      if (m?.type === 'diag') {
        app.log.info({ uid: a.uid, diag: nettoyerDiag(m) }, `agent : ${typeof m.quoi === 'string' ? m.quoi.slice(0, 30) : 'diag'}`);
        return;
      }
      // L'agent redemande un jeton pour se reconnecter au relais, seulement s'il héberge encore.
      if (m?.type === 'jeux' || m?.type === 'jeu-en-cours') {
        if (m.type === 'jeux') agents.definirJeux(a.uid, m.jeux);
        else agents.definirJeuEnCours(a.uid, typeof m.jeu === 'string' ? m.jeu : '');
        for (const s of salles.salles.values()) if (s.hote === a.uid) diffuser(s.id);
        return;
      }
      if (m?.type === 'jeton' && salles.get(m.salle)?.hote === a.uid) {
        ws.send(JSON.stringify({ type: 'jeton', salle: m.salle, jeton: jetonRelais(m.salle, 'hote', a.uid) }));
        envoyerPlaces(m.salle);
      } else if (m?.type === 'etat' && typeof m.salle === 'string' && salles.get(m.salle)?.hote === a.uid) {
        const texte = typeof m.erreur === 'string' ? m.erreur.slice(0, 200) : null;
        for (const j of joueurs.get(m.salle) || []) {
          if (texte && j.ws.readyState === 1) j.ws.send(JSON.stringify({ type: 'erreur', texte: `PC de l’hôte : ${texte}` }));
        }
      }
    });
    ws.on('close', (code) => {
      if (!agents.deconnecter(a.uid, ws)) return;
      app.log.info({ uid: a.uid, code, duree: Math.round((Date.now() - debut) / 1000) }, 'agent déconnecté');
      for (const id of joueurs.keys()) diffuser(id);
      // La vidéo passe par les relais, pas par cette connexion : on laisse à l'agent le temps de revenir.
      clearTimeout(departsAgent.get(a.uid));
      departsAgent.set(a.uid, setTimeout(() => {
        departsAgent.delete(a.uid);
        if (agents.enLigne(a.uid)) return;
        app.log.info({ uid: a.uid }, 'agent parti pour de bon : la partie s’arrête');
        // Pas un arrêt voulu : si l'agent revient plus tard en hébergeant encore, la partie reprend.
        for (const id of salles.agentParti(a.uid)) diffuser(id);
      }, DELAI_AGENT_MS));
    });
  });

  // Relais de repli (si le relais Cloudflare ne répond pas).
  scope.get('/relais', { websocket: true }, (ws, request) => {
    const droit = relais.autoriser(request.query.jeton);
    if (!droit) return ws.close(4001, 'jeton invalide');
    suivreVie(ws);
    const debut = Date.now();
    ws.on('close', (code) => app.log.info({ uid: droit.uid, role: droit.role, salle: court(droit.salle), code, duree: Math.round((Date.now() - debut) / 1000) }, 'relais VPS : départ'));
    relais.brancher(ws, droit);
  });
});

// ------------------------------------------------------------------ fichiers du client

const dist = fileURLToPath(new URL('../../client/dist/', import.meta.url));
if (existsSync(dist)) {
  await app.register(fastifyStatic, { root: dist, wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    if (request.raw.url.startsWith('/api/')) return reply.code(404).send({ error: 'introuvable' });
    return reply.sendFile('index.html');
  });
} else {
  app.log.warn('client/dist absent : lance « npm run build » pour servir l’interface');
}

await app.listen({ port: config.port, host: config.host });
