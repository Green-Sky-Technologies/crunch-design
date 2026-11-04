import type { Role } from '@crunch/authz';
import type { Workspace } from '@crunch/db';

/** The authenticated caller, resolved once per request. */
export interface Actor {
  userId: string;
  role: Role;
  workspace: Workspace;
}

export class NotFoundError extends Error {
  override name = 'NotFoundError';
}

export class ValidationError extends Error {
  override name = 'ValidationError';
  constructor(
    message: string,
    public readonly fieldErrors: Record<string, string[]> = {},
  ) {
    super(message);
  }
}
