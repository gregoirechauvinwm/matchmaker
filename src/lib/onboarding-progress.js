// src/lib/onboarding-progress.js
// Derives a user's onboarding progress from WHICH PROFILE FIELDS ARE POPULATED,
// not from the stored step index. The data the user gave us IS the record of how
// far they got: if the latest field we have is birth_date, they stopped at the
// birth-date step; they completed every step whose field is present.
//
// Why field-presence instead of users.onboarding_step:
//   - Robust to the deferred-save UX (fields save as the user slides; the step
//     index and the saved data can be briefly out of sync).
//   - Robust to steps being added/removed (which shifts every later index).
//   - No new column, no migration, no change to the sign-up flow - this is
//     read-only logic consumed by the back-office (user-list pill + funnel).
//
// Every onboarding step is mandatory (no skipping), so "field is present"
// reliably means "the user completed that step". Presence = NOT NULL for scalar
// columns; for array columns it additionally means non-empty (a column could be
// stored as []).

// Ordered onboarding checkpoints, matching the sign-up slider order:
// phone -> email -> birth -> name -> gender -> preferences -> age range ->
// neighborhood -> education -> children -> ethnicity -> religion -> photos ->
// avatar -> done.
//
// Each checkpoint's `has(user)` returns true once that step is complete. The
// `code`, `intro`, and `generating` slider steps have no field of their own and
// fold into their neighbors; `done` is the terminal checkpoint.
export const ONBOARDING_CHECKPOINTS = [
  { key: 'phone',        label: 'Phone',        has: (u) => present(u.phone_verified_at) },
  { key: 'email',        label: 'Email',        has: (u) => present(u.email) },
  { key: 'birth_date',   label: 'Birth date',   has: (u) => present(u.birth_date) },
  { key: 'name',         label: 'Name',         has: (u) => present(u.name) },
  { key: 'gender',       label: 'Gender',       has: (u) => present(u.gender) },
  { key: 'gender_pref',  label: 'Preferences',  has: (u) => nonEmptyArray(u.gender_pref) },
  { key: 'age_range',    label: 'Age range',    has: (u) => present(u.partner_age_min) },
  { key: 'neighborhood', label: 'Neighborhood', has: (u) => present(u.neighborhood) },
  { key: 'education',    label: 'Education',     has: (u) => present(u.education) },
  { key: 'has_kids',     label: 'Children',     has: (u) => present(u.has_kids) },
  { key: 'ethnicity',    label: 'Ethnicity',    has: (u) => nonEmptyArray(u.ethnicity) },
  { key: 'religion',     label: 'Religion',     has: (u) => nonEmptyArray(u.religion) },
  { key: 'photos',       label: 'Photos',       has: (u) => nonEmptyArray(u.photos) },
  { key: 'avatar',       label: 'Avatar',       has: (u) => present(u.chosen_amata) },
  { key: 'done',         label: 'Completed',    has: (u) => u.onboarding_done === true },
];

// NOT NULL / not-undefined. Empty string counts as absent (a trimmed empty
// text field means the step was never really filled). Booleans: false is a
// real, present value (e.g. has_kids = false), so it must count as present.
function present(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  return true;
}

function nonEmptyArray(v) {
  return Array.isArray(v) && v.length > 0;
}

// The furthest checkpoint the user has reached: the LAST checkpoint in order
// whose field is present. Using "furthest" (rather than "first gap") means a
// missing earlier field never makes someone look less progressed than the data
// shows. Returns the checkpoint object, or null if nothing is set yet.
export function furthestCheckpoint(user) {
  let result = null;
  for (const cp of ONBOARDING_CHECKPOINTS) {
    if (cp.has(user)) result = cp;
  }
  return result;
}

// Whether the user reached AT LEAST the given checkpoint key. "Reached" = the
// user has that checkpoint's field, OR any later checkpoint's field, OR has
// completed onboarding. This is the right notion for funnel counting (got at
// least this far), and is tolerant of an occasional gap in earlier fields.
export function reachedCheckpoint(user, key) {
  const idx = ONBOARDING_CHECKPOINTS.findIndex((c) => c.key === key);
  if (idx === -1) return false;
  for (let i = idx; i < ONBOARDING_CHECKPOINTS.length; i++) {
    if (ONBOARDING_CHECKPOINTS[i].has(user)) return true;
  }
  return false;
}
