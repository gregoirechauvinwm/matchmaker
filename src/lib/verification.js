// src/lib/verification.js
// The SMS-verification seam. Right now both functions are stubs, but they are
// the two real points where Twilio Verify (or similar) plugs in later. The
// rest of the entry flow calls these and doesn't care how they work inside.

const DEV_BYPASS_CODE = '000000';

// Step 1 of verification: "send a code to this phone."
// Stub: in development we don't actually send anything. Later, this calls
// Twilio Verify's "start verification" API. Returns nothing meaningful yet.
export async function requestCode(_phoneE164) {
  if (process.env.NODE_ENV === 'development') {
    // No real SMS in dev. The user will just type 000 on the next screen.
    return { sent: true, dev: true };
  }
  // Production path (not built yet): call Twilio Verify here.
  throw new Error('Real SMS sending is not configured yet.');
}

// Step 2 of verification: "is this code correct for this phone?"
// Stub: in development, the code 000 always passes. The env check is what
// makes this safe - it can NEVER bypass once NODE_ENV is not 'development'.
// Later, this calls Twilio Verify's "check verification" API.
export async function confirmCode(_phoneE164, code) {
  if (process.env.NODE_ENV === 'development' && code === DEV_BYPASS_CODE) {
    return { verified: true, dev: true };
  }
  if (process.env.NODE_ENV === 'development') {
    // In dev, only 000 works. Any other code is rejected.
    return { verified: false };
  }
  // Production path (not built yet): call Twilio Verify check here.
  throw new Error('Real SMS verification is not configured yet.');
}
