import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Adaptation, BASSE, HAUTE } from './qualite.ts';

const bonne = { image: 20, jetees: 0, ips: 60 };
const lente = { image: 120, jetees: 0, ips: 60 };
const saccadee = { image: 22, jetees: 3, ips: 50 };

test('connexion stable : reste en 1080p', () => {
  const a = new Adaptation();
  for (let i = 0; i < 60; i++) assert.equal(a.seconde(bonne), HAUTE);
});

test('connexion qui sature : passe en 720p après 3 mauvaises secondes', () => {
  const a = new Adaptation();
  for (let i = 0; i < 10; i++) a.seconde(bonne);
  a.seconde(lente);
  a.seconde(lente);
  assert.equal(a.seconde(bonne), HAUTE, 'deux mauvaises secondes ne suffisent pas');
  assert.equal(a.seconde(saccadee), BASSE);
});

test('un pic isolé ne fait pas changer', () => {
  const a = new Adaptation();
  for (let i = 0; i < 30; i++) assert.equal(a.seconde(i % 7 === 0 ? lente : bonne), HAUTE);
});

test('remonte en 1080p après 30 s sans souci, puis attend plus longtemps si l’essai rate', () => {
  const a = new Adaptation();
  for (let i = 0; i < 3; i++) a.seconde(saccadee);
  assert.equal(a.couche, BASSE);
  for (let i = 0; i < 29; i++) assert.equal(a.seconde(bonne), BASSE);
  assert.equal(a.seconde(bonne), HAUTE);
  // L'essai rate tout de suite : retour en 720p, et le prochain essai attend 60 s.
  for (let i = 0; i < 3; i++) a.seconde(saccadee);
  assert.equal(a.couche, BASSE);
  for (let i = 0; i < 59; i++) assert.equal(a.seconde(bonne), BASSE);
  assert.equal(a.seconde(bonne), HAUTE);
});

test('choix manuel : la qualité ne bouge pas', () => {
  const a = new Adaptation('720');
  for (let i = 0; i < 40; i++) assert.equal(a.seconde(bonne), BASSE);
  a.definir('1080');
  for (let i = 0; i < 10; i++) assert.equal(a.seconde(saccadee), HAUTE);
});
