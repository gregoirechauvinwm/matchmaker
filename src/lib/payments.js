// src/lib/payments.js
// Payment links (obscure token -> user) + the date/pricing helpers for the
// payment page. Stripe wiring lives in routes (Step 2b); this file is pure
// data + date logic so it's easy to reason about and test.

import { randomBytes } from 'node:crypto';
import { query } from '../db/pool.js';

// --- pricing (hardcoded for now) -------------------------------------------
// id is what we attach to the Stripe payment as metadata so the webhook knows
// how many tokens to grant. amount_cents is the charge; tokens is what we add.
export const PRICE_OPTIONS = [
  { id: 'tokens_1', tokens: 1, amount_cents: 1999, label: '1 date token',  sub: 'Regular',      discount: false },
  { id: 'tokens_3', tokens: 3, amount_cents: 3999, label: '3 date tokens', sub: '$13.33/date',  discount: true  },
  { id: 'tokens_6', tokens: 6, amount_cents: 5999, label: '6 date tokens', sub: '$9.99 date',   discount: true  },
];

export function priceOptionById(id) {
  return PRICE_OPTIONS.find((o) => o.id === id) || null;
}

// --- obscure payment links --------------------------------------------------
export function newToken() {
  return randomBytes(24).toString('base64url'); // ~32 chars, URL-safe, unguessable
}

// Create a fresh link for a user (called when [SEND_PAYMENT] fires).
export async function createPaymentLink(userId) {
  const token = newToken();
  await query(
    `INSERT INTO payment_links (token, user_id) VALUES ($1, $2)`,
    [token, userId]
  );
  return token;
}

// Resolve a token to its link row (or null). Used by the /pay page.
export async function getPaymentLink(token) {
  if (!token) return null;
  const res = await query(
    `SELECT token, user_id, created_at, expires_at, paid_at
       FROM payment_links WHERE token = $1`,
    [token]
  );
  const row = res.rows[0];
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) return null; // expired
  return row;
}

export async function markPaymentLinkPaid(token) {
  await query(`UPDATE payment_links SET paid_at = now() WHERE token = $1`, [token]);
}

// Direct paid check, ignoring expiry (used by the return-page status poll).
export async function isPaymentLinkPaid(token) {
  if (!token) return false;
  const res = await query(`SELECT paid_at FROM payment_links WHERE token = $1`, [token]);
  return !!res.rows[0]?.paid_at;
}

// --- next-Tuesday 8PM logic -------------------------------------------------
// Rule: if today is Tuesday, show NEXT week's Tuesday; otherwise the upcoming
// Tuesday. Returns { date: Date, label: "Tues Apr 28 - 8PM", relative: "in 3 days"|"tomorrow" }.
// `now` is injectable for testing.
export function nextTuesday(now = new Date()) {
  // Work in a date-only sense for day counting (local server time is fine for
  // the relative count; the displayed time is fixed at 8PM EST text).
  const d = new Date(now);
  const day = d.getDay(); // 0 Sun ... 2 Tue ... 6 Sat
  // Days until Tuesday (2). If today IS Tuesday, jump a full week (7).
  let delta = (2 - day + 7) % 7;
  if (delta === 0) delta = 7;

  const target = new Date(d);
  target.setDate(d.getDate() + delta);

  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const label = `Tues ${months[target.getMonth()]} ${target.getDate()} - 8PM`;

  let relative;
  if (delta === 1) relative = 'tomorrow';
  else relative = `in ${delta} days`;

  return { date: target, label, relative, delta };
}

// The "right-hand polaroid" image based on who the user is looking for.
// Priority when multiple: women > men > non-binary.
export function lookForImage(genderPref) {
  const prefs = Array.isArray(genderPref) ? genderPref.map((s) => String(s).toLowerCase()) : [];
  const has = (k) => prefs.some((p) => p.includes(k));
  if (has('female') || has('women') || has('woman')) return '/pay/look-for-women.png';
  if (has('male')   || has('men')   || has('man'))   return '/pay/look-for-men.png';
  return '/pay/look-for-nbinaries.png';
}

// --- fulfillment (called by the Stripe webhook, the source of truth) --------
import { renderTemplate } from './template.js';
import { userContext } from './users.js';
import { getPublished } from './config-versions.js';

// Grant tokens for a paid link and inject the scripted "payment successful"
// message into the user's chat. Idempotent: if the link is already marked paid,
// it does nothing (Stripe may deliver a webhook more than once).
// Returns { granted: boolean, tokens, userId } so the caller can log.
export async function fulfillPayment({ payToken, tokens }) {
  // Atomically claim the link: only proceed if it exists and isn't paid yet.
  const claim = await query(
    `UPDATE payment_links
        SET paid_at = now()
      WHERE token = $1 AND paid_at IS NULL
      RETURNING user_id`,
    [payToken]
  );
  if (claim.rows.length === 0) {
    return { granted: false, reason: 'already_paid_or_missing' };
  }
  const userId = claim.rows[0].user_id;
  const n = Number(tokens) || 0;

  // Increment the user's token balance.
  await query(
    `UPDATE users SET token_count = COALESCE(token_count, 0) + $2 WHERE id = $1`,
    [userId, n]
  );

  // Inject the scripted payment-success message as a new AI-initiated turn so it
  // shows in chat history like any other AI message.
  const published = await getPublished();
  const rawSuccess = published?.snapshot?.payment_success || 'Payment successful!';
  const userRow = await query('SELECT * FROM users WHERE id = $1', [userId]);
  const user = userRow.rows[0] || {};
  const ctx = { user: userContext(user), tokens_purchased: n };
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
    [turn.rows[0].id, '(scripted: payment success)', successText, published?.id || null]
  );

  return { granted: true, tokens: n, userId };
}
