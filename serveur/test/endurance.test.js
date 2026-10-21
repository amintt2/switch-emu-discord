// Test d'endurance : le vrai serveur (et son relais VPS) avec un faux agent, un faux hôte et de faux amis,
// qui se comportent comme les vrais (reconnexions comprises). On coupe des connexions, on redémarre le
// serveur ou l'agent, et on vérifie que l'image revient toujours chez l'ami. Les délais du serveur sont
// réduits du même facteur (SWITCHEMU_ECHELLE_DELAIS) pour que le test dure moins d'une minute.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ECHELLE = 0.05;
const DELAI_AGENT_MS = 90_000 * ECHELLE;      // comme le serveur
// Un port libre, donné par le système.
const PORT = await new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const B = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}`;
const SALLE = 'endurance';
const ENV = {
  ...process.env, PORT: String(PORT), HOST: '127.0.0.1', PUBLIC_URL: B, RELAIS_CF_URL: 'off', ALLOW_BROWSER_MODE: '1',
  SESSION_SECRET: 'endurance-session-0123456789', AGENT_SECRET: 'endurance-agent-0123456789',
  RELAY_SECRET: 'endurance-relais-0123456789', DISCORD_CLIENT_ID: 'x', SWITCHEMU_ECHELLE_DELAIS: String(ECHELLE), SWITCHEMU_MODE_ESSAI: '1',
  LOG_LEVEL: 'warn',
};

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function jusqua(cond, ms, quoi) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    if (await cond()) return;
    await pause(50);
  }
  assert.fail(`pas arrivé en ${ms} ms : ${quoi}`);
}

// ------------------------------------------------------------------ le serveur
let serveur = null;
async function demarrerServeur() {
  const s = serveur = spawn(process.execPath, [fileURLToPath(new URL('../src/index.js', import.meta.url))], { env: ENV, stdio: ['ignore', 'ignore', 'inherit'] });
  s.on('error', () => {});
  await jusqua(async () => {
    if (s.exitCode !== null) assert.fail(`le serveur s'est arrêté au démarrage (code ${s.exitCode})`);
    try { return (await fetch(`${B}/api/config`)).ok; } catch { return false; }
  }, 10_000, 'serveur démarré');
}
async function arreterServeur() {
  const s = serveur;
  serveur = null;
  if (!s || s.exitCode !== null) return;
  s.kill();
  await Promise.race([once(s, 'exit'), pause(5000).then(() => s.kill('SIGKILL'))]);
}

