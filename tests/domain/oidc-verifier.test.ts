import { describe, it, expect } from 'vitest';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { createOidcVerifier } from '../../src/domain/auth/oidc-verifier';
describe('OIDC trusted signature boundary', () => {
  it('accepts real signed tokens only with matching issuer audience nonce and expiry', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...await exportJWK(publicKey), kid: 'trusted', alg: 'RS256' };
    const verify = createOidcVerifier({ issuer: 'https://git.example', clientId: 'app', key: createLocalJWKSet({ keys: [jwk] }) });
    const token = await new SignJWT({ nonce: 'browser-nonce' }).setProtectedHeader({ alg: 'RS256', kid: 'trusted' }).setSubject('42').setIssuer('https://git.example').setAudience('app').setIssuedAt().setExpirationTime('5m').sign(privateKey);
    await expect(verify(token, 'browser-nonce')).resolves.toEqual({ giteaId: 42 });
    await expect(verify(token, 'wrong')).rejects.toThrow();
  });
});
