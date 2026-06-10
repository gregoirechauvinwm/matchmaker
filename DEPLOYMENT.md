# Deployment & Environments

This is the operational runbook for Blind Tuesdate. It describes the three
environments, how code flows to each, how the database is handled, and the exact
procedures for deploys, migrations, and the rating-photo seed.

## The three environments

```
git branch        Railway env      Neon database          external services
──────────        ───────────      ─────────────          ─────────────────
(local)      ───►  —          ───►  dev Neon branch   ───►  Stripe TEST, SMS dev-bypass
staging      ───►  staging     ───►  staging Neon branch ─►  Stripe TEST, SMS dev-bypass, shared R2
main         ───►  production  ───►  prod Neon branch   ───►  Stripe LIVE, Twilio live, prod R2
```

Each environment has its OWN database. Never share a database between
environments. Railway's environment duplication intentionally does NOT copy
database data, which is what we want.

## The deploy loop

1. Edit locally, run against the **dev** Neon branch.
2. `git push origin staging` → Railway **staging** auto-deploys.
3. Test on a real phone against staging (SMS uses the dev-bypass code, Stripe is
   in test mode — use Stripe test cards).
4. Merge `staging` → `main` (`git checkout main && git merge staging && git push`)
   → Railway **production** auto-deploys.

## Migrations (now automatic on deploy)

`railway.json` defines a **pre-deploy command**: `ALLOW_PROD_WRITE=1 npm run
migrate:all`. It runs after the build and BEFORE the new version takes traffic.
If it fails, the deploy is aborted and the previous version keeps serving.

- Migrations are idempotent (`IF NOT EXISTS`), so this no-ops when there's no
  schema change.
- It runs on BOTH staging and production deploys — so you always exercise a
  migration on staging first.
- You normally never run migrations by hand anymore. If you must (e.g. a
  one-off), see the guard rules below.

## The migration / seed guard (reads before it writes)

Any script that writes to the DB (`migrate:all`, `seed:rating-photos`) prints
its target database host first and **refuses to run against a prod-looking
database** unless explicitly authorized. "Prod-looking" = `APP_ENV=production`,
or a `sk_live_` Stripe key is present, or the host matches `PROD_DB_HOST`.

To authorize a prod write, either pass `--prod` or set `ALLOW_PROD_WRITE=1`
(the pre-deploy command uses the latter, since deploying to prod is exactly when
a prod migration is intended).

This guard exists because a seed once silently wrote to the dev DB for hours.

## The rating-photo seed (still manual — needs your local images)

Pool images live only on your local disk (`public/rate/pool/{male,female,nonbinary}/`,
git-ignored). The seed uploads them to R2 and writes their public URLs into the
`rating_photos` table. It must run from your machine but target the intended DB.

**Seed staging:**
```
DATABASE_URL='<staging-neon-url>' npm run seed:rating-photos
```

**Seed production (explicit opt-in required):**
```
DATABASE_URL='<prod-neon-url>' npm run seed:rating-photos -- --prod
```

After ANY pool change, three things must stay in sync: R2 files, `rating_photos`
rows, and per-user frozen sessions. So after re-seeding, clear sessions so they
re-freeze with the current photos:
```
DELETE FROM rating_session_photos;
DELETE FROM rating_sessions;
```

## Confirming which environment you're hitting

`GET /health` returns a secret-free summary:
```json
{ "status": "ok", "db_time": "...",
  "env": { "app_env": "staging", "db_host": "ep-...neon.tech/neondb",
           "stripe_mode": "test", "sms": "dev-bypass", "services": { ... } } }
```
Check `app_env` and `db_host` whenever you're unsure. The boot log also prints
`[APP_ENV=...]`.

## Per-environment variable matrix

| Variable                  | local (dev)      | staging          | production        |
|---------------------------|------------------|------------------|-------------------|
| APP_ENV                   | development      | staging          | production        |
| NODE_ENV                  | development      | development*     | production        |
| DATABASE_URL              | dev Neon branch  | staging branch   | prod branch       |
| OPENAI_API_KEY            | ✓                | ✓                | ✓                 |
| ADMIN_PASSWORD            | ✓                | ✓                | ✓ (strong)        |
| COOKIE_SECRET             | optional         | ✓                | ✓ (required)      |
| STRIPE_SECRET_KEY         | sk_test_         | sk_test_         | sk_live_          |
| STRIPE_PUBLISHABLE_KEY    | pk_test_         | pk_test_         | pk_live_          |
| STRIPE_WEBHOOK_SECRET     | from Stripe CLI  | staging whsec_   | prod whsec_       |
| TWILIO_* (3 vars)         | blank (bypass)   | blank (bypass)   | ✓ (required)      |
| R2_* (5 vars)             | ✓ (shared)       | ✓ (shared)       | ✓                 |

*staging keeps `NODE_ENV=development` ON PURPOSE so the SMS dev-bypass stays
active (no real texts) — `APP_ENV=staging` is what labels it as staging. The
boot validator (`src/lib/env.js`) only enforces full prod requirements when
`APP_ENV=production`.

## First-time setup of a fresh database (e.g. the staging branch)

```
DATABASE_URL='<staging-url>' npm run db:init
DATABASE_URL='<staging-url>' npm run migrate:all
DATABASE_URL='<staging-url>' npm run seed:prompts
DATABASE_URL='<staging-url>' npm run seed:tasks
DATABASE_URL='<staging-url>' npm run seed:rating-photos
```
