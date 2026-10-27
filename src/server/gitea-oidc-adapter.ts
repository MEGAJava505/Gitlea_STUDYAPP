import Database from 'better-sqlite3';
import { createRemoteJWKSet } from 'jose';
import { createOidcVerifier } from '../domain/auth/oidc-verifier';
import type { UserId } from '../shared/contracts';

export interface OidcConfig {
  issuer: string; clientId: string; clientSecret: string; callbackUrl: string;
  authorizationEndpoint: string; tokenEndpoint: string; jwksUri: string;
}

/** Explicit pinned endpoints: never discover a URL from an unverified token. */
export function readOidcConfig(env: NodeJS.ProcessEnv = process.env): OidcConfig {
  const required = (name: string) => { const value = env[name]; if (!value) throw new Error('OIDC unavailable'); return value; };
  const issuer = required('OIDC_ISSUER');
  const url = (value: string) => {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) throw new Error('OIDC unavailable');
    return parsed;
  };
  const issuerUrl = url(issuer);
  if (issuerUrl.search) throw new Error('OIDC unavailable');
  const callbackUrl = required('OIDC_CALLBACK_URL');
  const callback = url(callbackUrl);
  if (callback.pathname !== '/api/auth/oidc/callback' || callback.search) throw new Error('OIDC unavailable');
  const endpoint = (name: string) => {
    const value = required(name); const parsed = url(value);
    if (parsed.origin !== issuerUrl.origin || parsed.search) throw new Error('OIDC unavailable');
    return value;
  };
  return { issuer, callbackUrl, clientId: required('OIDC_CLIENT_ID'), clientSecret: required('OIDC_CLIENT_SECRET'),
    authorizationEndpoint: endpoint('OIDC_AUTHORIZATION_ENDPOINT'), tokenEndpoint: endpoint('OIDC_TOKEN_ENDPOINT'), jwksUri: endpoint('OIDC_JWKS_URI') };
}

export function createGiteaOidcAdapter(config: OidcConfig, fetcher: typeof fetch = fetch) {
  const verify = createOidcVerifier({ ...config, key: createRemoteJWKSet(new URL(config.jwksUri), { timeoutDuration: 5000 }) });
  return {
    async exchange(code: string, verifier: string, nonce: string) {
      const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: config.callbackUrl,
        client_id: config.clientId, client_secret: config.clientSecret, code_verifier: verifier });
      const response = await fetcher(config.tokenEndpoint, { method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(10000), headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error('Login failed');
      const tokens: unknown = await response.json();
      if (!tokens || typeof tokens !== 'object' || !('id_token' in tokens) || typeof tokens.id_token !== 'string' || tokens.id_token.length > 32768) throw new Error('Login failed');
      return verify(tokens.id_token, nonce);
    },
  };
}

/** Separate short-lived readonly handle, no migrations or account creation. */
export async function findMappedGiteaUser(giteaId: number): Promise<UserId | null> {
  const url = process.env.DATABASE_URL ?? 'file:./data/local-github.sqlite';
  const db = new Database(url.startsWith('file:') ? url.slice(5) : url, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare('SELECT id FROM users WHERE gitea_id = ?').get(giteaId) as { id: UserId } | undefined;
    return row?.id ?? null;
  } finally { db.close(); }
}
