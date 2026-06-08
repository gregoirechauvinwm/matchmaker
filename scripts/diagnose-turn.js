// Dumps the most recent turn's full execution in true order. Read-only.
import { pool } from '../src/db/pool.js';
async function main() {
  const t = await pool.query(
    `SELECT t.id, t.seq, t.user_message, t.task_id, tk.name AS task_name, tk.position, tk.is_active,
            length(COALESCE(tk.end_message,'')) AS end_msg_len,
            length(COALESCE(tk.initial_thought,'')) AS it_len
       FROM turns t LEFT JOIN tasks tk ON tk.id = t.task_id
      ORDER BY t.seq DESC LIMIT 1`);
  const turn = t.rows[0];
  console.log('\n=== LAST TURN ===');
  console.log(turn);

  const next = await pool.query(
    'SELECT name, position FROM tasks WHERE is_active=true AND position > $1 ORDER BY position ASC LIMIT 1',
    [turn.position]);
  console.log('\nnext task by position:', next.rows[0] || '(NONE - this is the last task)');

  const r = await pool.query(
    `SELECT seq_in_turn, prompt_type, status, left(COALESCE(output,''),60) AS output_preview,
            left(COALESCE(resolved_prompt,''),0) AS _
       FROM prompt_results WHERE turn_id=$1 ORDER BY seq_in_turn ASC NULLS LAST, created_at ASC`,
    [turn.id]);
  console.log('\n=== RESULTS (true order) ===');
  console.table(r.rows.map(x => ({ seq: x.seq_in_turn, type: x.prompt_type, status: x.status, output: x.output_preview })));

  // Show whether the speaker's resolved prompt contained the end_message text.
  const sp = await pool.query(
    `SELECT resolved_prompt FROM prompt_results WHERE turn_id=$1 AND prompt_type='speaker' ORDER BY seq_in_turn ASC LIMIT 1`,
    [turn.id]);
  if (sp.rows[0]) {
    const rp = sp.rows[0].resolved_prompt || '';
    console.log('\n=== SPEAKER resolved_prompt: does it contain "Private guidance"? ===');
    console.log(rp.includes('Private guidance') ? 'YES - whisperer block rendered' : 'NO - whisperer block was empty/omitted');
    console.log('\n--- speaker resolved_prompt (first 600 chars) ---\n' + rp.slice(0, 600));
  }
  await pool.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
