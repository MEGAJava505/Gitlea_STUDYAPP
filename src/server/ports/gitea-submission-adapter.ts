import type { GiteaSubmissionPort } from './gitea-submissions';

/**
 * Production Gitea adapter for the submission port (verified against the
 * Gitea 1.27.3 API).
 *
 * A submission snapshot is a real branch `refs/heads/submission/<attempt>`
 * created at the exact submitted commit through `POST /branches`, covered by
 * a branch-protection rule that disables pushes (and therefore force-pushes)
 * for everyone. Gitea refuses to delete protected branches. Arbitrary
 * `refs/submission/*` refs are not used: Gitea 1.27 has no ref-creation API
 * and branch protection does not apply to non-branch refs.
 *
 * Every snapshot — new or reconciled after a retry — is verified before it is
 * reported: the branch must point at the expected SHA and its effective rule
 * must block pushes. Anything else fails closed.
 *
 * Only a 404 is interpreted as "absent"; every other Gitea error propagates
 * with the admin token redacted. Uses the same admin token as the provisioning
 * adapter; never logs it.
 */
export class GiteaHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'GiteaHttpError';
  }
}

interface GiteaBranch {
  name: string;
  commit: { id: string };
  protected: boolean;
  effective_branch_protection_name?: string;
}

interface GiteaBranchProtection {
  rule_name: string;
  enable_push: boolean;
  enable_push_whitelist?: boolean;
  enable_force_push?: boolean;
  enable_bypass_allowlist?: boolean;
}

export class GiteaSubmissionAdapter implements GiteaSubmissionPort {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly log: (message: string) => void;

  constructor(config: { baseUrl?: string; token?: string; log?: (message: string) => void } = {}) {
    this.baseUrl = (config.baseUrl ?? process.env.GITEA_BASE_URL ?? '').replace(/\/$/, '');
    this.token = config.token ?? process.env.GITEA_ADMIN_TOKEN ?? '';
    this.log = config.log ?? (() => undefined);
  }

  private redact(text: string): string {
    return this.token ? text.split(this.token).join('[REDACTED]') : text;
  }

