import { afterEach, describe, expect, it, vi } from 'vitest';
import { GiteaValidationClientImpl } from '../../tools/gitea-validation/client';

afterEach(() => vi.unstubAllGlobals());

describe('Phase 0 template repository destination', () => {
  it('keeps the generated repository in the configured template fixture organization', async () => {
    const fetch = vi.fn(async () => Response.json({
      id: 42, owner: { login: 'isolated-validation' }, name: 'student-work',
    }, { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    const client = new GiteaValidationClientImpl({
      baseUrl: 'http://gitea.test', adminToken: 'synthetic-validation-token',
    });
    const created = await client.createRepositoryFromTemplate({
      templateOwner: 'isolated-validation', templateRepo: 'template', name: 'student-work',
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, request] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://gitea.test/api/v1/repos/isolated-validation/template/generate');
    expect(JSON.parse(String(request.body))).toEqual({
      owner: 'isolated-validation', name: 'student-work', private: true, git_content: true,
    });
    expect(created).toEqual({ id: 42, fullName: 'isolated-validation/student-work' });
  });
});
