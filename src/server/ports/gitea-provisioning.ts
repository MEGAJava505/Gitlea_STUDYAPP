/**
 * Port for Gitea repository provisioning and Git workflow operations.
 *
 * Every Gitea call used by the provisioning and submission workflow is behind
 * this interface so the domain can be unit-tested with an in-memory fake.
 */
export interface GiteaProvisioningPort {
  /** Creates a new private repository from a template. */
  createRepositoryFromTemplate(input: {
    templateOwner: string;
    templateRepo: string;
    owner: string;
    name: string;
    private: true;
  }): Promise<{ id: number; fullName: string; private: boolean; defaultBranch: string }>;

  /** Grants Write access to a user on a repository. */
  grantWriteAccess(input: { repo: string; login: string }): Promise<void>;

  /** Protects a branch against force-push and direct commits. */
  protectBranch(input: { repo: string; branch: string }): Promise<void>;

  /** Creates a pull request from head to base. */
  createPullRequest(input: {
    repo: string;
    head: string;
    base: string;
  }): Promise<{ number: number }>;

  /** Adds a comment to a pull request. */
  addComment(input: {
    repo: string;
    number: number;
    body: string;
    inline?: { path: string; line: number };
  }): Promise<void>;
}

/**
 * Production adapter for Gitea API using fetch.
 *
 * Every request uses the admin token and redacts it from logs.
 */
export class GiteaProvisioningAdapter implements GiteaProvisioningPort {
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

  async createRepositoryFromTemplate(input: {
    templateOwner: string;
    templateRepo: string;
    owner: string;
    name: string;
    private: true;
  }): Promise<{ id: number; fullName: string; private: boolean; defaultBranch: string }> {
    const response = await this.fetch<{
      id: number;
      full_name: string;
      private: boolean;
      default_branch: string;
    }>(`/api/v1/repos/${input.templateOwner}/${input.templateRepo}/generate`, {
      method: 'POST',
      body: JSON.stringify({
        owner: input.owner,
        name: input.name,
        private: input.private,
      }),
    });

    return {
      id: response.id,
      fullName: response.full_name,
      private: response.private,
      defaultBranch: response.default_branch,
    };
  }

  async grantWriteAccess(input: { repo: string; login: string }): Promise<void> {
    await this.fetch(`/api/v1/repos/${input.repo}/collaborators/${input.login}`, {
      method: 'PUT',
      body: JSON.stringify({ permission: 'write' }),
    });
  }

  async protectBranch(input: { repo: string; branch: string }): Promise<void> {
    await this.fetch(`/api/v1/repos/${input.repo}/branch_protections`, {
      method: 'POST',
      body: JSON.stringify({
        branch_name: input.branch,
        enable_push: false,
        enable_push_whitelist: false,
        enable_merge_whitelist: false,
      }),
    });
  }

  async createPullRequest(input: {
    repo: string;
    head: string;
    base: string;
  }): Promise<{ number: number }> {
    const response = await this.fetch<{ number: number }>(`/api/v1/repos/${input.repo}/pulls`, {
      method: 'POST',
      body: JSON.stringify({
        head: input.head,
        base: input.base,
        title: `Submission ${input.head}`,
      }),
    });
    return { number: response.number };
  }

  async addComment(input: {
    repo: string;
    number: number;
    body: string;
    inline?: { path: string; line: number };
  }): Promise<void> {
    await this.fetch(`/api/v1/repos/${input.repo}/issues/${input.number}/comments`, {
      method: 'POST',
      body: JSON.stringify({
        body: input.body,
      }),
    });
  }
}
