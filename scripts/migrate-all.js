// scripts/migrate-all.js
// Runs every idempotent migration in dependency order, as the single migration
// step of a deploy:  npm run migrate:all
//
// This does NOT run:
//   - init-db.js  (the one-time base-schema bootstrap; run once on a fresh DB)
//   - seed-*.js   (deliberate one-off data seeding; run when you intend to)
//
// Each migration uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS, so running this
// repeatedly is safe. Order matters where a later migration depends on an
// earlier table/column existing.
//
// FIRST-TIME SETUP on a brand-new database (run once, in this order):
//   npm run db:init            # base schema
//   npm run migrate:all        # all migrations below
//   npm run seed:prompts       # starter prompts
//   npm run seed:tasks         # starter tasks
//   npm run seed:rating-photos # rating pool (after photos are in place)
//
// ROUTINE DEPLOYS: just `npm run migrate:all` before the new version takes
// traffic. It applies any new schema changes and no-ops on already-applied ones.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Ordered list of migration scripts. Keep this in dependency order; append new
// migrations to the end as you add them.
//
// NOTE: migrate-task-types.js is intentionally NOT here. It is a one-time
// historical conversion (old `tasks` table -> `task_types`) that only applies
// to databases predating the task_types/tasks split. The current schema.sql
// already creates both tables in their final form, so on any fresh db:init that
// migration's guard correctly refuses to run. Do not add it to this list.
const MIGRATIONS = [
  'migrate-tokens.js',
  'migrate-profile.js',
  'migrate-initial-thought.js',
  'migrate-result-seq.js',
  'migrate-result-task.js',
  'migrate-app-config.js',
  'migrate-task-instances.js',
  'migrate-token-count.js',
  'migrate-scripted-lines.js',
  'migrate-payment-links.js',
  'migrate-ratings.js',
  'migrate-rate-lines.js',
  'migrate-user-archive.js',
  'migrate-neighborhood.js',
];

function run(script) {
  return new Promise((resolve, reject) => {
    const path = join(__dirname, script);
    const child = spawn(process.execPath, [path], { stdio: 'inherit' });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

async function main() {
  console.log(`Running ${MIGRATIONS.length} migrations in order...\n`);
  for (const m of MIGRATIONS) {
    console.log(`--- ${m} ---`);
    await run(m);
    console.log('');
  }
  console.log('All migrations complete.');
}

main().catch((err) => {
  console.error('\nMigration chain failed:', err.message);
  process.exit(1);
});
