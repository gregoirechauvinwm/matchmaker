// src/routes/onboarding.js
// Endpoints for the multi-step onboarding form:
//   POST /onboarding/save    -> save a subset of profile fields + step (bg save)
//   GET  /onboarding/status  -> where should the user go? (chat / resume / start)
//
// The client sends raw form values; we map them to DB columns here (gender
// labels -> codes, multi-selects -> arrays, etc.), keeping the mapping server-side.

import { getSessionUserId } from '../lib/session.js';
import { updateProfile, getProfile } from '../lib/users.js';
import { uploadUserPhoto, r2Configured } from '../lib/r2.js';

// Map a gender label from the form to a stored code.
function mapGender(label) {
  if (!label) return null;
  const l = label.toLowerCase();
  if (l.includes('woman')) return 'female';
  if (l.includes('man') && !l.includes('woman')) return 'male';
  if (l.includes('non-binary') || l.includes('nonbinary')) return 'nonbinary';
  return label;
}

// Map a list of "who to meet" labels to gender codes.
function mapGenderPrefs(labels) {
  if (!Array.isArray(labels)) return null;
  return labels.map((x) => {
    const l = x.toLowerCase();
    if (l.includes('women')) return 'female';
    if (l.includes('men')) return 'male';
    return 'nonbinary';
  });
}

// Accept a partial set of fields from the client and persist. Unknown keys are
// ignored by updateProfile. `step` records the resume point.
export default async function onboardingRoutes(app) {
  app.post('/onboarding/save', async (request, reply) => {
    const userId = getSessionUserId(request);
    if (!userId) return reply.code(401).send({ error: 'not_authenticated' });

    const b = request.body || {};
    const fields = {};

    if (b.name !== undefined) fields.name = String(b.name).trim();
    if (b.email !== undefined) fields.email = String(b.email).trim();
    if (b.birth_date !== undefined) fields.birth_date = b.birth_date; // ISO 'YYYY-MM-DD'
    if (b.gender !== undefined) fields.gender = mapGender(b.gender);
    if (b.gender_pref !== undefined) fields.gender_pref = mapGenderPrefs(b.gender_pref);
    if (b.religion !== undefined) fields.religion = Array.isArray(b.religion) ? b.religion : null;
    if (b.ethnicity !== undefined) fields.ethnicity = Array.isArray(b.ethnicity) ? b.ethnicity : null;
    if (b.has_kids !== undefined) fields.has_kids = !!b.has_kids;
    if (b.partner_age_min !== undefined) fields.partner_age_min = parseInt(b.partner_age_min, 10);
    if (b.partner_age_max !== undefined) fields.partner_age_max = parseInt(b.partner_age_max, 10);
    if (b.chosen_amata !== undefined) fields.chosen_amata = b.chosen_amata;
    if (b.photos !== undefined) fields.photos = Array.isArray(b.photos) ? b.photos : null;
    if (b.step !== undefined) fields.onboarding_step = parseInt(b.step, 10);
    if (b.done) fields.onboarding_done = true;

    try {
      await updateProfile(userId, fields);
      return { ok: true };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: 'save_failed' });
    }
  });

  // Upload a single photo (base64 data URL) to R2; returns its public URL.
  app.post('/onboarding/photo', async (request, reply) => {
    const userId = getSessionUserId(request);
    if (!userId) return reply.code(401).send({ error: 'not_authenticated' });
    if (!r2Configured()) return reply.code(500).send({ error: 'storage_not_configured' });
    const { data_url } = request.body || {};
    if (!data_url) return reply.code(400).send({ error: 'no_image' });
    try {
      const url = await uploadUserPhoto(userId, data_url);
      return { ok: true, url };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: 'upload_failed' });
    }
  });

  app.get('/onboarding/status', async (request, reply) => {
    const userId = getSessionUserId(request);
    if (!userId) return { authenticated: false };
    const p = await getProfile(userId);
    if (!p) return { authenticated: false };
    return {
      authenticated: true,
      onboarding_done: !!p.onboarding_done,
      onboarding_step: p.onboarding_step ?? 0,
    };
  });
}
