import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signer, verifier } from '../src/jetons.js';

test('un jeton signé se vérifie et rend ses données', () => {
  const j = signer('s3cret', { uid: '42', role: 'ami' }, 60_000, 1000);
  assert.deepEqual(verifier('s3cret', j, 2000), { uid: '42', role: 'ami', exp: 61_000 });
});

test('mauvais secret, jeton modifié ou expiré : refusé', () => {
  const j = signer('s3cret', { uid: '42' }, 1000, 0);
  assert.equal(verifier('autre', j, 0), null);
  const [payload, sig] = j.split('.');
  const faux = Buffer.from(JSON.stringify({ uid: '1', exp: 1000 })).toString('base64url');
  assert.equal(verifier('s3cret', `${faux}.${sig}`, 0), null);
  assert.equal(verifier('s3cret', `${payload}.`, 0), null);
  assert.equal(verifier('s3cret', j, 5000), null);
  assert.equal(verifier('s3cret', 'nimporte quoi', 0), null);
  assert.equal(verifier('s3cret', null, 0), null);
});

test('sans durée, le jeton n’expire pas', () => {
  const j = signer('k', { uid: '7' });
  assert.deepEqual(verifier('k', j, Number.MAX_SAFE_INTEGER), { uid: '7' });
});

test('signer sans secret est une erreur (jamais de jeton non signé)', () => {
  assert.throws(() => signer('', { uid: '1' }));
});
