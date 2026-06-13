// src/lib/funnel-versions.js
// Funnel VERSION definitions, declared in code (changed via deploy, in the same
// commit as the onboarding-flow change they describe). Each version lists the
// ordered STEP KEYS it presents. Keys map to the facts the funnel already
// computes:
//   - 'visited'            : a user row exists (reached the phone page)
//   - 'phone_number'       : entered a phone (phone_entered_at set)
//   - 'verif_code','email','birth_date','name','gender','gender_pref',
//     'age_range','neighborhood','education','has_kids','ethnicity','religion',
//     'photos','avatar'    : onboarding checkpoints (field presence)
//   - 'tasks'              : expands to every ACTIVE task, in configured order
//   - 'paid'               : has a paid payment_link
//
// HOW TO ADD A VERSION when you change the flow:
//   1. Add a new entry below with the new ordered `steps`.
//   2. Set `active: true` on it and `active: false` on the previous active one.
//   3. Commit alongside the index.html flow change. New users are stamped with
//      the active version at first touch; existing users keep their stamp.

export const FUNNEL_VERSIONS = [
  {
    id: 'v1',
    label: 'v1 (baseline)',
    active: false,
    steps: [
      'visited', 'phone_number', 'verif_code', 'email', 'birth_date', 'name',
      'gender', 'gender_pref', 'age_range', 'neighborhood', 'education',
      'has_kids', 'ethnicity', 'religion', 'photos', 'avatar',
      'tasks', 'paid',
    ],
  },
  {
    id: 'v2',
    label: 'v2 (birthdate first, phone late, no email)',
    active: true,
    steps: [
      'visited', 'applied', 'birth_date', 'gender', 'gender_pref', 'age_range',
      'neighborhood', 'education', 'has_kids', 'ethnicity', 'religion',
      'photos', 'name', 'phone_number', 'verif_code', 'avatar',
      'tasks', 'paid',
    ],
  },
];

// The cross-version "core funnel": a small set of milestone keys that exist in
// EVERY version, counted across ALL users regardless of which version they saw.
// This is the stable KPI view - it tracks "of everyone, how many reached each
// milestone", so the transition %s blend populations (it's milestone tracking,
// not a strict per-version sequence). Tweak deliberately if your universal
// milestones change.
export const CORE_MILESTONES = ['visited', 'phone_number', 'tasks', 'paid'];

export function activeVersion() {
  return FUNNEL_VERSIONS.find((v) => v.active) || FUNNEL_VERSIONS[0];
}

export function getVersion(id) {
  return FUNNEL_VERSIONS.find((v) => v.id === id) || null;
}
