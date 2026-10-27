import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GiteaSubmissionAdapter } from '../../src/server/ports/gitea-submission-adapter';

const BASE = 'https://git.example.com/api/v1/repos/org/repo';
const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

type Route = { status: number; body: unknown };

/**
 * Routes `METHOD path` to queued responses shaped like Gitea 1.27.3. Unrouted
 * calls fail the test so the adapter cannot hit unsupported endpoints.
 */
function giteaStub() {
  const routes = new Map<string, Route[]>();
  const calls: { method: string; url: string; body?: unknown; auth?: string }[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const headers = init.headers as Record<string, string>;
    calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined, auth: headers.Authorization });
    const queue = routes.get(`${method} ${url}`);
    const route = queue && (queue.length > 1 ? queue.shift()! : queue[0]);
    if (!route) throw new Error(`unexpected Gitea call ${method} ${url}`);
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      json: async () => route.body,
      text: async () => (typeof route.body === 'string' ? route.body : JSON.stringify(route.body)),
    };
  });
  return {
    fetchMock,
    calls,
    on(method: string, path: string, ...responses: Route[]) {
      routes.set(`${method} ${BASE}${path}`, responses);
    },
  };
}

const protectedBranch = (sha = SHA) => ({
  name: 'submission/1',
  commit: { id: sha },
  protected: true,
  effective_branch_protection_name: 'submission/1',
});
const lockedRule = { rule_name: 'submission/1', enable_push: false, enable_force_push: false, enable_bypass_allowlist: false };

