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

// --- 4. WebSocket via le proxy Discord : aller-retour, puis flux vidéo de test à 60 i/s décodé avec WebCodecs
function websocket() {
  return new Promise((resolve) => {
    const t = (R.tests.ws = { url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws` });
    const ws = new WebSocket(t.url);
    ws.binaryType = 'arraybuffer';
    const rtt = [], offsets = [];
    const t0 = performance.now();
    ws.onerror = () => { t.erreur = 'erreur de connexion'; show('t-ws', false, 'Connexion WebSocket impossible'); sendSoon(); resolve(); };
    ws.onopen = () => {
      t.ouvertureMs = +(performance.now() - t0).toFixed(1);
      let n = 0;
      const iv = setInterval(() => {
        if (n++ >= 100) {
          clearInterval(iv);
          t.allerRetour = stats(rtt);
          show('t-ws', true, `Aller-retour : médiane ${t.allerRetour.med} ms, p95 ${t.allerRetour.p95} ms`);
          sendSoon();
          flux(ws, offsets, resolve);
          return;
        }
        ws.send(JSON.stringify({ type: 'ping', t: performance.now() }));
      }, 50);
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      const m = JSON.parse(e.data);
      if (m.type === 'pong') {
        const now = performance.now(), r = now - m.t;
        rtt.push(r);
        offsets.push({ r, off: m.s - (performance.timeOrigin + (m.t + now) / 2) });  // horloge serveur - horloge locale
      }
    };
  });
}

function codecFromSPS(b) {
  for (let i = 0; i + 6 < b.length; i++) {
    if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1 && (b[i + 3] & 0x1f) === 7) {
      return 'avc1.' + [b[i + 4], b[i + 5], b[i + 6]].map((x) => x.toString(16).padStart(2, '0')).join('');
    }
  }
  return 'avc1.4d4020';
}

function flux(ws, offsets, done) {
  const t = (R.tests.flux = {});
  const best = offsets.sort((a, b) => a.r - b.r)[0];
  const offset = best ? best.off : 0;
  const canvas = $('video'), ctx = canvas.getContext('2d');
  const oneWay = [], gaps = [], decode = [], pending = new Map();
  let last = 0, recu = 0, octets = 0, decoder = null, erreurs = 0, affichees = 0;
  const start = performance.now();
  show('t-flux', null, 'Réception du flux de test (10 s)…');
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      const m = JSON.parse(e.data);
      if (m.type === 'fin' || m.type === 'refus') {
        Object.assign(t, {
          recues: recu, envoyees: m.envoyees, refus: m.raison, debitMbps: +((octets * 8) / ((performance.now() - start) * 1000)).toFixed(2),
          serveurVersToi: stats(oneWay), ecartEntreImages: stats(gaps), decodage: stats(decode), affichees, erreursDecodage: erreurs, codec: t.codec,
        });
        show('t-flux', !m.raison && recu > 0, m.raison || `Serveur → toi : ${t.serveurVersToi.med} ms (p95 ${t.serveurVersToi.p95}) · décodage ${t.decodage.med} ms · ${affichees}/${recu} images affichées`);
        sendSoon();
        ws.close();
        done();
      }
      return;
    }
    const now = performance.now(), dv = new DataView(e.data);
    const sent = dv.getFloat64(0, true), seq = dv.getUint32(8, true), key = dv.getUint8(12) === 1;
    recu++; octets += e.data.byteLength;
    oneWay.push(performance.timeOrigin + now + offset - sent);
    if (last) gaps.push(now - last);
    last = now;
    if (typeof VideoDecoder !== 'function') return;
    const au = new Uint8Array(e.data, 13);
    if (!decoder) {
      if (!key) return;
      t.codec = codecFromSPS(au);
      decoder = new VideoDecoder({
        output: (f) => {
          const s = pending.get(f.timestamp);
          if (s !== undefined) { decode.push(performance.now() - s); pending.delete(f.timestamp); }
          if (canvas.width !== f.displayWidth) { canvas.width = f.displayWidth; canvas.height = f.displayHeight; }
          ctx.drawImage(f, 0, 0);
          f.close();
          affichees++;
        },
        error: (err) => { erreurs++; t.derniereErreur = String(err); decoder = null; },
      });
      decoder.configure({ codec: t.codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
    }
    pending.set(seq, performance.now());
    try { decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: seq, data: au })); } catch (err) { erreurs++; t.derniereErreur = String(err); }
  };
  ws.send(JSON.stringify({ type: 'flux', secondes: 10 }));
}

// --- Démarrage
async function main() {
  $('mode').textContent = inDiscord ? 'Dans Discord' : 'Hors de Discord (navigateur)';
  if (inDiscord) {
    try {
      const { clientId } = await fetch('/api/config').then((r) => r.json());
      const sdk = new DiscordSDK(clientId);
      await sdk.ready();
      R.discord = { plateforme: sdk.platform, instance: sdk.instanceId, salon: sdk.channelId, serveur: sdk.guildId, mobile: params.get('mobile_app_version') || null };
      $('mode').textContent = `Dans Discord (${sdk.platform})`;
    } catch (e) { R.discord = { erreur: String(e) }; }
  }
  await environnement();
  manette();
  clavierTactile();
  sendSoon();
  $('relancer').onclick = () => { $('relancer').disabled = true; websocket().then(() => { $('relancer').disabled = false; }); };
  await websocket();
}
main();
