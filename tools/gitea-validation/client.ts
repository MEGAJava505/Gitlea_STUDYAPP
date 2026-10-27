/**
 * GiteaValidationClient - REST/OAuth client for the Phase 0 validation harness.
 *
 * Contract: docs/IMPL_PLAN.md ("Phase 0 - technical validation harness").
 * The `GiteaValidationClient` interface and `GiteaValidationClientImpl` below
 * match that contract exactly. The implementation is built on the global
 * `fetch` (Node >= 18) so the harness has no runtime dependencies beyond the
 * declared dev toolchain (tsx).
 *
 * Security rules enforced here:
 *  - The admin access token is only ever sent in request headers.
 *  - `assertNoSecrets` must be called before any evidence is persisted; it
 *    throws if a configured secret value appears in the evidence text.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const API = '/api/v1';
const execFileAsync = promisify(execFile);

export interface OAuthFlow {
  /** URL of the Gitea sign-in page for the OAuth application (first hop). */
  signInUrl(state: string, nonce: string): string;
  /** POST the sign-in form and return the resulting redirect URL (contains the code). */
  signIn(input: { state: string; nonce: string; username: string; password: string }): Promise<string>;
  /** Authorize the application (grant step) and return the final redirect URL. */
  authorize(input: { state: string; nonce: string; redirectUri: string; username: string; password: string }): Promise<string>;
  /** Exchange an authorization code for an access token. */
  exchangeCode(code: string): Promise<string>;
  /** Fetch the OIDC userinfo for the access token. */
  userInfo(accessToken: string): Promise<{ sub: string; preferred_username: string }>;
}

export interface GiteaValidationClient {
  createUser(input: { username: string; email: string; password: string }): Promise<{ id: number; login: string }>;
  getOAuthAuthorizeUrl(state: string): string;
  exchangeOAuthCode(code: string): Promise<{ subject: string; login: string }>;
  createRepositoryFromTemplate(input: { templateOwner: string; templateRepo: string; name: string }): Promise<{ id: number; fullName: string }>;
  grantWriteAccess(input: { repo: string; login: string }): Promise<void>;
  protectBranch(input: { repo: string; branch: string }): Promise<void>;
  createSubmissionRef(input: { repo: string; sourceSha: string; ref: string }): Promise<void>;
  createPullRequest(input: { repo: string; head: string; base: string }): Promise<{ number: number }>;
  addComment(input: { repo: string; number: number; body: string; inline?: { path: string; line: number } }): Promise<void>;
}

export interface GiteaValidationClientOptions {
  /** Base URL of Gitea without trailing slash, e.g. http://localhost:3000. */
  baseUrl: string;
  /** Admin API token (header bearer). Never written to evidence. */
  adminToken: string;
  /** Secrets that must never appear in persisted evidence. */
  secrets?: string[];
  /** Client ID of the OAuth application registered for the harness. */
  oauthClientId?: string;
  /** Redirect URI registered for the OAuth application. */
  oauthRedirectUri?: string;
}

export class GiteaValidationClientImpl implements GiteaValidationClient {
  private readonly baseUrl: string;
  private readonly adminToken: string;
  private readonly secrets: string[];
  private readonly oauthClientId: string;
  private readonly oauthRedirectUri: string;
  private readonly oauth: OAuthFlow;

  constructor(options: GiteaValidationClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.adminToken = options.adminToken;
    this.secrets = (options.secrets ?? []).filter((s) => s.length > 0);
    this.oauthClientId = options.oauthClientId ?? '';
    this.oauthRedirectUri = options.oauthRedirectUri ?? '';
    this.oauth = new GiteaOAuthFlow(this);
  }

  /** The embedded OAuth flow (browserless sign-in + authorize). */
  get oauthFlow(): OAuthFlow {
    return this.oauth;
  }

  /** Secrets the evidence redaction layer must never let leak to disk. */
  get secretValues(): readonly string[] {
    return this.secrets;
  }

