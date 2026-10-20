// Salles : une par instance d'Activité Discord. Le serveur ne garde rien sur disque.
// Une salle a des participants (plusieurs onglets possibles par personne), au plus un hôte (un participant
// dont l'agent est en ligne et qui a choisi d'héberger) et 4 places de joueur, J1 à J4.
// J1 revient à l'hôte quand il commence à héberger (il joue sur son PC) ; il peut la laisser à un ami.
// Les autres participants sont spectateurs.

export const DELAI_DEPART_HOTE_MS = 30_000;
export const DELAI_PLACE_MS = 60_000;      // une place est gardée 1 min à quelqu'un qui s'est déconnecté
export const DUREE_EXCLUSION_MS = 10 * 60_000;
export const NB_PLACES = 4;

export class Salles {
  /** @param {{ agentEnLigne: (uid: string) => boolean, now?: () => number }} deps */
  constructor({ agentEnLigne, now = Date.now }) {
    this.agentEnLigne = agentEnLigne;
    this.now = now;
    /** @type {Map<string, any>} */
    this.salles = new Map();
  }

  get(id) {
    return this.salles.get(id) || null;
  }

  /** Renvoie la salle, ou { exclu: true } si l'hôte a retiré cette personne il y a peu. */
  rejoindre(id, { uid, nom, avatar }) {
    let s = this.salles.get(id);
    if (!s) {
      s = { id, participants: new Map(), hote: null, departHote: null, places: Array(NB_PLACES).fill(null), exclus: new Map() };
      this.salles.set(id, s);
    }
    const fin = s.exclus.get(uid);
    if (fin && fin > this.now()) return { exclu: true };
    s.exclus.delete(uid);
    const p = s.participants.get(uid);
    if (p) p.connexions++;
    else s.participants.set(uid, { uid, nom, avatar, connexions: 1, arrivee: this.now() });
    if (s.hote === uid) s.departHote = null;
    for (const pl of s.places) if (pl?.uid === uid) pl.absentDepuis = null;
    return s;
  }

  /** Renvoie true si la salle a changé de façon visible (quelqu'un est vraiment parti). */
  quitter(id, uid) {
    const s = this.salles.get(id);
    const p = s?.participants.get(uid);
    if (!p) return false;
    if (--p.connexions > 0) return false;
    s.participants.delete(uid);
    if (s.hote === uid) s.departHote = this.now();
    for (const pl of s.places) if (pl?.uid === uid) pl.absentDepuis = this.now();
    this.nettoyerSiVide(s);
    return true;
  }

  heberger(id, uid) {
    const s = this.salles.get(id);
    if (!s?.participants.has(uid)) return { erreur: 'Tu n’es pas dans cette salle.' };
    if (s.hote && s.hote !== uid) return { erreur: 'Quelqu’un héberge déjà la partie.' };
    if (!this.agentEnLigne(uid)) return { erreur: 'Ton PC n’est pas connecté : lance l’agent Switch EMU.' };
    s.hote = uid;
    s.departHote = null;
    // L'hôte prend J1 (il joue sur son PC), si personne ne l'a déjà.
    if (!s.places.some((pl) => pl?.uid === uid) && !s.places[0]) s.places[0] = { uid, nom: s.participants.get(uid).nom, local: true, absentDepuis: null };
    return { ok: true };
  }

  /** L'hôte arrête : la partie et les places sont libérées. Renvoie true si quelque chose a changé. */
  arreter(id, uid) {
    const s = this.salles.get(id);
    if (!s || s.hote !== uid) return false;
    s.hote = null;
    s.departHote = null;
    s.places = Array(NB_PLACES).fill(null);
    this.nettoyerSiVide(s);
    return true;
  }

  /**
   * Prend la place n (1 à 4), ou redevient spectateur avec n = 0. On quitte sa place précédente.
   * Seulement pendant une partie, et seulement une place libre (ou la sienne).
   */
  prendrePlace(id, uid, n) {
    const s = this.salles.get(id);
    if (!s?.participants.has(uid)) return { erreur: 'Tu n’es pas dans cette salle.' };
    if (!Number.isInteger(n) || n < 0 || n > NB_PLACES) return { erreur: 'Place inconnue.' };
    if (n && !s.hote) return { erreur: 'Attends que quelqu’un héberge la partie.' };
    const cible = n ? s.places[n - 1] : null;
    if (cible && cible.uid !== uid) return { erreur: `J${n} est déjà pris.` };
    for (let i = 0; i < NB_PLACES; i++) if (s.places[i]?.uid === uid) s.places[i] = null;
    // L'hôte qui reprend J1 joue sur son PC ; sur une autre place, il joue depuis l'Activité comme un ami.
    if (n) s.places[n - 1] = { uid, nom: s.participants.get(uid).nom, local: uid === s.hote && n === 1, absentDepuis: null };
    return { ok: true };
  }

