// Salles : une par instance d'Activité Discord. Le serveur ne garde rien sur disque.
// Une salle a des participants (plusieurs onglets possibles par personne) et au plus un hôte :
// un participant dont l'agent est en ligne et qui a choisi d'héberger.

export const DELAI_DEPART_HOTE_MS = 30_000;

export class Salles {
  /** @param {{ agentEnLigne: (uid: string) => boolean, now?: () => number }} deps */
  constructor({ agentEnLigne, now = Date.now }) {
    this.agentEnLigne = agentEnLigne;
    this.now = now;
    /** @type {Map<string, Salle>} */
    this.salles = new Map();
  }

  get(id) {
    return this.salles.get(id) || null;
  }

  rejoindre(id, { uid, nom, avatar }) {
    let s = this.salles.get(id);
    if (!s) {
      s = { id, participants: new Map(), hote: null, departHote: null };
      this.salles.set(id, s);
    }
    const p = s.participants.get(uid);
    if (p) p.connexions++;
    else s.participants.set(uid, { uid, nom, avatar, connexions: 1, arrivee: this.now() });
    if (s.hote === uid) s.departHote = null;
    return s;
  }

  /** Renvoie true si la salle a changé de façon visible (quelqu'un est vraiment parti). */
  quitter(id, uid) {
    const s = this.salles.get(id);
    const p = s?.participants.get(uid);
    if (!p) return false;
    if (--p.connexions > 0) return false;
    s.participants.delete(uid);
    if (s.hote === uid) s.departHote = this.now();  // on laisse un peu de temps pour revenir
    if (!s.participants.size && !s.hote) this.salles.delete(id);
    return true;
  }

  heberger(id, uid) {
    const s = this.salles.get(id);
    if (!s?.participants.has(uid)) return { erreur: 'Tu n’es pas dans cette salle.' };
    if (s.hote && s.hote !== uid) return { erreur: 'Quelqu’un héberge déjà la partie.' };
    if (!this.agentEnLigne(uid)) return { erreur: 'Ton PC n’est pas connecté : lance l’agent Switch EMU.' };
    s.hote = uid;
    s.departHote = null;
    return { ok: true };
  }

  /** L'hôte arrête. Renvoie true si quelque chose a changé. */
  arreter(id, uid) {
    const s = this.salles.get(id);
    if (!s || s.hote !== uid) return false;
    s.hote = null;
    s.departHote = null;
    if (!s.participants.size) this.salles.delete(id);
    return true;
  }

  /** L'agent de `uid` s'est déconnecté : il n'héberge plus nulle part. Renvoie les salles touchées. */
  agentParti(uid) {
    const touchees = [];
    for (const s of this.salles.values()) if (s.hote === uid && this.arreter(s.id, uid)) touchees.push(s.id);
    return touchees;
  }

  /** À appeler régulièrement : arrête les hôtes partis depuis trop longtemps. Renvoie les salles touchées. */
  tick() {
    const touchees = [];
    for (const s of [...this.salles.values()]) {
      if (s.hote && s.departHote !== null && this.now() - s.departHote > DELAI_DEPART_HOTE_MS) {
        this.arreter(s.id, s.hote);
        touchees.push(s.id);
      }
    }
    return touchees;
  }

  /** Ce que voit un participant. Ne contient aucun secret. */
  vue(id) {
    const s = this.salles.get(id);
    if (!s) return { participants: [], hote: null };
    const participants = [...s.participants.values()]
      .sort((a, b) => a.arrivee - b.arrivee)
      .map(({ uid, nom, avatar }) => ({ uid, nom, avatar, hote: uid === s.hote }));
    const h = s.hote ? s.participants.get(s.hote) : null;
    return { participants, hote: s.hote ? { uid: s.hote, nom: h?.nom || '…', absent: !h } : null };
  }
}
