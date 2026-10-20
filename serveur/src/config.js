// Toute la configuration vient de l'environnement (voir .env.example).
import { createHash } from 'node:crypto';

function trimSlash(url) {
  return (url || '').replace(/\/+$/, '');
}

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  // Adresse publique du serveur (sert à l'agent pour joindre le relais de repli).
  publicUrl: trimSlash(process.env.PUBLIC_URL || 'https://switch.mciut.fr'),

  discord: {
    clientId: process.env.DISCORD_CLIENT_ID || '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
  },

  // Signent respectivement : les sessions des joueurs, les jetons des agents, les jetons du relais.
  // RELAY_SECRET doit être le même que celui du relais Cloudflare (wrangler secret put RELAY_SECRET).
  sessionSecret: process.env.SESSION_SECRET || '',
  agentSecret: process.env.AGENT_SECRET || '',
  relaySecret: process.env.RELAY_SECRET || '',

  // Relais Cloudflare : adresse vue par l'agent et par un navigateur, et chemin mappé dans Discord.
  // RELAIS_CF_URL=off désactive le relais Cloudflare (essais en local).
  relaisCloudflare: process.env.RELAIS_CF_URL === 'off' ? '' : trimSlash(process.env.RELAIS_CF_URL || 'wss://switch-emu-relais.amin2020e.workers.dev/relais'),
  relaisCloudflareChemin: process.env.RELAIS_CF_CHEMIN || '/cf/relais',

  // Mode navigateur (sans Discord) pour les essais en local.
  allowBrowserMode: process.env.ALLOW_BROWSER_MODE === '1',
};

export function assertConfig(log) {
  const manque = ['sessionSecret', 'agentSecret', 'relaySecret'].filter((k) => !config[k]);
  if (manque.length) throw new Error(`Variables manquantes : ${manque.join(', ')} (voir .env.example)`);
  if (!config.discord.clientId || !config.discord.clientSecret) {
    log.warn('DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET manquants : la connexion Discord ne marchera pas');
  }
}

/** Identifiant de salle pour une instance d'Activité (accepté par le relais : [a-z0-9-]). */
export function salleDepuisInstance(instanceId) {
  return 'i' + createHash('sha256').update(String(instanceId)).digest('hex').slice(0, 31);
}

/** Les relais, dans l'ordre de préférence. `agent` = URL pour l'hôte, `discord` = chemin mappé, `web` = URL directe. */
export function listeRelais() {
  const vps = config.publicUrl.replace(/^http/, 'ws') + '/relais';
  return [
    config.relaisCloudflare && { nom: 'cloudflare', agent: config.relaisCloudflare, discord: config.relaisCloudflareChemin, web: config.relaisCloudflare },
    { nom: 'vps', agent: vps, discord: '/relais', web: vps },
  ].filter(Boolean);
}
