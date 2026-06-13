// scripts/migrate-first-touch-identity.js
// STAGE 1 of the identity re-architecture: a user row now exists from FIRST
// TOUCH (phone-page load), identified by an anonymous id, with fields filling
// in progressively and phone repositionable to anywhere in the flow.
//
// Changes:
//   - users.anon_id   : anonymous id (from the mm_visit cookie) for the row
//                       that exists before phone is collected.
//   - users.status    : 'anonymous' (row exists, not yet phone-verified) |
//                       'verified' (phone confirmed). Lets the back-office
//                       filter out anonymous rows.
//   - users.phone_e164: made NULLABLE; uniqueness enforced only WHEN PRESENT
//                       via a partial unique index (was NOT NULL UNIQUE).
//   - Fold the `visits` table into users as anonymous rows (so funnel history
//     carries over). The `visits` table is LEFT IN PLACE this release as a
//     safety net; a later migration drops it.
//   - Backfill existing users: status='verified', anon_id='user:<id>'.
//
// Idempotent. Run: npm run migrate:first-touch-identity
import { pool } from '../src/db/pool.js';

async function main() {
  // 1. New columns.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS anon_id text`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS status text`);
  // When the user first submitted a phone number (entered, not necessarily
  // verified) - powers the funnel's "Phone number" step.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_entered_at timestamptz`);
  // The actual number they entered, stored even before/without verification.
  // Kept SEPARATE from phone_e164 (which stays reserved for the verified
  // identity and carries the unique constraint) so an unverified entry can't
  // collide with a verified user's number. Future no-verification flows can
  // promote phone_entered -> phone_e164 deliberately.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_entered text`);

  // 2. Backfill existing rows BEFORE relaxing constraints (they're all real,
  //    verified users). status='verified'; anon_id synthesized from their id.
  await pool.query(`UPDATE users SET status = 'verified' WHERE status IS NULL`);
  await pool.query(`UPDATE users SET anon_id = 'user:' || id::text WHERE anon_id IS NULL`);
  // Existing users obviously entered a phone; use created_at as the entry time.
  await pool.query(`UPDATE users SET phone_entered_at = created_at WHERE phone_entered_at IS NULL AND phone_e164 IS NOT NULL`);
  // Their verified number is also the number they entered.
  await pool.query(`UPDATE users SET phone_entered = phone_e164 WHERE phone_entered IS NULL AND phone_e164 IS NOT NULL`);

  // 3. Relax the phone constraint: drop NOT NULL, replace the column UNIQUE with
  //    a PARTIAL unique index (unique only when phone is present, so many
  //    anonymous rows can coexist with NULL phone).
  await pool.query(`ALTER TABLE users ALTER COLUMN phone_e164 DROP NOT NULL`);
  // The original column-level UNIQUE created an implicit constraint named
  // users_phone_e164_key. Drop it if present, then add the partial index.
  await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_phone_e164_key`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_users_phone_present
      ON users (phone_e164) WHERE phone_e164 IS NOT NULL
  `);

  // 4. anon_id should be unique + indexed (it's how we find the row pre-phone).
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_users_anon_id
      ON users (anon_id) WHERE anon_id IS NOT NULL
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_status ON users (status)`);

  // 5. Fold the visits table into users as anonymous rows, if visits exists.
  //    A visit becomes an anonymous user row (visit_id -> anon_id). If a visit
  //    already entered a phone that now matches a real user, skip it (that
  //    person is already represented). Visits with no match become anon rows.
  const hasVisits = await pool.query(`SELECT to_regclass('public.visits') AS t`);
  if (hasVisits.rows[0].t) {
    const res = await pool.query(`
      INSERT INTO users (anon_id, status, phone_e164, phone_verified_at, phone_entered_at, created_at, last_activity_at)
      SELECT v.visit_id, 'anonymous', NULL, NULL, v.phone_entered_at, v.first_seen_at, v.first_seen_at
        FROM visits v
       WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.anon_id = v.visit_id)
         AND (v.phone_e164 IS NULL
              OR NOT EXISTS (SELECT 1 FROM users u2 WHERE u2.phone_e164 = v.phone_e164))
      ON CONFLICT DO NOTHING
    `);
    console.log(`Folded ${res.rowCount} visit(s) into users as anonymous rows (visits table left in place).`);
  }

  console.log('first-touch-identity migration complete.');
  await pool.end();
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
