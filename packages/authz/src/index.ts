/**
 * CrunchDesign roles and permissions. The only source of truth for what each role may do.
 *
 * Roles come from the Clerk organization role in the session:
 *   org:admin  -> admin
 *   org:editor -> editor   (custom Clerk role)
 *   org:viewer -> viewer   (custom Clerk role)
 *   org:member -> editor   (Clerk's built-in default; treated as editor)
 * Unknown roles map to viewer, the least privileged.
 */

export const ROLES = ['admin', 'editor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  // workspace
  'workspace:read',
  'workspace:manage_members',
  'workspace:manage_credentials',
  // projects & designs
  'project:read',
  'project:create',
  'project:update',
  'project:archive',
  'design:edit', // canvas edits, sliders, version restore
  'design:comment',
  // agent (spends the workspace key)
  'agent:run',
  // exports
  'export:deterministic', // HTML/ZIP, handoff bundle (no LLM)
  'export:llm', // React+Tailwind codegen, Figma push via agent
  'share:manage', // create/revoke share links
  // design systems
  'design_system:read',
  'design_system:edit',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const VIEWER: readonly Permission[] = [
  'workspace:read',
  'project:read',
  'design_system:read',
  'export:deterministic',
];

const EDITOR: readonly Permission[] = [
  ...VIEWER,
  'project:create',
  'project:update',
  'project:archive',
  'design:edit',
  'design:comment',
  'agent:run',
  'export:llm',
  'share:manage',
  'design_system:edit',
];

const ADMIN: readonly Permission[] = [
  ...EDITOR,
  'workspace:manage_members',
  'workspace:manage_credentials',
];

const MATRIX: Record<Role, ReadonlySet<Permission>> = {
  viewer: new Set(VIEWER),
  editor: new Set(EDITOR),
  admin: new Set(ADMIN),
};

export function can(role: Role, permission: Permission): boolean {
  return MATRIX[role].has(permission);
}

export function permissionsFor(role: Role): Permission[] {
  return [...MATRIX[role]];
}

export function roleFromClerk(orgRole: string | null | undefined): Role {
  switch (orgRole) {
    case 'org:admin':
      return 'admin';
    case 'org:editor':
    case 'org:member':
      return 'editor';
    case 'org:viewer':
      return 'viewer';
    default:
      return 'viewer';
  }
}

export class ForbiddenError extends Error {
  override name = 'ForbiddenError';
  constructor(public readonly permission: Permission) {
    super(`Missing permission: ${permission}`);
  }
}

export function assertCan(role: Role, permission: Permission): void {
  if (!can(role, permission)) throw new ForbiddenError(permission);
}
