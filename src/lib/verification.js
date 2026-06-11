// src/lib/verification.js
// The SMS-verification seam: two functions the entry flow calls without caring
// how they work inside.
//
//   - In DEVELOPMENT (NODE_ENV !== 'production'): no real SMS. The bypass code
//     below always passes. This can NEVER fire in production because of the env
//     gate, so there is no way to skip verification with real users.
//   - In PRODUCTION: Twilio Verify sends and checks the code. Twilio generates,
//     stores, expires, and rate-limits the codes - we never handle them.
//
// Required env in production:
//   TWILIO_ACCOUNT_SID         (AC...)
//   TWILIO_AUTH_TOKEN
//   TWILIO_VERIFY_SERVICE_SID  (VA...)  -- the Verify Service, created once.

import twilio from 'twilio';

const DEV_BYPASS_CODE = '000000';
const isProd = process.env.NODE_ENV === 'production';

// Lazily build the Twilio client so dev/test never needs the credentials and a
// missing var only errors at the point of actually sending (with a clear msg).
let _client = null;
function twilioClient() {
  if (_client) return _client;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    throw new Error('Twilio credentials missing (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN).');
  }
  _client = twilio(sid, token);
  return _client;
}

function verifyServiceSid() {
  const vsid = process.env.TWILIO_VERIFY_SERVICE_SID;
  if (!vsid) throw new Error('TWILIO_VERIFY_SERVICE_SID is not set.');
  return vsid;
}

// Step 1: send a code to this phone (E.164).
// Returns { sent: true } on success, or { sent: false, reason } if Twilio
// rejects the number (e.g. unreachable/invalid). We catch rather than throw so
// the entry flow can show a clean "couldn't send" message instead of a 500 -
// this is now the real validation point for bad numbers.
export async function requestCode(phoneE164) {
  if (!isProd) {
    // No real SMS in dev; the user types the bypass code on the next screen.
    return { sent: true, dev: true };
  }
  try {
    const v = await twilioClient()
      .verify.v2.services(verifyServiceSid())
      .verifications.create({ to: phoneE164, channel: 'sms' });
    // Twilio returns status 'pending' when the code has been dispatched.
    return { sent: v.status === 'pending' };
  } catch (err) {
    // Twilio rejects malformed/unreachable numbers (e.g. 60200 invalid
    // parameter, 60205 SMS not supported). Surface as a clean failure.
    return { sent: false, reason: 'send_failed', code: err?.code };
  }
}

// Step 2: is this code correct for this phone? Returns { verified: boolean }.
export async function confirmCode(phoneE164, code) {
  if (!isProd) {
    return { verified: code === DEV_BYPASS_CODE, dev: true };
  }
  try {
    const check = await twilioClient()
      .verify.v2.services(verifyServiceSid())
      .verificationChecks.create({ to: phoneE164, code });
    return { verified: check.status === 'approved' };
  } catch (err) {
    // Twilio throws 404 when the verification has expired or was already used,
    // and 400 for malformed input. Treat all as "not verified" rather than a
    // 500 - the user just sees "bad code" and can request a new one.
    return { verified: false };
  }
}
