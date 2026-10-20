import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agents, DUREE_CODE_MS, normaliserCode, nouveauCode } from '../src/agents.js';

function fabrique() {
  let t = 0;
  return { agents: new Agents({ secret: 'k', now: () => t }), avancer: (ms) => (t += ms) };
}
const alice = { uid: 'a', nom: 'Alice' };

test('format des codes : 8 caractères lisibles, tapés avec ou sans tiret', () => {
  const c = nouveauCode();
  assert.match(c, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(normaliserCode(' abcd efgh '), 'ABCD-EFGH');
  assert.equal(normaliserCode('abc'), null);
});

test('jumelage complet : code → confirmation → jeton récupéré une seule fois', () => {
  const { agents } = fabrique();
  const { code, secret } = agents.demanderJumelage();
  assert.deepEqual(agents.recuperer(secret), { etat: 'attente' });
  assert.deepEqual(agents.confirmer(code.toLowerCase(), alice), { ok: true });
  const r = agents.recuperer(secret);
  assert.equal(r.etat, 'lie');
  assert.equal(agents.verifierJeton(r.jeton).uid, 'a');
  assert.equal(agents.recuperer(secret), null);
});

test('un code ne sert qu’une fois et expire', () => {
  const { agents, avancer } = fabrique();
  const { code } = agents.demanderJumelage();
  agents.confirmer(code, alice);
  assert.match(agents.confirmer(code, { uid: 'b', nom: 'Bob' }).erreur, /déjà/);
  const second = agents.demanderJumelage();
  avancer(DUREE_CODE_MS + 1);
  assert.match(agents.confirmer(second.code, alice).erreur, /expiré/);
  assert.equal(agents.recuperer(second.secret), null);
});

test('on ne peut pas deviner les codes à la chaîne', () => {
  const { agents } = fabrique();
  for (let i = 0; i < 10; i++) agents.confirmer('AAAA-AAAA', alice);
  assert.match(agents.confirmer('AAAA-AAAA', alice).erreur, /Trop/);
});

test('un jeton signé par un autre serveur est refusé', () => {
  const { agents } = fabrique();
  const autre = new Agents({ secret: 'autre' });
  const { code, secret } = autre.demanderJumelage();
  autre.confirmer(code, alice);
  assert.equal(agents.verifierJeton(autre.recuperer(secret).jeton), null);
});

test('une seule connexion de contrôle par compte', () => {
  const { agents } = fabrique();
  const ws1 = { readyState: 1 }, ws2 = { readyState: 1 };
  assert.equal(agents.connecter('a', ws1), null);
  assert.equal(agents.connecter('a', ws2), ws1);
  assert.equal(agents.deconnecter('a', ws1), false);
  assert.equal(agents.enLigne('a'), true);
  assert.equal(agents.deconnecter('a', ws2), true);
  assert.equal(agents.enLigne('a'), false);
});
