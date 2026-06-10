// src/lib/env.js
// ONE place that reads, labels, and validates environment configuration.
//
// Two distinct concepts, deliberately separate:
//   - NODE_ENV  ('development' | 'production'): the Node convention. Drives
//     framework/library behavior and our SMS dev-bypass (see verification.js).
//     It is 'production' ONLY in true production, so staging keeps the SMS
//     bypass (no real texts) while still being a deployed, always-on env.
//   - APP_ENV   ('development' | 'staging' | 'production'): OUR human-facing
//     label for "which deployment is this". Surfaced in /health and logs so you
//     can SEE which environment + database you're talking to, and used below to
//     decide what configuration is required to boot.
//
// Importing this module has no side effects beyond reading process.env. Call
// assertEnv() once at startup (server.js) to fail fast on misconfiguration.

import 'dotenv/config';

const APP_ENVS = ['development', 'staging', 'production'];

// Resolve APP_ENV. If unset, infer a sensible default from NODE_ENV so existing
// setups keep working: NODE_ENV=production -> 'production', else 'development'.
function resolveAppEnv() {
  const raw = (process.env.APP_ENV || '').trim().toLowerCase();
  if (APP_ENVS.includes(raw)) return raw;
  return process.env.NODE_ENV === 'production' ? 'production' : 'development';
}

export const APP_ENV = resolveAppEnv();
export const isProd = APP_ENV === 'production';
export const isStaging = APP_ENV === 'staging';
export const isDev = APP_ENV === 'development';

// Pull the database host out of the connection string for display/guards.
// Never returns credentials - host (and db name) only.
export function dbHostFromUrl(url = process.env.DATABASE_URL || '') {
  try {
    const u = new URL(url);
    const db = u.pathname.replace(/^\//, '');
    return db ? `${u.host}/${db}` : u.host;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

// A compact, SECRET-FREE description of the running config. Safe to log and to
// return from /health. Shows presence (configured: true/false), never values.
export function envSummary() {
  const has = (k) => !!process.env[k];
  return {
    app_env: APP_ENV,
    node_env: process.env.NODE_ENV || '(unset)',
    db_host: dbHostFromUrl(),
    stripe_mode: (process.env.STRIPE_SECRET_KEY || '').startsWith('sk_live') ? 'live'
      : (process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test') ? 'test' : 'unset',
    sms: process.env.NODE_ENV === 'production' ? 'twilio' : 'dev-bypass',
    services: {
      database: has('DATABASE_URL'),
      openai: has('OPENAI_API_KEY'),
      stripe: has('STRIPE_SECRET_KEY'),
      stripe_webhook: has('STRIPE_WEBHOOK_SECRET'),
      twilio: has('TWILIO_ACCOUNT_SID') && has('TWILIO_AUTH_TOKEN') && has('TWILIO_VERIFY_SERVICE_SID'),
      r2: has('R2_ACCOUNT_ID') && has('R2_BUCKET') && has('R2_PUBLIC_URL')
        && has('R2_ACCESS_KEY_ID') && has('R2_SECRET_ACCESS_KEY'),
    },
  };
}

// Fail-fast validation. Always-required vars must exist in every environment;
// production additionally requires the live-traffic essentials so a misconfigured
// prod refuses to boot instead of failing deep inside a user request.
export function assertEnv() {
  const missing = [];
  const problems = [];

  // Required everywhere.
  const alwaysRequired = ['DATABASE_URL', 'OPENAI_API_KEY', 'ADMIN_PASSWORD'];
  for (const k of alwaysRequired) if (!process.env[k]) missing.push(k);

  if (isProd) {
    // Production must be fully wired for real users + real money.
    const prodRequired = [
      'STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET',
      'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_VERIFY_SERVICE_SID',
      'R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_PUBLIC_URL',
      'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
      'COOKIE_SECRET',
    ];
    for (const k of prodRequired) if (!process.env[k]) missing.push(k);

    // Guard against the classic foot-guns.
    if (process.env.NODE_ENV !== 'production') {
      problems.push("APP_ENV=production but NODE_ENV is not 'production' (this would enable the SMS dev-bypass for real users).");
    }
    if ((process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test')) {
      problems.push('APP_ENV=production but STRIPE_SECRET_KEY is a TEST key (sk_test_...).');
    }
  }

  if (missing.length || problems.length) {
    const lines = [
      `\n[env] Configuration check FAILED for APP_ENV=${APP_ENV}.`,
      ...(missing.length ? [`  Missing required variables: ${missing.join(', ')}`] : []),
      ...problems.map((p) => `  Problem: ${p}`),
      '  See env.example and DEPLOYMENT.md for the per-environment variable matrix.\n',
    ];
    throw new Error(lines.join('\n'));
  }
}
