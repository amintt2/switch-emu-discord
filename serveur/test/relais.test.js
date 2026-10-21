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

test('l’hôte peut couper la connexion de quelqu’un qu’il a retiré', () => {
  const { entrer } = fabrique();
  const hote = entrer('hote', 'h');
  const retire = entrer('ami', 'x');
  const reste = entrer('ami', 'y');
  hote.texte({ type: 'exclure', uid: 'x' });
  assert.equal(retire.ferme, 4003);
  assert.equal(reste.ferme, null);
});

test('battements : le relais répond lui-même, sans rien transmettre', () => {
  const { entrer } = fabrique();
  const hote = entrer('hote', 'h');
  const ami = entrer('ami', 'a');
  const avant = hote.recus.length;
  ami.texte({ type: 'battement' });
  hote.texte({ type: 'battement' });
  assert.deepEqual(ami.recus, [{ type: 'battement' }]);
  assert.deepEqual(hote.recus.slice(avant), [{ type: 'battement' }]);
});

test('couches : chaque ami reçoit la qualité qu’il a choisie', () => {
  const { entrer } = fabrique();
  const hote = entrer('hote', 'h');
  const a = entrer('ami', 'a');
  const b = entrer('ami', 'b');
  b.texte({ type: 'qualite', q: 1 });
  b.texte({ type: 'qualite', q: 7 });  // couche inconnue : ignoré
  assert.deepEqual(hote.recus.at(-1), { type: 'qualite', q: 1, de: 2, uid: 'b' });
  const image = (dest, txt) => { const p = Buffer.alloc(8); p.writeUInt32LE(dest, 0); p.write(txt, 4); return p; };
  hote.binaire(image(0xFFFFFF00, 'hd!!'));
  hote.binaire(image(0xFFFFFF01, 'sd!!'));
  assert.deepEqual(a.recus.map(String), ['hd!!']);
  assert.deepEqual(b.recus.map(String), ['sd!!']);
});

test('pause : un ami en direct (P2P) ne reçoit plus les images, mais toujours les messages', () => {
  const { entrer } = fabrique();
  const hote = entrer('hote', 'h');
  const a = entrer('ami', 'a');
  a.texte({ type: 'pause', p: true });
  assert.deepEqual(hote.recus.at(-1), { type: 'pause', p: true, de: 1, uid: 'a' });
  const image = Buffer.alloc(8); image.writeUInt32LE(0, 0); image.write('vid!', 4);
  hote.binaire(image);
  hote.texte({ type: 'reponse', a: 1, sdp: 'v=0' });
  assert.deepEqual(a.recus, [{ type: 'reponse', sdp: 'v=0' }]);
  a.texte({ type: 'pause', p: false });
  hote.binaire(image);
  assert.equal(String(a.recus.at(-1)), 'vid!');
});

test('l’hôte qui se reconnecte retrouve l’état de chacun (qui, quelle couche, en direct ou non)', () => {
  const { entrer } = fabrique();
  const a = entrer('ami', 'a');
  a.texte({ type: 'qualite', q: 1 });
  a.texte({ type: 'pause', p: true });
  const hote = entrer('hote', 'h');
  assert.deepEqual(hote.recus[0], { type: 'arrivee', de: 1, uid: 'a', q: 1, p: true });
});
