// scripts/migrate-neighborhood.js
// Adds users.neighborhood for the "Where do you live" onboarding step.
// Run once: npm run migrate:neighborhood. Idempotent (IF NOT EXISTS).
import { pool } from '../src/db/pool.js';

async function main() {
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS neighborhood text`);
  console.log('neighborhood column added (if not already present).');
  await pool.end();
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
