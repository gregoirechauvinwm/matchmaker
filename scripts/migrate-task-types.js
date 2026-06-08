// scripts/migrate-task-types.js
// Step A of the task_types/tasks split: rename the DEFINITION table `tasks` to
// `task_types`. Pure rename, no behavior change. The per-user instance table
// (also called `tasks`) is added later in Step B.
// The index idx_tasks_position is renamed alongside for clarity.
// Idempotent: only renames if `tasks` still exists and `task_types` does not.
// Run once: npm run migrate:task-types.

import { pool } from '../src/db/pool.js';

async function main() {
  const exists = async (t) => {
    const r = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = $1 AND table_schema = current_schema()`,
      [t]
    );
    return r.rows.length > 0;
  };

  const hasTasks = await exists('tasks');
  const hasTaskTypes = await exists('task_types');

  if (hasTaskTypes && !hasTasks) {
    console.log('Already migrated: task_types exists, tasks does not. Nothing to do.');
    await pool.end();
    return;
  }
  if (!hasTasks) {
    console.log('No `tasks` table found; nothing to rename.');
    await pool.end();
    return;
  }
  if (hasTaskTypes && hasTasks) {
    throw new Error('Both `tasks` and `task_types` exist. Resolve manually before running.');
  }

  await pool.query('ALTER TABLE tasks RENAME TO task_types');
  // Rename the index if present (non-fatal if it isn't).
  try { await pool.query('ALTER INDEX idx_tasks_position RENAME TO idx_task_types_position'); } catch {}
  console.log('Renamed tasks -> task_types.');
  await pool.end();
}
main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
