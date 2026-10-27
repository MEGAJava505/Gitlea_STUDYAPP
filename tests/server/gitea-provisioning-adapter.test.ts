import { afterEach, describe, expect, it, vi } from 'vitest';
import { GiteaProvisioningAdapter } from '../../src/server/ports/gitea-provisioning';

afterEach(() => vi.unstubAllGlobals());

describe('GiteaProvisioningAdapter (Gitea 1.27.3 API)', () => {
  it('protects the default branch using rule_name and disables write bypasses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ rule_name: 'main' }, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new GiteaProvisioningAdapter({ baseUrl: 'https://git.example.com', token: 'synthetic-token' });
    await adapter.protectBranch({ repo: 'org/repo', branch: 'main' });
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload).toEqual({
      rule_name: 'main', enable_push: false, enable_push_whitelist: false,
      enable_force_push: false, enable_bypass_allowlist: false, enable_merge_whitelist: false,
    });
  });
  it('redacts a token echoed by a transport failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed: synthetic-token')));
    const adapter = new GiteaProvisioningAdapter({ baseUrl: 'https://git.example.com', token: 'synthetic-token' });
    const error = await adapter.grantWriteAccess({ repo: 'org/repo', login: 'student' }).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('fetch failed: [REDACTED]');
  });

  it('redacts every literal token occurrence in errors and request logs', async () => {
    const token = 'synthetic.[token]+(value)';
    const logs: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(`bad ${token} again ${token}`, { status: 401 })));
    const adapter = new GiteaProvisioningAdapter({ baseUrl: 'https://git.example.com', token, log: (message) => logs.push(message) });
    const error = await adapter.grantWriteAccess({ repo: 'org/repo', login: token }).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Gitea API error (401): bad [REDACTED] again [REDACTED]');
    expect(logs.join(' ')).not.toContain(token);
  });

  it('accepts the empty HTTP 204 collaborator update response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new GiteaProvisioningAdapter({ baseUrl: 'https://git.example.com', token: 'synthetic-token' });

    await expect(adapter.grantWriteAccess({ repo: 'org/repo', login: 'student' })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith('https://git.example.com/api/v1/repos/org/repo/collaborators/student', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ permission: 'write' }),
    }));
  });
});
