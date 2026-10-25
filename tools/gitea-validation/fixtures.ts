import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { GiteaValidationClientImpl } from './client';

export const fixtures = {
  templateOwner: 'local-github-validation',
  templateRepo: 'phase0-validation-template',
  organization: 'local-github-validation',
  student: 'phase0-student',
  otherStudent: 'phase0-other-student',
  repository: 'phase0-student-work',
  otherRepository: 'phase0-other-work',
  submissionRef: 'refs/heads/submission/1',
} as const;

export function generateFixturePassword(): string {
  return `P0-${randomBytes(24).toString('base64url')}`;
}

export async function cleanupFixtures(client: GiteaValidationClientImpl): Promise<void> {
  const repos = [
    `${fixtures.organization}/${fixtures.repository}`,
    `${fixtures.organization}/${fixtures.otherRepository}`,
    `${fixtures.templateOwner}/${fixtures.templateRepo}`,
  ];
  for (const repo of repos) {
    try {
      await client.deleteRepo(repo);
    } catch (error) {
      if (!/failed: 404\b/.test(String(error))) throw new Error('fixture repository cleanup failed');
    }
  }
  for (const username of [fixtures.student, fixtures.otherStudent]) {
    try {
      await client.deleteUser(username);
    } catch (error) {
      if (!/failed: 404\b/.test(String(error))) throw new Error('fixture user cleanup failed');
    }
  }
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

export async function fixtureApi<T>(
  baseUrl: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`fixture API ${method} failed: ${response.status}`);
  const text = await response.text();
  return text ? JSON.parse(text) as T : undefined as T;
}

export async function createFixtureToken(
  baseUrl: string, username: string, password: string, secrets: string[],
): Promise<string> {
  const basic = Buffer.from(`${username}:${password}`).toString('base64');
  secrets.push(basic);
  const response = await fetch(`${baseUrl}/api/v1/users/${username}/tokens`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'phase0-validation', scopes: ['all'] }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`fixture token creation failed: ${response.status}`);
  const data = await response.json() as { sha1?: string };
  if (!data.sha1) throw new Error('fixture token missing from response');
  secrets.push(data.sha1);
  return data.sha1;
}

export async function protectFixtureBranch(baseUrl: string, adminToken: string, repo: string, branch: string): Promise<void> {
  await fixtureApi(baseUrl, adminToken, 'POST', `/repos/${repo}/branch_protections`, {
    rule_name: branch,
    branch_name: branch,
    enable_push: false,
    enable_force_push: false,
    block_admin_merge_override: true,
  });
}

const execute = promisify(execFile);
export async function withFixtureGit<T>(
  baseUrl: string,
  repo: string,
  token: string,
  secrets: string[],
  action: (git: (args: string[]) => Promise<{ stdout: string; stderr: string }>, directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'phase0-git-'));
  const basic = Buffer.from(`${fixtures.student}:${token}`).toString('base64');
  secrets.push(basic);
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
  const git = (args: string[]) => execute('git', args, { cwd: directory, env, timeout: 60_000 });
  try {
    await git(['clone', '--quiet', `${baseUrl}/${repo}.git`, '.']);
    await git(['config', 'user.name', fixtures.student]);
    await git(['config', 'user.email', `${fixtures.student}@validation.invalid`]);
    return await action(git, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
