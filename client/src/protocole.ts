// Images reçues du relais : [u8 drapeaux (bit0 = clé)][u8 qualité][f64 heure de l'hôte en ms][Annex B]
// (même format que agent/protocole.go, sans les 4 octets de destinataire retirés par le relais).
export const ENTETE = 10;

export interface Image {
  cle: boolean;
  qualite: number;
  heureHote: number;
  donnees: Uint8Array;
}

export function lireImage(buf: ArrayBuffer): Image | null {
  if (buf.byteLength <= ENTETE) return null;
  const v = new DataView(buf);
  return {
    cle: (v.getUint8(0) & 1) === 1,
    qualite: v.getUint8(1),
    heureHote: v.getFloat64(2, true),
    donnees: new Uint8Array(buf, ENTETE),
  };
}

/** Chaîne de codec WebCodecs (avc1.PPCCLL) lue dans le SPS d'une image clé H.264. */
export function codecDepuisSPS(b: Uint8Array): string | null {
  for (let i = 0; i + 6 < b.length; i++) {
    if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1 && (b[i + 3] & 0x1f) === 7) {
      return 'avc1.' + [b[i + 4], b[i + 5], b[i + 6]].map((x) => x.toString(16).padStart(2, '0')).join('');
    }
  }
  return null;
}

/**
 * Décalage d'horloge (hôte - local, en ms) estimé à partir des pings : on garde l'échange au plus
 * court aller-retour, le moins perturbé.
 */
export class Horloge {
  private meilleur = Infinity;
  decalage = 0;
  allerRetour: number[] = [];

  ajouter(envoiLocal: number, recuLocal: number, heureHote: number) {
    const rtt = recuLocal - envoiLocal;
    this.allerRetour.push(rtt);
    if (this.allerRetour.length > 30) this.allerRetour.shift();
    if (rtt <= this.meilleur) {
      this.meilleur = rtt;
      this.decalage = heureHote - (envoiLocal + recuLocal) / 2;
    }
  }

  /** Retard d'une image : maintenant (en heure de l'hôte) moins son heure de capture. */
  retard(heureHote: number, maintenantLocal: number) {
    return maintenantLocal + this.decalage - heureHote;
  }

  mediane() {
    if (!this.allerRetour.length) return null;
    const s = [...this.allerRetour].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }
}