async function session(nom) {
  const r = await fetch(`${B}/api/dev-session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nom, salle: SALLE }) });
  return (await r.json()).session;
}

// ------------------------------------------------------------------ une page (hôte ou ami) : la salle
class FauxJoueur {
  constructor(nom) { this.nom = nom; this.etat = null; this.actif = true; this.fermeCode = null; }
  async ouvrir() { this.session = await session(this.nom); this.connecter(0); return this; }
  connecter(essai) {
    if (!this.actif) return;
    const ws = this.ws = new WebSocket(`${WS}/api/salle?session=${encodeURIComponent(this.session)}`);
    const ping = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'ping', t: 0 })), 200);
    ws.on('open', () => { essai = 0; });
    ws.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'etat') this.etat = m; });
    ws.on('error', () => {});
    ws.on('close', (code) => {
      clearInterval(ping);
      this.fermeCode = code;
      if (code === 4003 || code === 4001) return;
      setTimeout(() => this.connecter(essai + 1), essai ? Math.min(2000, 100 * 2 ** essai) : 50);  // comme la page
    });
  }
  envoyer(m) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m)); }
  couper() { this.actif = false; this.ws?.terminate(); }
  reprendre() { this.actif = true; this.connecter(0); }
}

// ------------------------------------------------------------------ un ami qui regarde par le relais
class FauxSpectateur {
  constructor(joueur) { this.joueur = joueur; this.images = 0; this.derniere = 0; this.actif = true; this.fermeCode = null; }
  demarrer() { this.connecter(); return this; }
  connecter() {
    if (!this.actif) return;
    const flux = this.joueur.etat?.flux;
    if (!flux) { setTimeout(() => this.connecter(), 100); return; }
    const ws = this.ws = new WebSocket(`${flux.relais[0].web}?jeton=${encodeURIComponent(flux.jeton)}`);
    const battement = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'battement' })), 200);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'idr' })));
    ws.on('message', (d, binaire) => { if (binaire) { this.images++; this.derniere = Date.now(); } });
    ws.on('error', () => {});
    ws.on('close', (code) => {
      clearInterval(battement);
      this.fermeCode = code;
      if (code !== 4003) setTimeout(() => this.connecter(), 100);
    });
  }
  /** L'image arrive en ce moment (au moins 5 images depuis l'appel). */
  async voitLImage(ms, quoi) {
    const avant = this.images;
    await jusqua(() => this.images - avant >= 5, ms, quoi);
  }
  couper() { this.actif = false; this.ws?.terminate(); }
}

// ------------------------------------------------------------------ un faux agent (même protocole que agent/)
class FauxAgent {
  constructor() { this.salle = ''; this.actif = true; this.ordres = []; this.generation = 0; this.minuteur = null; }
  async jumeler(hote) {
    const { code, secret } = await (await fetch(`${B}/api/agent/jumelage`, { method: 'POST' })).json();
    await fetch(`${B}/api/jumelage`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${hote.session}` }, body: JSON.stringify({ code }) });
    this.jeton = (await (await fetch(`${B}/api/agent/jumelage/${secret}`)).json()).jeton;
    this.connecter(0);
    await jusqua(() => this.connecte, 5000, 'agent connecté');
    return this;
  }
  // Une seule connexion à la fois (comme l'agent) : celles d'avant ne déclenchent plus rien.
  connecter(essai) {
    if (!this.actif) return;
    clearTimeout(this.minuteur);
    const generation = ++this.generation;
    const ws = this.ws = new WebSocket(`${WS}/api/agent`, { headers: { authorization: `Bearer ${this.jeton}`, 'x-agent-version': 'endurance' } });
    ws.on('message', (d) => generation === this.generation && this.surOrdre(JSON.parse(d)));
    ws.on('error', () => {});
    ws.on('close', () => {
      if (generation !== this.generation) return;
      this.connecte = false;
      this.minuteur = setTimeout(() => this.connecter(essai + 1), Math.min(1000, 100 * 2 ** essai));
    });
  }
  envoyer(m) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m)); }
  surOrdre(o) {
    this.ordres.push(o.type);
    if (o.type === 'bienvenue') {
      this.connecte = true;
      this.envoyer({ type: 'heberge', salle: this.salle });  // comme l'agent : toujours dire ce qu'on héberge
    } else if (o.type === 'heberger') {
      this.salle = o.salle;
      this.jetonRelais = o.jeton;
      this.relaisUrl = o.relais[0];
      this.brancherRelais();
    } else if (o.type === 'arreter') {
      this.salle = '';
      this.relais?.close();
    } else if (o.type === 'jeton' && o.salle === this.salle) {
      this.jetonRelais = o.jeton;
    } else if (o.type === 'exclure' && this.relais?.readyState === 1) {
      this.relais.send(JSON.stringify({ type: 'exclure', uid: o.uid }));  // comme l'agent : le relais coupe la personne
    }
  }
  brancherRelais() {
    if (!this.salle || !this.actif || this.relais?.readyState === 1) return;
    const salle = this.salle;
    const ws = this.relais = new WebSocket(`${this.relaisUrl}?jeton=${encodeURIComponent(this.jetonRelais)}`);
    // 30 images/s vers tous les amis : [u32 destinataire][u8 drapeaux][u8 couche][f64 heure][données]
    const images = setInterval(() => {
      if (ws.readyState !== 1) return;
      const b = Buffer.alloc(4 + 10 + 100);
      b[4] = Math.random() < 0.05 ? 1 : 0;
      b.writeDoubleLE(Date.now(), 6);
      ws.send(b);
    }, 33);
    ws.on('message', (d, binaire) => {
      if (binaire) return;
      const m = JSON.parse(d);
      if (m.type === 'ping') ws.send(JSON.stringify({ type: 'pong', a: m.de, t: m.t, s: Date.now() }));
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      clearInterval(images);
      if (this.salle === salle) setTimeout(() => this.brancherRelais(), 100);
    });
  }
  /** Coupure réseau : plus rien ne passe (et pas de reconnexion) jusqu'à reprendre(). */
  couper() { this.actif = false; clearTimeout(this.minuteur); this.generation++; this.ws?.terminate(); this.relais?.terminate(); }
  /** Le réseau revient : l'agent se reconnecte en hébergeant toujours sa partie. */
  reprendre() { this.actif = true; this.connecter(0); this.brancherRelais(); }
  /** L'agent redémarre (mise à jour, plantage) : il a tout oublié. */
  redemarrer() { this.couper(); this.salle = ''; this.reprendre(); }
}

