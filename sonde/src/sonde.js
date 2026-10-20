// Côté navigateur de la sonde. Chaque test remplit `R` ; le rapport part au serveur après chaque test
// et à chaque nouvel événement (manette, clavier, tactile), sous le même identifiant de session.
import { DiscordSDK } from '@discord/embedded-app-sdk';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const inDiscord = params.has('frame_id');
const session = Math.random().toString(36).slice(2, 10);
const R = { session, dansDiscord: inDiscord, ua: navigator.userAgent, ecran: `${screen.width}x${screen.height}@${devicePixelRatio}`, tests: {} };

const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1) : null; };
const stats = (a) => ({ n: a.length, med: q(a, 0.5), p95: q(a, 0.95), min: q(a, 0), max: q(a, 1) });

function show(id, ok, text) {
  const el = $(id);
  el.className = ok === true ? 'ok' : ok === false ? 'ko' : 'wait';
  el.querySelector('.res').textContent = text;
}

let sendTimer;
function sendSoon() {
  clearTimeout(sendTimer);
  sendTimer = setTimeout(() => {
    fetch('/api/rapport', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(R) }).catch(() => {});
  }, 800);
}

// --- 1. Environnement
async function environnement() {
  const codecs = {};
  for (const c of ['avc1.42e01f', 'avc1.4d002a', 'avc1.640c2a', 'hvc1.1.6.L120.90']) {
    try {
      const r = await VideoDecoder.isConfigSupported({ codec: c, hardwareAcceleration: 'prefer-hardware', optimizeForLatency: true });
      codecs[c] = r.supported;
    } catch (e) { codecs[c] = 'erreur ' + e.name; }
  }
  let gamepadPolicy = null;
  try { gamepadPolicy = document.featurePolicy ? document.featurePolicy.allowsFeature('gamepad') : 'inconnu'; } catch { gamepadPolicy = 'erreur'; }
  R.tests.env = {
    RTCPeerConnection: typeof window.RTCPeerConnection, WebTransport: typeof window.WebTransport,
    VideoDecoder: typeof window.VideoDecoder, codecs, gamepadPolicy,
    pleinEcran: document.fullscreenEnabled, tactile: navigator.maxTouchPoints, vibrate: typeof navigator.vibrate,
    mouvement: typeof window.DeviceMotionEvent, reseau: navigator.connection ? navigator.connection.effectiveType : null,
  };
  const e = R.tests.env;
  show('t-env', true, `WebRTC : ${e.RTCPeerConnection === 'function' ? 'présent' : 'BLOQUÉ'} · WebCodecs : ${e.VideoDecoder} · H.264 : ${codecs['avc1.4d002a']} · politique manette : ${gamepadPolicy}`);
}

// --- 2. Manette (Gamepad API)
function manette() {
  const t = (R.tests.manette = { api: typeof navigator.getGamepads, erreur: null, vues: [] });
  try { navigator.getGamepads(); } catch (e) { t.erreur = e.name + ': ' + e.message; }
  if (t.erreur || t.api !== 'function') { show('t-pad', false, 'Gamepad API indisponible : ' + (t.erreur || t.api)); sendSoon(); return; }
  show('t-pad', null, 'Branche une manette puis appuie sur un bouton…');
  const seen = new Set();
  const loop = () => {
    for (const g of navigator.getGamepads()) {
      if (!g) continue;
      const pressed = g.buttons.map((b, i) => (b.pressed ? i : -1)).filter((i) => i >= 0);
      if (!seen.has(g.id)) {
        seen.add(g.id);
        t.vues.push({ id: g.id, mapping: g.mapping, boutons: g.buttons.length, axes: g.axes.length, vibration: !!g.vibrationActuator });
        sendSoon();
      }
      show('t-pad', true, `${g.id} (${g.mapping || 'sans mapping'}) — boutons : ${pressed.join(', ') || 'aucun'} — stick : ${g.axes.slice(0, 2).map((a) => a.toFixed(2)).join(' / ')}`);
      if (pressed.length && !t.premierAppui) { t.premierAppui = new Date().toISOString(); sendSoon(); }
    }
    requestAnimationFrame(loop);
  };
  loop();
  $('vibrer').onclick = () => {
    const g = [...navigator.getGamepads()].find(Boolean);
    if (!g || !g.vibrationActuator) { t.vibration = 'pas de manette ou pas de vibration'; sendSoon(); return; }
    g.vibrationActuator.playEffect('dual-rumble', { duration: 400, strongMagnitude: 1, weakMagnitude: 1 })
      .then((r) => { t.vibration = r; sendSoon(); }, (e) => { t.vibration = 'erreur ' + e.name; sendSoon(); });
  };
}

