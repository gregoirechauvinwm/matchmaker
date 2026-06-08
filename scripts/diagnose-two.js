// Dump the last ~3 turns with EVERY result, its turn, seq, task, and resolved-prompt's
// "current task" line + whether it had a whisperer block. Read-only.
import { pool } from '../src/db/pool.js';
async function main() {
  const turns = await pool.query(
    `SELECT t.id, t.seq, t.user_message, t.task_id, tk.name AS task_name,
            tk.max_user_messages
       FROM turns t LEFT JOIN tasks tk ON tk.id=t.task_id
      WHERE t.seq BETWEEN 6 AND 8
      ORDER BY t.seq ASC`);
  for (const turn of turns.rows) {
    console.log(`\n========== TURN seq=${turn.seq}  task=${turn.task_name}  cap=${turn.max_user_messages}  user="${turn.user_message}" ==========`);
    const rs = await pool.query(
      `SELECT seq_in_turn, prompt_type, status, left(COALESCE(output,''),55) AS output, resolved_prompt
         FROM prompt_results WHERE turn_id=$1 ORDER BY seq_in_turn ASC NULLS LAST, created_at ASC`, [turn.id]);
    for (const r of rs.rows) {
      let taskLine = '';
      if (r.prompt_type === 'speaker' && r.resolved_prompt) {
        const m = r.resolved_prompt.match(/current task:\s*\n?(.{0,60})/i);
        taskLine = m ? m[1].replace(/\n/g,' ').trim() : '';
        const hasWhisp = /Private guidance/.test(r.resolved_prompt);
        taskLine += hasWhisp ? '  [HAS whisperer block]' : '  [no whisperer block]';
      }
      console.log(`  seq${r.seq_in_turn} ${r.prompt_type}/${r.status}: ${r.output}  ${taskLine}`);
    }
  }
  await pool.end();
}
main().catch(e=>{console.error(e.message);process.exit(1);});
