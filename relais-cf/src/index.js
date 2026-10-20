// Relais de test sur Cloudflare : une salle = un Durable Object, créé près du premier qui s'y connecte
// (l'hôte), donc près de lui. Même protocole que le relais du VPS (sonde/server.mjs) :
//   /relais?salle=<nom>&role=hote|ami
//   ami -> hôte : texte JSON, le relais ajoute "de": <id de l'ami>
//   hôte -> ami : texte JSON avec "a": <id> (ou sans "a" = tout le monde) ;
//                 binaire = [u32 id destinataire, 0 = tout le monde][charge]
const MAX_AMIS = 16;

export class Salle {
  constructor(state) {
    this.state = state;
    this.hote = null;
    this.amis = new Map();
    this.suivant = 1;
  }

  async fetch(req) {
    if (new URL(req.url).pathname.endsWith('/info')) {  // diagnostic : où Cloudflare a placé cette salle
      let trace = '';
      try { trace = await (await fetch('https://1.1.1.1/cdn-cgi/trace')).text(); } catch (e) { trace = String(e); }
      return Response.json({ salle: (trace.match(/colo=(\w+)/) || [])[1], hote: !!this.hote, amis: this.amis.size });
    }
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket attendu', { status: 426 });
    const role = new URL(req.url).searchParams.get('role');
    if (role !== 'hote' && this.amis.size >= MAX_AMIS) return new Response('salle pleine', { status: 429 });
    const { 0: client, 1: ws } = new WebSocketPair();
    ws.binaryType = 'arraybuffer';  // sinon les messages binaires arrivent en Blob (comportement standard récent)
    ws.accept();
    if (role === 'hote') {
      if (this.hote) try { this.hote.close(4000, 'remplacé par un autre hôte'); } catch {}
      this.hote = ws;
      ws.addEventListener('message', (e) => this.depuisHote(e.data));
      ws.addEventListener('close', () => { if (this.hote === ws) this.hote = null; });
    } else {
      const id = this.suivant++;
      this.amis.set(id, ws);
      this.versHote({ type: 'arrivee', de: id });
      ws.addEventListener('message', (e) => {
        if (typeof e.data !== 'string' || e.data.length > 65536) return;
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        m.de = id;
        this.versHote(m);
      });
      ws.addEventListener('close', () => { this.amis.delete(id); this.versHote({ type: 'depart', de: id }); });
      if (!this.hote) ws.send(JSON.stringify({ type: 'pas-d-hote' }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  versHote(m) {
    try { this.hote?.send(JSON.stringify(m)); } catch {}
  }

  depuisHote(d) {
    const envoyer = (a, charge) => {
      const cibles = a ? [this.amis.get(a)] : [...this.amis.values()];
      for (const w of cibles) try { w?.send(charge); } catch {}
    };
    if (typeof d === 'string') {
      let m;
      try { m = JSON.parse(d); } catch { return; }
      const a = m.a;
      delete m.a;
      envoyer(a, JSON.stringify(m));
    } else {
      const u8 = d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : null;
      if (!u8) { console.log('message binaire de type inattendu', Object.prototype.toString.call(d)); return; }
      if (u8.byteLength <= 4) return;
      envoyer(new DataView(u8.buffer, u8.byteOffset, 4).getUint32(0, true), u8.slice(4));
    }
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/relais') || url.pathname.endsWith('/info')) {
      const salle = url.searchParams.get('salle') || '';
      if (!/^[a-z0-9-]{1,64}$/.test(salle)) return new Response('salle invalide', { status: 400 });
      const res = await env.SALLE.get(env.SALLE.idFromName(salle)).fetch(req);
      if (!url.pathname.endsWith('/info')) return res;
      return Response.json({ ...(await res.json()), worker: req.cf && req.cf.colo });
    }
    return new Response('relais switch-emu (test)', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  },
};
