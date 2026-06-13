// src/routes/auth.js
// The HTTP endpoints behind the entry flow:
//   POST /auth/request-code  -> validate phone, "send" code (stub)
//   POST /auth/confirm-code   -> check code, find-or-create user, set session
//   POST /auth/logout         -> clear session (handy during testing)
//   GET  /auth/me             -> who am I? (used by the frontend to route)

import { requestCode, confirmCode } from '../lib/verification.js';
import { normalizePhone, findOrCreateUser, findOrCreateAnonUser, verifyPhoneForUser, getUserById } from '../lib/users.js';
import { setSession, clearSession, getSessionUserId } from '../lib/session.js';
import { query } from '../db/pool.js';
import { randomUUID } from 'node:crypto';

// Anonymous per-browser id. Set on first touch (phone-page load). It now backs
// a real (anonymous-status) user row so onboarding fields can be saved BEFORE
// phone is collected and phone can sit anywhere in the flow.
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
  // First touch (phone page load): ensure an anonymous user row exists for this
  // browser and the session points at it, so subsequent /onboarding/save calls
  // have a row to write to even before phone verification.
  app.post('/auth/visit', async (request, reply) => {
    let visitId = getVisitId(request);
    if (!visitId) {
      visitId = randomUUID();
      reply.setCookie(VISIT_COOKIE, visitId, visitCookieOptions);
    }
    try {
      const user = await findOrCreateAnonUser(visitId);
      // Only set the session if not already logged in as someone real, so we
      // never downgrade a verified session back to the anon row.
      const current = getSessionUserId(request);
      if (!current) setSession(reply, user.id);
      return { ok: true };
    } catch (err) {
      // Don't block the page load, but make a real failure visible (this is
      // how an earlier ON CONFLICT/index mismatch stayed hidden behind a 200).
      request.log.error({ err: err.message }, 'visit/anon-user insert failed');
      return { ok: true };
    }
  });

  // Ask for a verification code to be sent to a phone number.
  app.post('/auth/request-code', async (request, reply) => {
    const { phone, country } = request.body || {};
    const phoneE164 = normalizePhone(phone || '', country || 'US');
    if (!phoneE164) {
      return reply.code(400).send({ error: 'invalid_phone' });
    }
    // Record the entered number on this browser's row so the funnel's "Phone
    // number" step counts it even before verification, AND so the back-office
    // can show what they typed. We store it in phone_entered (NOT phone_e164,
    // which stays reserved for the verified identity). phone_verified_at stays
    // null until the code is confirmed. Never blocks the user.
    try {
      const uid = getSessionUserId(request);
      if (uid) {
        await query(
          `UPDATE users
              SET phone_entered = $2,
                  phone_entered_at = COALESCE(phone_entered_at, now())
            WHERE id = $1`,
          [uid, phoneE164]
        );
      }
    } catch (err) {
      request.log.warn({ err: err.message }, 'phone-entered log failed');
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

    // Resolve identity against the current (anon) session row: merge into an
    // existing returning user, or promote this anon row to verified.
    const currentUserId = getSessionUserId(request);
    const { user, created } = await verifyPhoneForUser(currentUserId, phoneE164);
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
    // 'verified' means phone-confirmed; 'anonymous' is a first-touch row that
    // hasn't verified yet. Downstream routing should treat anonymous as
    // "not really logged in" for anything gated on a real account.
    const verified = user.status === 'verified' || !!user.phone_verified_at;
    return {
      authenticated: verified,
      status: user.status || (verified ? 'verified' : 'anonymous'),
      user_id: user.id,
      name: user.name || null,
      chosen_amata: user.chosen_amata || null,
    };
  });
}
