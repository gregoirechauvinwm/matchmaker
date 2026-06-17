// scripts/migrate-payment-kind.js
// Adds payment_links.kind to distinguish how a "paid" link was satisfied:
//   'token'     - paid upfront for date token(s) via the original paywall
//   'rsvp_card' - saved a card (SetupIntent) to authorize the $30 no-show fee
// Both count as "paid" in the funnel; dashboards can group by kind.
// Existing rows are backfilled to 'token' (the only mechanic before RSVP).
// Idempotent. Run: npm run migrate:payment-kind
import { pool } from '../src/db/pool.js';

async function main() {
  await pool.query(`ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS kind text`);
  const res = await pool.query(`UPDATE payment_links SET kind = 'token' WHERE kind IS NULL`);
  console.log(`payment-kind migration complete. Backfilled ${res.rowCount} row(s) to 'token'.`);
  await pool.end();
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