  get giteaBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Throw if `evidence` contains any configured secret value. Call this before
   * writing evidence to artifacts/phase0 so a regression cannot persist
   * credentials.
   */
  assertNoSecrets(evidence: string): void {
    for (const secret of this.secrets) {
      if (secret.length >= 8 && evidence.includes(secret)) {
        throw new Error('evidence redaction failure: a configured secret value appears in evidence; refusing to persist');
      }
    }
  }

  /** GET /api/healthz - used to fail fast when Gitea is unavailable. */
  async ping(): Promise<void> {
    const res = await fetch(`${this.baseUrl}${API}/healthz`);
    if (!res.ok) {
      throw new Error(`gitea unavailable: GET ${API}/healthz returned ${res.status}`);
    }
  }

  async giteaVersion(): Promise<string> {
    const res = await fetch(`${this.baseUrl}${API}/version`, {
      headers: this.adminHeaders(),
    });
    if (!res.ok) {
      throw new Error(`failed to read gitea version: ${res.status}`);
    }
    const body = (await res.json()) as { version: string };
    return body.version;
  }

  // --- raw helpers -------------------------------------------------------

  private adminHeaders(): Record<string, string> {
    return {
      Authorization: `token ${this.adminToken}`,
      'Content-Type': 'application/json',
      'X-Gitea-OTP': '',
    };
  }

