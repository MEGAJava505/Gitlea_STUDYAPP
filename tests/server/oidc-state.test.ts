import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, readdirSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createFileOidcState } from '../../src/server/oidc-login-services';
const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'oidc-state-')); dirs.push(dir); return dir; };
const opaque = () => randomBytes(32).toString('base64url');
const browser = opaque();
const record = (expiresAt: number) => ({ browserHash: createHash('sha256').update(browser).digest('hex'), nonce: opaque(), verifier: opaque(), expiresAt, returnTo: '/' });
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('private durable OIDC state', () => {
  it('survives reopening and allows one concurrent consumer only', async () => {
    const dir = temp(); const state = opaque(); const expected = record(Date.now()+300000);
    await createFileOidcState(dir).create(state, expected);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const files = readdirSync(dir); expect(files).toHaveLength(1); expect(files[0]).toMatch(/^[a-f0-9]{64}$/); expect(files[0]).not.toBe(state);
    expect(statSync(join(dir, files[0]!)).mode & 0o777).toBe(0o600);
    const results = await Promise.all([createFileOidcState(dir).consume(state, browser), createFileOidcState(dir).consume(state, browser)]);
    expect(results.filter(Boolean)).toEqual([expected]);
    expect(await createFileOidcState(dir).consume(state, browser)).toBeNull();
  });
  it('rejects expired, missing, malformed and wrong-browser state; cleans expired files', async () => {
    const dir = temp(); const store = createFileOidcState(dir, () => 1000); const state = opaque();
    await store.create(state, record(999));
    expect(await store.consume(state, browser)).toBeNull();
    await store.create(opaque(), record(2000)); expect(readdirSync(dir)).toHaveLength(1);
    expect(await store.consume('../outside', browser)).toBeNull();
    expect(await store.consume(opaque(), browser)).toBeNull();
    const fresh = opaque(); await store.create(fresh, record(2000));
    expect(await store.consume(fresh, opaque())).toBeNull(); expect(await store.consume(fresh, browser)).not.toBeNull();
  });
  it('rejects symlinks and unsafe directory permissions', () => {
    const dir = temp(); chmodSync(dir, 0o755); expect(() => createFileOidcState(dir)).toThrow();
    const parent = temp(); const target = temp(); symlinkSync(target, join(parent, 'link'));
    expect(() => createFileOidcState(join(parent, 'link'))).toThrow();
  });
});
