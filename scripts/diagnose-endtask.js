// Find the most recent turn whose evaluation returned END_TASK and dump it fully.
import { pool } from '../src/db/pool.js';
async function main() {
  const ev = await pool.query(
    `SELECT pr.turn_id FROM prompt_results pr
      WHERE pr.prompt_type='evaluation' AND pr.output ILIKE '%END_TASK%'
      ORDER BY pr.created_at DESC LIMIT 1`);
  if (!ev.rows[0]) { console.log('No END_TASK turn found.'); await pool.end(); return; }
  const turnId = ev.rows[0].turn_id;

  const t = await pool.query(
    `SELECT t.id, t.seq, t.user_message, t.task_id, tk.name AS task_name, tk.position, tk.is_active,
            length(COALESCE(tk.end_message,'')) AS end_msg_len, length(COALESCE(tk.initial_thought,'')) AS it_len,
            tk.max_user_messages
       FROM turns t LEFT JOIN tasks tk ON tk.id=t.task_id WHERE t.id=$1`, [turnId]);
  console.log('\n=== END_TASK TURN ===');
  console.log(t.rows[0]);

  const next = await pool.query(
    "SELECT id, name, position, length(COALESCE(initial_thought,'')) AS it_len FROM tasks WHERE is_active=true AND position > $1 ORDER BY position ASC LIMIT 1",
    [t.rows[0].position]);
  console.log('\nNEXT task by position:', next.rows[0] || '(NONE - last task)');

  const r = await pool.query(
    `SELECT seq_in_turn, prompt_type, status, left(COALESCE(output,''),70) AS output
       FROM prompt_results WHERE turn_id=$1 ORDER BY seq_in_turn ASC NULLS LAST, created_at ASC`, [turnId]);
  console.log('\n=== RESULTS (by seq_in_turn) ===');
  console.table(r.rows.map(x=>({seq:x.seq_in_turn, type:x.prompt_type, status:x.status, output:x.output})));

  // Are seq_in_turn values populated? (did the migration run?)
  const nullseq = r.rows.filter(x=>x.seq_in_turn==null).length;
  console.log(`\nseq_in_turn NULL count: ${nullseq} of ${r.rows.length} (if >0, migration not applied to these rows)`);
  await pool.end();
}
main().catch(e=>{console.error(e.message);process.exit(1);});
