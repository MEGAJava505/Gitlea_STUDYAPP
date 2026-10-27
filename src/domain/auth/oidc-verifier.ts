import { jwtVerify, type JWTVerifyGetKey } from 'jose';

/** Only a trusted, configured issuer's numeric subject maps to gitea_id. */
export function createOidcVerifier(config: { issuer: string; clientId: string; key: JWTVerifyGetKey }) {
  return async (token: string, nonce: string): Promise<{ giteaId: number }> => {
    const { payload } = await jwtVerify(token, config.key, {
      issuer: config.issuer, audience: config.clientId, algorithms: ['RS256'],
      requiredClaims: ['sub', 'exp', 'iat', 'nonce'],
    });
    if (payload.nonce !== nonce || (payload.azp !== undefined && payload.azp !== config.clientId)
      || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== config.clientId)
      || !payload.sub || !/^[1-9][0-9]*$/.test(payload.sub)) throw new Error('Invalid identity');
    const giteaId = Number(payload.sub);
    if (!Number.isSafeInteger(giteaId)) throw new Error('Invalid identity');
    return { giteaId };
  };
}
