// Vérifie les jetons signés par le serveur (serveur/src/jetons.js) : base64url(JSON).base64url(HMAC-SHA256).
const enc = new TextEncoder();
const cles = new Map();

function depuisBase64url(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function cle(secret) {
  if (!cles.has(secret)) {
    cles.set(secret, crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']));
  }
  return cles.get(secret);
}

export async function verifier(secret, jeton, now = Date.now()) {
  if (!secret || typeof jeton !== 'string' || jeton.length > 4096) return null;
  const [payload, sig] = jeton.split('.');
  if (!payload || !sig) return null;
  try {
    if (!(await crypto.subtle.verify('HMAC', await cle(secret), depuisBase64url(sig), enc.encode(payload)))) return null;
    const data = JSON.parse(new TextDecoder().decode(depuisBase64url(payload)));
    if (data.exp !== undefined && (typeof data.exp !== 'number' || data.exp < now)) return null;
    return data;
  } catch {
    return null;
  }
}
