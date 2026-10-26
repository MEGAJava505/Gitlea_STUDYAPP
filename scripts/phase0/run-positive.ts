import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertEqual, assertGitDenied, assertTrue, writeEvidence, type AssertionResult } from '../../tools/gitea-validation/assertions';
import { GiteaValidationClientImpl } from '../../tools/gitea-validation/client';
import {
  cleanupFixtures, createFixtureToken, fixtureApi, fixtures, generateFixturePassword,
  protectFixtureBranch, requiredEnv, withFixtureGit,
} from '../../tools/gitea-validation/fixtures';

// Use a fresh cookie jar per login so the second subject check proves a second login.
async function loginIdentity(
  client: GiteaValidationClientImpl, password: string, redirectUri: string,
  clientId: string, clientSecret: string, secrets: string[],
): Promise<{ sub: string; preferred_username: string }> {
  const state = randomUUID();
  const nonce = randomUUID();
  const baseUrl = client.giteaBaseUrl;
  const cookies = new Map<string, string>();
  let url = new URL(client.getOAuthAuthorizeUrl(state));
  url.searchParams.set('nonce', nonce);
  let form: URLSearchParams | undefined;
  let code: string | null = null;
  for (let hop = 0; hop < 12; hop += 1) {
    const target = new URL(redirectUri);
    if (url.origin === target.origin && url.pathname === target.pathname) {
      assertEqual('OAuth state preserved', url.searchParams.get('state'), state);
      code = url.searchParams.get('code');
      break;
    }
    assertEqual('OAuth credentials stay on Gitea origin', url.origin, new URL(baseUrl).origin);
    const response = await fetch(url, {
      method: form ? 'POST' : 'GET', redirect: 'manual',
      headers: { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: form?.toString(), signal: AbortSignal.timeout(30_000),
    });
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(';')[0] ?? '';
      const index = pair.indexOf('=');
      if (index > 0) {
        const value = pair.slice(index + 1);
        cookies.set(pair.slice(0, index), value);
        if (value) secrets.push(value);
      }
    }
    form = undefined;
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) throw new Error(`OAuth browser flow failed: ${response.status}`);
    const html = await response.text();
    const forms = html.match(/<form\b[\s\S]*?<\/form>/gi) ?? [];
    const selected = forms.find((item) => /name=["']password["']/.test(item))
      ?? forms.find((item) => /oauth\/grant/.test(item));
    if (!selected) throw new Error('OAuth page missing login or consent form');
    form = new URLSearchParams();
    for (const input of selected.matchAll(/<input\b[^>]*>/gi)) {
      const name = /\bname=["']([^"']*)["']/i.exec(input[0])?.[1];
      const value = /\bvalue=["']([^"']*)["']/i.exec(input[0])?.[1];
      if (name && value !== undefined) form.set(name, value.replace(/&amp;/g, '&').replace(/&#34;|&quot;/g, '"'));
    }
    // Gitea 1.27+ stopped rendering a _csrf hidden input on the login/consent pages
    // (session-bound CSRF); keep sending it when present, but do not require it.
    if (/name=["']password["']/.test(selected)) {
      form.set('user_name', fixtures.student);
      form.set('password', password);
    } else {
      form.set('granted', 'true');
      form.set('client_id', clientId);
      form.set('redirect_uri', redirectUri);
      form.set('state', state);
      form.set('nonce', nonce);
    }
    const action = /<form\b[^>]*\baction=["']([^"']*)["']/i.exec(selected)?.[1];
    if (action) url = new URL(action.replace(/&amp;/g, '&'), url);
  }
  if (!code) throw new Error('OAuth flow did not reach the registered callback with a code');
  secrets.push(code);
  const response = await fetch(`${baseUrl}/login/oauth/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`OAuth token exchange failed: ${response.status}`);
  const token = await response.json() as { access_token?: string; refresh_token?: string; id_token?: string };
  if (!token.access_token) throw new Error('OAuth access token missing');
  secrets.push(token.access_token, token.refresh_token ?? '', token.id_token ?? '');
  return client.oauthFlow.userInfo(token.access_token);
}

async function run(): Promise<void> {
  const baseUrl = requiredEnv('GITEA_BASE_URL').replace(/\/+$/, '');
  const adminToken = requiredEnv('GITEA_ADMIN_TOKEN');
  const oauthClientId = requiredEnv('GITEA_OAUTH_CLIENT_ID');
  const oauthClientSecret = process.env.GITEA_OAUTH_CLIENT_SECRET ?? '';
  const oauthRedirectUri = requiredEnv('GITEA_OAUTH_REDIRECT_URI');
  const secrets = [adminToken, oauthClientSecret];
  const client = new GiteaValidationClientImpl({ baseUrl, adminToken, secrets, oauthClientId, oauthRedirectUri });
  const results: AssertionResult[] = [];
  const studentPassword = generateFixturePassword();
  const otherPassword = generateFixturePassword();
  secrets.push(studentPassword, otherPassword);
  const report: Record<string, unknown> = {
    passed: false, version: null, repository: `${fixtures.organization}/${fixtures.repository}`,
    submissionRef: fixtures.submissionRef, assertions: results, transport: new URL(baseUrl).protocol,
  };
  let cleanupNeeded = false;
  try {
    report.version = await client.giteaVersion();
    cleanupNeeded = true;
    await cleanupFixtures(client);
    const student = await client.createUser({ username: fixtures.student, email: `${fixtures.student}@validation.invalid`, password: studentPassword });
    await client.createUser({ username: fixtures.otherStudent, email: `${fixtures.otherStudent}@validation.invalid`, password: otherPassword });
    results.push(assertEqual('student user created', student.login, fixtures.student));
    const identity = await loginIdentity(client, studentPassword, oauthRedirectUri, oauthClientId, oauthClientSecret, secrets);
    results.push(assertEqual('OIDC username mapping', identity.preferred_username, fixtures.student));
    results.push(assertEqual('OIDC subject maps to created user', identity.sub, String(student.id)));
    const second = await loginIdentity(client, studentPassword, oauthRedirectUri, oauthClientId, oauthClientSecret, secrets);
    results.push(assertEqual('OIDC subject stable across two logins', second.sub, identity.sub));
    results.push(assertEqual('OIDC username stable across two logins', second.preferred_username, identity.preferred_username));

    await client.createOrganization(fixtures.organization);
    await client.createRepo({
      owner: fixtures.templateOwner,
      name: fixtures.templateRepo,
      autoInit: true,
      template: true,
    });
    const repo = await client.createRepositoryFromTemplate({
      templateOwner: fixtures.templateOwner,
      templateRepo: fixtures.templateRepo,
      name: fixtures.repository,
    });
    const repoInfo = await client.api<{ private: boolean }>('GET', `/repos/${repo.fullName}`);
    results.push(assertTrue('private repository created from template', repoInfo.private));
    await client.api('GET', `/repos/${repo.fullName}/contents/README.md`);
    results.push({ name: 'template content copied', passed: true });
    const collaboratorToken = await createFixtureToken(baseUrl, fixtures.student, studentPassword, secrets);
    await client.grantWriteAccess({ repo: repo.fullName, login: fixtures.student });
    const permission = await client.api<{ permission?: string }>(
      'GET', `/repos/${fixtures.organization}/${fixtures.repository}/collaborators/${fixtures.student}/permission`,
    );
    results.push(assertEqual('student has restricted Write access', permission.permission, 'write'));
    const studentRepo = await fixtureApi<{ permissions: { push: boolean; pull: boolean; admin: boolean } }>(baseUrl, collaboratorToken, 'GET', `/repos/${repo.fullName}`);
    results.push(assertTrue('student can read/write but cannot administer', studentRepo.permissions.pull && studentRepo.permissions.push && !studentRepo.permissions.admin));

    await protectFixtureBranch(baseUrl, adminToken, repo.fullName, 'main');
    const protections = await client.api<Array<{ branch_name: string; rule_name: string; enable_push: boolean }>>(
      'GET', `/repos/${fixtures.organization}/${fixtures.repository}/branch_protections`,
    );
    assertTrue('main branch protection enabled', protections.some((item) => (item.rule_name ?? item.branch_name) === 'main' && item.enable_push === false));
    results.push({ name: 'main branch protection enabled', passed: true });

    const sourceSha = await client.getRefSha(repo.fullName, 'heads/main');
    await client.createSubmissionRef({ repo: repo.fullName, sourceSha, ref: fixtures.submissionRef });
    await protectFixtureBranch(baseUrl, adminToken, repo.fullName, 'submission/1');
    assertEqual('submission ref points to submitted commit', await client.getRefSha(repo.fullName, 'heads/submission/1'), sourceSha);
    results.push({ name: 'submission snapshot created and protection configured', passed: true });

    await withFixtureGit(baseUrl, repo.fullName, collaboratorToken, secrets, async (git, repoDir) => {
      results.push({ name: 'student cloned repository over HTTP', passed: true });
      await git(['switch', '-c', 'phase0-validation']);
      await writeFile(join(repoDir, 'submission.txt'), 'validation\n');
      await git(['add', 'submission.txt']);
      await git(['commit', '-m', 'Phase 0 validation']);
      await git(['push', '-u', 'origin', 'phase0-validation']);
      results.push({ name: 'student pushed feature branch over HTTP', passed: true });
      results.push(await assertGitDenied('student cannot push protected main', () => git(['push', 'origin', 'HEAD:refs/heads/main'])));
      results.push(await assertGitDenied('submission snapshot rejects student changes', () => git(['push', '--force', 'origin', `HEAD:${fixtures.submissionRef}`])));
      results.push(await assertGitDenied('submission snapshot rejects student deletion', () => git(['push', 'origin', `:${fixtures.submissionRef}`])));
    });
    results.push(assertEqual('submission snapshot remains unchanged', await client.getRefSha(repo.fullName, 'heads/submission/1'), sourceSha));

    const pull = await client.createPullRequest({ repo: repo.fullName, head: 'phase0-validation', base: 'main' });
    results.push({ name: 'pull request created', passed: true });
    await client.addComment({ repo: repo.fullName, number: pull.number, body: 'Phase 0 general comment.' });
    results.push({ name: 'general pull request comment added', passed: true });
    await client.api('POST', `/repos/${repo.fullName}/pulls/${pull.number}/reviews`, {
      event: 'COMMENT', comments: [{ body: 'Phase 0 inline comment.', path: 'submission.txt', new_position: 1 }],
    });
    results.push({ name: 'inline pull request comment added', passed: true });
    report.passed = true;
  } finally {
    try {
      if (cleanupNeeded) await cleanupFixtures(client);
    } finally {
      await writeEvidence('artifacts/phase0/positive.json', report, secrets);
    }
  }
}

run().catch(() => {
  console.error('positive validation failed; check configuration and artifacts/phase0/positive.json');
  process.exitCode = 1;
});
