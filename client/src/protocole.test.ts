import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codecDepuisSPS, Horloge, lireImage } from './protocole.ts';

test('lireImage lit l’en-tête écrit par l’agent', () => {
  const buf = new ArrayBuffer(10 + 3);
  const v = new DataView(buf);
  v.setUint8(0, 1);
  v.setUint8(1, 2);
  v.setFloat64(2, 1_700_000_000_123, true);
  new Uint8Array(buf, 10).set([7, 8, 9]);
  const img = lireImage(buf)!;
  assert.equal(img.cle, true);
  assert.equal(img.qualite, 2);
  assert.equal(img.heureHote, 1_700_000_000_123);
  assert.deepEqual([...img.donnees], [7, 8, 9]);
  assert.equal(lireImage(new ArrayBuffer(10)), null);
});

test('codec lu dans le SPS', () => {
  const sps = new Uint8Array([0, 0, 0, 1, 9, 0x10, 0, 0, 0, 1, 0x67, 0x4d, 0x40, 0x2a, 0xff]);
  assert.equal(codecDepuisSPS(sps), 'avc1.4d402a');
  assert.equal(codecDepuisSPS(new Uint8Array([0, 0, 1, 0x65, 1, 2, 3])), null);
});

test('l’horloge garde le ping le plus court pour estimer le décalage', () => {
  const h = new Horloge();
  h.ajouter(0, 100, 1050);   // aller-retour 100 : décalage 1000
  h.ajouter(200, 220, 1210); // aller-retour 20 : décalage 1000 aussi, mais plus fiable
  h.ajouter(300, 400, 1390); // plus lent : ignoré pour le décalage
  assert.equal(h.decalage, 1000);
  assert.equal(h.retard(1400, 420), 20);  // image capturée à 1400 (hôte), affichée à 420 (local) = 1420 hôte
  assert.equal(h.mediane(), 100);
});