  async api<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${API}${path}`, {
      method,
      headers: this.adminHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`gitea api ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`);
    }
    if (text.length === 0) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }

  private static parseRepo(fullName: string): { owner: string; repo: string } {
    const idx = fullName.indexOf('/');
    if (idx < 1 || idx === fullName.length - 1) {
      throw new Error(`invalid repo full name: ${fullName}`);
    }
    return { owner: fullName.slice(0, idx), repo: fullName.slice(idx + 1) };
  }

  /** Fetch the full ref value (sha) for a git ref like "refs/heads/main". */
  async getRefSha(repo: string, ref: string): Promise<string> {
    const { owner, repo: name } = GiteaValidationClientImpl.parseRepo(repo);
    const data = await this.api<{ object: { sha: string } } | Array<{ object: { sha: string } }>>(
      'GET',
      `/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}`,
    );
    // Gitea 1.28 answers a single ref with a one-element array; older versions
    // returned the object directly.
    const entry = Array.isArray(data) ? data[0] : data;
    if (!entry?.object?.sha) throw new Error(`git ref ${ref} not found in ${repo}`);
    return entry.object.sha;
  }

  /** Create an organization (admin, idempotent - tolerates 905/409). */
  async createOrganization(username: string): Promise<void> {
    try {
      await this.api('POST', '/orgs', { username, full_name: `Local GitHub`, description: 'Service organization for educational repositories (PLAN_GITEA section 8.2)' });
    } catch (err) {
      const msg = String(err);
      if (!msg.includes('905') && !msg.includes('409') && !msg.includes('already exists')) {
        throw err;
      }
    }
  }

  /** Create a private repository with optional initial files and template flag. */
  async createRepo(input: {
    owner: string;
    name: string;
    description?: string;
    autoInit?: boolean;
    defaultBranch?: string;
    readme?: string;
    template?: boolean;
    extraFiles?: Record<string, string>;
  }): Promise<{ id: number; fullName: string }> {
    const body: Record<string, unknown> = {
      name: input.name,
      private: true,
      auto_init: input.autoInit ?? true,
      default_branch: input.defaultBranch ?? 'main',
    };
    if (input.description !== undefined) body.description = input.description;
    if (input.readme !== undefined) body.readme = input.readme;
    if (input.template === true) body.template = true;
    if (input.extraFiles && Object.keys(input.extraFiles).length > 0) {
      body.git_content = input.extraFiles;
    }
    const data = await this.api<{ id: number; owner: { login: string }; name: string }>(
      'POST',
      `/orgs/${input.owner}/repos`,
      body,
    );
    return { id: data.id, fullName: `${data.owner.login}/${data.name}` };
  }

  /** Create a user-level repository (used for template repos when needed). */
  async createUserRepo(input: { owner: string; name: string; autoInit?: boolean; extraFiles?: Record<string, string> }): Promise<{ id: number; fullName: string }> {
    const body: Record<string, unknown> = {
      name: input.name,
      private: true,
      auto_init: input.autoInit ?? true,
      default_branch: 'main',
    };
    if (input.extraFiles && Object.keys(input.extraFiles).length > 0) {
      body.git_content = input.extraFiles;
    }
    const data = await this.api<{ id: number; owner: { login: string }; name: string }>(
      'POST',
      `/users/${input.owner}/repos`,
      body,
    );
    return { id: data.id, fullName: `${data.owner.login}/${data.name}` };
  }

  /** Mark a repository as a template (PUT /repos/{owner}/{repo}). */
  async markTemplate(repo: string): Promise<void> {
    const { owner, repo: name } = GiteaValidationClientImpl.parseRepo(repo);
    await this.api('PUT', `/repos/${owner}/${name}`, { template: true });
  }

  async deleteRepo(repo: string): Promise<void> {
    const { owner, repo: name } = GiteaValidationClientImpl.parseRepo(repo);
    await this.api('DELETE', `/repos/${owner}/${name}`);
  }

  async deleteUser(username: string): Promise<void> {
    await this.api('DELETE', `/admin/users/${encodeURIComponent(username)}`);
  }

  async deleteRef(repo: string, ref: string): Promise<void> {
    const { owner, repo: name } = GiteaValidationClientImpl.parseRepo(repo);
    await this.api('DELETE', `/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}`);
  }

  // --- GiteaValidationClient contract -------------------------------------

  async createUser(input: { username: string; email: string; password: string }): Promise<{ id: number; login: string }> {
    const data = await this.api<{ id: number; login: string }>('POST', '/admin/users', {
      username: input.username,
      email: input.email,
      password: input.password,
      must_change_password: false,
      send_notify: false,
    });
    return { id: data.id, login: data.login };
  }

  getOAuthAuthorizeUrl(state: string): string {
    return (
      `${this.baseUrl}/login/oauth/authorize` +
      `?client_id=${encodeURIComponent(this.oauthClientId)}` +
      `&redirect_uri=${encodeURIComponent(this.oauthRedirectUri)}` +
      `&response_type=code&scope=openid&state=${encodeURIComponent(state)}`
    );
  }

  async exchangeOAuthCode(code: string): Promise<{ subject: string; login: string }> {
    const tokenRes = await fetch(`${this.baseUrl}/login/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.oauthClientId,
        client_secret: '',
        code,
        grant_type: 'authorization_code',
        redirect_uri: this.oauthRedirectUri,
      }),
    });
    if (!tokenRes.ok) {
      throw new Error(`oauth token exchange failed: ${tokenRes.status}`);
    }
    const token = (await tokenRes.json()) as { access_token: string };
    const info = await this.oauth.userInfo(token.access_token);
    return { subject: info.sub, login: info.preferred_username };
  }

  async createRepositoryFromTemplate(input: { templateOwner: string; templateRepo: string; name: string }): Promise<{ id: number; fullName: string }> {
    const data = await this.api<{ id: number; owner: { login: string }; name: string }>(
      'POST',
      `/repos/${input.templateOwner}/${input.templateRepo}/generate`,
      {
        owner: input.templateOwner,
        name: input.name,
        private: true,
        git_content: true,
      },
    );
    return { id: data.id, fullName: `${data.owner.login}/${data.name}` };
  }

  async grantWriteAccess(input: { repo: string; login: string }): Promise<void> {
    const { owner, repo: name } = GiteaValidationClientImpl.parseRepo(input.repo);
    await this.api('PUT', `/repos/${owner}/${name}/collaborators/${encodeURIComponent(input.login)}`, {
      permission: 'write',
    });
  }

  async protectBranch(input: { repo: string; branch: string }): Promise<void> {
    const { owner, repo: name } = GiteaValidationClientImpl.parseRepo(input.repo);
    await this.api(
      'POST',
      `/repos/${owner}/${name}/branch_protections`,
      {
        rule_name: `protect-${input.branch}`,
        branch_name: input.branch,
        enable_push: true,
        enable_push_whitelist: true,
        push_whitelist_usernames: [],
        enable_force_push: true,
        enable_force_push_allowlist: true,
        force_push_allowlist_usernames: [],
      },
    );
  }

  async createSubmissionRef(input: { repo: string; sourceSha: string; ref: string }): Promise<void> {
    const { owner, repo: name } = GiteaValidationClientImpl.parseRepo(input.repo);
    // Gitea's REST API only exposes GET on /git/refs, so the snapshot ref is
    // created by pushing it with the admin credentials (same effect, no API).
    const target = input.ref.startsWith('refs/') ? input.ref : `refs/heads/${input.ref}`;
    const login = await this.adminLogin();
    const basic = Buffer.from(`${login}:${this.adminToken}`).toString('base64');
    const directory = await mkdtemp(join(tmpdir(), 'phase0-ref-'));
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    };
    const git = (args: string[]) => execFileAsync('git', args, { cwd: directory, env, timeout: 60_000 });
    try {
      await git(['init', '--quiet']);
      await git(['remote', 'add', 'origin', `${this.baseUrl}/${owner}/${name}.git`]);
      await git(['fetch', '--quiet', 'origin', 'main']);
      await git(['push', '--quiet', 'origin', `${input.sourceSha}:${target}`]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private adminLoginCache?: string;

  /** Login name of the admin account that owns `adminToken`, resolved once. */
  private async adminLogin(): Promise<string> {
    if (!this.adminLoginCache) {
      const user = await this.api<{ login: string }>('GET', '/user');
      this.adminLoginCache = user.login;
    }
    return this.adminLoginCache;
  }

  async createPullRequest(input: { repo: string; head: string; base: string }): Promise<{ number: number }> {
    const { owner, repo: name } = GiteaValidationClientImpl.parseRepo(input.repo);
    const data = await this.api<{ number: number }>(
      'POST',
      `/repos/${owner}/${name}/pulls`,
      {
        title: `Phase 0 validation: ${input.head} -> ${input.base}`,
        body: 'Created by the Phase 0 technical validation harness.',
        head: input.head,
        base: input.base,
      },
    );
    return { number: data.number };
  }

  async addComment(input: { repo: string; number: number; body: string; inline?: { path: string; line: number } }): Promise<void> {
    const { owner, repo: name } = GiteaValidationClientImpl.parseRepo(input.repo);
    if (!input.inline) {
      await this.api('POST', `/repos/${owner}/${name}/issues/${input.number}/comments`, { body: input.body });
      return;
    }
    const pr = await this.api<{ number: number }>('GET', `/repos/${owner}/${name}/pulls/${input.number}`);
    const headSha = (await this.api<{ head: string; base: string }>('GET', `/repos/${owner}/${name}/pulls/${pr.number}`)) as unknown;
    // Inline review comments require the head commit and a path/line within the
    // PR diff. We fetch the first file of the diff to anchor the comment.
    const diff = await this.api<{ files?: Array<{ filename: string }> }>(
      'GET',
      `/repos/${owner}/${name}/pulls/${pr.number}/files`,
    );
    const file = diff.files?.[0];
    if (!file) {
      throw new Error('cannot add inline comment: PR has no changed files');
    }
    await this.api(
      'POST',
      `/repos/${owner}/${name}/pulls/${pr.number}/reviews`,
      {
        event: 'comment',
        comments: [
          {
            body: input.body,
            path: input.inline.path ?? file.filename,
            new_position: input.inline.line ?? 1,
          },
        ],
      },
    );
    void headSha;
  }
}

/**
 * Browserless OAuth2 flow against Gitea's own OAuth2 application endpoints.
 *
 * Sequence (matches Gitea's web UI):
 *   1. GET /user/signin?open_id=...&state=...&nonce=...  -> grab CSRF token + cookies
 *   2. POST /user/signin  (user_name, password, _csrf)
 *   3. POST /login/oauth/grant (client_id, state, scope, nonce, redirect_uri, granted=true)
 *   4. final 302 Location carries ?code=...
 *
 * The flow keeps session cookies per username so the same user can be
 * authorized twice (used to prove subject stability across logins).
 */
class GiteaOAuthFlow implements OAuthFlow {
  private readonly client: GiteaValidationClientImpl;
  private readonly cookies = new Map<string, string>();

  constructor(client: GiteaValidationClientImpl) {
    this.client = client;
  }

  private cookieHeader(username: string): string {
    return this.cookies.get(username) ?? '';
  }

  private storeCookies(username: string, headers: Headers): void {
    const setCookies = headers.getSetCookie?.() ?? [];
    for (const raw of setCookies) {
      const pair = raw.split(';')[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq > 0) {
        this.cookies.set(username + ':' + pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    }
  }

  signInUrl(state: string, nonce: string): string {
    return (this.client as GiteaValidationClientImpl).getOAuthAuthorizeUrl(state).replace(
      /\/login\/oauth\/authorize.*/,
      `/user/signin?open_id=authorize_oauth&state=${encodeURIComponent(state)}&nonce=${encodeURIComponent(nonce)}`,
    );
  }

  async signIn(input: { state: string; nonce: string; username: string; password: string }): Promise<string> {
    const client = this.client as GiteaValidationClientImpl;
    const url = this.signInUrl(input.state, input.nonce);
    const res = await fetch(url, { redirect: 'manual', headers: { cookie: this.cookieHeader(input.username) } });
    this.storeCookies(input.username, res.headers);
    const html = await res.text();
    const csrf = /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? /_csrf":\s*"([^"]+)"/.exec(html)?.[1];
    if (!csrf) {
      throw new Error(`oauth signin: could not find CSRF token (status ${res.status})`);
    }
    const form = new URLSearchParams();
    form.set('user_name', input.username);
    form.set('password', input.password);
    form.set('_csrf', csrf);
    form.set('open_id', 'authorize_oauth');
    form.set('state', input.state);
    form.set('nonce', input.nonce);
    const signinRes = await fetch(`${client.giteaBaseUrl}/user/signin`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: this.cookieHeader(input.username) },
      body: form.toString(),
    });
    this.storeCookies(input.username, signinRes.headers);
    return signinRes.headers.get('location') ?? '';
  }

  async authorize(input: { state: string; nonce: string; redirectUri: string; username: string; password: string }): Promise<string> {
    const client = this.client as GiteaValidationClientImpl;
    await this.signIn(input);
    const form = new URLSearchParams();
    form.set('granted', 'true');
    form.set('state', input.state);
    form.set('nonce', input.nonce);
    form.set('redirect_uri', input.redirectUri);
    const res = await fetch(`${client.giteaBaseUrl}/login/oauth/grant`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: this.cookieHeader(input.username) },
      body: form.toString(),
    });
    this.storeCookies(input.username, res.headers);
    const location = res.headers.get('location') ?? '';
    if (!location) {
      throw new Error(`oauth authorize: expected redirect, got status ${res.status}`);
    }
    return location;
  }

  async exchangeCode(code: string): Promise<string> {
    const client = this.client as GiteaValidationClientImpl;
    const opts = (client as unknown as { oauthClientId: string; oauthRedirectUri: string });
    const res = await fetch(`${client.giteaBaseUrl}/login/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: opts.oauthClientId,
        client_secret: '',
        code,
        grant_type: 'authorization_code',
        redirect_uri: opts.oauthRedirectUri,
      }),
    });
    if (!res.ok) {
      throw new Error(`oauth code exchange failed: ${res.status}`);
    }
    const token = (await res.json()) as { access_token: string };
    return token.access_token;
  }

  async userInfo(accessToken: string): Promise<{ sub: string; preferred_username: string }> {
    const client = this.client as GiteaValidationClientImpl;
    const res = await fetch(`${client.giteaBaseUrl}/login/oauth/userinfo`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`userinfo failed: ${res.status}`);
    }
    const info = (await res.json()) as { sub: string; preferred_username: string };
    return { sub: info.sub, preferred_username: info.preferred_username };
  }
}
