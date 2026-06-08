// src/db/pool.js
// One shared connection pool to the Neon Postgres database.
// Every part of the app that needs the database imports `query` from here,
// so we open connections in exactly one place.

import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error('Missing DATABASE_URL. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// Neon requires SSL. The connection string already includes sslmode=require,
// and node-postgres honours it; this extra setting keeps local dev smooth.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Small helper so callers write `query('SELECT ...', [params])`
// instead of reaching into the pool object directly.
export function query(text, params) {
  return pool.query(text, params);
}
