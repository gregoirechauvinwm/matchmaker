// Read-only diagnostic. Changes nothing.
import { pool } from '../src/db/pool.js';
async function main() {
  const prompts = await pool.query('SELECT prompt_type, length(body) AS body_len, model FROM prompts ORDER BY prompt_type');
  console.log('\n=== PROMPTS (draft table) ===');
  console.table(prompts.rows);

  const tasks = await pool.query('SELECT id, name, position, is_active FROM tasks ORDER BY position');
  console.log('\n=== TASKS (draft table) ===');
  console.table(tasks.rows);

  const versions = await pool.query(
    `SELECT id, label, published_at,
            (snapshot ? 'prompts') AS has_prompts,
            jsonb_array_length(COALESCE(snapshot->'prompts','[]'::jsonb)) AS n_prompts,
            jsonb_array_length(COALESCE(snapshot->'tasks','[]'::jsonb)) AS n_tasks
       FROM config_versions ORDER BY published_at DESC LIMIT 10`
  );
  console.log('\n=== CONFIG VERSIONS (published snapshots, newest first) ===');
  console.table(versions.rows);

  await pool.end();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