// --- 3. Clavier et tactile
function clavierTactile() {
  const t = (R.tests.saisie = { touches: 0, tactile: 0, souris: 0 });
  addEventListener('keydown', (e) => { t.touches++; t.derniere = e.code; show('t-key', true, `${t.touches} touche(s), dernière : ${e.code}`); sendSoon(); });
  addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') t.tactile++; else t.souris++;
    show('t-touch', true, `${t.tactile} appui(s) tactile(s), ${t.souris} clic(s)`);
    sendSoon();
  });
  show('t-key', null, 'Appuie sur une touche du clavier…');
  show('t-touch', null, 'Touche l’écran (ou clique)…');
}

// --- Mesure générique sur un « transport » : { send(obj), onText, onBinary, close() }.
// 100 pings (aller-retour + décalage d'horloge), puis 10 s de flux vidéo à 60 i/s décodé avec WebCodecs.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mesurer(tr, id, label) {
  const t = {};
  const rtt = [], offsets = [];
  tr.onText = (m) => {
    if (m.type === 'pong') {
      const now = performance.now(), r = now - m.t;
      rtt.push(r);
      offsets.push({ r, off: m.s - (performance.timeOrigin + (m.t + now) / 2) });  // horloge distante - horloge locale
    }
  };
  for (let n = 0; n < 100; n++) { tr.send({ type: 'ping', t: performance.now() }); await sleep(50); }
  await sleep(500);
  t.allerRetour = stats(rtt);
  t.pertesPing = 100 - rtt.length;
  if (!rtt.length) { show(id, false, `${label} : aucune réponse`); return t; }
  show(id, null, `${label} : aller-retour ${t.allerRetour.med} ms… flux en cours`);
  sendSoon();
  const best = offsets.sort((a, b) => a.r - b.r)[0];
  Object.assign(t, await fluxSur(tr, best ? best.off : 0));
  show(id, t.recues > 0, `${label} : aller-retour ${t.allerRetour.med} ms (p95 ${t.allerRetour.p95}) · image ${t.versToi.med} ms (p95 ${t.versToi.p95}) · ${t.affichees}/${t.envoyees || '?'} images`);
  return t;
}

function codecFromSPS(b) {
  for (let i = 0; i + 6 < b.length; i++) {
    if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1 && (b[i + 3] & 0x1f) === 7) {
      return 'avc1.' + [b[i + 4], b[i + 5], b[i + 6]].map((x) => x.toString(16).padStart(2, '0')).join('');
    }
  }
  return 'avc1.4d4020';
}

