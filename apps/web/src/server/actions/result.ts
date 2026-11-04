import { ForbiddenError } from '@crunch/authz';
import { CryptoError } from '@crunch/crypto';
import { NotFoundError, ValidationError } from '../services/types';

export type ActionResult<T = undefined> =
  { ok: true; data: T } | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

/** Convert known domain errors into a serializable result. Unknown errors are logged without details. */
export async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    if (err instanceof ValidationError)
      return { ok: false, error: err.message, fieldErrors: err.fieldErrors };
    if (err instanceof ForbiddenError)
      return { ok: false, error: "You don't have permission to do that." };
    if (err instanceof NotFoundError) return { ok: false, error: err.message };
    if (err instanceof CryptoError) {
      console.error('[credentials] decryption error', err.message);
      return { ok: false, error: 'Stored credential could not be decrypted. Re-enter it.' };
    }
    // Avoid logging error objects that might carry request payloads (secrets).
    console.error('[action] unexpected error', err instanceof Error ? err.name : typeof err);
    return { ok: false, error: 'Something went wrong. Please try again.' };
  }
}
