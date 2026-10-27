import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { errors } from '../shared/contracts';
import type { BlobStorage } from '../domain/materials/service';

const MAX_BYTES = 50 * 1024 * 1024;
const PATH_PATTERN = /^materials\/([a-f0-9]{2})\/([a-f0-9]{64})$/;

export class FilesystemBlobStorage implements BlobStorage {
  constructor(private readonly root: string, private readonly maxBytes = MAX_BYTES) {}

  async store(bytes: Uint8Array, expectedSha256: string): Promise<{ storedPath: string }> {
    if (!/^[a-f0-9]{64}$/.test(expectedSha256) || bytes.byteLength > this.maxBytes) throw errors.invalidInput('blob digest or size is invalid');
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== expectedSha256) throw errors.invalidInput('blob digest does not match bytes');
    const storedPath = `materials/${expectedSha256.slice(0, 2)}/${expectedSha256}`;
    const target = await this.safePath(storedPath);
    const directory = join(this.root, 'materials', expectedSha256.slice(0, 2));
    await this.ensureDirectory(directory);
    try {
      const existing = await lstat(target);
      if (existing.isSymbolicLink() || !existing.isFile()) throw errors.integration('Material blob target is unsafe');
      return { storedPath };
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const temporary = join(directory, `.${expectedSha256}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.write(Buffer.from(bytes));
      await handle.sync();
      await handle.close();
      try { await rename(temporary, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await lstat(target);
        if (existing.isSymbolicLink() || !existing.isFile()) throw errors.integration('Material blob target is unsafe');
      }
      return { storedPath };
    } catch (error) {
      if (handle) { try { await handle.close(); } catch { /* already closed */ } }
      try { await unlink(temporary); } catch { /* best effort cleanup */ }
      if (error instanceof Error && error.name === 'DomainError') throw error;
      throw errors.integration('Material blob could not be stored');
    }
  }

  async retrieve(storedPath: string): Promise<Uint8Array> {
    const target = await this.safePath(storedPath);
    let handle;
    try {
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > this.maxBytes) throw errors.integration('Material blob is unsafe');
      return new Uint8Array(await handle.readFile());
    } catch (error) {
      if (error instanceof Error && error.name === 'DomainError') throw error;
      throw errors.integration('Material blob could not be read');
    } finally { await handle?.close().catch(() => undefined); }
  }

  private async safePath(storedPath: string): Promise<string> {
    const match = PATH_PATTERN.exec(storedPath);
    if (!match || match[1] !== match[2]!.slice(0, 2)) throw errors.invalidInput('storedPath is invalid');
    const target = resolve(this.root, storedPath);
    if (!target.startsWith(resolve(this.root) + '/')) throw errors.invalidInput('storedPath is invalid');
    return target;
  }

  private async ensureDirectory(directory: string): Promise<void> {
    const root = resolve(this.root);
    const materials = join(root, 'materials');
    for (const path of [root, materials, directory]) {
      try {
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw errors.integration('Material storage path is unsafe');
      } catch (error) {
        if (error instanceof Error && error.name === 'DomainError') throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw errors.integration('Material storage path is unsafe');
        await mkdir(path, { recursive: false, mode: 0o700 });
      }
    }
  }
}
