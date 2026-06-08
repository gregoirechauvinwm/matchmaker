// scripts/migrate-payment-links.js
// Maps an obscure random token -> user, so /pay/{token} resolves to the right
// user without exposing user ids. Created when [SEND_PAYMENT] fires.
// Run once: npm run migrate:payment-links. Idempotent.
import { pool } from '../src/db/pool.js';
async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_links (
      token       text        PRIMARY KEY,
      user_id     uuid        NOT NULL REFERENCES users(id),
      created_at  timestamptz NOT NULL DEFAULT now(),
      expires_at  timestamptz NOT NULL DEFAULT now() + interval '7 days',
      paid_at     timestamptz
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payment_links_user ON payment_links (user_id)`);
  console.log('payment-links migration complete.');
  await pool.end();
}
main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
