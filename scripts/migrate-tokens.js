// scripts/migrate-tokens.js
// Adds token-count columns to prompt_results so the back-office completion panel
// can show token input/output. latency_ms already exists (duration).
// Run once:  npm run migrate:tokens
// Idempotent: uses IF NOT EXISTS, safe to re-run.

import { pool } from '../src/db/pool.js';

async function main() {
  await pool.query(`
    ALTER TABLE prompt_results
      ADD COLUMN IF NOT EXISTS prompt_tokens     integer,
      ADD COLUMN IF NOT EXISTS completion_tokens integer
  `);
  console.log('Added prompt_tokens and completion_tokens columns (if missing).');
  await pool.end();
  console.log('Done.');
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
