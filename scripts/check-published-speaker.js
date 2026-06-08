import { pool } from '../src/db/pool.js';
// The pipeline reads the latest REAL published snapshot.
const v = await pool.query(
  `SELECT id, label, published_at, snapshot FROM config_versions
    WHERE snapshot ? 'prompts' ORDER BY published_at DESC LIMIT 1`);
const row = v.rows[0];
console.log('Latest published version:', row.label, row.id, row.published_at);
const sp = (row.snapshot.prompts || []).find(p => p.prompt_type === 'speaker');
console.log('\n=== PUBLISHED speaker body ===\n' + (sp?.body || '(none)'));
console.log('\ncontains {{whisperer}}:', (sp?.body||'').includes('{{whisperer}}'));
console.log('contains {% if whisperer %}:', /\{%\s*if\s+whisperer\s*%\}/.test(sp?.body||''));

// Also: what version did the END_TASK turn actually use?
const t = await pool.query(
  `SELECT config_version_id, resolved_prompt FROM prompt_results
    WHERE turn_id='e9a4ad9c-cffc-4f01-905e-e5c9daf37d5d' AND prompt_type='speaker'
    ORDER BY seq_in_turn ASC LIMIT 1`);
console.log('\n=== The END_TASK turn (seq 7) closing speaker ===');
console.log('config_version used:', t.rows[0]?.config_version_id);
console.log('\nresolved_prompt actually sent:\n' + (t.rows[0]?.resolved_prompt || '(none)'));
await pool.end();
