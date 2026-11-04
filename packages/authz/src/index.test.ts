import { describe, expect, it } from 'vitest';
import { assertCan, can, ForbiddenError, PERMISSIONS, roleFromClerk } from './index';

describe('role matrix', () => {
  it('viewers are strictly view-only but can run deterministic exports', () => {
    expect(can('viewer', 'project:read')).toBe(true);
    expect(can('viewer', 'export:deterministic')).toBe(true);
    for (const p of [
      'design:edit',
      'design:comment',
      'agent:run',
      'export:llm',
      'project:create',
      'share:manage',
    ] as const) {
      expect(can('viewer', p), p).toBe(false);
    }
  });

  it('editors cannot manage members or credentials', () => {
    expect(can('editor', 'agent:run')).toBe(true);
    expect(can('editor', 'workspace:manage_credentials')).toBe(false);
    expect(can('editor', 'workspace:manage_members')).toBe(false);
  });

  it('admins have every permission', () => {
    for (const p of PERMISSIONS) expect(can('admin', p), p).toBe(true);
  });

  it('maps Clerk roles, defaulting unknown roles to viewer', () => {
    expect(roleFromClerk('org:admin')).toBe('admin');
    expect(roleFromClerk('org:member')).toBe('editor');
    expect(roleFromClerk('org:editor')).toBe('editor');
    expect(roleFromClerk('org:viewer')).toBe('viewer');
    expect(roleFromClerk('org:billing')).toBe('viewer');
    expect(roleFromClerk(undefined)).toBe('viewer');
  });

  it('assertCan throws ForbiddenError', () => {
    expect(() => assertCan('viewer', 'design:edit')).toThrow(ForbiddenError);
  });
});
