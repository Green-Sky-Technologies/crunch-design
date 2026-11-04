/**
 * Setup project for the app suite: fetch a Clerk testing token, create this run's users and
 * organizations, then sign each role in once through the real UI and save its storage state
 * (Clerk session cookies, with the workspace org active) for the specs to reuse.
 */
import { clerk, clerkSetup } from '@clerk/testing/playwright';
import { expect, test as setup } from '@playwright/test';
import fs from 'node:fs';
import { clerkKeys, STATE_FILE, storageStatePath } from './support/env';
import {
  createRunData,
  deleteRunData,
  newRunId,
  readRunState,
  requireRunState,
  ROLES,
  type E2ERole,
} from './support/run-state';

setup.describe.configure({ mode: 'serial' });

setup('clerk testing token', async () => {
  clerkKeys(); // fail fast without development keys
  await clerkSetup();
});

setup('create users and workspaces', async () => {
  setup.setTimeout(120_000);
  // A previous run that died before its teardown: delete what it recorded first.
  if (fs.existsSync(STATE_FILE)) await deleteRunData(readRunState());
  const state = await createRunData(newRunId());
  expect(state.org?.slug).toContain(state.runId);
});

const ROLE_BADGE: Record<E2ERole, string> = {
  admin: 'admin',
  editor: 'editor',
  editor2: 'editor',
  viewer: 'viewer',
  outsider: 'admin',
};

for (const role of ROLES) {
  setup(`sign in ${role}`, async ({ browser }) => {
    setup.setTimeout(90_000);
    const state = requireRunState();
    const org = role === 'outsider' ? state.outsiderOrg : state.org;
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/');
    await clerk.signIn({ page, emailAddress: state.users[role].email });
    // Activate the workspace in the Clerk session, as the org switcher would.
    await page.evaluate((orgId) => window.Clerk.setActive({ organization: orgId }), org.id);
    await page.goto(`/w/${org.slug}`);
    await expect(page).toHaveURL(new RegExp(`/w/${org.slug}$`));
    await expect(
      page.getByRole('banner').getByText(ROLE_BADGE[role], { exact: true }),
    ).toBeVisible();
    await context.storageState({ path: storageStatePath(role) });
    await context.unrouteAll({ behavior: 'ignoreErrors' }); // quiet the testing-token routes
    await context.close();
  });
}
