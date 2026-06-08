// src/routes/admin.js
// The back-office, served under /wm-admin. Step 6a: login gate + users list +
// conversation view (read-only, full conversation with intermediary prompt
// completions shown inline). Editor and reorder come in 6b/6c.
//
// Rendered server-side as HTML (this view is read-heavy and simple; no need for
// a client framework). All pages require the admin cookie except the login page.

import {
  adminPasswordIsSet, checkPassword, setAdminSession, clearAdminSession, isAdmin,
} from '../lib/admin-auth.js';
import { listUsers, getUserBasic, getConversation } from '../lib/admin-data.js';
import { getDraft } from '../lib/editor-data.js';
import {
  getPublished, listVersions, reloadVersion, saveAndPublish,
} from '../lib/config-versions.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', '..', 'public');

const BASE = '/wm-admin';

// Format a user row into a profile object for the back-office detail panel.
function formatProfile(u) {
  const ageFromBirth = (b) => {
    if (!b) return null;
    const d = new Date(b); if (isNaN(d)) return null;
    const t = new Date(); let a = t.getFullYear() - d.getFullYear();
    const had = (t.getMonth() > d.getMonth()) || (t.getMonth() === d.getMonth() && t.getDate() >= d.getDate());
    return had ? a : a - 1;
  };
  const list = (v) => Array.isArray(v) ? v.join(', ') : (v || '');
  return {
    id: u.id,
    phone_e164: u.phone_e164,
    completed_at: u.completed_at,
    name: u.name || '',
    email: u.email || '',
    age: ageFromBirth(u.birth_date),
    gender: u.gender || '',
    gender_pref: list(u.gender_pref),
    religion: list(u.religion),
    ethnicity: list(u.ethnicity),
    has_kids: u.has_kids == null ? '' : (u.has_kids ? 'Has kids' : "Doesn't have kids"),
    partner_age_min: u.partner_age_min ?? null,
    partner_age_max: u.partner_age_max ?? null,
    photos: Array.isArray(u.photos) ? u.photos : [],
    chosen_amata: u.chosen_amata || null,
  };
}

// --- tiny HTML helpers -----------------------------------------------------
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function page(title, body) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex, nofollow"/>
<title>${esc(title)}</title>
<link rel="stylesheet" href="/wm-admin.css"/>
</head><body>${body}</body></html>`;
}

function shortId(id) { return String(id).slice(0, 8); }

export default async function adminRoutes(app) {
  // Guard: every /wm-admin page except login requires the admin cookie.
  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith(BASE)) return; // not an admin route
    if (request.url.startsWith(`${BASE}/login`)) return; // login is open
    if (!isAdmin(request)) {
      return reply.redirect(`${BASE}/login`);
    }
  });

  // --- login ---------------------------------------------------------------
  app.get(`${BASE}/login`, async (request, reply) => {
    if (isAdmin(request)) return reply.redirect(`${BASE}`);
    const warn = adminPasswordIsSet()
      ? ''
      : '<p class="warn">No ADMIN_PASSWORD is set in .env. Set one and restart.</p>';
    const err = request.query?.e ? '<p class="warn">Wrong password.</p>' : '';
    reply.type('text/html').send(page('Admin login', `
      <div class="login">
        <h1>Back office</h1>
        ${warn}${err}
        <form method="POST" action="${BASE}/login">
          <input type="password" name="password" placeholder="Admin password" autofocus />
          <button type="submit">Enter</button>
        </form>
      </div>`));
  });

  app.post(`${BASE}/login`, async (request, reply) => {
    const password = (request.body && request.body.password) || '';
    if (!checkPassword(password)) {
      return reply.redirect(`${BASE}/login?e=1`);
    }
    setAdminSession(reply);
    return reply.redirect(`${BASE}`);
  });

  app.post(`${BASE}/logout`, async (request, reply) => {
    clearAdminSession(reply);
    return reply.redirect(`${BASE}/login`);
  });

  // --- users list (JSON) ---------------------------------------------------
  app.get(`${BASE}/api/users`, async (request, reply) => {
    const users = await listUsers();
    return { users };
  });

  // --- conversation (JSON) -------------------------------------------------
  app.get(`${BASE}/api/conversation/:id`, async (request, reply) => {
    const user = await getUserBasic(request.params.id);
    if (!user) return reply.code(404).send({ error: 'not_found' });
    const turns = await getConversation(user.id);
    return { user: formatProfile(user), turns };
  });

  // --- the back-office shell pages (client-rendered) -----------------------
  app.get(`${BASE}`, async (request, reply) => {
    return reply.sendFile('wm-admin.html', publicDir);
  });
  app.get(`${BASE}/u/:id`, async (request, reply) => {
    return reply.sendFile('wm-admin.html', publicDir);
  });

  // === EDITOR (prompts / tasks / parts) ===================================
  app.get(`${BASE}/prompts`, async (request, reply) => {
    return reply.sendFile('wm-admin-editor.html', publicDir);
  });

  // Read the current draft + published-version info (initial editor load).
  app.get(`${BASE}/api/draft`, async () => {
    const draft = await getDraft();
    const published = await getPublished();
    const versions = await listVersions();
    return {
      draft,
      published_version_id: published?.id || null,
      versions,
      env: process.env.NODE_ENV === 'production' ? 'production' : 'development',
    };
  });

  // Single save: the editor sends its entire in-memory config; we write all of
  // it to the draft tables transactionally and publish a new version.
  app.post(`${BASE}/api/save`, async (request) => {
    const { config, label } = request.body || {};
    const version = await saveAndPublish(config || {}, label || null);
    return { ok: true, version };
  });

  // Reload a past version into the draft (then the editor reloads it).
  app.post(`${BASE}/api/reload`, async (request) => {
    await reloadVersion((request.body || {}).id);
    return { ok: true };
  });
}
