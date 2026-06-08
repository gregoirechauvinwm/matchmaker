// scripts/migrate-user-archive.js
// Adds users.archived_at: NULL = active (shown in the list), a timestamp = archived
// (hidden unless "show archived" is on). Archiving is reversible; it does not touch
// the user's data or their ability to log in - it only affects the back-office list.
import { pool } from '../src/db/pool.js';

async function main() {
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS archived_at timestamptz`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_archived ON users (archived_at)`);
  console.log('user-archive migration complete (users.archived_at).');
  await pool.end();
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
