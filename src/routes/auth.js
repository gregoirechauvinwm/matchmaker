// src/routes/auth.js
// The HTTP endpoints behind the entry flow:
//   POST /auth/request-code  -> validate phone, "send" code (stub)
//   POST /auth/confirm-code   -> check code, find-or-create user, set session
//   POST /auth/logout         -> clear session (handy during testing)
//   GET  /auth/me             -> who am I? (used by the frontend to route)

import { requestCode, confirmCode } from '../lib/verification.js';
import { normalizePhone, findOrCreateUser, getUserById } from '../lib/users.js';
import { setSession, clearSession, getSessionUserId } from '../lib/session.js';

export default async function authRoutes(app) {
  // Ask for a verification code to be sent to a phone number.
  app.post('/auth/request-code', async (request, reply) => {
    const { phone, country } = request.body || {};
    const phoneE164 = normalizePhone(phone || '', country || 'US');
    if (!phoneE164) {
      return reply.code(400).send({ error: 'invalid_phone' });
    }
    await requestCode(phoneE164);
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
