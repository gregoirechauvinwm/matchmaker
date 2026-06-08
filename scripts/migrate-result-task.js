// scripts/migrate-result-task.js
// Adds task_id to prompt_results so the back-office can draw task dividers at the
// exact result where a task transition happens (transitions are intra-turn now).
// Run once: npm run migrate:result-task. Idempotent.

import { pool } from '../src/db/pool.js';

async function main() {
  await pool.query(`ALTER TABLE prompt_results ADD COLUMN IF NOT EXISTS task_id uuid`);
  // Backfill existing rows with their turn's task_id (best-effort for history).
  await pool.query(`
    UPDATE prompt_results pr SET task_id = t.task_id
      FROM turns t WHERE pr.turn_id = t.id AND pr.task_id IS NULL
  `);
  console.log('result-task migration complete.');
  await pool.end();
}
main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
