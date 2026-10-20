import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';

import { assertConfig, config, listeRelais, salleDepuisInstance } from './config.js';
import { signer, verifier } from './jetons.js';
import { exchangeCode, fetchUser } from './discord.js';
import { Salles } from './salles.js';
import { Agents, normaliserCode } from './agents.js';
import { Relais } from './relais.js';

const SESSION_MS = 24 * 3600_000;
const JETON_RELAIS_MS = 5 * 60_000;

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
  return s && typeof s.uid === 'string' && typeof s.salle === 'string' ? s : null;
};
const jetonRelais = (salle, role, uid) => signer(config.relaySecret, { salle, role, uid }, JETON_RELAIS_MS);

/** Envoie à chaque joueur de la salle ce qu'il doit voir (avec son propre jeton pour regarder). */
function diffuser(salleId) {
  const vue = salles.vue(salleId);
  const hoteUid = vue.hote?.uid;
  vue.jeu = hoteUid ? agents.jeuEnCours(hoteUid)?.titre || null : null;
  for (const j of joueurs.get(salleId) || []) {
    if (j.ws.readyState !== 1) continue;
    const moi = { agent: agents.enLigne(j.uid) ? 'en-ligne' : 'absent' };
    if (j.uid === hoteUid) moi.jeux = agents.jeuxDe(hoteUid);  // la liste de jeux ne va qu'à l'hôte
    // L'hôte reçoit aussi un accès : il peut afficher l'aperçu de ce que voient ses amis.
    const flux = vue.hote && !vue.hote.absent
      ? { relais: listeRelais().map((r) => ({ nom: r.nom, discord: r.discord, web: r.web })), jeton: jetonRelais(salleId, 'ami', j.uid) }
      : null;
    j.ws.send(JSON.stringify({ type: 'etat', salle: vue, moi, flux }));
  }
}

/** Dit à l'agent de l'hôte qui joue sur quelle place (les amis à distance seulement). */
function envoyerPlaces(salleId) {
  const s = salles.get(salleId);
  if (s?.hote) agents.envoyer(s.hote, { type: 'places', salle: salleId, places: salles.placesDistantes(salleId) });
}

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

setInterval(() => {
  for (const id of salles.tick()) { diffuser(id); envoyerPlaces(id); }
}, 2000).unref();

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
    if (!joueurs.has(s.salle)) joueurs.set(s.salle, new Set());
    joueurs.get(s.salle).add(moi);
    diffuser(s.salle);

    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m?.type === 'heberger') {
        const r = salles.heberger(s.salle, s.uid);
        if (r.erreur) return ws.send(JSON.stringify({ type: 'erreur', texte: r.erreur }));
        commanderAgent(s.uid, s.salle, true);
        envoyerPlaces(s.salle);
        diffuser(s.salle);
      } else if (m?.type === 'arreter') {
        if (salles.arreter(s.salle, s.uid)) { commanderAgent(s.uid, s.salle, false); diffuser(s.salle); }
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
    ws.on('close', () => {
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
    ws.send(JSON.stringify({ type: 'bienvenue', nom: a.nom }));
    app.log.info({ uid: a.uid }, 'agent connecté');
    for (const id of joueurs.keys()) diffuser(id);  // « Héberger » devient possible

    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
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
    ws.on('close', () => {
      if (!agents.deconnecter(a.uid, ws)) return;
      app.log.info({ uid: a.uid }, 'agent déconnecté');
      salles.agentParti(a.uid);
      for (const id of joueurs.keys()) diffuser(id);
    });
  });

  // Relais de repli (si le relais Cloudflare ne répond pas).
  scope.get('/relais', { websocket: true }, (ws, request) => {
    const droit = relais.autoriser(request.query.jeton);
    if (!droit) return ws.close(4001, 'jeton invalide');
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
