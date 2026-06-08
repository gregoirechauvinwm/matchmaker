// Target ONE user by phone, dump their END_TASK turn(s) with each speaker's task + whisperer state.
import { pool } from '../src/db/pool.js';
const PHONE = '+16464999555';
async function main() {
  const u = await pool.query('SELECT id FROM users WHERE phone_e164=$1', [PHONE]);
  if (!u.rows[0]) { console.log('user not found'); await pool.end(); return; }
  const userId = u.rows[0].id;

  const turns = await pool.query(
    `SELECT t.id, t.seq, t.user_message, tk.name AS task_name, tk.max_user_messages
       FROM turns t LEFT JOIN tasks tk ON tk.id=t.task_id
      WHERE t.user_id=$1 ORDER BY t.seq ASC`, [userId]);

  for (const turn of turns.rows) {
    const rs = await pool.query(
      `SELECT seq_in_turn, prompt_type, status, left(COALESCE(output,''),50) AS output, resolved_prompt
         FROM prompt_results WHERE turn_id=$1 ORDER BY seq_in_turn ASC NULLS LAST, created_at ASC`, [turn.id]);
    // Only print turns that have an END_TASK or more than one speaker (the interesting ones)
    const speakers = rs.rows.filter(r=>r.prompt_type==='speaker');
    const hasEnd = rs.rows.some(r=>r.prompt_type==='evaluation' && /END_TASK/.test(r.output||''));
    if (!hasEnd && speakers.length < 2) continue;
    console.log(`\n===== TURN seq=${turn.seq} task=${turn.task_name} cap=${turn.max_user_messages} user="${turn.user_message}" =====`);
    for (const r of rs.rows) {
      let tag='';
      if (r.prompt_type==='speaker' && r.resolved_prompt){
        const m=r.resolved_prompt.match(/current task[:\s]*\n?(.{0,55})/i);
        tag=(m?m[1].replace(/\n/g,' ').trim():'') + (/Private guidance/.test(r.resolved_prompt)?'  [whisperer block PRESENT]':'  [no whisperer block]');
      }
      console.log(`  seq${r.seq_in_turn} ${r.prompt_type}/${r.status}: ${r.output}  ${tag}`);
    }
  }
  await pool.end();
}
main().catch(e=>{console.error(e.message);process.exit(1);});
