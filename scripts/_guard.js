// scripts/_guard.js
// A shared safety guard for any script that WRITES to the database (migrations,
// seeds). It exists because the rating-photos saga was caused by a write
// silently hitting the wrong database. This makes the target impossible to miss
// and hard to get wrong.
//
// Behavior:
//   - Always prints the DB host + name the script is about to touch.
//   - If the target looks like PRODUCTION, it REFUSES unless the caller has
//     explicitly opted in, via either:
//        * passing --prod on the command line, or
//        * setting ALLOW_PROD_WRITE=1 in the environment.
//   - "Looks like production" = APP_ENV=production OR a Stripe LIVE key is
//     present OR the host matches a configured PROD_DB_HOST hint.
//
// This is intentionally conservative: it would rather make you type --prod than
// let an unguarded write reach real user data.

import { dbHostFromUrl, APP_ENV } from '../src/lib/env.js';

export function guardDbTarget({ scriptName = 'script' } = {}) {
  const host = dbHostFromUrl();
  const argvOptIn = process.argv.includes('--prod');
  const envOptIn = process.env.ALLOW_PROD_WRITE === '1';
  const optedIn = argvOptIn || envOptIn;

  // Heuristics for "this is production".
  const prodHint = (process.env.PROD_DB_HOST || '').trim();
  const looksProd =
    APP_ENV === 'production' ||
    (process.env.STRIPE_SECRET_KEY || '').startsWith('sk_live') ||
    (prodHint && host.includes(prodHint));

  console.log(`\n[${scriptName}] target database: ${host}`);
  console.log(`[${scriptName}] APP_ENV=${APP_ENV}  looksProd=${looksProd}  optedIn=${optedIn}`);

  if (looksProd && !optedIn) {
    console.error(
      `\n[${scriptName}] REFUSING to write: the target looks like PRODUCTION ` +
      `(${host}).\n` +
      `  If this is intentional, re-run with the --prod flag, e.g.:\n` +
      `    DATABASE_URL='<prod-url>' npm run ${scriptName} -- --prod\n` +
      `  (or set ALLOW_PROD_WRITE=1). Otherwise, check your DATABASE_URL — you may\n` +
      `  be pointed at prod when you meant dev/staging.\n`
    );
    process.exit(2);
  }

  if (looksProd && optedIn) {
    console.log(`[${scriptName}] PROD write explicitly authorized. Proceeding.\n`);
  }
}
