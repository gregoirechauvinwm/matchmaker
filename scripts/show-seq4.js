import { pool } from '../src/db/pool.js';
const u = await pool.query("SELECT id FROM users WHERE phone_e164='+16464999555'");
const turn = await pool.query("SELECT id FROM turns WHERE user_id=$1 AND seq=7", [u.rows[0].id]);
const r = await pool.query(
  `SELECT seq_in_turn, resolved_prompt FROM prompt_results
    WHERE turn_id=$1 AND prompt_type='speaker' ORDER BY seq_in_turn ASC`, [turn.rows[0].id]);
r.rows.forEach(row => {
  console.log(`\n========= SPEAKER seq${row.seq_in_turn} resolved_prompt =========`);
  // show just the task + guidance region
  const m = row.resolved_prompt.match(/current task[\s\S]{0,400}/i);
  console.log(m ? m[0] : row.resolved_prompt.slice(0,400));
});
await pool.end();
