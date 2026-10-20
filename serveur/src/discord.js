import { config } from './config.js';

const API = 'https://discord.com/api';

/** Échange le code de discordSdk.commands.authorize() contre un jeton d'accès. */
export async function exchangeCode(code, redirectUri) {
  const res = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.discord.clientId,
      client_secret: config.discord.clientSecret,
      grant_type: 'authorization_code',
      code,
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Échange du code Discord refusé (${res.status}) : ${body.error || 'inconnu'}`);
  }
  return body.access_token;
}

export async function fetchUser(accessToken) {
  const res = await fetch(`${API}/users/@me`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Discord /users/@me a échoué (${res.status})`);
  const user = await res.json();
  return {
    uid: user.id,
    nom: user.global_name || user.username,
    avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64` : null,
  };
}
