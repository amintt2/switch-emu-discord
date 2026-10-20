import { DiscordSDK } from '@discord/embedded-app-sdk';
import { api, setSession, type Utilisateur } from './api.ts';

export interface Identite {
  user: Utilisateur;
  mode: 'discord' | 'navigateur';
  sdk: DiscordSDK | null;
}

/** Discord ajoute frame_id (entre autres) à l'adresse de l'Activité. */
export function dansDiscord() {
  return new URLSearchParams(location.search).has('frame_id');
}

export async function seConnecter(): Promise<Identite> {
  const cfg = await api<{ clientId: string | null; browserMode: boolean }>('/api/config');

  // « Ouvrir dans le navigateur » depuis l'Activité : un lien à usage unique, valable 2 minutes.
  const passage = new URLSearchParams(location.search).get('passage');
  if (passage && !dansDiscord()) {
    history.replaceState(null, '', location.pathname);  // le lien ne sert qu'une fois : on l'efface de l'adresse
    const res = await api<{ session: string; user: Utilisateur }>('/api/passage/echange', {
      method: 'POST',
      body: JSON.stringify({ passage }),
    });
    setSession(res.session);
    return { user: res.user, mode: 'navigateur', sdk: null };
  }

  if (dansDiscord()) {
    if (!cfg.clientId) throw new Error('DISCORD_CLIENT_ID manquant côté serveur');
    const sdk = new DiscordSDK(cfg.clientId);
    await sdk.ready();
    const { code } = await sdk.commands.authorize({
      client_id: cfg.clientId,
      response_type: 'code',
      state: '',
      prompt: 'none',
      scope: ['identify'],
    });
    const res = await api<{ access_token: string; session: string; user: Utilisateur }>('/api/token', {
      method: 'POST',
      body: JSON.stringify({ code, instanceId: sdk.instanceId }),
    });
    await sdk.commands.authenticate({ access_token: res.access_token });
    setSession(res.session);
    return { user: res.user, mode: 'discord', sdk };
  }

  if (!cfg.browserMode) {
    throw new Error('Ouvre Switch EMU depuis une Activité Discord, dans un salon vocal.');
  }
  // Mode essai dans un navigateur : ?salle=xyz&nom=Bob
  const params = new URLSearchParams(location.search);
  const nom = params.get('nom') || prompt('Ton pseudo ?') || 'Invité';
  const res = await api<{ session: string; user: Utilisateur }>('/api/dev-session', {
    method: 'POST',
    body: JSON.stringify({ nom, salle: params.get('salle') || 'test' }),
  });
  setSession(res.session);
  return { user: res.user, mode: 'navigateur', sdk: null };
}
