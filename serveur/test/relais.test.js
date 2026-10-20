import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Relais } from '../src/relais.js';
import { signer } from '../src/jetons.js';

class FauxWS extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.recus = []; this.bufferedAmount = 0; this.ferme = null; }
  send(d) { this.recus.push(typeof d === 'string' ? JSON.parse(d) : Buffer.from(d)); }
  close(code) { this.ferme = code; this.readyState = 3; this.emit('close'); }
  texte(m) { this.emit('message', Buffer.from(JSON.stringify(m)), false); }
  binaire(b) { this.emit('message', b, true); }
}

function fabrique() {
  const relais = new Relais({ secret: 'r' });
  const entrer = (role, uid, salle = 'salle1') => {
    const ws = new FauxWS();
    relais.brancher(ws, relais.autoriser(signer('r', { salle, role, uid }, 60_000)));
    return ws;
  };
  return { relais, entrer };
}

test('jetons : il faut un jeton signé valide avec une salle et un rôle', () => {
  const { relais } = fabrique();
  assert.equal(relais.autoriser(signer('autre', { salle: 's', role: 'ami' })), null);
  assert.equal(relais.autoriser(signer('r', { salle: 'S!', role: 'ami' })), null);
  assert.equal(relais.autoriser(signer('r', { salle: 's', role: 'admin' })), null);
  assert.deepEqual(relais.autoriser(signer('r', { salle: 's', role: 'ami', uid: '9' })), { salle: 's', role: 'ami', uid: '9' });
});

test('l’hôte voit arriver les amis et peut leur envoyer images et messages', () => {
  const { entrer } = fabrique();
  const hote = entrer('hote', 'h');
  const ami = entrer('ami', 'a');
  assert.deepEqual(hote.recus[0], { type: 'arrivee', de: 1, uid: 'a' });
  const image = Buffer.alloc(8); image.writeUInt32LE(0, 0); image.write('vid!', 4);
  hote.binaire(image);
  hote.texte({ type: 'pong', a: 1, t: 5 });
  assert.equal(ami.recus[0].toString(), 'vid!');
  assert.deepEqual(ami.recus[1], { type: 'pong', t: 5 });
});

test('un ami ne peut envoyer que des types autorisés, et ne peut pas usurper son identité', () => {
  const { entrer } = fabrique();
  const hote = entrer('hote', 'h');
  const ami = entrer('ami', 'a');
  ami.texte({ type: 'commande', exe: 'calc.exe' });
  ami.texte({ type: 'ping', t: 1, uid: 'h', de: 99 });
  ami.binaire(Buffer.from('xx'));
  assert.deepEqual(hote.recus.slice(1), [{ type: 'ping', t: 1, uid: 'a', de: 1 }]);
});

test('les salles sont isolées', () => {
  const { entrer } = fabrique();
  const hote1 = entrer('hote', 'h1', 'salle1');
  const ami2 = entrer('ami', 'a2', 'salle2');
  hote1.texte({ type: 'info' });
  assert.deepEqual(ami2.recus, [{ type: 'pas-d-hote' }]);
});

test('un ami qui ne suit pas ne reçoit plus d’images (pas de retard qui s’accumule)', () => {
  const { entrer } = fabrique();
  const hote = entrer('hote', 'h');
  const lent = entrer('ami', 'l');
  const rapide = entrer('ami', 'r');
  lent.bufferedAmount = 10_000_000;
  const image = Buffer.alloc(6);
  hote.binaire(image);
  assert.equal(lent.recus.length, 0);
  assert.equal(rapide.recus.length, 1);
});

test('si l’hôte part, les amis sont prévenus', () => {
  const { entrer } = fabrique();
  const hote = entrer('hote', 'h');
  const ami = entrer('ami', 'a');
  hote.close(1000);
  assert.deepEqual(ami.recus.at(-1), { type: 'hote-parti' });
});