  private async fetch<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = {
      Authorization: `token ${this.token}`,
      'Content-Type': 'application/json',
      ...init.headers,
    };
    this.log(`Gitea ${init.method ?? 'GET'} ${this.redact(url)}`);
    const response = await fetch(url, { ...init, headers }).catch((error: unknown) => {
      throw new Error(this.redact(error instanceof Error ? error.message : 'Gitea request failed'));
    });
    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown error');
      throw new GiteaHttpError(response.status, `Gitea API error (${response.status}): ${this.redact(text)}`);
    }
    return response.json() as Promise<T>;
  }

  /** Runs a GET and maps exactly a 404 to null; all other errors propagate. */
  private async getOrNull<T>(path: string): Promise<T | null> {
    try {
      return await this.fetch<T>(path);
    } catch (err) {
      if (err instanceof GiteaHttpError && err.status === 404) return null;
      throw err;
    }
  }

  private static branchName(attempt: number): string {
    return `submission/${attempt}`;
  }

  async hasCommit(input: { repoFullName: string; commitSha: string }): Promise<boolean> {
    const commit = await this.getOrNull(
      `/api/v1/repos/${input.repoFullName}/git/commits/${encodeURIComponent(input.commitSha)}`,
    );
    return commit !== null;
  }

  async createProtectedSnapshot(input: {
    repoFullName: string;
    commitSha: string;
    attempt: number;
  }): Promise<{ protectedRef: string }> {
    const branch = GiteaSubmissionAdapter.branchName(input.attempt);
    const repo = `/api/v1/repos/${input.repoFullName}`;

    try {
      await this.fetch(`${repo}/branches`, {
        method: 'POST',
        body: JSON.stringify({ new_branch_name: branch, old_ref_name: input.commitSha }),
      });
    } catch (err) {
      // 409: the branch already exists (retry, or a student pushed it first).
      // Accepted only if it already points at the submitted commit.
      if (!(err instanceof GiteaHttpError && err.status === 409)) throw err;
      const existing = await this.getOrNull<GiteaBranch>(`${repo}/branches/${branch}`);
      if (!existing || existing.commit.id !== input.commitSha) {
        throw new Error(`Snapshot branch ${branch} already exists at a different commit`);
      }
    }

    const rules = await this.fetch<GiteaBranchProtection[]>(`${repo}/branch_protections`);
    if (!rules.some((rule) => rule.rule_name === branch)) {
      await this.fetch(`${repo}/branch_protections`, {
        method: 'POST',
        body: JSON.stringify({
          rule_name: branch,
          enable_push: false,
          enable_push_whitelist: false,
          enable_force_push: false,
          enable_bypass_allowlist: false,
          enable_merge_whitelist: false,
          enable_status_check: false,
        }),
      });
    }

    // Re-read after protection: a push that raced the rule creation is caught here.
    const verified = await this.verifiedSnapshot(input.repoFullName, branch);
    if (!verified || verified.commitSha !== input.commitSha) {
      throw new Error(`Snapshot branch ${branch} does not point at the submitted commit`);
    }
    return { protectedRef: `refs/heads/${branch}` };
  }

  async ensureReviewPullRequest(input: {
    repoFullName: string;
    protectedRef: string;
    attempt: number;
  }): Promise<{ number: number }> {
    const repo = `/api/v1/repos/${input.repoFullName}`;
    const head = GiteaSubmissionAdapter.branchName(input.attempt);
    if (input.protectedRef !== `refs/heads/${head}`) {
      throw new Error('Snapshot reference does not match the submission attempt');
    }
    const { default_branch: base } = await this.fetch<{ default_branch: string }>(repo);
    const existing = await this.getOrNull<{ number: number }>(
      `${repo}/pulls/${encodeURIComponent(base)}/${head.split('/').map(encodeURIComponent).join('/')}`,
    );
    if (existing) return { number: existing.number };
    const created = await this.fetch<{ number: number }>(`${repo}/pulls`, {
      method: 'POST',
      body: JSON.stringify({ base, head, title: `Submission ${input.attempt}` }),
    });
    return { number: created.number };
  }

  async getExistingSubmission(input: {
    repoFullName: string;
    attempt: number;
  }): Promise<{ protectedRef: string; commitSha: string } | null> {
    const branch = GiteaSubmissionAdapter.branchName(input.attempt);
    const verified = await this.verifiedSnapshot(input.repoFullName, branch);
    return verified && { protectedRef: `refs/heads/${branch}`, commitSha: verified.commitSha };
  }

  async addComment(input: {
    repoFullName: string;
    pullRequestNumber: number;
    body: string;
    inline?: { path: string; line: number };
  }): Promise<void> {
    const repo = `/api/v1/repos/${input.repoFullName}`;
    if (input.inline) {
      // Gitea PR review comments: create a review with one line comment.
      await this.fetch(`${repo}/pulls/${input.pullRequestNumber}/reviews`, {
        method: 'POST',
        body: JSON.stringify({
          body: '',
          event: 'COMMENT',
          comments: [
            {
              body: input.body,
              path: input.inline.path,
              old_position: 0,
              new_position: input.inline.line,
            },
          ],
        }),
      });
      return;
    }
    // General issue/PR comment.
    await this.fetch(`${repo}/issues/${input.pullRequestNumber}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: input.body }),
    });
  }

  /**
   * Returns the branch head if the branch exists and is effectively protected
   * against pushes; null if it does not exist; throws if it exists unprotected
   * (an orphan or student-created branch must never be trusted as a snapshot).
   */
  private async verifiedSnapshot(repoFullName: string, branch: string): Promise<{ commitSha: string } | null> {
    const repo = `/api/v1/repos/${repoFullName}`;
    const found = await this.getOrNull<GiteaBranch>(`${repo}/branches/${branch}`);
    if (!found) return null;
    const ruleName = found.effective_branch_protection_name;
    if (!found.protected || !ruleName) {
      throw new Error(`Snapshot branch ${branch} exists but is not protected`);
    }
    const rules = await this.fetch<GiteaBranchProtection[]>(`${repo}/branch_protections`);
    const rule = rules.find((r) => r.rule_name === ruleName);
    if (!rule || rule.enable_push !== false || rule.enable_force_push || rule.enable_bypass_allowlist) {
      throw new Error(`Snapshot branch ${branch} protection does not block pushes`);
    }
    return { commitSha: found.commit.id };
  }
}
