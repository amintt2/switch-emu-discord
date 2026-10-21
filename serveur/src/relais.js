// Relais de repli sur le VPS, même protocole que le relais Cloudflare (relais/src/index.js) :
//   connexion : /relais?jeton=<jeton signé {salle, role: 'hote'|'ami', uid}>
//   ami -> hôte : texte JSON (types autorisés seulement), le relais ajoute "de": <id>
//   hôte -> amis : texte JSON avec "a": <id> (ou sans "a" = tout le monde) ;
//                  binaire = [u32 id destinataire, 0 = tout le monde, 0xFFFFFF00 + q = les amis de la couche q][charge]
//   ami -> relais : {type:'qualite', q} choisit sa couche vidéo (0 = 1080p, 1 = 720p), aussi transmis à l'hôte
import { verifier } from './jetons.js';

export const MAX_AMIS = 16;
export const TYPES_AMI = new Set(['ping', 'idr', 'qualite', 'manette', 'pause', 'offre']);
const MAX_TEXTE = 16384;  // une offre WebRTC (connexion directe) avec ses candidats
const BATTEMENT = JSON.stringify({ type: 'battement' });
export const DEST_COUCHE = 0xFFFFFF00;
export const NB_COUCHES = 2;

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
      // L'hôte (re)connecté reçoit l'état de chacun : qui, quelle couche, en direct ou non.
      for (const [id, w] of s.amis) versHote({ type: 'arrivee', de: id, uid: w.uidRelais, q: w.couche, p: w.enDirect });
      ws.on('message', (d, binaire) => this.depuisHote(s, d, binaire, ws));
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
    // État de l'ami, rangé sur sa connexion (noms à nous : ws a déjà pause(), resume()…).
    ws.uidRelais = uid;
    ws.couche = 0;
    ws.enDirect = false;
    s.amis.set(id, ws);
    versHote({ type: 'arrivee', de: id, uid });
    if (!s.hote) ws.send(JSON.stringify({ type: 'pas-d-hote' }));
    ws.on('message', (d, binaire) => {
      if (binaire || d.length > MAX_TEXTE) return;
      let m;
      try { m = JSON.parse(d); } catch { return; }
      // Battement : le relais répond lui-même (la page sait ainsi que la connexion est vivante).
      if (m?.type === 'battement') return ws.send(BATTEMENT);
      if (!m || !TYPES_AMI.has(m.type)) return;
      if (m.type === 'qualite') {
        if (!Number.isInteger(m.q) || m.q < 0 || m.q >= NB_COUCHES) return;
        ws.couche = m.q;
      }
      // L'ami reçoit la vidéo en direct (P2P) : on ne lui envoie plus d'images (le texte continue).
      if (m.type === 'pause') ws.enDirect = m.p === true;
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

  depuisHote(s, d, binaire, hote) {
    const envoyer = (a, charge, opts) => {
      const couche = a >= DEST_COUCHE ? a - DEST_COUCHE : -1;
      for (const [id, w] of s.amis) {
        if (couche >= 0 ? w.couche !== couche : a && a !== id) continue;
        if (opts.binary && w.enDirect) continue;
        if (w.readyState !== 1) continue;
        // Un ami qui ne suit pas : on jette plutôt que d'accumuler du retard.
        if (opts.binary && w.bufferedAmount > 2_000_000) continue;
        w.send(charge, opts);
      }
    };
    if (!binaire) {
      let m;
      try { m = JSON.parse(d); } catch { return; }
      if (m?.type === 'battement') return hote?.send(BATTEMENT);
      // L'hôte retire quelqu'un : on ferme ses connexions.
      if (m.type === 'exclure' && typeof m.uid === 'string') {
        for (const w of s.amis.values()) if (w.uidRelais === m.uid) w.close(4003, 'retiré par l’hôte');
        return;
      }
      const a = m.a;
      delete m.a;
      envoyer(a, JSON.stringify(m), { binary: false });
    } else if (d.length > 4) {
      envoyer(d.readUInt32LE(0), d.subarray(4), { binary: true });
    }
  }
}
