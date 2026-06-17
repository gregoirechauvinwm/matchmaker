// scripts/migrate-rsvp-lines.js
// Adds the RSVP / no-show-fee scripted lines to app_config (twin of the payment
// and rate ones):
//   rsvp_prompt   - the message sent with the RSVP card ([SEND_RSVP])
//   rsvp_success  - the message after the user saves their card (spot confirmed)
// Run once: npm run migrate:rsvp-lines. Idempotent.
import { pool } from '../src/db/pool.js';
async function main() {
  await pool.query(`ALTER TABLE app_config ADD COLUMN IF NOT EXISTS rsvp_prompt text NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE app_config ADD COLUMN IF NOT EXISTS rsvp_success text NOT NULL DEFAULT ''`);
  // Seed sensible defaults if empty (match the in-code fallbacks).
  await pool.query(
    `UPDATE app_config
        SET rsvp_prompt = COALESCE(NULLIF(rsvp_prompt,''), $1),
            rsvp_success = COALESCE(NULLIF(rsvp_success,''), $2)
      WHERE id = 1`,
    [
      "Your date is set! Confirm your spot below — it's free, we just need a card on file for the cancellation policy.",
      "You're all set — your spot is confirmed. See you Tuesday!",
    ]
  );
  console.log('rsvp-lines migration complete.');
  await pool.end();
}
main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
