// scripts/migrate-task-instances.js
// Step B: per-user task EXECUTION instances. `task_types` = definitions (shared);
// `tasks` = one row per (user, task_type) run, carrying the status.
//   status: 'started'   -> task opened, not finished
//           'completed' -> ended via [END_TASK] or cap hit (neutral end)
//           'accepted'  -> ended via [ACCEPT]
//           'refused'   -> ended via [REFUSE]
// Keyed uniquely by (user_id, task_type_id): a user runs each task type once.
// Idempotent. Run once: npm run migrate:task-instances.

import { pool } from '../src/db/pool.js';

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       uuid        NOT NULL REFERENCES users(id),
      task_type_id  uuid        NOT NULL REFERENCES task_types(id),
      status        text        NOT NULL DEFAULT 'started'
                      CHECK (status IN ('started','completed','accepted','refused')),
      started_at    timestamptz NOT NULL DEFAULT now(),
      decided_at    timestamptz,
      UNIQUE (user_id, task_type_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks (user_id)`);
  console.log('task-instances migration complete.');
  await pool.end();
}
main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
