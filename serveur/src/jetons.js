// Jetons signés (HMAC-SHA256) : base64url(JSON) + "." + base64url(signature).
// Le même format est vérifié par le relais Cloudflare (relais/src/jetons.js) avec WebCrypto.
import { createHmac, timingSafeEqual } from 'node:crypto';

function mac(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Signe `data` ; avec `ttlMs`, le jeton expire (champ exp en ms). */
export function signer(secret, data, ttlMs, now = Date.now()) {
  if (!secret) throw new Error('secret manquant');
  const body = ttlMs ? { ...data, exp: now + ttlMs } : { ...data };
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  return `${payload}.${mac(secret, payload)}`;
}

/** Renvoie les données si la signature est bonne et le jeton pas expiré, sinon null. */
export function verifier(secret, token, now = Date.now()) {
  if (!secret || typeof token !== 'string' || token.length > 4096) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const attendu = Buffer.from(mac(secret, payload));
  const recu = Buffer.from(sig);
  if (attendu.length !== recu.length || !timingSafeEqual(attendu, recu)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.exp !== undefined && (typeof data.exp !== 'number' || data.exp < now)) return null;
    return data;
  } catch {
    return null;
  }
}
