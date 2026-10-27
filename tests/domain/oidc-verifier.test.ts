import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { createOidcVerifier } from '../../src/domain/auth/oidc-verifier';
let key: Awaited<ReturnType<typeof generateKeyPair>>;
let verify: ReturnType<typeof createOidcVerifier>;
beforeAll(async () => {
  key = await generateKeyPair('RS256');
  verify = createOidcVerifier({ issuer: 'https://git.example', clientId: 'app', key: createLocalJWKSet({ keys: [{ ...await exportJWK(key.publicKey), kid: 'trusted', alg: 'RS256' }] }) });
});
async function signed(changes: Record<string, unknown> = {}, kid = 'trusted', signingKey = key.privateKey) {
  return new SignJWT({ sub: '42', iss: 'https://git.example', aud: 'app', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+300, nonce: 'browser-nonce', ...changes })
    .setProtectedHeader({ alg: 'RS256', kid }).sign(signingKey);
}
describe('OIDC trusted signature boundary', () => {
  it('accepts real signed tokens', async () => { await expect(verify(await signed(), 'browser-nonce')).resolves.toEqual({ giteaId: 42 }); });
  it.each([
    ['issuer', { iss: 'https://evil.example' }], ['audience', { aud: 'other' }], ['nonce', { nonce: 'wrong' }],
    ['expired', { exp: 1 }], ['future nbf', { nbf: Math.floor(Date.now()/1000)+300 }], ['missing exp', { exp: undefined }],
    ['missing nonce', { nonce: undefined }], ['nonnumeric subject', { sub: 'admin' }], ['unsafe subject', { sub: '999999999999999999999999' }],
    ['azp', { azp: 'other' }], ['multi audience without azp', { aud: ['app', 'other'] }],
  ])('rejects %s', async (_, changes) => { await expect(verify(await signed(changes), 'browser-nonce')).rejects.toThrow(); });
  it('rejects unknown keys', async () => { await expect(verify(await signed({}, 'unknown'), 'browser-nonce')).rejects.toThrow(); });
  it('rejects a forged signature with a trusted kid', async () => { const attacker = await generateKeyPair('RS256'); await expect(verify(await signed({}, 'trusted', attacker.privateKey), 'browser-nonce')).rejects.toThrow(); });
  it('rejects unsigned tokens', async () => { await expect(verify('eyJhbGciOiJub25lIn0.eyJzdWIiOiI0MiJ9.', 'browser-nonce')).rejects.toThrow(); });
});
