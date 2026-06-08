// scripts/migrate-result-seq.js
// Adds a per-turn sequence number to prompt_results so the back-office can show
// results in TRUE execution order (timestamps tie at sub-second granularity).
// Run once: npm run migrate:result-seq. Idempotent.

import { pool } from '../src/db/pool.js';

async function main() {
  await pool.query(`
    ALTER TABLE prompt_results
      ADD COLUMN IF NOT EXISTS seq_in_turn integer
  `);
  // Backfill existing rows by created_at order within each turn so old
  // conversations still display sensibly.
  await pool.query(`
    WITH ordered AS (
      SELECT id, row_number() OVER (PARTITION BY turn_id ORDER BY created_at ASC) AS rn
        FROM prompt_results
       WHERE seq_in_turn IS NULL
    )
    UPDATE prompt_results pr SET seq_in_turn = ordered.rn
      FROM ordered WHERE pr.id = ordered.id
  `);
  console.log('result-seq migration complete.');
  await pool.end();
}

main().catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
