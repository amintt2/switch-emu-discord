import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vecteurStick } from './tactile.ts';

test('stick tactile : centre = repos, bord = à fond, vers le haut = ly positif', () => {
  assert.deepEqual(vecteurStick(2, 2, 50), { lx: 0, ly: 0 });
  assert.deepEqual(vecteurStick(50, 0, 50), { lx: 32767, ly: 0 });
  assert.deepEqual(vecteurStick(0, -50, 50), { lx: 0, ly: 32767 });
  // Au-delà du bord : limité (pas de dépassement de l'axe)
  const loin = vecteurStick(300, 300, 50);
  assert.ok(Math.hypot(loin.lx, loin.ly) <= 32768);
  // À mi-course : environ la moitié
  assert.ok(Math.abs(vecteurStick(25, 0, 50).lx - 16384) < 2);
});