// ------------------------------------------------------------------ les scénarios
let hote, ami, regard, agent;

before(async () => {
  await demarrerServeur();
  hote = await new FauxJoueur('Hote').ouvrir();
  ami = await new FauxJoueur('Ami').ouvrir();
  agent = await new FauxAgent().jumeler(hote);
  await jusqua(() => hote.etat?.moi?.agent === 'en-ligne', 5000, 'agent vu par la salle');
  hote.envoyer({ type: 'heberger' });
  regard = new FauxSpectateur(ami).demarrer();
});

after(async () => {
  for (const x of [regard, ami, hote, agent]) x?.couper();
  await arreterServeur();
});

test('un ami reçoit l’image par le relais', async () => {
  await regard.voitLImage(5000, 'image chez l’ami');
});

test('coupure courte de l’agent (moins que le délai) : la partie continue', async () => {
  agent.couper();
  await pause(DELAI_AGENT_MS / 2);
  assert.ok(ami.etat.salle.hote, 'la partie n’est pas arrêtée pendant la coupure');
  agent.reprendre();
  await regard.voitLImage(5000, 'image revenue après la coupure');
});

test('agent redémarré (mise à jour, plantage) : la partie est relancée', async () => {
  agent.redemarrer();
  await jusqua(() => agent.salle !== '', 5000, 'le serveur relance la partie sur l’agent redémarré');
  await regard.voitLImage(5000, 'image revenue après le redémarrage de l’agent');
});

test('serveur redémarré en pleine partie : tout repart', async () => {
  await arreterServeur();
  await pause(300);
  await demarrerServeur();
  await jusqua(() => ami.etat?.salle?.hote, 8000, 'la partie est reprise par le serveur');
  await regard.voitLImage(8000, 'image revenue après le redémarrage du serveur');
});

test('coupure longue de l’hôte et de son agent (box) : la partie reprend à leur retour', async () => {
  agent.couper();
  hote.couper();
  await pause(DELAI_AGENT_MS * 1.5);
  await jusqua(() => !ami.etat?.salle?.hote, 5000, 'la partie est suspendue');
  hote.reprendre();
  agent.reprendre();
  await jusqua(() => ami.etat?.salle?.hote, 8000, 'la partie reprend au retour de l’hôte');
  await regard.voitLImage(8000, 'image revenue après la longue coupure');
});

test('« Arrêter » pendant une coupure de l’agent : la partie ne repart pas toute seule', async () => {
  agent.couper();
  await pause(200);
  hote.envoyer({ type: 'arreter' });
  await jusqua(() => !ami.etat?.salle?.hote, 3000, 'arrêtée pour tout le monde');
  agent.reprendre();
  await jusqua(() => agent.connecte, 5000, 'agent revenu');
  await jusqua(() => agent.salle === '', 3000, 'le serveur redit à l’agent d’arrêter');
  await pause(500);
  assert.equal(ami.etat.salle.hote, null, 'la partie reste arrêtée');
  // On relance pour la suite.
  hote.envoyer({ type: 'heberger' });
  await regard.voitLImage(5000, 'image après avoir relancé la partie');
});

test('chaos : coupures au hasard pendant 10 s, l’image revient toujours', async () => {
  const fin = Date.now() + 10_000;
  let coupures = 0;
  while (Date.now() < fin) {
    const cible = [() => regard.ws?.terminate(), () => ami.ws?.terminate(), () => agent.relais?.terminate(), () => agent.ws?.terminate(), () => hote.ws?.terminate()][Math.floor(Math.random() * 5)];
    cible();
    coupures++;
    await pause(300 + Math.random() * 900);
  }
  assert.ok(coupures >= 8);
  await regard.voitLImage(5000, 'image revenue après le chaos');
  assert.ok(ami.etat.salle.hote, 'toujours en partie');
});

test('retiré par l’hôte : plus d’image, et la porte reste fermée', async () => {
  const uidAmi = ami.etat.salle.participants.find((p) => p.nom === 'Ami').uid;
  hote.envoyer({ type: 'exclure', uid: uidAmi });
  await jusqua(() => ami.fermeCode === 4003, 3000, 'page de l’ami fermée (4003)');
  await jusqua(() => regard.fermeCode === 4003, 3000, 'vidéo de l’ami coupée au relais (4003)');
});
