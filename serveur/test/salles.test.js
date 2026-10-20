import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DELAI_DEPART_HOTE_MS, Salles } from '../src/salles.js';

function fabrique() {
  let t = 0;
  const enLigne = new Set();
  const salles = new Salles({ agentEnLigne: (uid) => enLigne.has(uid), now: () => t });
  return { salles, enLigne, avancer: (ms) => (t += ms) };
}
const alice = { uid: 'a', nom: 'Alice', avatar: null };
const bob = { uid: 'b', nom: 'Bob', avatar: null };

test('on ne peut héberger que si son agent est en ligne', () => {
  const { salles, enLigne } = fabrique();
  salles.rejoindre('s1', alice);
  assert.match(salles.heberger('s1', 'a').erreur, /agent/);
  enLigne.add('a');
  assert.deepEqual(salles.heberger('s1', 'a'), { ok: true });
  assert.deepEqual(salles.vue('s1').hote, { uid: 'a', nom: 'Alice', absent: false });
});

test('un seul hôte par salle, et seulement un participant', () => {
  const { salles, enLigne } = fabrique();
  enLigne.add('a').add('b');
  salles.rejoindre('s1', alice);
  salles.rejoindre('s1', bob);
  assert.ok(salles.heberger('s1', 'a').ok);
  assert.match(salles.heberger('s1', 'b').erreur, /déjà/);
  assert.match(salles.heberger('s2', 'b').erreur, /pas dans/);
});

test('seul l’hôte peut arrêter', () => {
  const { salles, enLigne } = fabrique();
  enLigne.add('a');
  salles.rejoindre('s1', alice);
  salles.rejoindre('s1', bob);
  salles.heberger('s1', 'a');
  assert.equal(salles.arreter('s1', 'b'), false);
  assert.equal(salles.vue('s1').hote.uid, 'a');
  assert.equal(salles.arreter('s1', 'a'), true);
  assert.equal(salles.vue('s1').hote, null);
});

test('plusieurs onglets : on ne quitte la salle qu’au dernier', () => {
  const { salles } = fabrique();
  salles.rejoindre('s1', alice);
  salles.rejoindre('s1', alice);
  assert.equal(salles.quitter('s1', 'a'), false);
  assert.equal(salles.vue('s1').participants.length, 1);
  assert.equal(salles.quitter('s1', 'a'), true);
  assert.equal(salles.get('s1'), null);
});

test('l’hôte qui part a un délai pour revenir, sinon la partie s’arrête', () => {
  const { salles, enLigne, avancer } = fabrique();
  enLigne.add('a');
  salles.rejoindre('s1', alice);
  salles.rejoindre('s1', bob);
  salles.heberger('s1', 'a');
  salles.quitter('s1', 'a');
  assert.equal(salles.vue('s1').hote.absent, true);
  avancer(DELAI_DEPART_HOTE_MS - 1);
  assert.deepEqual(salles.tick(), []);
  salles.rejoindre('s1', alice);  // revient à temps
  avancer(DELAI_DEPART_HOTE_MS + 1);
  assert.deepEqual(salles.tick(), []);
  assert.equal(salles.vue('s1').hote.uid, 'a');
  salles.quitter('s1', 'a');
  avancer(DELAI_DEPART_HOTE_MS + 1);
  assert.deepEqual(salles.tick(), ['s1']);
  assert.equal(salles.vue('s1').hote, null);
});

test('l’agent qui se déconnecte arrête l’hébergement partout', () => {
  const { salles, enLigne } = fabrique();
  enLigne.add('a');
  salles.rejoindre('s1', alice);
  salles.heberger('s1', 'a');
  assert.deepEqual(salles.agentParti('a'), ['s1']);
  assert.equal(salles.vue('s1').hote, null);
});

test('la vue ne contient que des infos publiques, dans l’ordre d’arrivée', () => {
  const { salles, avancer } = fabrique();
  salles.rejoindre('s1', bob);
  avancer(10);
  salles.rejoindre('s1', alice);
  assert.deepEqual(salles.vue('s1').participants.map((p) => p.nom), ['Bob', 'Alice']);
  assert.deepEqual(Object.keys(salles.vue('s1').participants[0]).sort(), ['avatar', 'hote', 'nom', 'uid']);
});
