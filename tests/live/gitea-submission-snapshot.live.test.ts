import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GiteaSubmissionAdapter } from '@/server/ports/gitea-submission-adapter';
import { assertGitDenied } from '../../tools/gitea-validation/assertions';
import { GiteaValidationClientImpl } from '../../tools/gitea-validation/client';
import {
  cleanupFixtures, createFixtureToken, fixtureApi, fixtures, generateFixturePassword, withFixtureGit,
} from '../../tools/gitea-validation/fixtures';

/**
 * Live enforcement test for GiteaSubmissionAdapter against a real Gitea
 * (verified target: 1.27.3). Skipped unless GITEA_LIVE_BASE_URL and
 * GITEA_LIVE_ADMIN_TOKEN are both set.
 *
 * The student account is the shared Phase 0 fixture user (withFixtureGit
 * authenticates as fixtures.student); the repository name is unique per run.
 */
const baseUrlEnv = process.env.GITEA_LIVE_BASE_URL;
const adminTokenEnv = process.env.GITEA_LIVE_ADMIN_TOKEN;
const live = Boolean(baseUrlEnv && adminTokenEnv);

interface Branch { name: string; commit: { id: string }; protected: boolean }

describe.skipIf(!live)('GiteaSubmissionAdapter (live Gitea)', () => {
  const baseUrl = (baseUrlEnv ?? '').replace(/\/+$/, '');
  const adminToken = adminTokenEnv ?? '';
  const secrets: string[] = [adminToken];
  const client = new GiteaValidationClientImpl({ baseUrl, adminToken, secrets: [adminToken] });
  const adapter = new GiteaSubmissionAdapter({ baseUrl, token: adminToken });
  const repoName = `submission-live-${Date.now()}`;
  const repo = `${fixtures.organization}/${repoName}`;
  let studentToken = '';
  let sha = '';
  let otherSha = '';
  let repoCreated = false;

  const studentGit = <T>(action: Parameters<typeof withFixtureGit<T>>[4]) =>
    withFixtureGit(baseUrl, repo, studentToken, secrets, action);
  const branch = (name: string) => client.api<Branch>('GET', `/repos/${repo}/branches/${name}`);

  beforeAll(async () => {
    await cleanupFixtures(client);
    const password = generateFixturePassword();
    secrets.push(password);
    await client.createUser({ username: fixtures.student, email: `${fixtures.student}@validation.invalid`, password });
    await client.createOrganization(fixtures.organization);
    await client.createRepo({ owner: fixtures.organization, name: repoName, autoInit: true });
    repoCreated = true;
    await client.grantWriteAccess({ repo, login: fixtures.student });
    studentToken = await createFixtureToken(baseUrl, fixtures.student, password, secrets);

    // Student pushes the commit that will be submitted, plus an unrelated one.
    [sha, otherSha] = await studentGit(async (git, directory) => {
      await writeFile(join(directory, 'solution.txt'), 'submitted work\n');
      await git(['add', 'solution.txt']);
      await git(['commit', '-m', 'student submission']);
      await git(['push', 'origin', 'HEAD:main']);
      const submitted = (await git(['rev-parse', 'HEAD'])).stdout.trim();
      await git(['commit', '--allow-empty', '-m', 'later work']);
      await git(['push', 'origin', 'HEAD:main']);
      const later = (await git(['rev-parse', 'HEAD'])).stdout.trim();
      return [submitted, later];
    });
  }, 120_000);

  afterAll(async () => {
    try {
      if (repoCreated) await client.deleteRepo(repo).catch(() => undefined);
    } finally {
      await cleanupFixtures(client);
    }
  }, 120_000);

  it('creates a protected snapshot branch at the submitted commit', async () => {
    const result = await adapter.createProtectedSnapshot({ repoFullName: repo, commitSha: sha, attempt: 1 });
    expect(result.protectedRef).toBe('refs/heads/submission/1');
    const found = await branch('submission/1');
    expect(found.commit.id).toBe(sha);
    expect(found.protected).toBe(true);
  }, 60_000);

  it('rejects student force-push and normal push to the snapshot branch', async () => {
    await studentGit(async (git, directory) => {
      // Control: the student can push elsewhere, so a rejection below is protection, not auth.
      await git(['push', 'origin', `${sha}:refs/heads/student-control`]);

      await git(['switch', '--orphan', 'rewrite']);
      await git(['rm', '-rf', '.']).catch(() => undefined);
      await writeFile(join(directory, 'tamper.txt'), 'rewrite\n');
      await git(['add', 'tamper.txt']);
      await git(['commit', '-m', 'rewrite attempt']);
      await assertGitDenied('force-push to submission/1',
        () => git(['push', '--force', 'origin', 'HEAD:refs/heads/submission/1']));

      await git(['switch', '--detach', sha]);
      await git(['commit', '--allow-empty', '-m', 'fast-forward attempt']);
      await assertGitDenied('normal push to submission/1',
        () => git(['push', 'origin', 'HEAD:refs/heads/submission/1']));
    });
    expect((await branch('submission/1')).commit.id).toBe(sha);
  }, 120_000);

  it('rejects student deletion via git and via the API', async () => {
    await studentGit(async (git) => {
      await assertGitDenied('git push --delete submission/1',
        () => git(['push', 'origin', '--delete', 'submission/1']));
    });
    await expect(fixtureApi(baseUrl, studentToken, 'DELETE', `/repos/${repo}/branches/submission/1`))
      .rejects.toThrow(/fixture API DELETE failed: \d{3}/);
    const found = await branch('submission/1');
    expect(found.commit.id).toBe(sha);
    expect(found.protected).toBe(true);
  }, 120_000);

  it('getExistingSubmission returns the snapshot sha', async () => {
    await expect(adapter.getExistingSubmission({ repoFullName: repo, attempt: 1 })).resolves.toEqual({
      protectedRef: 'refs/heads/submission/1',
      commitSha: sha,
    });
  }, 60_000);

  it('is idempotent for the same sha and rejects a different sha', async () => {
    await expect(adapter.createProtectedSnapshot({ repoFullName: repo, commitSha: sha, attempt: 1 }))
      .resolves.toEqual({ protectedRef: 'refs/heads/submission/1' });
    await expect(adapter.createProtectedSnapshot({ repoFullName: repo, commitSha: otherSha, attempt: 1 }))
      .rejects.toThrow();
    expect((await branch('submission/1')).commit.id).toBe(sha);
  }, 60_000);

  it('refuses to trust a student-pushed unprotected submission/2 branch', async () => {
    await studentGit(async (git) => {
      await git(['push', 'origin', `${otherSha}:refs/heads/submission/2`]);
    });
    const found = await branch('submission/2');
    expect(found.protected).toBe(false);
    await expect(adapter.getExistingSubmission({ repoFullName: repo, attempt: 2 }))
      .rejects.toThrow(/not protected/);
  }, 120_000);
});
