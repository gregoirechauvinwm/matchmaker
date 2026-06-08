// scripts/migrate-initial-thought.js
// Replaces the per-task `first_whisperer` field with `initial_thought` (a field
// of instructions for a preliminary reasoning call), and adds a place on users
// to persist that call's result for the active task. Run once:
//   npm run migrate:initial-thought
// Idempotent.

import { pool } from '../src/db/pool.js';

async function main() {
  // Rename first_whisperer -> initial_thought if the old column still exists.
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='tasks' AND column_name='first_whisperer') THEN
        ALTER TABLE tasks RENAME COLUMN first_whisperer TO initial_thought;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='tasks' AND column_name='initial_thought') THEN
        ALTER TABLE tasks ADD COLUMN initial_thought text;
      END IF;
    END $$;
  `);

  // The result of the initial-thought call for the user's CURRENT task.
  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS current_task_initial_thought text
  `);

  // The 5th prompt type. Seed an empty initial_thought prompt row if absent.
  await pool.query(`
    INSERT INTO prompts (prompt_type, body, model)
    SELECT 'initial_thought', '', 'gpt-4.1-mini'
    WHERE NOT EXISTS (SELECT 1 FROM prompts WHERE prompt_type='initial_thought')
  `);

  console.log('initial_thought migration complete.');
  await pool.end();
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
