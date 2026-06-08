// scripts/migrate-scripted-lines.js
// Adds the payment scripted lines to app_config (alongside flow_opener):
//   payment_prompt  - the message sent with the payment card ([SEND_PAYMENT])
//   payment_success - the message after a successful payment ({{tokens_purchased}})
// Run once: npm run migrate:scripted-lines. Idempotent.
import { pool } from '../src/db/pool.js';
async function main() {
  await pool.query(`ALTER TABLE app_config ADD COLUMN IF NOT EXISTS payment_prompt text NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE app_config ADD COLUMN IF NOT EXISTS payment_success text NOT NULL DEFAULT ''`);
  // Seed sensible defaults if empty.
  await pool.query(
    `UPDATE app_config
        SET payment_prompt = COALESCE(NULLIF(payment_prompt,''), $1),
            payment_success = COALESCE(NULLIF(payment_success,''), $2)
      WHERE id = 1`,
    [
      'Great, here is your link to secure your spot',
      "Payment successful! You've got {{tokens_purchased}} date token(s). Ready to keep going?",
    ]
  );
  console.log('scripted-lines migration complete.');
  await pool.end();
}
main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
