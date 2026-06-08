// src/lib/session.js
// The auth session: a signed cookie holding the user's id. This is separate
// from the "flow" (which lives on the user row) - it just answers "is this
// browser logged in, and as whom."
//
// For local v1 we keep it simple: the cookie stores the user id, signed by
// Fastify's cookie plugin so it can't be tampered with. httpOnly so client
// JS can't read it.

const COOKIE_NAME = 'mm_session';

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  // `secure` would require HTTPS; off for local http dev.
  secure: false,
  signed: true,
  maxAge: 60 * 60 * 24 * 30, // 30 days
};

export function setSession(reply, userId) {
  reply.setCookie(COOKIE_NAME, userId, cookieOptions);
}

export function clearSession(reply) {
  reply.clearCookie(COOKIE_NAME, { path: '/' });
}

// Read the user id from the signed cookie, or null if absent/invalid.
export function getSessionUserId(request) {
  const raw = request.cookies[COOKIE_NAME];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid ? unsigned.value : null;
}
