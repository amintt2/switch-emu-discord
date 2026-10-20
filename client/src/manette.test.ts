import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BITS, depuisClavier, depuisGamepad, fusionner, REPOS, sourceBougee, valeurSource } from './manette.ts';
import {
  attribuerSource, attribuerTouche, CLAVIER_DEFAUT, inverserABXY, inverserStick, nettoyer, profilPour, reglagesDefaut,
} from './reglages.ts';

const pad = (presses: number[], axes = [0, 0, 0, 0], gachettes: [number, number] = [0, 0], mapping = 'standard') => ({
  id: 'Pad test', mapping,
  buttons: Array.from({ length: 17 }, (_, i) => ({
    pressed: presses.includes(i) || (i === 6 && gachettes[0] > 0) || (i === 7 && gachettes[1] > 0),
    value: i === 6 ? gachettes[0] : i === 7 ? gachettes[1] : presses.includes(i) ? 1 : 0,
  })),
  axes,
});

test('disposition standard → boutons Xbox', () => {
  assert.equal(depuisGamepad(pad([0])).b, BITS.a);
  assert.equal(depuisGamepad(pad([1, 3])).b, BITS.b! | BITS.y!);
  assert.equal(depuisGamepad(pad([12, 15, 9])).b, BITS.haut! | BITS.droite! | BITS.start!);
});

test('sticks : Y inversé, zone morte, bornes', () => {
  const e = depuisGamepad(pad([], [1, -1, 0.03, 0.5]));
  assert.equal(e.lx, 32767);
  assert.equal(e.ly, 32767);   // vers le haut (-1 en Gamepad API) = +32767 en XInput
  assert.equal(e.rx, 0);       // zone morte
  assert.equal(e.ry, -16383);
});

test('gâchettes analogiques 0..255', () => {
  const e = depuisGamepad(pad([], undefined, [0.5, 1]));
  assert.equal(e.lt, 128);
  assert.equal(e.rt, 255);
  assert.equal(e.b, 0);
});

test('manette générique : croix et gâchettes sur des axes', () => {
  // Croix sur les axes 6/7 et gâchettes sur les axes 4/5, comme beaucoup de manettes USB génériques.
  let r = reglagesDefaut();
  const id = 'Generic USB Joystick (Vendor: 0079 Product: 0006)';
  for (const [s, src] of [['haut', 'a7-'], ['gauche', 'a6-'], ['lt', 'a4+'], ['a', 'b2']] as const) r = attribuerSource(r, id, s, src);
  const g = { ...pad([2], [0, 0, 0, 0, 1, 0, -1, -1], [0, 0], ''), id };
  const e = depuisGamepad(g, profilPour(r, id));
  assert.equal(e.b, BITS.haut! | BITS.gauche! | BITS.a!);
  assert.equal(e.lt, 255);
  assert.equal(valeurSource(g, 'a6+'), 0);
});

test('assistant : on reconnaît le bouton ou le demi-axe qui a bougé', () => {
  const repos = pad([], [0, 0, 0, 0, -1]);  // gâchette au repos à -1 sur certaines manettes
  assert.equal(sourceBougee(pad([5], [0, 0, 0, 0, -1]), repos), 'b5');
  assert.equal(sourceBougee(pad([], [0, 0.9, 0, 0, -1]), repos), 'a1+');
  assert.equal(sourceBougee(pad([], [0, 0, 0, 0, 1]), repos), 'a4+');  // de -1 à +1
  assert.equal(sourceBougee(repos, repos), null);
});

test('réattribuer : échange si la source servait déjà, disposition Nintendo, inversion du stick', () => {
  let r = attribuerSource(reglagesDefaut(), 'standard', 'a', 'b1');
  assert.equal(r.manettes.standard.a, 'b1');
  assert.equal(r.manettes.standard.b, 'b0');  // échangés
  r = inverserABXY(reglagesDefaut(), 'standard');
  assert.equal(depuisGamepad(pad([0]), profilPour(r, 'x')).b, BITS.b);
  r = inverserStick(reglagesDefaut(), 'standard', 'gauche');
  assert.equal(depuisGamepad(pad([], [0, -1, 0, 0]), profilPour(r, 'x')).ly, -32767);
});

test('clavier : position physique, réattribution sans doublon', () => {
  const e = depuisClavier(new Set(['KeyW', 'KeyD', 'KeyK', 'ArrowLeft', 'KeyP']), CLAVIER_DEFAUT);
  assert.equal(e.ly, 32767);
  assert.equal(e.lx, 32767);
  assert.equal(e.b, BITS.a! | BITS.gauche!);
  assert.equal(e.rt, 255);
  assert.deepEqual(depuisClavier(new Set(['KeyA', 'KeyD']), CLAVIER_DEFAUT), REPOS);
  const r = attribuerTouche(reglagesDefaut(), 'a', 'Space');
  assert.equal(r.clavier.a, 'Space');
  const r2 = attribuerTouche(r, 'b', 'Space');
  assert.equal(r2.clavier.a, undefined);  // une touche = une seule commande
  assert.equal(r2.clavier.b, 'Space');
});

test('réglages lus sur disque : les valeurs invalides sont écartées', () => {
  const r = nettoyer({ version: 2, clavier: { a: 'Space', b: '<script>' }, manettes: { standard: { a: 'b3', b: 'calc.exe' } } });
  assert.equal(r.clavier.a, 'Space');
  assert.equal(r.clavier.b, undefined);
  assert.equal(r.manettes.standard.a, 'b3');
  assert.equal(r.manettes.standard.b, undefined);
  assert.deepEqual(nettoyer('nimporte quoi'), reglagesDefaut());
  assert.equal(nettoyer({ version: 2, entree: 'clavier' }).entree, 'clavier');
  assert.equal(nettoyer({ version: 2, entree: 'souris' }).entree, 'tout');
});

test('manette + clavier combinés', () => {
  const r = fusionner(depuisGamepad(pad([0], [0.5, 0, 0, 0])), depuisClavier(new Set(['KeyL', 'KeyA']), CLAVIER_DEFAUT));
  assert.equal(r.b, BITS.a! | BITS.b!);
  assert.equal(r.lx, -32767);
});
