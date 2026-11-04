/** Creates (if needed) and migrates the integration-test database. */
import { ensureDatabase, runMigrations } from '@crunch/db/admin';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://crunch:crunch@localhost:5433/crunch_test';

export default async function setup() {
  await ensureDatabase(TEST_DB_URL);
  await runMigrations(TEST_DB_URL);
}
