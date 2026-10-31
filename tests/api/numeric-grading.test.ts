import { beforeEach, describe, expect, it } from 'vitest';
import { GET, PATCH } from '../../src/app/api/v1/admin/numeric-grading/route';
import { configureServices, type AppServices } from '../../src/server/auth-context';
import { IdentityServiceImpl } from '../../src/domain/identity';
import { GradingService } from '../../src/domain/grading/service';
import type { Role } from '../../src/shared/contracts';
import { InMemoryAuditRepository, InMemoryRoleRepository, InMemorySessionRepository, makeAuditWriter, makeSessionStore, uid } from '../domain/fakes';

let services: AppServices;
let tokens: Partial<Record<Role, string>>;
let settings: Map<string, unknown>;

beforeEach(async () => {
  const roles: Role[] = ['admin', 'owner', 'teacher', 'student'];
  const now = () => 1000;
  const repo = new InMemoryRoleRepository({
    users: roles.map(role => ({ id: uid(role), login: role, email: `${role}@example.test`, displayName: role })),
    roles: roles.map(role => ({ userId: uid(role), role })),
  });
  const audit = makeAuditWriter(new InMemoryAuditRepository(), now);
  const identities = new IdentityServiceImpl({ roles: repo, audit });
  const sessions = makeSessionStore(new InMemorySessionRepository(), now);
  tokens = {};
  for (const role of roles) tokens[role] = (await sessions.create({ userId: uid(role), login: role, displayName: role, roles: [role] }, 60000)).token;
  settings = new Map();
  const grading = new GradingService({
    settings: { get: async key => settings.has(key) ? { id: key, key, value: settings.get(key), updatedAt: now() } : null, set: async (key, value) => { settings.set(key, value); } },
    reviews: { getLatestActiveReview: async () => null, listReviewsForReview: async () => [] },
    audit, now,
  });
  services = { sessions, identities, audit, grading };
  configureServices(services);
});

function request(method: string, role?: Role, body?: unknown): Request {
  return new Request('http://localhost/api/v1/admin/numeric-grading', {
    method, headers: role ? { cookie: `session=${tokens[role]}` } : {},
    body: method === 'PATCH' ? JSON.stringify(body) : undefined,
  });
}

describe('admin numeric grading setting', () => {
  it('defaults off and persists enabling and disabling', async () => {
    expect(await (await GET(request('GET', 'admin'))).json()).toEqual({ enabled: false });
    for (const enabled of [true, false]) {
      const response = await PATCH(request('PATCH', 'admin', { enabled }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ enabled });
      expect(settings.get('numeric_grading.enabled')).toEqual({ enabled });
      expect(await (await GET(request('GET', 'admin'))).json()).toEqual({ enabled });
    }
  });

  it('allows owner under existing admin role conventions', async () => {
    expect((await GET(request('GET', 'owner'))).status).toBe(200);
    expect((await PATCH(request('PATCH', 'owner', { enabled: true }))).status).toBe(200);
  });

  it.each([undefined, 'student', 'teacher'] as const)('rejects unauthorized role %s before changing state', async role => {
    for (const handler of [GET, PATCH]) {
      const response = await handler(request(handler === GET ? 'GET' : 'PATCH', role, { enabled: true }));
      expect(response.status).toBe(role ? 403 : 401);
    }
    expect(settings.size).toBe(0);
  });

  it.each([{}, null, [], { enabled: 'true' }, { enabled: 1 }, { enabled: null }])('rejects nonboolean input %j', async body => {
    expect((await PATCH(request('PATCH', 'admin', body))).status).toBe(400);
    expect(settings.size).toBe(0);
  });

  it('rejects malformed JSON', async () => {
    const req = new Request('http://localhost/api/v1/admin/numeric-grading', { method: 'PATCH', headers: { cookie: `session=${tokens.admin}` }, body: '{' });
    expect((await PATCH(req)).status).toBe(400);
  });

  it('returns unavailable when grading service is absent', async () => {
    configureServices({ ...services, grading: undefined });
    expect((await GET(request('GET', 'admin'))).status).toBe(503);
    expect((await PATCH(request('PATCH', 'admin', { enabled: true }))).status).toBe(503);
    expect((await GET(request('GET'))).status).toBe(401);
  });
});
