// scripts/migrate-payment-amount.js
// Adds amount_cents + tokens to payment_links so we can report revenue by
// capture date. Historical rows (paid before this deploy) will have NULL
// amount_cents and are excluded from revenue sums - the revenue chart is
// accurate from this point forward. Run once: npm run migrate:payment-amount.
// Idempotent.
import { pool } from '../src/db/pool.js';

async function main() {
  await pool.query(`ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS amount_cents integer`);
  await pool.query(`ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS tokens integer`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payment_links_paid_at ON payment_links (paid_at) WHERE paid_at IS NOT NULL`);
  console.log('payment-amount migration complete.');
  await pool.end();
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
