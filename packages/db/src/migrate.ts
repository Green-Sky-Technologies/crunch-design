import { runMigrations } from './admin';

await runMigrations(process.env.DATABASE_URL ?? 'postgres://crunch:crunch@localhost:5433/crunch');
console.log('migrations applied');
