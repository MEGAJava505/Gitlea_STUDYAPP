import { describe, expect, it } from 'vitest';
import { hasRolePermission } from '../../src/domain/permissions';
import type { Permission, Role } from '../../src/shared/contracts';

// Launch contract: infrastructure privileges do not grant student submission rights.
const cases: Array<[Permission, boolean, boolean, boolean, boolean]> = [
  ['session:read', true, true, true, true],
  ['identity:read', true, true, true, true],
  ['identity:list_roles', false, true, true, true],
  ['identity:grant_role', false, false, true, true],
  ['identity:revoke_role', false, false, true, true],
  ['assignment:read', true, true, true, true],
  ['assignment:submit', true, false, false, false],
  ['assignment:review', false, true, true, true],
  ['submission:read', true, true, true, true],
  ['audit:read', false, false, true, true],
];
const roles: Role[] = ['student', 'teacher', 'admin', 'owner'];

describe('Phase 7 launch role matrix', () => {
  it.each(cases)('%s follows the four-role launch contract', (permission, ...allowed) => {
    roles.forEach((role, index) => {
      expect(hasRolePermission([role], permission), `${role}: ${permission}`).toBe(allowed[index]);
    });
    expect(hasRolePermission([], permission)).toBe(false);
  });

  it('combines explicitly granted roles without inheriting owner privileges', () => {
    expect(hasRolePermission(['student', 'teacher'], 'assignment:submit')).toBe(true);
    expect(hasRolePermission(['student', 'teacher'], 'assignment:review')).toBe(true);
    expect(hasRolePermission(['student', 'teacher'], 'identity:grant_role')).toBe(false);
    expect(hasRolePermission(['owner', 'student'], 'assignment:submit')).toBe(true);
  });
});
