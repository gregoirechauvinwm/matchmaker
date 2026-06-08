// src/lib/ratings.js
// Photo-rating feature ([RATE_PHOTOS]) - the twin of payments.js.
//
// SOURCE OF TRUTH is the per-user rating_sessions row (its completed_at), NOT
// the link. Several [RATE_PHOTOS] cards can be sent; each mints a fresh
// /rate/{token} link, but all of a user's links resolve to the SAME resumable
// session. The session's photo list is shuffled and FROZEN at creation
// (rating_session_photos), so multi-gender mixing stays compatible with
// "resume where you left off" and "all photos scored = complete".

import { randomBytes } from 'node:crypto';
import { query, pool } from '../db/pool.js';
import { renderTemplate } from './template.js';
import { userContext } from './users.js';
import { getPublished } from './config-versions.js';

// --- gender buckets ---------------------------------------------------------
// gender_pref is stored already-normalized by onboarding to these values.
// Normalize defensively anyway (older/freeform rows), and de-dupe.
const VALID_BUCKETS = ['male', 'female', 'nonbinary'];

export function bucketsForPrefs(genderPref) {
  const raw = Array.isArray(genderPref) ? genderPref : (genderPref ? [genderPref] : []);
  const out = [];
  for (const item of raw) {
    const l = String(item).toLowerCase();
    let b = null;
    if (l.includes('non') && l.includes('binary')) b = 'nonbinary';
    else if (l.includes('female') || l.includes('women') || l.includes('woman')) b = 'female';
    else if (l.includes('male') || l.includes('men') || l.includes('man')) b = 'male';
    else if (VALID_BUCKETS.includes(l)) b = l;
    if (b && !out.includes(b)) out.push(b);
  }
  // Fallback: if we couldn't resolve anything, rate everyone.
  return out.length ? out : ['male', 'female', 'nonbinary'];
}

// Fisher-Yates shuffle (in place), returns the array.
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// --- find-or-create the user's session, freezing its shuffled photo list ----
// One session per user (UNIQUE user_id). On first creation we snapshot the
// buckets from the user's prefs and write the shuffled, mixed photo order into
// rating_session_photos. Returns the session row. Re-entrant: if the session
// already exists, returns it untouched (the frozen list and any scores stand).
export async function ensureSession(userId) {
  // Fast path: already have one.
  const existing = await query('SELECT * FROM rating_sessions WHERE user_id = $1', [userId]);
  if (existing.rows[0]) return existing.rows[0];

  // Resolve buckets from the user's stored preference.
  const profile = await query('SELECT gender_pref FROM users WHERE id = $1', [userId]);
  const buckets = bucketsForPrefs(profile.rows[0]?.gender_pref);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create the session (ON CONFLICT guards a race: two cards opened at once).
    const sess = await client.query(
      `INSERT INTO rating_sessions (user_id, buckets)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING
       RETURNING *`,
      [userId, buckets]
    );

    // If someone else created it first, just return theirs.
    if (sess.rows.length === 0) {
      await client.query('ROLLBACK');
      const again = await query('SELECT * FROM rating_sessions WHERE user_id = $1', [userId]);
      return again.rows[0];
    }
    const session = sess.rows[0];

    // Pull the active photos for the chosen buckets, shuffle, and freeze the
    // order into rating_session_photos. This is the per-session mixed list.
    const photos = await client.query(
      `SELECT id FROM rating_photos
        WHERE is_active AND gender_bucket = ANY($1::text[])`,
      [buckets]
    );
    const ids = shuffle(photos.rows.map((r) => r.id));
    for (let pos = 0; pos < ids.length; pos++) {
      await client.query(
        `INSERT INTO rating_session_photos (session_id, photo_id, position)
         VALUES ($1, $2, $3)`,
        [session.id, ids[pos], pos + 1]
      );
    }

    await client.query('COMMIT');
    return session;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// --- disposable entry links (twin of createPaymentLink) ---------------------
function newToken() {
  return randomBytes(24).toString('base64url'); // ~32 chars, URL-safe, unguessable
}

// Create a fresh /rate/{token} link for a user, ensuring their session exists.
// Returns the token string. Called when [RATE_PHOTOS] fires.
export async function createRatingLink(userId) {
  const session = await ensureSession(userId);
  const token = newToken();
  await query(
    `INSERT INTO rating_links (token, user_id, session_id) VALUES ($1, $2, $3)`,
    [token, userId, session.id]
  );
  return token;
}

// Resolve a token to its link row (or null), respecting expiry. Used by /rate.
export async function getRatingLink(token) {
  if (!token) return null;
  const res = await query(
    `SELECT token, user_id, session_id, created_at, expires_at
       FROM rating_links WHERE token = $1`,
    [token]
  );
  const row = res.rows[0];
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) return null; // expired
  return row;
}

