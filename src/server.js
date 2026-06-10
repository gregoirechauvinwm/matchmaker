// src/server.js
// The local web server. For Step 1 it does three things:
//   1. starts up
//   2. serves files from /public (the chat UI will live there later)
//   3. exposes GET /health, which pings the database so you can confirm
//      the whole chain (server -> Neon) is working.

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import 'dotenv/config';
import { query } from './db/pool.js';
import { assertEnv, envSummary, APP_ENV } from './lib/env.js';

// Fail fast on misconfiguration BEFORE we start serving. In production a missing
// live key or webhook secret aborts boot instead of failing deep in a request.
assertEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = Fastify({ logger: true, bodyLimit: 15 * 1024 * 1024 });

// Cookies, with a secret used to sign the session cookie so it can't be
// tampered with. In a real deployment this would come from an env var; for
// local dev a fixed string is fine.
await app.register(fastifyCookie, {
  secret: process.env.COOKIE_SECRET || 'local-dev-secret-change-me',
});

// Parse HTML form submissions (used by the back-office login form).
await app.register(fastifyFormbody);

// Serve static files (HTML/CSS/JS) from the /public folder at the site root.
// Registered before our routes so the `reply.sendFile` decorator it adds is
// available to them.
await app.register(fastifyStatic, {
  root: join(__dirname, '..', 'public'),
  prefix: '/',
});

// Root route: send finished, logged-in users straight to /chat; everyone else
// falls through to index.html (the onboarding flow, starting at the phone step).
// Declared after static so reply.sendFile (added by @fastify/static) exists;
// an explicit exact-match "/" route takes precedence over the static wildcard.
{
  const { getSessionUserId } = await import('./lib/session.js');
  const { getProfile } = await import('./lib/users.js');
  app.get('/', async (request, reply) => {
    try {
      const userId = getSessionUserId(request);
      if (userId) {
        const p = await getProfile(userId);
        if (p && p.onboarding_done) return reply.redirect('/chat');
      }
    } catch { /* fall through to the static index.html */ }
    return reply.sendFile('index.html');
  });
}

// Entry-flow endpoints (phone verify, login).
await app.register((await import('./routes/auth.js')).default);

// Chat page (gated to logged-in users).
await app.register((await import('./routes/chat.js')).default);

// Back-office (gated to admin password).
await app.register((await import('./routes/admin.js')).default);

// Onboarding (profile form saves + status).
await app.register((await import('./routes/onboarding.js')).default);
await app.register((await import('./routes/pay.js')).default);
await app.register((await import('./routes/rate.js')).default);
await app.register((await import('./routes/webhook.js')).default);

// Health check: confirms the server is up AND can reach the database. Also
// reports a SECRET-FREE summary of which environment + database this process is
// wired to - so when testing you can SEE "I'm hitting staging / db X" instead
// of guessing (this is what prevents the wrong-environment class of confusion).
app.get('/health', async () => {
  const result = await query('SELECT now() as time');
  return {
    status: 'ok',
    db_time: result.rows[0].time,
    env: envSummary(),
  };
});

const port = Number(process.env.PORT) || 3000;
// Bind 0.0.0.0 (not localhost) so the platform/proxy can reach the app. Railway,
// Render, Fly, etc. route to the container's external interface; binding only to
// localhost would make the service unreachable and fail health checks.
const host = process.env.HOST || '0.0.0.0';

try {
  await app.listen({ port, host });
  console.log(`Server running on ${host}:${port} [APP_ENV=${APP_ENV}]`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
