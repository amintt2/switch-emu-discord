export interface Utilisateur {
  uid: string;
  nom: string;
  avatar: string | null;
}

let session = '';
export const setSession = (s: string) => { session = s; };
export const getSession = () => session;

export async function api<T>(chemin: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  if (session) headers.set('Authorization', `Bearer ${session}`);
  const res = await fetch(chemin, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Erreur ${res.status}`);
  return body as T;
}

export const wsUrl = (chemin: string) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${chemin}`;
