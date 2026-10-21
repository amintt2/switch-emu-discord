import { test } from 'node:test';
import assert from 'node:assert/strict';
import { programmer, versCanaux } from './son.ts';

test('PCM entrelacé vers deux canaux', () => {
  const b = new Uint8Array(8);
  const v = new DataView(b.buffer);
  v.setInt16(0, 16384, true); v.setInt16(2, -32768, true);
  v.setInt16(4, 0, true); v.setInt16(6, 32767, true);
  const [g, d] = versCanaux(b);
  assert.deepEqual([...g], [0.5, 0]);
  assert.equal(d[0], -1);
  assert.ok(Math.abs(d[1] - 1) < 0.001);
});

test('programmation : un peu d’avance au départ, à la suite ensuite, on jette si le retard s’accumule', () => {
  assert.ok(Math.abs(programmer(0, 10) - 10.06) < 1e-9, 'départ : 60 ms d’avance');
  assert.equal(programmer(10.1, 10), 10.1, 'à la suite du précédent');
  assert.ok(Math.abs(programmer(9.5, 10) - 10.06) < 1e-9, 'trou : on repart avec de l’avance');
  assert.equal(programmer(10.4, 10), null, 'plus de 250 ms d’avance : jeté');
});
