import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Assembleur } from './direct.ts';

const morceau = (numero: number, i: number, total: number, octets: number[]) => {
  const b = new Uint8Array(8 + octets.length);
  const v = new DataView(b.buffer);
  v.setUint32(0, numero, true); v.setUint16(4, i, true); v.setUint16(6, total, true);
  b.set(octets, 8);
  return b.buffer;
};

function fabrique() {
  const livres: number[][] = [];
  let pertes = 0;
  const a = new Assembleur((p) => livres.push([...new Uint8Array(p)]), () => pertes++);
  return { a, livres, pertes: () => pertes };
}

test('remet les morceaux dans l’ordre, même arrivés dans le désordre', () => {
  const { a, livres, pertes } = fabrique();
  a.recevoir(morceau(1, 1, 2, [3, 4]));
  a.recevoir(morceau(1, 0, 2, [1, 2]));
  a.recevoir(morceau(2, 0, 1, [9]));
  assert.deepEqual(livres, [[1, 2, 3, 4], [9]]);
  assert.equal(pertes(), 0);
});

test('une image perdue est signalée ; une image en retard est jetée', () => {
  const { a, livres, pertes } = fabrique();
  a.recevoir(morceau(1, 0, 1, [1]));
  a.recevoir(morceau(3, 0, 1, [3]));      // la 2 manque
  assert.equal(pertes(), 1);
  a.recevoir(morceau(2, 0, 1, [2]));      // arrive après la 3 : trop tard
  assert.deepEqual(livres, [[1], [3]]);
});

test('le son a sa propre numérotation : il ne compte pas comme une image perdue', () => {
  const { a, livres, pertes } = fabrique();
  a.recevoir(morceau(1, 0, 1, [1]));
  a.recevoir(morceau(0x80000005, 0, 1, [50]));
  a.recevoir(morceau(0x80000009, 0, 1, [51]));
  a.recevoir(morceau(2, 0, 1, [2]));
  assert.deepEqual(livres, [[1], [50], [51], [2]]);
  assert.equal(pertes(), 0);
});

test('morceaux invalides ignorés', () => {
  const { a, livres } = fabrique();
  a.recevoir(new ArrayBuffer(3));
  a.recevoir(morceau(1, 2, 2, [1]));  // morceau 2 sur 2 : n'existe pas
  a.recevoir(morceau(1, 0, 0, [1]));
  assert.deepEqual(livres, []);
});
