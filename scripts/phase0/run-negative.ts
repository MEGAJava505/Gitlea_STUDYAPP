import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertEqual, assertGitDenied, assertRejects, type AssertionResult, writeEvidence } from '../../tools/gitea-validation/assertions';
import { GiteaValidationClientImpl } from '../../tools/gitea-validation/client';
import {
  cleanupFixtures, createFixtureToken, fixtureApi, fixtures, generateFixturePassword,
  protectFixtureBranch, requiredEnv, withFixtureGit,
} from '../../tools/gitea-validation/fixtures';

async function run(): Promise<void> {
  const baseUrl = requiredEnv('GITEA_BASE_URL').replace(/\/+$/, '');
  const adminToken = requiredEnv('GITEA_ADMIN_TOKEN');
  const client = new GiteaValidationClientImpl({ baseUrl, adminToken, secrets: [adminToken] });
  const secrets = [adminToken];
  const assertions: AssertionResult[] = [];
  const password = generateFixturePassword();
  const otherPassword = generateFixturePassword();
  secrets.push(password, otherPassword);
  const repo = `${fixtures.organization}/${fixtures.repository}`;
  const otherRepo = `${fixtures.organization}/${fixtures.otherRepository}`;
  const report: Record<string, unknown> = {
    passed: false, version: null, repository: repo, otherRepository: otherRepo,
    submissionRef: fixtures.submissionRef, assertions, transport: new URL(baseUrl).protocol,
  };
  let cleanupNeeded = false;
  try {
    report.version = await client.giteaVersion();
    cleanupNeeded = true;
    await cleanupFixtures(client);
    await client.createUser({ username: fixtures.student, email: `${fixtures.student}@validation.invalid`, password });
    await client.createUser({ username: fixtures.otherStudent, email: `${fixtures.otherStudent}@validation.invalid`, password: otherPassword });
    await client.createOrganization(fixtures.organization);
    await client.createRepo({ owner: fixtures.organization, name: fixtures.repository });
    await client.createRepo({ owner: fixtures.organization, name: fixtures.otherRepository });
    await client.grantWriteAccess({ repo, login: fixtures.student });
    await client.grantWriteAccess({ repo: otherRepo, login: fixtures.otherStudent });
    const studentToken = await createFixtureToken(baseUrl, fixtures.student, password, secrets);
    const otherToken = await createFixtureToken(baseUrl, fixtures.otherStudent, otherPassword, secrets);
    const own = await fixtureApi<{ full_name: string }>(baseUrl, studentToken, 'GET', `/repos/${repo}`);
    assertions.push(assertEqual('student credentials access own repository', own.full_name, repo));
    const theirs = await fixtureApi<{ full_name: string }>(baseUrl, otherToken, 'GET', `/repos/${otherRepo}`);
    assertions.push(assertEqual('other student credentials access other repository', theirs.full_name, otherRepo));
    const sha = await client.getRefSha(repo, 'heads/main');
    await client.createSubmissionRef({ repo, sourceSha: sha, ref: fixtures.submissionRef });
    await protectFixtureBranch(baseUrl, adminToken, repo, 'submission/1');

    await withFixtureGit(baseUrl, repo, studentToken, secrets, async (git, directory) => {
      // A successful control push prevents auth/transport failures from counting as protection.
      await git(['switch', '-c', 'phase0-control']);
      await git(['commit', '--allow-empty', '-m', 'Phase 0 write control']);
      await git(['push', 'origin', 'phase0-control']);
      assertions.push({ name: 'student can push unprotected control branch', passed: true });
      await git(['switch', '--orphan', 'phase0-rewrite']);
      // An orphan branch starts with an empty index; keep the removal for
      // non-empty trees but do not fail when there is nothing to remove.
      await git(['rm', '-rf', '.']).catch(() => undefined);
      await writeFile(join(directory, 'tamper.txt'), 'valid unrelated commit for force-push check\n');
      await git(['add', 'tamper.txt']);
      await git(['commit', '-m', 'Phase 0 rewrite attempt']);
      assertions.push(await assertGitDenied('student cannot force-push protected submission ref',
        () => git(['push', '--force', 'origin', `HEAD:${fixtures.submissionRef}`])));
      assertions.push(await assertGitDenied('student cannot delete protected submission ref',
        () => git(['push', 'origin', `:${fixtures.submissionRef}`])));
    });
    assertions.push(assertEqual('submission ref still points to original commit', await client.getRefSha(repo, 'heads/submission/1'), sha));
    assertions.push(await assertRejects('student cannot access another student repository',
      () => fixtureApi(baseUrl, studentToken, 'GET', `/repos/${otherRepo}`), [403, 404]));
    report.passed = true;
  } finally {
    try {
      if (cleanupNeeded) await cleanupFixtures(client);
    } finally {
      await writeEvidence('artifacts/phase0/negative.json', report, secrets);
    }
  }
}

run().catch(() => {
  console.error('negative validation failed; check configuration and artifacts/phase0/negative.json');
  process.exitCode = 1;
});
