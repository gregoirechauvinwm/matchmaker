// src/lib/users.js
// Everything about finding/creating the user record, keyed on the normalized
// phone number. A user IS the lifelong flow (no sessions), so this is also
// where "resume the existing user" happens - find-or-create returns the same
// row for a returning phone.

import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { query } from '../db/pool.js';

// Turn whatever the user typed into canonical E.164 (e.g. +15551234567),
// or return null if it isn't a valid number. We store and look up by this
// canonical form so "+1 (555) 123-4567" and "5551234567" are the same user.
// Normalize a phone to E.164 (+1XXXXXXXXXX) for sending + as the user key.
// Loosened (intentionally): we do NOT reject "invalid" numbers here. The real
// validation is whether the SMS code actually arrives. We still need a stable
// canonical form, so:
//   1. If libphonenumber can parse it, use its E.164 (handles formatting,
//      country codes, the selected country).
//   2. If not, fall back to '+' + digits, prefixing the US country code (1)
//      when the digits look like a bare 10-digit US number.
// Returns null only when there clearly aren't enough digits to be a phone
// (< 7), which mirrors the front-end's minimum.
export function normalizePhone(raw, defaultCountry = 'US') {
  // Enforce a minimum digit count FIRST (mirrors the front-end's >=7). This
  // matters because libphonenumber will happily form an E.164 from too few
  // digits (e.g. '12345' -> '+112345'), which we don't want to accept.
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 7) return null;

  const parsed = parsePhoneNumberFromString(raw || '', defaultCountry);
  if (parsed && parsed.number) return parsed.number; // E.164, even if !isValid()

  // Couldn't parse but we have enough digits: build a plausible E.164.
  if (defaultCountry === 'US' && digits.length === 10) return '+1' + digits;
  return '+' + digits;
}

// Find the user with this phone, or create one if new. Returns the user row.
// This is the "resume vs new" decision point: a returning phone finds its
// existing row (with its current_task_id and message count intact), a new
// phone gets a fresh row.
export async function findOrCreateUser(phoneE164) {
  const found = await query(
    'SELECT * FROM users WHERE phone_e164 = $1',
    [phoneE164]
  );
  if (found.rows.length > 0) {
    return { user: found.rows[0], created: false };
  }

  const created = await query(
    `INSERT INTO users (phone_e164, phone_verified_at)
     VALUES ($1, now())
     RETURNING *`,
    [phoneE164]
  );
  return { user: created.rows[0], created: true };
}

export async function getUserById(id) {
  const result = await query('SELECT * FROM users WHERE id = $1', [id]);
  return result.rows[0] || null;
}

// ---- profile (onboarding) ------------------------------------------------

// Map of allowed profile fields -> column names. Arrays for multi-selects.
const PROFILE_FIELDS = {
  name: 'name', email: 'email', birth_date: 'birth_date', gender: 'gender',
  gender_pref: 'gender_pref', religion: 'religion', ethnicity: 'ethnicity',
  has_kids: 'has_kids', partner_age_min: 'partner_age_min', partner_age_max: 'partner_age_max',
  photos: 'photos', chosen_amata: 'chosen_amata',
  neighborhood: 'neighborhood', education: 'education',
  onboarding_step: 'onboarding_step', onboarding_done: 'onboarding_done',
};

// Update any subset of profile fields for a user. `fields` is an object whose
// keys are in PROFILE_FIELDS. Builds a parameterized UPDATE.
export async function updateProfile(userId, fields) {
  const sets = [];
  const vals = [];
  let n = 1;
  for (const [k, v] of Object.entries(fields)) {
    if (!PROFILE_FIELDS[k]) continue;
    sets.push(`${PROFILE_FIELDS[k]} = $${n++}`);
    vals.push(v);
  }
  if (!sets.length) return;
  vals.push(userId);
  await query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${n}`, vals);
}

// Compute age from a birth_date (Date or ISO string), or null.
export function ageFromBirth(birth) {
  if (!birth) return null;
  const d = new Date(birth);
  if (isNaN(d)) return null;
  const t = new Date();
  let age = t.getFullYear() - d.getFullYear();
  const had = (t.getMonth() > d.getMonth()) || (t.getMonth() === d.getMonth() && t.getDate() >= d.getDate());
  if (!had) age--;
  return age;
}

function joinList(v) {
  if (Array.isArray(v)) return v.filter(Boolean).join(', ');
  return v || '';
}

// The {{user.*}} template shape. SINGLE SOURCE used by both the pipeline prompts
// and the scripted first message, so they resolve variables identically.
export function userContext(user) {
  if (!user) return {};
  return {
    name: user.name || '',
    age: ageFromBirth(user.birth_date),
    gender: user.gender || '',
    genderPref: joinList(user.gender_pref),
    religion: joinList(user.religion),
    ethnicity: joinList(user.ethnicity),
    hasKids: user.has_kids == null ? '' : (user.has_kids ? 'has kids' : "doesn't have kids"),
    token_count: user.token_count ?? 0,
  };
}

// Full profile for a user (raw row + derived age).
export async function getProfile(userId) {
  const res = await query('SELECT * FROM users WHERE id = $1', [userId]);
  const u = res.rows[0];
  if (!u) return null;
  return { ...u, age: ageFromBirth(u.birth_date) };
}
