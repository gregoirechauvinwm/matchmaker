// scripts/migrate-token-count.js
// Adds users.token_count (date tokens owned). Incremented by payment (Step 3).
// Run once: npm run migrate:token-count. Idempotent.
import { pool } from '../src/db/pool.js';
async function main() {
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS token_count integer NOT NULL DEFAULT 0`);
  console.log('token-count migration complete.');
  await pool.end();
}
main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
