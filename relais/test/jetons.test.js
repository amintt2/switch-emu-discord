// Le relais doit accepter exactement les jetons du serveur, et rien d'autre.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signer } from '../../serveur/src/jetons.js';
import { verifier } from '../src/jetons.js';

test('un jeton du serveur est accepté par le relais', async () => {
  const j = signer('secret-relais', { salle: 'i0abc', role: 'ami', uid: '42' }, 60_000);
  const d = await verifier('secret-relais', j);
  assert.equal(d.salle, 'i0abc');
  assert.equal(d.role, 'ami');
});

test('mauvais secret, signature modifiée ou jeton expiré : refusé', async () => {
  const j = signer('secret-relais', { salle: 's', role: 'hote' }, 1000, 0);
  assert.equal(await verifier('autre', j, 0), null);
  assert.equal(await verifier('secret-relais', j.slice(0, -2) + 'AA', 0), null);
  assert.equal(await verifier('secret-relais', j, 5000), null);
  assert.equal(await verifier('secret-relais', 'abc', 0), null);
  assert.equal(await verifier('', j, 0), null);
});
