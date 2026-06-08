// scripts/migrate-app-config.js
// A single-row table holding editable app-wide draft settings (currently just
// the scripted first message, flow_opener). The editor reads/writes this draft;
// publish() snapshots it into config_versions like everything else.
// Run once: npm run migrate:app-config. Idempotent.

import { pool } from '../src/db/pool.js';

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_config (
      id          integer PRIMARY KEY DEFAULT 1,
      flow_opener text NOT NULL DEFAULT '',
      CONSTRAINT app_config_singleton CHECK (id = 1)
    )
  `);
  // Seed the single row with the current hardcoded opener if empty.
  await pool.query(`
    INSERT INTO app_config (id, flow_opener)
    VALUES (1, $1)
    ON CONFLICT (id) DO NOTHING
  `, ["Hey, glad you're interested in our next Blind Tuesdate event in Manhattan! Ready to begin?"]);
  console.log('app-config migration complete.');
  await pool.end();
}
main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
