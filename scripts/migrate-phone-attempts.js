// scripts/migrate-phone-attempts.js
// Funnel top-of-funnel tracking, keyed on an ANONYMOUS per-browser visit id
// (cookie set when the phone page loads). One row per browser gives three steps
// without any pre-verification identity guesswork:
//   - "Visited"      = a visit row exists (landed on the phone page)
//   - "Phone number" = phone_e164 set (entered a number; deduped per browser)
//   - "Verif code"   = the user later verified (from the users table)
//
// Supersedes the earlier phone-keyed `phone_attempts` table (dev-only).
//
// Backfill: existing verified users get a synthetic visit row so historical
// funnel data stays consistent. To avoid double-counting a user who ALSO has a
// real cookie visit row carrying their phone, we only backfill users whose
// phone isn't already present in visits. Run once:
//   npm run migrate:phone-attempts   (idempotent)
import { pool } from '../src/db/pool.js';

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS visits (
      visit_id         text PRIMARY KEY,
      first_seen_at    timestamptz NOT NULL DEFAULT now(),
      phone_e164       text,
      phone_entered_at timestamptz
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_visits_first_seen ON visits (first_seen_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_visits_phone_entered ON visits (phone_entered_at) WHERE phone_entered_at IS NOT NULL`);
  // Helps the "does this phone already have a visit row" check during backfill.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_visits_phone ON visits (phone_e164) WHERE phone_e164 IS NOT NULL`);

  // Fold in old dev-only phone_attempts rows, if present.
  const hasOld = await pool.query(`SELECT to_regclass('public.phone_attempts') AS t`);
  if (hasOld.rows[0].t) {
    await pool.query(`
      INSERT INTO visits (visit_id, first_seen_at, phone_e164, phone_entered_at)
      SELECT 'legacy:' || phone_e164, first_seen_at, phone_e164, first_seen_at
        FROM phone_attempts
      ON CONFLICT (visit_id) DO NOTHING
    `);
    await pool.query(`DROP TABLE phone_attempts`);
    console.log('Folded legacy phone_attempts into visits and dropped it.');
  }

  // Backfill verified users as visits-that-entered-a-phone, but ONLY when their
  // phone isn't already represented by a real visit row (avoids double-count).
  const res = await pool.query(`
    INSERT INTO visits (visit_id, first_seen_at, phone_e164, phone_entered_at)
    SELECT 'user:' || u.id::text, u.created_at, u.phone_e164, u.created_at
      FROM users u
     WHERE u.phone_e164 NOT IN (SELECT phone_e164 FROM visits WHERE phone_e164 IS NOT NULL)
    ON CONFLICT (visit_id) DO NOTHING
  `);
  console.log(`visits ready. Backfilled ${res.rowCount} existing user(s).`);
  await pool.end();
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