  /** L'hôte retire quelqu'un : il perd sa place et ne peut pas revenir pendant 10 minutes. */
  exclure(id, hoteUid, cibleUid) {
    const s = this.salles.get(id);
    if (!s || s.hote !== hoteUid) return { erreur: 'Seul l’hôte peut retirer quelqu’un.' };
    if (cibleUid === hoteUid) return { erreur: 'Tu ne peux pas te retirer toi-même.' };
    if (!s.participants.has(cibleUid) && !s.places.some((pl) => pl?.uid === cibleUid)) return { erreur: 'Cette personne n’est pas dans la salle.' };
    for (let i = 0; i < NB_PLACES; i++) if (s.places[i]?.uid === cibleUid) s.places[i] = null;
    s.participants.delete(cibleUid);
    s.exclus.set(cibleUid, this.now() + DUREE_EXCLUSION_MS);
    return { ok: true };
  }

  /** Place (1 à 4) de quelqu'un, ou 0 s'il est spectateur. */
  placeDe(id, uid) {
    const s = this.salles.get(id);
    const i = s ? s.places.findIndex((pl) => pl?.uid === uid) : -1;
    return i + 1;
  }

  /** Pour l'agent : uid -> place, seulement pour ceux qui jouent depuis l'Activité (pas l'hôte sur son PC). */
  placesDistantes(id) {
    const s = this.salles.get(id);
    const r = {};
    if (s) s.places.forEach((pl, i) => { if (pl && !pl.local) r[pl.uid] = i + 1; });
    return r;
  }

  /** L'agent de `uid` s'est déconnecté : il n'héberge plus nulle part. Renvoie les salles touchées. */
  agentParti(uid) {
    const touchees = [];
    for (const s of [...this.salles.values()]) if (s.hote === uid && this.arreter(s.id, uid)) touchees.push(s.id);
    return touchees;
  }

  /** À appeler régulièrement : hôtes partis depuis trop longtemps, places abandonnées. Renvoie les salles touchées. */
  tick() {
    const touchees = new Set();
    for (const s of [...this.salles.values()]) {
      if (s.hote && s.departHote !== null && this.now() - s.departHote > DELAI_DEPART_HOTE_MS) {
        this.arreter(s.id, s.hote);
        touchees.add(s.id);
        continue;
      }
      for (let i = 0; i < NB_PLACES; i++) {
        const pl = s.places[i];
        if (pl?.absentDepuis !== null && pl?.absentDepuis !== undefined && this.now() - pl.absentDepuis > DELAI_PLACE_MS) {
          s.places[i] = null;
          touchees.add(s.id);
        }
      }
      for (const [uid, fin] of s.exclus) if (fin <= this.now()) s.exclus.delete(uid);
      this.nettoyerSiVide(s);
    }
    return [...touchees];
  }

  nettoyerSiVide(s) {
    if (!s.participants.size && !s.hote && !s.places.some(Boolean) && !s.exclus.size) this.salles.delete(s.id);
  }

  /** Ce que voit un participant. Ne contient aucun secret. */
  vue(id) {
    const s = this.salles.get(id);
    if (!s) return { participants: [], hote: null, places: Array(NB_PLACES).fill(null) };
    const placeDe = (uid) => s.places.findIndex((pl) => pl?.uid === uid) + 1;
    const participants = [...s.participants.values()]
      .sort((a, b) => a.arrivee - b.arrivee)
      .map(({ uid, nom, avatar }) => ({ uid, nom, avatar, hote: uid === s.hote, place: placeDe(uid) }));
    const h = s.hote ? s.participants.get(s.hote) : null;
    return {
      participants,
      hote: s.hote ? { uid: s.hote, nom: h?.nom || '…', absent: !h } : null,
      places: s.places.map((pl) => (pl ? { uid: pl.uid, nom: pl.nom, local: pl.local, absent: pl.absentDepuis !== null } : null)),
    };
  }
}
