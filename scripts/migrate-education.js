// scripts/migrate-education.js
// Adds users.education for the "education" onboarding step. The step already
// collects this value, but until now there was no column and the value was
// silently dropped on save. Run once: npm run migrate:education. Idempotent.
import { pool } from '../src/db/pool.js';

async function main() {
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS education text`);
  console.log('education column added (if not already present).');
  await pool.end();
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
