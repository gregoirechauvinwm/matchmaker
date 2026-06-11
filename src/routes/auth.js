// src/routes/auth.js
// The HTTP endpoints behind the entry flow:
//   POST /auth/request-code  -> validate phone, "send" code (stub)
//   POST /auth/confirm-code   -> check code, find-or-create user, set session
//   POST /auth/logout         -> clear session (handy during testing)
//   GET  /auth/me             -> who am I? (used by the frontend to route)

import { requestCode, confirmCode } from '../lib/verification.js';
import { normalizePhone, findOrCreateUser, getUserById } from '../lib/users.js';
import { setSession, clearSession, getSessionUserId } from '../lib/session.js';
import { query } from '../db/pool.js';
import { randomUUID } from 'node:crypto';

// Anonymous per-browser id used for funnel top-of-funnel tracking (Visited ->
// Phone number -> Verif code). Not tied to any PII; just lets us dedup a single
// browser so one person trying two numbers counts once, and lets us count
// visits to the phone page. Persistent (~1 year).
const VISIT_COOKIE = 'mm_visit';
const visitCookieOptions = {
  httpOnly: false, sameSite: 'lax', path: '/', secure: false, signed: false,
  maxAge: 60 * 60 * 24 * 365,
};

function getVisitId(request) {
  const v = request.cookies?.[VISIT_COOKIE];
  return (typeof v === 'string' && v.length > 0) ? v : null;
}

export default async function authRoutes(app) {
  // Called when the phone page loads. Establishes (once) an anonymous visit id
  // and records the visit. Idempotent per browser via the cookie + ON CONFLICT.
  app.post('/auth/visit', async (request, reply) => {
    let visitId = getVisitId(request);
    if (!visitId) {
      visitId = randomUUID();
      reply.setCookie(VISIT_COOKIE, visitId, visitCookieOptions);
    }
    try {
      await query(
        `INSERT INTO visits (visit_id) VALUES ($1) ON CONFLICT (visit_id) DO NOTHING`,
        [visitId]
      );
    } catch (err) {
      request.log.warn({ err: err.message }, 'visit log failed');
    }
    return { ok: true };
  });

  // Ask for a verification code to be sent to a phone number.
  app.post('/auth/request-code', async (request, reply) => {
    const { phone, country } = request.body || {};
    const phoneE164 = normalizePhone(phone || '', country || 'US');
    if (!phoneE164) {
      return reply.code(400).send({ error: 'invalid_phone' });
    }
    // Record the entered number against this browser's visit row (dedup per
    // browser, not per number). If somehow there's no visit cookie yet, create
    // one now so the entry is still counted. Never blocks the user.
    try {
      let visitId = getVisitId(request);
      if (!visitId) {
        visitId = randomUUID();
        reply.setCookie(VISIT_COOKIE, visitId, visitCookieOptions);
      }
      await query(
        `INSERT INTO visits (visit_id, phone_e164, phone_entered_at)
              VALUES ($1, $2, now())
         ON CONFLICT (visit_id)
         DO UPDATE SET phone_e164 = EXCLUDED.phone_e164,
                       phone_entered_at = COALESCE(visits.phone_entered_at, EXCLUDED.phone_entered_at)`,
        [visitId, phoneE164]
      );
    } catch (err) {
      request.log.warn({ err: err.message }, 'visit phone log failed');
    }
    const result = await requestCode(phoneE164);
    if (result && result.sent === false) {
      // Twilio refused the number (invalid/unreachable). Tell the client so it
      // can show a clear message rather than advancing to a code screen where
      // no SMS will arrive.
      return reply.code(422).send({ error: 'send_failed' });
    }
    // We hand back the normalized phone so the next step uses the canonical form.
    // `dev` tells the entry page whether the bypass code is in effect; it mirrors
    // the verification seam: the bypass is active in any non-production env.
    return { ok: true, phone: phoneE164, dev: process.env.NODE_ENV !== 'production' };
  });

  // Confirm the code, then log the user in (creating them if new).
  app.post('/auth/confirm-code', async (request, reply) => {
    const { phone, country, code } = request.body || {};
    const phoneE164 = normalizePhone(phone || '', country || 'US');
    if (!phoneE164) {
      return reply.code(400).send({ error: 'invalid_phone' });
    }

    const result = await confirmCode(phoneE164, String(code || ''));
    if (!result.verified) {
      return reply.code(401).send({ error: 'bad_code' });
    }

    const { user, created } = await findOrCreateUser(phoneE164);
    setSession(reply, user.id);
    return { ok: true, created };
  });

  app.post('/auth/logout', async (request, reply) => {
    clearSession(reply);
    return { ok: true };
  });

  // Lightweight "am I logged in" check the frontend uses to decide whether to
  // show the phone screen or the chat.
  app.get('/auth/me', async (request) => {
    const userId = getSessionUserId(request);
    if (!userId) return { authenticated: false };
    const user = await getUserById(userId);
    if (!user) return { authenticated: false };
    return {
      authenticated: true,
      user_id: user.id,
      name: user.name || null,
      chosen_amata: user.chosen_amata || null,
    };
  });
}
