// Shared bearer-token gate for WS upgrades.
// Token can arrive via Authorization: Bearer <token> (native codex clients use
// --remote-auth-token-env) or ?token=<token> (browser clients).
// When no token is configured the gate is open — callers must refuse
// non-loopback binds without a token (see cli serve).

import type { IncomingMessage } from 'node:http';

export function requestToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization ?? '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const t = url.searchParams.get('token');
    return t && t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

export function tokenOk(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const presented = requestToken(req);
  return presented !== null && presented === token;
}

export function isLoopbackHost(host: string | undefined): boolean {
  const h = host ?? '127.0.0.1';
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}
