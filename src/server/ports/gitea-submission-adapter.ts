import type { GiteaSubmissionPort } from './gitea-submissions';

/**
 * Production Gitea adapter for the submission port.
 *
 * Implements the three operations the assignment state machine relies on:
 *  - hasCommit:            verify a commit SHA exists on the remote repo.
 *  - createProtectedSnapshot: create the immutable `submission/<attempt>` ref.
 *  - getExistingSubmission: read an already-created snapshot ref (idempotent retry).
 *
 * Uses the same admin token as the provisioning adapter; never logs it.
 */
export class GiteaSubmissionAdapter implements GiteaSubmissionPort {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly log: (message: string) => void;

  constructor(config: { baseUrl?: string; token?: string; log?: (message: string) => void } = {}) {
    this.baseUrl = (config.baseUrl ?? process.env.GITEA_BASE_URL ?? '').replace(/\/$/, '');
    this.token = config.token ?? process.env.GITEA_ADMIN_TOKEN ?? '';
    this.log = config.log ?? (() => undefined);
  }

  private async fetch<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = {
      Authorization: `token ${this.token}`,
      'Content-Type': 'application/json',
      ...init.headers,
    };
    this.log(`Gitea ${init.method ?? 'GET'} ${url.replace(this.token, '[REDACTED]')}`);
    const response = await fetch(url, { ...init, headers });
    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown error');
      const redacted = text.replace(new RegExp(this.token, 'g'), '[REDACTED]');
      throw new Error(`Gitea API error (${response.status}): ${redacted}`);
    }
    return response.json() as Promise<T>;
  }

  async hasCommit(input: { repoFullName: string; commitSha: string }): Promise<boolean> {
    try {
      await this.fetch(`/api/v1/repos/${input.repoFullName}/git/commits/${input.commitSha}`);
      return true;
    } catch {
      return false;
    }
  }

  async createProtectedSnapshot(input: {
    repoFullName: string;
    commitSha: string;
    attempt: number;
  }): Promise<{ protectedRef: string }> {
    const refName = `submission/${input.attempt}`;
    await this.fetch(`/api/v1/repos/${input.repoFullName}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/${refName}`, sha: input.commitSha }),
    });
    return { protectedRef: refName };
  }

  async getExistingSubmission(input: {
    repoFullName: string;
    attempt: number;
  }): Promise<{ protectedRef: string; commitSha: string } | null> {
    try {
      const ref = await this.fetch<{ object: { sha: string } }>(
        `/api/v1/repos/${input.repoFullName}/git/refs/submission/${input.attempt}`,
      );
      return { protectedRef: `submission/${input.attempt}`, commitSha: ref.object.sha };
    } catch {
      return null;
    }
  }
}
