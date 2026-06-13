// scripts/migrate-applied-at.js
// Adds users.applied_at: set when a user clicks "Apply now" on the welcome /
// landing step to proceed into onboarding. Powers the funnel's "Applied" step
// (the welcome-screen -> started-form conversion), which only exists in flows
// that have the welcome screen (v2+).
//
// No backfill: users who predate the welcome screen never had this event, so
// applied_at stays null for them (honest - they're not counted as "applied").
//
// Idempotent. Run: npm run migrate:applied-at
import { pool } from '../src/db/pool.js';

async function main() {
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS applied_at timestamptz`);
  console.log('applied-at migration complete (users.applied_at).');
  await pool.end();
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
