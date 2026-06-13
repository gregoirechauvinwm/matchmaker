// scripts/migrate-funnel-version.js
// Stamps each user with the funnel version they experienced, so the analytics
// dashboard can show per-version funnels (faithful to each version's step
// order/set) and a cross-version milestone view.
//
//   - users.funnel_version : the version id active when this row was created
//                            (set at first touch in /auth/visit). Never changes.
//   - Backfill existing users to 'v1' (the pre-versioning baseline).
//
// Idempotent. Run: npm run migrate:funnel-version
import { pool } from '../src/db/pool.js';

async function main() {
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS funnel_version text`);
  // Everyone who exists before versioning is the 'v1' baseline.
  const res = await pool.query(
    `UPDATE users SET funnel_version = 'v1' WHERE funnel_version IS NULL`
  );
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_funnel_version ON users (funnel_version)`);
  console.log(`funnel-version migration complete. Stamped ${res.rowCount} existing user(s) as 'v1'.`);
  await pool.end();
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
