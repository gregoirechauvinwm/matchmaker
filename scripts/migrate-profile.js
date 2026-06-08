// scripts/migrate-profile.js
// Adds onboarding/profile columns to users. Run once: npm run migrate:profile
// Idempotent (IF NOT EXISTS).

import { pool } from '../src/db/pool.js';

async function main() {
  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS name text,
      ADD COLUMN IF NOT EXISTS email text,
      ADD COLUMN IF NOT EXISTS birth_date date,
      ADD COLUMN IF NOT EXISTS gender text,
      ADD COLUMN IF NOT EXISTS gender_pref text[],
      ADD COLUMN IF NOT EXISTS religion text[],
      ADD COLUMN IF NOT EXISTS ethnicity text[],
      ADD COLUMN IF NOT EXISTS has_kids boolean,
      ADD COLUMN IF NOT EXISTS partner_age_min integer,
      ADD COLUMN IF NOT EXISTS partner_age_max integer,
      ADD COLUMN IF NOT EXISTS photos text[],
      ADD COLUMN IF NOT EXISTS chosen_amata text,
      ADD COLUMN IF NOT EXISTS onboarding_step integer,
      ADD COLUMN IF NOT EXISTS onboarding_done boolean DEFAULT false
  `);
  console.log('Profile columns added (if not already present).');
  await pool.end();
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