function fluxSur(tr, offset) {
  return new Promise((done) => {
    const canvas = $('video'), ctx = canvas.getContext('2d');
    const oneWay = [], gaps = [], decode = [], pending = new Map();
    let last = 0, recu = 0, octets = 0, decoder = null, erreurs = 0, affichees = 0, codec = null, derniereErreur;
    const start = performance.now();
    let garde;
    const fin = (m) => {
      clearTimeout(garde);
      done({
        recues: recu, envoyees: m.envoyees, refus: m.raison, debitMbps: +((octets * 8) / ((performance.now() - start) * 1000)).toFixed(2),
        versToi: stats(oneWay), ecartEntreImages: stats(gaps), decodage: stats(decode), affichees, erreursDecodage: erreurs, codec, derniereErreur,
      });
    };
    garde = setTimeout(() => fin({ raison: 'délai dépassé' }), 20000);
    tr.onText = (m) => { if (m.type === 'fin' || m.type === 'refus') fin(m); };
    tr.onBinary = (buf) => {
      const now = performance.now(), dv = new DataView(buf);
      const sent = dv.getFloat64(0, true), seq = dv.getUint32(8, true), key = dv.getUint8(12) === 1;
      recu++; octets += buf.byteLength;
      oneWay.push(performance.timeOrigin + now + offset - sent);
      if (last) gaps.push(now - last);
      last = now;
      if (typeof VideoDecoder !== 'function') return;
      const au = new Uint8Array(buf, 13);
      if (!decoder) {
        if (!key) return;
        codec = codecFromSPS(au);
        decoder = new VideoDecoder({
          output: (f) => {
            const s0 = pending.get(f.timestamp);
            if (s0 !== undefined) { decode.push(performance.now() - s0); pending.delete(f.timestamp); }
            if (canvas.width !== f.displayWidth) { canvas.width = f.displayWidth; canvas.height = f.displayHeight; }
            ctx.drawImage(f, 0, 0);
            f.close();
            affichees++;
          },
          error: (err) => { erreurs++; derniereErreur = String(err); decoder = null; },
        });
        decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
      }
      pending.set(seq, performance.now());
      try { decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: seq, data: au })); } catch (err) { erreurs++; derniereErreur = String(err); }
    };
    tr.send({ type: 'flux', secondes: 10 });
  });
}

// Transport WebSocket. Sur /relais, on rejoint la salle comme ami : les messages vont à l'hôte (le PC).
function transportWS(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const tr = { onText() {}, onBinary() {}, send: (m) => ws.send(JSON.stringify(m)), close: () => ws.close(), url };
    const timer = setTimeout(() => { ws.close(); reject(new Error('délai de connexion')); }, timeoutMs);
    const t0 = performance.now();
    ws.onopen = () => { clearTimeout(timer); tr.ouvertureMs = +(performance.now() - t0).toFixed(1); setTimeout(() => resolve(tr), 300); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('connexion impossible')); };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return tr.onBinary(e.data);
      const m = JSON.parse(e.data);
      if (m.type === 'pas-d-hote') tr.pasDHote = true;
      tr.onText(m);
    };
  });
}

async function premierQuiMarche(urls) {
  let err;
  for (const u of urls) { try { return await transportWS(u); } catch (e) { err = e; } }
  throw err;
}

const wsBase = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
const SALLE = /^[a-z0-9-]{1,64}$/.test(params.get('salle') || '') ? params.get('salle') : 'sonde';
const urlsVPS = [`${wsBase}/relais?salle=${SALLE}&role=ami`];
const urlsCF = inDiscord
  ? [`${wsBase}/cf/relais?salle=${SALLE}&role=ami`, `${wsBase}/.proxy/cf/relais?salle=${SALLE}&role=ami`]
  : [`wss://switch-emu-relais.amin2020e.workers.dev/relais?salle=${SALLE}&role=ami`];

