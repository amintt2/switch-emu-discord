import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DELAI_DEPART_HOTE_MS, DELAI_PLACE_MS, DUREE_EXCLUSION_MS, Salles } from '../src/salles.js';

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
  assert.deepEqual(Object.keys(salles.vue('s1').participants[0]).sort(), ['avatar', 'hote', 'nom', 'place', 'uid']);
});

const chloe = { uid: 'c', nom: 'Chloé', avatar: null };
const dan = { uid: 'd', nom: 'Dan', avatar: null };
const eve = { uid: 'e', nom: 'Ève', avatar: null };

function partie() {
  const f = fabrique();
  f.enLigne.add('a');
  for (const u of [alice, bob, chloe, dan, eve]) f.salles.rejoindre('s1', u);
  f.salles.heberger('s1', 'a');
  return f;
}

test('l’hôte prend J1 en hébergeant ; les autres choisissent une place libre', () => {
  const { salles } = partie();
  assert.deepEqual(salles.vue('s1').places[0], { uid: 'a', nom: 'Alice', local: true, absent: false });
  assert.ok(salles.prendrePlace('s1', 'b', 2).ok);
  assert.match(salles.prendrePlace('s1', 'c', 2).erreur, /déjà pris/);
  assert.match(salles.prendrePlace('s1', 'c', 1).erreur, /déjà pris/);
  assert.ok(salles.prendrePlace('s1', 'c', 3).ok);
  assert.match(salles.prendrePlace('s1', 'c', 5).erreur, /inconnue/);
  assert.equal(salles.placeDe('s1', 'c'), 3);
  assert.equal(salles.placeDe('s1', 'e'), 0);  // spectatrice
});

test('4 places au maximum, les autres restent spectateurs', () => {
  const { salles } = partie();
  salles.prendrePlace('s1', 'b', 2);
  salles.prendrePlace('s1', 'c', 3);
  salles.prendrePlace('s1', 'd', 4);
  assert.ok([1, 2, 3, 4].every((n) => salles.prendrePlace('s1', 'e', n).erreur));
  assert.deepEqual(salles.vue('s1').participants.find((p) => p.uid === 'e').place, 0);
});

test('changer de place libère l’ancienne ; 0 = redevenir spectateur', () => {
  const { salles } = partie();
  salles.prendrePlace('s1', 'b', 2);
  salles.prendrePlace('s1', 'b', 4);
  assert.equal(salles.vue('s1').places[1], null);
  assert.equal(salles.placeDe('s1', 'b'), 4);
  salles.prendrePlace('s1', 'b', 0);
  assert.equal(salles.placeDe('s1', 'b'), 0);
});

test('l’hôte peut laisser J1 à un ami (jeux à un joueur)', () => {
  const { salles } = partie();
  salles.prendrePlace('s1', 'a', 0);
  assert.ok(salles.prendrePlace('s1', 'b', 1).ok);
  assert.deepEqual(salles.placesDistantes('s1'), { b: 1 });
  salles.prendrePlace('s1', 'a', 2);  // l'hôte joue alors depuis l'Activité, comme un ami
  assert.deepEqual(salles.placesDistantes('s1'), { b: 1, a: 2 });
});

test('pas de place sans partie en cours', () => {
  const { salles } = fabrique();
  salles.rejoindre('s1', bob);
  assert.match(salles.prendrePlace('s1', 'b', 2).erreur, /héberge/);
});

test('l’agent ne reçoit que les joueurs à distance (pas l’hôte sur son PC)', () => {
  const { salles } = partie();
  salles.prendrePlace('s1', 'b', 2);
  assert.deepEqual(salles.placesDistantes('s1'), { b: 2 });
});

test('une place est gardée 1 minute à qui se déconnecte', () => {
  const { salles, avancer } = partie();
  salles.prendrePlace('s1', 'b', 2);
  salles.quitter('s1', 'b');
  assert.equal(salles.vue('s1').places[1].absent, true);
  avancer(DELAI_PLACE_MS / 2);
  salles.rejoindre('s1', bob);
  assert.equal(salles.vue('s1').places[1].absent, false);
  salles.quitter('s1', 'b');
  avancer(DELAI_PLACE_MS + 1);
  assert.deepEqual(salles.tick(), ['s1']);
  assert.equal(salles.vue('s1').places[1], null);
});

test('arrêter la partie libère toutes les places', () => {
  const { salles } = partie();
  salles.prendrePlace('s1', 'b', 2);
  salles.arreter('s1', 'a');
  assert.deepEqual(salles.vue('s1').places, [null, null, null, null]);
});

test('seul l’hôte retire quelqu’un, qui ne peut pas revenir pendant 10 minutes', () => {
  const { salles, avancer } = partie();
  salles.prendrePlace('s1', 'b', 2);
  assert.match(salles.exclure('s1', 'c', 'b').erreur, /Seul l’hôte/);
  assert.match(salles.exclure('s1', 'a', 'a').erreur, /toi-même/);
  assert.ok(salles.exclure('s1', 'a', 'b').ok);
  assert.equal(salles.vue('s1').places[1], null);
  assert.equal(salles.vue('s1').participants.some((p) => p.uid === 'b'), false);
  assert.deepEqual(salles.rejoindre('s1', bob), { exclu: true });
  avancer(DUREE_EXCLUSION_MS + 1);
  salles.tick();
  assert.ok(salles.rejoindre('s1', bob).participants);
});
