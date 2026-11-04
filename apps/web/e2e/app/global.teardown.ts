/**
 * Teardown project: delete the Clerk users and organizations this run created (only those; see
 * deleteRunData), then confirm none of them is left.
 */
import fs from 'node:fs';
import { expect, test as teardown } from '@playwright/test';
import { STATE_FILE } from './support/env';
import {
  clerkBackend,
  deleteRunData,
  emailFor,
  readRunState,
  type E2ERole,
} from './support/run-state';

teardown('delete this run’s Clerk users and organizations', async () => {
  teardown.setTimeout(120_000);
  if (!fs.existsSync(STATE_FILE)) return; // setup never got as far as creating anything
  const state = readRunState();
  await deleteRunData(state);

  const clerk = clerkBackend();
  const left = await clerk.users.getUserList({
    emailAddress: (Object.keys(state.users) as E2ERole[]).map((r) => emailFor(r, state.runId)),
  });
  expect(left.data.map((u) => u.id)).toEqual([]);
  const orgs = await clerk.organizations.getOrganizationList({ query: `e2e-${state.runId}` });
  expect(orgs.data.map((o) => o.slug)).toEqual([]);
  fs.rmSync(STATE_FILE); // done: the next setup has no leftovers to clean up
});
