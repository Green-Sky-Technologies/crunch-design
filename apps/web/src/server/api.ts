/** Helpers for JSON route handlers: auth and domain-error mapping. */
import 'server-only';
import { ForbiddenError } from '@crunch/authz';
import { NextResponse } from 'next/server';
import { getActor } from './context';
import { ConflictError, LockedError } from './services/design-docs';
import { NotFoundError, ValidationError, type Actor } from './services/types';

export class UnauthorizedError extends Error {
  override name = 'UnauthorizedError';
}

/** Route-handler variant of requireActor: throws instead of redirecting. */
export async function apiActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new UnauthorizedError('Sign in and select a workspace');
  return actor;
}

export function apiError(err: unknown): NextResponse {
  if (err instanceof UnauthorizedError)
    return NextResponse.json({ error: 'unauthorized', message: err.message }, { status: 401 });
  if (err instanceof ForbiddenError)
    return NextResponse.json(
      { error: 'forbidden', message: "You don't have permission to do that." },
      { status: 403 },
    );
  if (err instanceof NotFoundError)
    return NextResponse.json({ error: 'not_found', message: err.message }, { status: 404 });
  if (err instanceof ConflictError)
    return NextResponse.json(
      { error: 'conflict', message: err.message, version: err.currentVersion },
      { status: 409 },
    );
  if (err instanceof LockedError)
    return NextResponse.json(
      { error: 'locked', message: err.message, holder: err.holderUserId },
      { status: 423 },
    );
  if (err instanceof ValidationError)
    return NextResponse.json(
      { error: 'invalid', message: err.message, fieldErrors: err.fieldErrors },
      { status: 400 },
    );
  console.error(
    '[api] unexpected error',
    err instanceof Error ? `${err.name}: ${err.message}` : typeof err,
  );
  return NextResponse.json({ error: 'internal', message: 'Something went wrong' }, { status: 500 });
}

/** Parse a JSON body with a size cap (doc transactions can be large, but not unbounded). */
export async function jsonBody(req: Request, maxBytes = 4 * 1024 * 1024): Promise<unknown> {
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > maxBytes) throw new ValidationError('Request body too large');
  const text = await req.text();
  if (text.length > maxBytes) throw new ValidationError('Request body too large');
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError('Invalid JSON');
  }
}
