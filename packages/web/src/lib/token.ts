const STORAGE_KEY = 'leon_token';

/**
 * On app load: if the URL carries ?token=XYZ, persist it and strip it from
 * the address bar so it never ends up in screenshots or browser history.
 */
export function initToken(): void {
  const url = new URL(window.location.href);
  const token = url.searchParams.get('token');
  if (token) {
    localStorage.setItem(STORAGE_KEY, token);
    url.searchParams.delete('token');
    window.history.replaceState(null, '', url.toString());
  }
}

export function getToken(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}

/** Build a ws:// (or wss://) URL for a daemon websocket path, with auth token attached. */
export function wsUrl(path: string, params?: Record<string, string>): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = new URL(`${proto}//${window.location.host}${path}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }
  const token = getToken();
  if (token) url.searchParams.set('token', token);
  return url.toString();
}
