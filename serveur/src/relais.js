// Relais de repli sur le VPS, même protocole que le relais Cloudflare (relais/src/index.js) :
//   connexion : /relais?jeton=<jeton signé {salle, role: 'hote'|'ami', uid}>
//   ami -> hôte : texte JSON (types autorisés seulement), le relais ajoute "de": <id>
//   hôte -> amis : texte JSON avec "a": <id> (ou sans "a" = tout le monde) ;
//                  binaire = [u32 id destinataire, 0 = tout le monde][charge]
import { verifier } from './jetons.js';

export const MAX_AMIS = 16;
export const TYPES_AMI = new Set(['ping', 'idr', 'qualite', 'manette']);
const MAX_TEXTE = 4096;

export class Relais {
  constructor({ secret }) {
    this.secret = secret;
    /** salle -> { hote, amis: Map<id, ws>, suivant } */
    this.salles = new Map();
  }

  /** Vérifie le jeton d'une connexion entrante. Renvoie { salle, role, uid } ou null. */
  autoriser(jeton) {
    const d = verifier(this.secret, jeton);
    if (!d || typeof d.salle !== 'string' || !/^[a-z0-9-]{1,64}$/.test(d.salle)) return null;
    if (d.role !== 'hote' && d.role !== 'ami') return null;
    return { salle: d.salle, role: d.role, uid: String(d.uid || '') };
  }

  brancher(ws, { salle, role, uid }) {
    let s = this.salles.get(salle);
    if (!s) this.salles.set(salle, (s = { hote: null, amis: new Map(), suivant: 1 }));
    const versHote = (m) => { if (s.hote?.readyState === 1) s.hote.send(JSON.stringify(m)); };
    const fermer = () => { if (!s.hote && !s.amis.size) this.salles.delete(salle); };

    if (role === 'hote') {
      if (s.hote && s.hote !== ws) s.hote.close(4000, 'remplacé par un autre hôte');
      s.hote = ws;
      for (const id of s.amis.keys()) versHote({ type: 'arrivee', de: id });
      ws.on('message', (d, binaire) => this.depuisHote(s, d, binaire));
      ws.on('close', () => {
        if (s.hote !== ws) return;
        s.hote = null;
        for (const a of s.amis.values()) if (a.readyState === 1) a.send(JSON.stringify({ type: 'hote-parti' }));
        fermer();
      });
      return;
    }
    if (s.amis.size >= MAX_AMIS) return ws.close(4002, 'salle pleine');
    const id = s.suivant++;
    s.amis.set(id, ws);
    versHote({ type: 'arrivee', de: id, uid });
    if (!s.hote) ws.send(JSON.stringify({ type: 'pas-d-hote' }));
    ws.on('message', (d, binaire) => {
      if (binaire || d.length > MAX_TEXTE) return;
      let m;
      try { m = JSON.parse(d); } catch { return; }
      if (!m || !TYPES_AMI.has(m.type)) return;
      m.de = id;
      m.uid = uid;  // l'hôte sait toujours qui parle : ce n'est pas l'ami qui le dit
      versHote(m);
    });
    ws.on('close', () => {
      s.amis.delete(id);
      versHote({ type: 'depart', de: id });
      fermer();
    });
  }

  depuisHote(s, d, binaire) {
    const envoyer = (a, charge, opts) => {
      for (const [id, w] of s.amis) {
        if ((a && a !== id) || w.readyState !== 1) continue;
        // Un ami qui ne suit pas : on jette plutôt que d'accumuler du retard.
        if (opts.binary && w.bufferedAmount > 2_000_000) continue;
        w.send(charge, opts);
      }
    };
    if (!binaire) {
      let m;
      try { m = JSON.parse(d); } catch { return; }
      const a = m.a;
      delete m.a;
      envoyer(a, JSON.stringify(m), { binary: false });
    } else if (d.length > 4) {
      envoyer(d.readUInt32LE(0), d.subarray(4), { binary: true });
    }
  }
}
