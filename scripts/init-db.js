// scripts/init-db.js
// Runs the schema file against your Neon database to create all the tables.
// Run it once with:  npm run db:init
// Safe to re-run only if you first drop existing tables; for now it's a
// one-time setup. If a table already exists you'll get an error - that just
// means the schema is already loaded.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from '../src/db/pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, '..', 'src', 'db', 'schema.sql');

async function main() {
  const sql = readFileSync(schemaPath, 'utf8');
  console.log('Loading schema into the database...');
  await pool.query(sql);
  console.log('Done. Tables created.');
  await pool.end();
}

main().catch((err) => {
  console.error('Schema load failed:');
  console.error(err.message);
  process.exit(1);
});