// P2P : la poignée de main passe par le relais du VPS, puis tout va directement au PC (canaux de données WebRTC).
async function transportP2P() {
  const sig = await premierQuiMarche(urlsVPS);
  if (sig.pasDHote) return sig;
  const pc = new RTCPeerConnection({ iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }] });
  const ctrl = pc.createDataChannel('ctrl');
  const video = pc.createDataChannel('video', { ordered: false, maxRetransmits: 0 });
  video.binaryType = 'arraybuffer';
  const tr = { onText() {}, onBinary() {}, send: (m) => ctrl.send(JSON.stringify(m)), close: () => { pc.close(); sig.close(); } };
  ctrl.onmessage = (e) => tr.onText(JSON.parse(e.data));
  video.onmessage = (e) => tr.onBinary(e.data);
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((r) => {
    if (pc.iceGatheringState === 'complete') return r();
    pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && r();
    setTimeout(r, 3000);
  });
  const answer = new Promise((resolve, reject) => {
    sig.onText = (m) => { if (m.type === 'reponse') { if (m.sdp) resolve(m.sdp); else reject(new Error(m.erreur || 'pas de réponse')); } };
    setTimeout(() => reject(new Error('pas de réponse de l’hôte')), 10000);
  });
  sig.send({ type: 'offre', sdp: pc.localDescription.sdp });
  await pc.setRemoteDescription({ type: 'answer', sdp: await answer });
  await new Promise((resolve, reject) => {
    const check = () => { if (ctrl.readyState === 'open' && video.readyState === 'open') resolve(); };
    ctrl.onopen = check; video.onopen = check; check();
    setTimeout(() => reject(new Error('connexion directe impossible (NAT des deux côtés)')), 10000);
  });
  const st = await pc.getStats();
  st.forEach((s) => {
    if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') {
      const l = st.get(s.localCandidateId), r = st.get(s.remoteCandidateId);
      tr.chemin = `${l && l.candidateType} → ${r && r.candidateType} (${l && l.protocol})`;
    }
  });
  return tr;
}

async function chemin(id, label, ouvrir) {
  let tr;
  try { tr = await ouvrir(); } catch (e) {
    show(id, false, `${label} : ${e.message}`);
    return { erreur: e.message };
  }
  if (tr.pasDHote) { tr.close(); show(id, false, `${label} : l’hôte de test n’est pas lancé sur le PC`); return { erreur: 'hôte absent' }; }
  const t = await mesurer(tr, id, label);
  t.url = tr.url; t.ouvertureMs = tr.ouvertureMs; t.chemin = tr.chemin;
  tr.close();
  return t;
}

async function tousLesTests() {
  R.tests.serveur = await chemin('t-ws', 'VPS seul', () => transportWS(`${wsBase}/ws`));
  sendSoon();
  R.tests.chemins = {};
  R.tests.chemins.vps = await chemin('t-vps', 'Via Helsinki', () => premierQuiMarche(urlsVPS));
  sendSoon();
  R.tests.chemins.cloudflare = await chemin('t-cf', 'Via Cloudflare', () => premierQuiMarche(urlsCF));
  sendSoon();
  if (typeof window.RTCPeerConnection === 'function') {
    R.tests.chemins.p2p = await chemin('t-p2p', 'P2P direct', transportP2P);
  } else {
    show('t-p2p', false, 'Impossible dans Discord (WebRTC bloqué) : utilise « Ouvrir dans le navigateur »');
  }
  sendSoon();
}

// --- Démarrage
async function main() {
  $('mode').textContent = inDiscord ? 'Dans Discord' : 'Hors de Discord (navigateur)';
  let sdk = null;
  if (inDiscord) {
    try {
      const { clientId } = await fetch('/api/config').then((r) => r.json());
      sdk = new DiscordSDK(clientId);
      await sdk.ready();
      R.discord = { plateforme: sdk.platform, instance: sdk.instanceId, salon: sdk.channelId, serveur: sdk.guildId, mobile: params.get('mobile_app_version') || null };
      $('mode').textContent = `Dans Discord (${sdk.platform})`;
    } catch (e) { R.discord = { erreur: String(e) }; }
  }
  // « Ouvrir dans le navigateur » : la même page hors de Discord, où le P2P est possible.
  $('ouvrir').onclick = async () => {
    const url = 'https://switch.mciut.fr/?depuis=discord';
    if (!sdk) { location.href = url; return; }
    try { R.ouvrirNavigateur = await sdk.commands.openExternalLink({ url }); } catch (e) { R.ouvrirNavigateur = { erreur: String(e) }; }
    sendSoon();
  };
  await environnement();
  manette();
  clavierTactile();
  sendSoon();
  const relancer = $('relancer');
  relancer.onclick = () => { relancer.disabled = true; tousLesTests().then(() => { relancer.disabled = false; }); };
  relancer.disabled = true;
  await tousLesTests();
  relancer.disabled = false;
}
main();
