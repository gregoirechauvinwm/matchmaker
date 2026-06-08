// scripts/migrate-ratings.js
// Photo-rating feature ([RATE_PHOTOS], the twin of [SEND_PAYMENT]).
// Creates the five tables that back it. Run once: npm run migrate:ratings.
// Idempotent (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS).
//
//   rating_photos          the seeded pool, bucketed by gender
//   rating_sessions        ONE per user; the source of truth for "done"
//   rating_session_photos  the frozen, shuffled, mixed photo list for a session
//   rating_links           disposable /rate/{token} entry points -> a session
//   ratings                the 1-5 scores
//
// Source of truth for completion is the SESSION (per user), not the link:
// several cards can be sent, each mints a fresh link, but all resolve to the
// same resumable session. fulfillRating atomically claims completed_at once.

import { pool } from '../src/db/pool.js';

async function main() {
  // --- the pool of photos to rate, bucketed by gender ----------------------
  // gender_bucket matches the values mapGenderPrefs() produces in onboarding:
  // 'male' | 'female' | 'nonbinary'. position orders photos within a bucket.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rating_photos (
      id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      gender_bucket text        NOT NULL CHECK (gender_bucket IN ('male','female','nonbinary')),
      url           text        NOT NULL,
      position      integer     NOT NULL DEFAULT 0,
      is_active     boolean     NOT NULL DEFAULT true,
      created_at    timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rating_photos_bucket ON rating_photos (gender_bucket) WHERE is_active`);

  // --- one rating session per user (source of truth for completion) --------
  // buckets is snapshotted from the user's gender_pref at creation, so the
  // photo set can't shift if they later change preferences. completed_at is
  // claimed exactly once (the fire-once guard, like payment_links.paid_at).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rating_sessions (
      id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       uuid        NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      buckets       text[]      NOT NULL,
      completed_at  timestamptz,
      created_at    timestamptz NOT NULL DEFAULT now()
    )
  `);

  // --- the frozen, shuffled, mixed photo list for a session ----------------
  // Written ONCE at session creation: we shuffle the selected buckets' active
  // photos with a per-session order and store that order as position. Resume
  // and completion both read from THIS list, so the order is stable regardless
  // of later pool changes. This is what makes multi-gender mixing compatible
  // with "resume where you left off".
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rating_session_photos (
      session_id  uuid        NOT NULL REFERENCES rating_sessions(id) ON DELETE CASCADE,
      photo_id    uuid        NOT NULL REFERENCES rating_photos(id),
      position    integer     NOT NULL,
      PRIMARY KEY (session_id, photo_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rsp_session_pos ON rating_session_photos (session_id, position)`);

  // --- disposable entry tokens (twin of payment_links) ---------------------
  // Each [RATE_PHOTOS] send mints one; all of a user's links point at their one
  // session. /rate/{token} resolves token -> session without exposing user ids.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rating_links (
      token       text        PRIMARY KEY,
      user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id  uuid        NOT NULL REFERENCES rating_sessions(id) ON DELETE CASCADE,
      created_at  timestamptz NOT NULL DEFAULT now(),
      expires_at  timestamptz NOT NULL DEFAULT now() + interval '7 days'
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rating_links_user ON rating_links (user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rating_links_session ON rating_links (session_id)`);

  // --- the scores (1-5 per photo, per session) -----------------------------
  // UNIQUE (session_id, photo_id): re-scoring a photo UPDATES rather than
  // duplicating. Progress = count(ratings) vs count(rating_session_photos).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ratings (
      id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id  uuid        NOT NULL REFERENCES rating_sessions(id) ON DELETE CASCADE,
      photo_id    uuid        NOT NULL REFERENCES rating_photos(id),
      score       integer     NOT NULL CHECK (score BETWEEN 1 AND 5),
      rated_at    timestamptz NOT NULL DEFAULT now(),
      UNIQUE (session_id, photo_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ratings_session ON ratings (session_id)`);

  console.log('ratings migration complete (rating_photos, rating_sessions, rating_session_photos, rating_links, ratings).');
  await pool.end();
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
