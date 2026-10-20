// Relais sur Cloudflare : une salle = un Durable Object, créé près du premier qui s'y connecte (l'hôte).
// Même protocole que le relais de repli du VPS (serveur/src/relais.js) :
//   connexion : /relais?jeton=<jeton signé par le serveur {salle, role: 'hote'|'ami', uid}>
//   ami -> hôte : texte JSON (types autorisés seulement), le relais ajoute "de": <id> et "uid"
//   hôte -> amis : texte JSON avec "a": <id> (ou sans "a" = tout le monde) ;
//                  binaire = [u32 id destinataire, 0 = tout le monde][charge]
import { verifier } from './jetons.js';

const MAX_AMIS = 16;
const MAX_TEXTE = 4096;
const TYPES_AMI = new Set(['ping', 'idr', 'qualite', 'manette']);

export class Salle {
  constructor(state) {
    this.state = state;
    this.hote = null;
    this.amis = new Map();
    this.uids = new Map();  // id de connexion -> uid Discord (pour retirer quelqu'un)
    this.suivant = 1;
  }

  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket attendu', { status: 426 });
    // Rôle et identité viennent du jeton vérifié par le Worker, jamais de l'utilisateur.
    const role = req.headers.get('X-Relais-Role');
    const uid = req.headers.get('X-Relais-Uid') || '';
    if (role !== 'hote' && this.amis.size >= MAX_AMIS) return new Response('salle pleine', { status: 429 });
    const { 0: client, 1: ws } = new WebSocketPair();
    ws.binaryType = 'arraybuffer';  // sinon les messages binaires arrivent en Blob
    ws.accept();
    if (role === 'hote') this.brancherHote(ws);
    else this.brancherAmi(ws, uid);
    return new Response(null, { status: 101, webSocket: client });
  }

  brancherHote(ws) {
    if (this.hote) try { this.hote.close(4000, 'remplacé par un autre hôte'); } catch {}
    this.hote = ws;
    for (const id of this.amis.keys()) this.versHote({ type: 'arrivee', de: id });
    ws.addEventListener('message', (e) => this.depuisHote(e.data));
    ws.addEventListener('close', () => {
      if (this.hote !== ws) return;
      this.hote = null;
      for (const a of this.amis.values()) try { a.send(JSON.stringify({ type: 'hote-parti' })); } catch {}
    });
  }

  brancherAmi(ws, uid) {
    const id = this.suivant++;
    this.amis.set(id, ws);
    this.uids.set(id, uid);
    this.versHote({ type: 'arrivee', de: id, uid });
    if (!this.hote) ws.send(JSON.stringify({ type: 'pas-d-hote' }));
    ws.addEventListener('message', (e) => {
      if (typeof e.data !== 'string' || e.data.length > MAX_TEXTE) return;
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (!m || !TYPES_AMI.has(m.type)) return;
      m.de = id;
      m.uid = uid;
      this.versHote(m);
    });
    ws.addEventListener('close', () => { this.amis.delete(id); this.uids.delete(id); this.versHote({ type: 'depart', de: id }); });
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
      // L'hôte retire quelqu'un : on ferme ses connexions.
      if (m.type === 'exclure' && typeof m.uid === 'string') {
        for (const [id, w] of this.amis) if (this.uids.get(id) === m.uid) try { w.close(4003, 'retiré par l’hôte'); } catch {}
        return;
      }
      const a = m.a;
      delete m.a;
      envoyer(a, JSON.stringify(m));
    } else if (d instanceof ArrayBuffer && d.byteLength > 4) {
      envoyer(new DataView(d).getUint32(0, true), d.slice(4));
    }
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.endsWith('/relais')) {
      return new Response('relais Switch EMU', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    const d = await verifier(env.RELAY_SECRET, url.searchParams.get('jeton'));
    if (!d || typeof d.salle !== 'string' || !/^[a-z0-9-]{1,64}$/.test(d.salle) || (d.role !== 'hote' && d.role !== 'ami')) {
      return new Response('jeton invalide', { status: 401 });
    }
    const headers = new Headers(req.headers);
    headers.set('X-Relais-Role', d.role);
    headers.set('X-Relais-Uid', String(d.uid || ''));
    return env.SALLE.get(env.SALLE.idFromName(d.salle)).fetch(new Request(req, { headers }));
  },
};
