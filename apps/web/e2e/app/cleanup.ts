/**
 * Delete the Clerk users and organizations recorded by the last app-suite run, for when the run
 * died before its teardown project (CI uses it in an `if: cancelled() || failure()` step).
 * Deletes only what the run file lists, after checking each id carries the run id.
 *
 *   pnpm exec tsx apps/web/e2e/app/cleanup.ts
 */
import fs from 'node:fs';
import { STATE_FILE } from './support/env';
import { deleteRunData, readRunState } from './support/run-state';

if (!fs.existsSync(STATE_FILE)) {
  console.log('No e2e run state: nothing to clean up.');
} else {
  const state = readRunState();
  const res = await deleteRunData(state);
  console.log(`Run ${state.runId}: deleted ${res.users} user(s) and ${res.orgs} organization(s).`);
}
