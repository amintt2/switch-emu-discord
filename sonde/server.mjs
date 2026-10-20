// Sonde jetable : vérifie dans le vrai Discord ce que l'Activité permet (manette, clavier, tactile,
// WebSocket via le proxy, WebCodecs). Les rapports sont écrits dans les journaux (ligne "RAPPORT {...}").
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 3000);
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '1562101845688717364';
const PUBLIC = new URL('./public/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };

// Test clip (Annex B with an AUD before each frame) split into access units once at startup.
const clip = readFileSync(join(PUBLIC, '..', 'clip.h264'));
const frames = [];
let start = 0;
for (let i = 1; i + 4 < clip.length; i++) {
  if (clip[i] === 0 && clip[i + 1] === 0 && clip[i + 2] === 0 && clip[i + 3] === 1 && (clip[i + 4] & 0x1f) === 9) {
    frames.push(clip.subarray(start, i));
    start = i;
  }
}
frames.push(clip.subarray(start));

// Very small per-IP budget so the public probe cannot be used to burn bandwidth.
const budget = new Map();
function allow(ip, cost, perMinute) {
  const now = Date.now(), b = budget.get(ip) || { t: now, used: 0 };
  if (now - b.t > 60_000) { b.t = now; b.used = 0; }
  b.used += cost;
  budget.set(ip, b);
  return b.used <= perMinute;
}
const ipOf = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/api/config') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ clientId: CLIENT_ID, frames: frames.length }));
  }
  if (req.method === 'POST' && url.pathname === '/api/rapport') {
    if (!allow(ipOf(req), 1, 30)) { res.writeHead(429); return res.end(); }
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 32_000) { res.writeHead(413); return res.end(); } }
    try {
      const r = JSON.parse(body);
      console.log('RAPPORT ' + JSON.stringify({ recu: new Date().toISOString(), ...r }));
      res.writeHead(204);
    } catch { res.writeHead(400); }
    return res.end();
  }
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  const path = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
  try {
    const data = await readFile(join(PUBLIC, path));
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch { res.writeHead(404); res.end('introuvable'); }
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
wss.on('connection', (ws, req) => {
  const ip = ipOf(req);
  let streaming = false;
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'ping') return ws.send(JSON.stringify({ type: 'pong', t: m.t, s: performance.timeOrigin + performance.now() }));
    if (m.type === 'flux' && !streaming) {
      // Sends the test clip (looped) at 60 fps: [f64 server time ms][u32 seq][u8 key][Annex B]
      const seconds = Math.min(15, Math.max(1, Number(m.secondes) || 10));
      if (!allow(ip, seconds, 60)) return ws.send(JSON.stringify({ type: 'refus', raison: 'limite atteinte, réessaie dans une minute' }));
      streaming = true;
      let seq = 0;
      const total = seconds * 60, t0 = performance.now();
      const tick = () => {
        if (ws.readyState !== ws.OPEN) { streaming = false; return; }
        if (seq >= total) { streaming = false; return ws.send(JSON.stringify({ type: 'fin', envoyees: seq })); }
        const au = frames[seq % frames.length];
        const hdr = Buffer.alloc(13);
        hdr.writeDoubleLE(performance.timeOrigin + performance.now(), 0);
        hdr.writeUInt32LE(seq, 8);
        hdr[12] = seq % frames.length === 0 ? 1 : 0;
        ws.send(Buffer.concat([hdr, au]));
        seq++;
        setTimeout(tick, Math.max(0, t0 + (seq * 1000) / 60 - performance.now()));
      };
      tick();
    }
  });
});

server.listen(PORT, () => console.log(`sonde prête sur :${PORT} (${frames.length} images dans l'extrait)`));
