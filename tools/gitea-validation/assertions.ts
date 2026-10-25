import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface AssertionResult {
  name: string;
  passed: true;
}

export function assertTrue(name: string, value: unknown, message = 'expected condition to be true'): AssertionResult {
  if (!value) throw new Error(`${name}: ${message}`);
  return { name, passed: true };
}

export function assertEqual<T>(name: string, actual: T, expected: T): AssertionResult {
  if (actual !== expected) {
    throw new Error(`${name}: expected ${String(expected)}, received ${String(actual)}`);
  }
  return { name, passed: true };
}

export async function assertRejects(
  name: string,
  operation: () => Promise<unknown>,
  allowedStatuses: number[] = [403],
): Promise<AssertionResult> {
  try {
    await operation();
  } catch (error) {
    const status = Number(/(?:^|\s)(\d{3})(?:\s|$)/.exec(String(error))?.[1]);
    if (allowedStatuses.includes(status)) return { name, passed: true };
    throw new Error(`${name}: operation failed unexpectedly (${String(error).slice(0, 240)})`);
  }
  throw new Error(`${name}: operation unexpectedly succeeded`);
}

export async function assertGitDenied(name: string, operation: () => Promise<unknown>): Promise<AssertionResult> {
  try {
    await operation();
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && /remote rejected/i.test(stderr) && /protected|not allowed|permission|denied/i.test(stderr)) {
      return { name, passed: true };
    }
    throw new Error(`${name}: Git failed without a protection rejection`);
  }
  throw new Error(`${name}: operation unexpectedly succeeded`);
}

function redact(value: unknown, secrets: readonly string[], key = ''): unknown {
  if (/password|secret|token|authorization|cookie/i.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, redact(child, secrets, childKey)]),
    );
  }
  if (typeof value !== 'string') return value;
  return secrets.reduce((result, secret) => secret ? result.split(secret).join('[REDACTED]') : result, value);
}

export async function writeEvidence(
  path: string,
  evidence: unknown,
  secrets: readonly string[],
): Promise<void> {
  const safeEvidence = redact(evidence, secrets);
  const serialized = `${JSON.stringify(safeEvidence, null, 2)}\n`;
  for (const secret of secrets) {
    if (secret && (serialized.includes(secret) || serialized.includes(JSON.stringify(secret).slice(1, -1)))) {
      throw new Error('evidence redaction failure: a configured secret value appears in evidence; refusing to persist');
    }
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serialized, { encoding: 'utf8', mode: 0o600 });
}
