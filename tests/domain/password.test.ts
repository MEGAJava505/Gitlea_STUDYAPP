import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { isValidPassword, PasswordServiceImpl } from '../../src/domain/password';
import { DomainError } from '../../src/shared/contracts';

describe('PasswordService', () => {
  it('issues seven characters containing either four letters or four digits', async () => {
    const service = new PasswordServiceImpl({
      hmacSecret: 'p'.repeat(32),
      fingerprints: { reserve: async () => true },
    });

    for (let i = 0; i < 40; i += 1) {
      const password = await service.generate();
      expect(password).toMatch(/^[a-z0-9]{7}$/);
      expect([3, 4]).toContain(password.replace(/[^a-z]/g, '').length);
      expect([3, 4]).toContain(password.replace(/[^0-9]/g, '').length);
    }
  });

  it.each(['abcd123', 'abc1234', '1a2b3c4'])('accepts the specified password %s', (password) => {
    expect(isValidPassword(password)).toBe(true);
  });

  it.each(['abcdef1', 'ab12345', 'ABCDEFG', 'abc123', 'abcd1234', 'Abcd123', 'abc!123', 'abcd123\n'])('rejects %j outside the policy', (password) => {
    expect(isValidPassword(password)).toBe(false);
  });

  it.each([
    { draws: [0, 0, 1, 2, 3, 1, 2, 3, 0, 0, 0, 0, 0, 0], password: 'bcd123a' },
    { draws: [1, 0, 1, 2, 1, 2, 3, 4, 0, 0, 0, 0, 0, 0], password: 'bc1234a' },
  ])('randomly chooses composition and shuffles every position: $password', async ({ draws, password }) => {
    const reserved: string[] = [];
    const service = new PasswordServiceImpl({
      hmacSecret: 'p'.repeat(32),
      randomInt: () => draws.shift()!,
      fingerprints: { reserve: async (fingerprint) => { reserved.push(fingerprint); return true; } },
    });
    expect(await service.generate()).toBe(password);
    expect(reserved).toEqual([createHmac('sha256', 'p'.repeat(32)).update(password).digest('hex')]);
    expect(reserved).not.toContain(password);
  });

  it('retries a reserved value and never issues duplicates across service instances', async () => {
    const used = new Set<string>();
    const fingerprints = {
      reserve: async (fingerprint: string) => {
        if (used.has(fingerprint)) return false;
        used.add(fingerprint);
        return true;
      },
    };
    const service = () => new PasswordServiceImpl({ hmacSecret: 'p'.repeat(32), fingerprints });
    const passwords = await Promise.all(Array.from({ length: 40 }, () => service().generate()));
    expect(new Set(passwords).size).toBe(40);
    expect(used.size).toBe(40);
  });

  it('bounds retries when every candidate has already been issued', async () => {
    const service = new PasswordServiceImpl({
      hmacSecret: 'p'.repeat(32),
      fingerprints: { reserve: async () => false },
    });
    await expect(service.generate()).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects an empty fingerprint key', () => {
    expect(() => new PasswordServiceImpl({
      hmacSecret: '', fingerprints: { reserve: async () => true },
    })).toThrow(DomainError);
  });

  it('propagates persistence failures without issuing a password', async () => {
    const service = new PasswordServiceImpl({
      hmacSecret: 'p'.repeat(32),
      fingerprints: { reserve: async () => { throw new Error('storage offline'); } },
    });
    await expect(service.generate()).rejects.toThrow('storage offline');
  });
});
