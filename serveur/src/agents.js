// Agents : le programme installé sur le PC d'un hôte.
// Jumelage : l'agent demande un code, l'utilisateur le tape dans l'Activité (connecté avec Discord),
// l'agent récupère alors un jeton signé qui le lie à ce compte. Rien n'est stocké : le jeton suffit.
import { randomBytes, randomInt } from 'node:crypto';
import { signer, verifier } from './jetons.js';

export const DUREE_CODE_MS = 10 * 60_000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  // sans 0/O ni 1/I
const ESSAIS_PAR_MINUTE = 10;

export function nouveauCode() {
  let c = '';
  for (let i = 0; i < 8; i++) c += ALPHABET[randomInt(ALPHABET.length)];
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

export function normaliserCode(code) {
  const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : null;
}

export class Agents {
  /** @param {{ secret: string, now?: () => number }} opts */
  constructor({ secret, now = Date.now }) {
    this.secret = secret;
    this.now = now;
    /** code -> { secret, expire, uid?, nom?, jeton? } */
    this.codes = new Map();
    /** uid -> ws de contrôle */
    this.connexions = new Map();
    /** uid -> { debut, n } (limite les essais de code) */
    this.essais = new Map();
  }

  demanderJumelage() {
    this.nettoyer();
    let code;
    do code = nouveauCode(); while (this.codes.has(code));
    const secret = randomBytes(24).toString('base64url');
    this.codes.set(code, { secret, expire: this.now() + DUREE_CODE_MS });
    return { code, secret, expireDans: DUREE_CODE_MS };
  }

  /** L'utilisateur (connecté) tape le code. Renvoie { ok } ou { erreur }. */
  confirmer(code, { uid, nom }) {
    const e = this.essais.get(uid);
    if (e && this.now() - e.debut < 60_000) {
      if (++e.n > ESSAIS_PAR_MINUTE) return { erreur: 'Trop d’essais, attends une minute.' };
    } else this.essais.set(uid, { debut: this.now(), n: 1 });
    const c = normaliserCode(code);
    const j = c && this.codes.get(c);
    if (!j || j.expire < this.now()) return { erreur: 'Code inconnu ou expiré.' };
    if (j.uid) return { erreur: 'Ce code a déjà servi.' };
    j.uid = uid;
    j.nom = nom;
    j.jeton = signer(this.secret, { uid, nom, aid: randomBytes(8).toString('hex'), cree: this.now() });
    return { ok: true };
  }

  /** L'agent vient chercher son jeton (une seule fois). */
  recuperer(secret) {
    for (const [code, j] of this.codes) {
      if (j.secret !== secret) continue;
      if (j.expire < this.now()) { this.codes.delete(code); return null; }
      if (!j.jeton) return { etat: 'attente' };
      this.codes.delete(code);
      return { etat: 'lie', jeton: j.jeton, nom: j.nom };
    }
    return null;
  }

  verifierJeton(jeton) {
    const d = verifier(this.secret, jeton);
    return d && typeof d.uid === 'string' ? d : null;
  }

  /** Une seule connexion de contrôle par compte : la nouvelle remplace l'ancienne. */
  connecter(uid, ws) {
    const ancienne = this.connexions.get(uid);
    this.connexions.set(uid, ws);
    return ancienne && ancienne !== ws ? ancienne : null;
  }

  /** Renvoie true si c'était bien la connexion active. */
  deconnecter(uid, ws) {
    if (this.connexions.get(uid) !== ws) return false;
    this.connexions.delete(uid);
    return true;
  }

  enLigne(uid) {
    return this.connexions.has(uid);
  }

  envoyer(uid, msg) {
    const ws = this.connexions.get(uid);
    if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
  }

  nettoyer() {
    for (const [code, j] of this.codes) if (j.expire < this.now()) this.codes.delete(code);
  }
}
