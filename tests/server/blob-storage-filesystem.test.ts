import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FilesystemBlobStorage } from '../../src/server/blob-storage-filesystem';

describe('FilesystemBlobStorage', () => {
  it('round-trips content addressed bytes and is idempotent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'materials-'));
    try {
      const storage = new FilesystemBlobStorage(root);
      const bytes = new TextEncoder().encode('stored bytes');
      const sha = createHash('sha256').update(bytes).digest('hex');
      const first = await storage.store(bytes, sha);
      const second = await storage.store(bytes, sha);
      expect(first).toEqual(second);
      expect(await storage.retrieve(first.storedPath)).toEqual(bytes);
      expect(readFileSync(join(root, first.storedPath))).toEqual(Buffer.from(bytes));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects digest mismatch and symlink targets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'materials-'));
    try {
      const storage = new FilesystemBlobStorage(root);
      const bytes = new Uint8Array([1, 2, 3]);
      await expect(storage.store(bytes, '0'.repeat(64))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      symlinkSync('/etc/passwd', join(root, 'materials'));
      await expect(storage.retrieve('materials/aa/' + 'a'.repeat(64))).rejects.toMatchObject({ code: 'INTEGRATION_ERROR' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