describe('GiteaSubmissionAdapter (Gitea 1.27.3 API)', () => {
  let stub: ReturnType<typeof giteaStub>;
  let adapter: GiteaSubmissionAdapter;

  beforeEach(() => {
    stub = giteaStub();
    vi.stubGlobal('fetch', stub.fetchMock);
    adapter = new GiteaSubmissionAdapter({ baseUrl: 'https://git.example.com/', token: 'test-token' });
  });

  describe('hasCommit', () => {
    it('returns true when the commit exists and sends the admin token header', async () => {
      stub.on('GET', `/git/commits/${SHA}`, { status: 200, body: { sha: SHA } });
      await expect(adapter.hasCommit({ repoFullName: 'org/repo', commitSha: SHA })).resolves.toBe(true);
      expect(stub.calls[0].auth).toBe('token test-token');
    });

    it('returns false only for 404', async () => {
      stub.on('GET', `/git/commits/${SHA}`, { status: 404, body: 'not found' });
      await expect(adapter.hasCommit({ repoFullName: 'org/repo', commitSha: SHA })).resolves.toBe(false);
    });

    it.each([401, 403, 422, 500, 503])('propagates HTTP %i instead of reporting a missing commit', async (status) => {
      stub.on('GET', `/git/commits/${SHA}`, { status, body: 'boom' });
      await expect(adapter.hasCommit({ repoFullName: 'org/repo', commitSha: SHA })).rejects.toThrow(String(status));
    });

    it('propagates network errors', async () => {
      stub.fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
      await expect(adapter.hasCommit({ repoFullName: 'org/repo', commitSha: SHA })).rejects.toThrow('fetch failed');
    });
  });

  describe('createProtectedSnapshot', () => {
    it('creates refs/heads/submission/N at the exact SHA and protects it against pushes', async () => {
      stub.on('POST', '/branches', { status: 201, body: { name: 'submission/1' } });
      stub.on('GET', '/branch_protections', { status: 200, body: [] }, { status: 200, body: [lockedRule] });
      stub.on('POST', '/branch_protections', { status: 201, body: lockedRule });
      stub.on('GET', '/branches/submission/1', { status: 200, body: protectedBranch() });

      await expect(adapter.createProtectedSnapshot({ repoFullName: 'org/repo', commitSha: SHA, attempt: 1 }))
        .resolves.toEqual({ protectedRef: 'refs/heads/submission/1' });

      const create = stub.calls.find((c) => c.method === 'POST' && c.url.endsWith('/branches'));
      expect(create?.body).toEqual({ new_branch_name: 'submission/1', old_ref_name: SHA });
      const protect = stub.calls.find((c) => c.method === 'POST' && c.url.endsWith('/branch_protections'));
      expect(protect?.body).toMatchObject({
        rule_name: 'submission/1', enable_push: false, enable_push_whitelist: false,
        enable_force_push: false, enable_bypass_allowlist: false,
      });
      expect(stub.calls.some((c) => c.url.includes('/git/refs'))).toBe(false);
    });

    it('accepts an existing branch at the same SHA on retry without duplicating the rule', async () => {
      stub.on('POST', '/branches', { status: 409, body: 'branch already exists' });
      stub.on('GET', '/branches/submission/1', { status: 200, body: protectedBranch() });
      stub.on('GET', '/branch_protections', { status: 200, body: [lockedRule] });

      await expect(adapter.createProtectedSnapshot({ repoFullName: 'org/repo', commitSha: SHA, attempt: 1 }))
        .resolves.toEqual({ protectedRef: 'refs/heads/submission/1' });
      expect(stub.calls.some((c) => c.method === 'POST' && c.url.endsWith('/branch_protections'))).toBe(false);
    });

    it('fails closed when the branch already exists at a different SHA', async () => {
      stub.on('POST', '/branches', { status: 409, body: 'branch already exists' });
      stub.on('GET', '/branches/submission/1', { status: 200, body: { ...protectedBranch(OTHER_SHA), protected: false } });

      await expect(adapter.createProtectedSnapshot({ repoFullName: 'org/repo', commitSha: SHA, attempt: 1 }))
        .rejects.toThrow(/different commit/);
      expect(stub.calls.some((c) => c.method === 'POST' && c.url.endsWith('/branch_protections'))).toBe(false);
    });

    it('fails closed when the branch moved before protection took effect', async () => {
      stub.on('POST', '/branches', { status: 201, body: {} });
      stub.on('GET', '/branch_protections', { status: 200, body: [] }, { status: 200, body: [lockedRule] });
      stub.on('POST', '/branch_protections', { status: 201, body: lockedRule });
      stub.on('GET', '/branches/submission/1', { status: 200, body: protectedBranch(OTHER_SHA) });

      await expect(adapter.createProtectedSnapshot({ repoFullName: 'org/repo', commitSha: SHA, attempt: 1 }))
        .rejects.toThrow(/does not point at the submitted commit/);
    });

    it('fails closed when protection is not effective after creation', async () => {
      stub.on('POST', '/branches', { status: 201, body: {} });
      stub.on('GET', '/branch_protections', { status: 200, body: [] });
      stub.on('POST', '/branch_protections', { status: 201, body: lockedRule });
      stub.on('GET', '/branches/submission/1', { status: 200, body: { ...protectedBranch(), protected: false } });

      await expect(adapter.createProtectedSnapshot({ repoFullName: 'org/repo', commitSha: SHA, attempt: 1 }))
        .rejects.toThrow(/not protected/);
    });

    it.each([403, 404, 422, 423, 500])('propagates protection-rule creation failure (HTTP %i)', async (status) => {
      stub.on('POST', '/branches', { status: 201, body: {} });
      stub.on('GET', '/branch_protections', { status: 200, body: [] });
      stub.on('POST', '/branch_protections', { status, body: 'nope' });

      await expect(adapter.createProtectedSnapshot({ repoFullName: 'org/repo', commitSha: SHA, attempt: 1 }))
        .rejects.toThrow(String(status));
    });

    it('propagates branch creation failures other than 409', async () => {
      stub.on('POST', '/branches', { status: 404, body: 'commit not found' });
      await expect(adapter.createProtectedSnapshot({ repoFullName: 'org/repo', commitSha: SHA, attempt: 1 }))
        .rejects.toThrow('404');
    });
  });

  describe('getExistingSubmission', () => {
    it('returns a verified, push-protected snapshot', async () => {
      stub.on('GET', '/branches/submission/1', { status: 200, body: protectedBranch() });
      stub.on('GET', '/branch_protections', { status: 200, body: [lockedRule] });
      await expect(adapter.getExistingSubmission({ repoFullName: 'org/repo', attempt: 1 }))
        .resolves.toEqual({ protectedRef: 'refs/heads/submission/1', commitSha: SHA });
    });

    it('returns null only when the branch is 404', async () => {
      stub.on('GET', '/branches/submission/1', { status: 404, body: 'not found' });
      await expect(adapter.getExistingSubmission({ repoFullName: 'org/repo', attempt: 1 })).resolves.toBeNull();
    });

    it('propagates non-404 errors', async () => {
      stub.on('GET', '/branches/submission/1', { status: 500, body: 'boom' });
      await expect(adapter.getExistingSubmission({ repoFullName: 'org/repo', attempt: 1 })).rejects.toThrow('500');
    });

    it('refuses to trust an orphan unprotected branch (e.g. pushed by the student)', async () => {
      stub.on('GET', '/branches/submission/1', { status: 200, body: { name: 'submission/1', commit: { id: SHA }, protected: false } });
      await expect(adapter.getExistingSubmission({ repoFullName: 'org/repo', attempt: 1 })).rejects.toThrow(/not protected/);
    });

    it.each([
      ['push enabled', { ...lockedRule, enable_push: true }],
      ['force-push enabled', { ...lockedRule, enable_force_push: true }],
      ['bypass allowlist', { ...lockedRule, enable_bypass_allowlist: true }],
    ])('refuses a branch whose effective rule allows writes (%s)', async (_label, rule) => {
      stub.on('GET', '/branches/submission/1', { status: 200, body: protectedBranch() });
      stub.on('GET', '/branch_protections', { status: 200, body: [rule] });
      await expect(adapter.getExistingSubmission({ repoFullName: 'org/repo', attempt: 1 })).rejects.toThrow(/does not block pushes/);
    });
  });

  describe('ensureReviewPullRequest', () => {
    const input = { repoFullName: 'org/repo', protectedRef: 'refs/heads/submission/2', attempt: 2 };

    it('opens a PR from the snapshot branch to the default branch', async () => {
      stub.on('GET', '', { status: 200, body: { default_branch: 'main' } });
      stub.on('GET', '/pulls/main/submission/2', { status: 404, body: 'not found' });
      stub.on('POST', '/pulls', { status: 201, body: { number: 7 } });
      await expect(adapter.ensureReviewPullRequest(input)).resolves.toEqual({ number: 7 });
      expect(stub.calls.at(-1)?.body).toEqual({ base: 'main', head: 'submission/2', title: 'Submission 2' });
    });

    it('reuses an existing PR on retry', async () => {
      stub.on('GET', '', { status: 200, body: { default_branch: 'main' } });
      stub.on('GET', '/pulls/main/submission/2', { status: 200, body: { number: 5 } });
      await expect(adapter.ensureReviewPullRequest(input)).resolves.toEqual({ number: 5 });
      expect(stub.calls.some((c) => c.method === 'POST')).toBe(false);
    });

    it('propagates non-404 lookup errors', async () => {
      stub.on('GET', '', { status: 200, body: { default_branch: 'main' } });
      stub.on('GET', '/pulls/main/submission/2', { status: 500, body: 'boom' });
      await expect(adapter.ensureReviewPullRequest(input)).rejects.toThrow('500');
    });
  });

  describe('token redaction', () => {
    it('redacts the admin token from propagated errors and logs', async () => {
      const logs: string[] = [];
      const logAdapter = new GiteaSubmissionAdapter({
        baseUrl: 'https://git.example.com',
        token: 'secret-token-123',
        log: (msg) => logs.push(msg),
      });
      stub.on('GET', '/git/commits/abc', { status: 401, body: 'unauthorized: token secret-token-123 is invalid' });

      const error = await logAdapter.hasCommit({ repoFullName: 'org/repo', commitSha: 'abc' }).catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('[REDACTED]');
      expect((error as Error).message).not.toContain('secret-token-123');
      expect(logs.join(' ')).not.toContain('secret-token-123');
    });
  });
});
