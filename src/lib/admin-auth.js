// src/lib/admin-auth.js
// Minimal admin gate for the back-office. A single password lives in .env as
// ADMIN_PASSWORD. On correct entry we set a signed cookie; back-office routes
// check it. This is the honest seam for real admin auth later, and keeps the
// back-office closed even if the path is ever reached from outside localhost.

const ADMIN_COOKIE = 'wm_admin';

const adminCookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  secure: false,
  signed: true,
  maxAge: 60 * 60 * 24 * 7, // 7 days
};

export function adminPasswordIsSet() {
  return !!process.env.ADMIN_PASSWORD;
}

export function checkPassword(candidate) {
  const expected = process.env.ADMIN_PASSWORD || '';
  return expected.length > 0 && candidate === expected;
}

export function setAdminSession(reply) {
  reply.setCookie(ADMIN_COOKIE, 'ok', adminCookieOptions);
}

export function clearAdminSession(reply) {
  reply.clearCookie(ADMIN_COOKIE, { path: '/' });
}

export function isAdmin(request) {
  const raw = request.cookies[ADMIN_COOKIE];
  if (!raw) return false;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid && unsigned.value === 'ok';
}