// --- the page's data: the frozen photo list + existing scores + resume index -
// Returns { session, photos: [{photo_id, url, position, score|null}],
//           total, scored, complete, resume_index }.
// resume_index is the 0-based position of the first UNSCORED photo (or the last
// index if all are scored), i.e. where the UI should open.
export async function getSessionView(sessionId) {
  const sess = await query('SELECT * FROM rating_sessions WHERE id = $1', [sessionId]);
  const session = sess.rows[0];
  if (!session) return null;

  const rows = await query(
    `SELECT rsp.photo_id, rsp.position, p.url, r.score
       FROM rating_session_photos rsp
       JOIN rating_photos p ON p.id = rsp.photo_id
       LEFT JOIN ratings r ON r.session_id = rsp.session_id AND r.photo_id = rsp.photo_id
      WHERE rsp.session_id = $1
      ORDER BY rsp.position ASC`,
    [sessionId]
  );

  const photos = rows.rows.map((r) => ({
    photo_id: r.photo_id,
    url: r.url,
    position: r.position,
    score: r.score ?? null,
  }));
  const total = photos.length;
  const scored = photos.filter((p) => p.score != null).length;
  const firstUnscored = photos.findIndex((p) => p.score == null);
  const resume_index = firstUnscored === -1 ? Math.max(0, total - 1) : firstUnscored;

  return {
    session,
    photos,
    total,
    scored,
    complete: total > 0 && scored === total,
    resume_index,
  };
}

// --- record one score (upsert) ----------------------------------------------
// Re-scoring updates rather than duplicates (UNIQUE session_id, photo_id).
// Validates the photo actually belongs to this session's frozen list and that
// the score is 1-5. Returns { ok, scored, total, complete }.
export async function recordScore({ sessionId, photoId, score }) {
  const n = Number(score);
  if (!Number.isInteger(n) || n < 1 || n > 5) {
    return { ok: false, error: 'bad_score' };
  }
  // Guard: the photo must be part of this session's frozen list.
  const belongs = await query(
    `SELECT 1 FROM rating_session_photos WHERE session_id = $1 AND photo_id = $2`,
    [sessionId, photoId]
  );
  if (belongs.rows.length === 0) return { ok: false, error: 'photo_not_in_session' };

  await query(
    `INSERT INTO ratings (session_id, photo_id, score)
     VALUES ($1, $2, $3)
     ON CONFLICT (session_id, photo_id)
     DO UPDATE SET score = EXCLUDED.score, rated_at = now()`,
    [sessionId, photoId, n]
  );

  const counts = await query(
    `SELECT
       (SELECT count(*) FROM rating_session_photos WHERE session_id = $1) AS total,
       (SELECT count(*) FROM ratings WHERE session_id = $1) AS scored`,
    [sessionId]
  );
  const total = Number(counts.rows[0].total);
  const scored = Number(counts.rows[0].scored);
  return { ok: true, total, scored, complete: total > 0 && scored === total };
}

// --- completion / fulfillment (twin of fulfillPayment) ----------------------
// Idempotent: atomically claims completed_at on the session, but ONLY if every
// frozen photo has a score. If newly claimed, injects the scripted rate_success
// message as an AI-initiated turn (like the payment success line). Safe to call
// repeatedly (re-opened cards, double submits) - it fires the line exactly once.
// Returns { completed: boolean, reason? }.
export async function fulfillRating(sessionId) {
  // Atomic claim: set completed_at only if not already set AND all photos scored.
  const claim = await query(
    `UPDATE rating_sessions s
        SET completed_at = now()
      WHERE s.id = $1
        AND s.completed_at IS NULL
        AND (SELECT count(*) FROM rating_session_photos WHERE session_id = s.id) > 0
        AND (SELECT count(*) FROM ratings WHERE session_id = s.id)
            = (SELECT count(*) FROM rating_session_photos WHERE session_id = s.id)
      RETURNING user_id`,
    [sessionId]
  );
  if (claim.rows.length === 0) {
    // Either already completed, or not all photos scored yet.
    return { completed: false, reason: 'already_completed_or_incomplete' };
  }
  const userId = claim.rows[0].user_id;

  // Inject the scripted success message as a new AI turn (shows in chat + replay).
  const published = await getPublished();
  const rawSuccess = published?.snapshot?.rate_success || 'Thanks, that helps!';
  const userRow = await query('SELECT * FROM users WHERE id = $1', [userId]);
  const user = userRow.rows[0] || {};
  const ctx = { user: userContext(user) };
  const rendered = renderTemplate(rawSuccess, ctx, {});
  const successText = rendered.ok ? rendered.text : rawSuccess;

  const seqRow = await query(
    'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM turns WHERE user_id = $1',
    [userId]
  );
  const seq = seqRow.rows[0].next;
  const turn = await query(
    `INSERT INTO turns (user_id, seq, user_message, task_id)
     VALUES ($1, $2, NULL, NULL) RETURNING id`,
    [userId, seq]
  );
  await query(
    `INSERT INTO prompt_results
       (turn_id, prompt_type, resolved_prompt, output, status, config_version_id, seq_in_turn)
     VALUES ($1, 'speaker', $2, $3, 'ok', $4, 1)`,
    [turn.rows[0].id, '(scripted: rate success)', successText, published?.id || null]
  );

  return { completed: true, userId };
}
