// scripts/migrate-rate-lines.js
// Adds the photo-rating scripted lines to app_config (twin of the payment ones):
//   rate_prompt   - the message sent with the rating card ([RATE_PHOTOS])
//   rate_success  - the message after the user finishes rating
// Run once: npm run migrate:rate-lines. Idempotent.
import { pool } from '../src/db/pool.js';
async function main() {
  await pool.query(`ALTER TABLE app_config ADD COLUMN IF NOT EXISTS rate_prompt text NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE app_config ADD COLUMN IF NOT EXISTS rate_success text NOT NULL DEFAULT ''`);
  // Seed sensible defaults if empty.
  await pool.query(
    `UPDATE app_config
        SET rate_prompt = COALESCE(NULLIF(rate_prompt,''), $1),
            rate_success = COALESCE(NULLIF(rate_success,''), $2)
      WHERE id = 1`,
    [
      'Your physical preferences',
      "Thanks! That really helps me understand your type. Ready to keep going?",
    ]
  );
  console.log('rate-lines migration complete.');
  await pool.end();
}
main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
