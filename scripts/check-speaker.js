import { pool } from '../src/db/pool.js';
const r = await pool.query("SELECT body FROM prompts WHERE prompt_type='speaker'");
const body = r.rows[0]?.body || '';
console.log('=== SPEAKER PROMPT BODY ===\n' + body);
console.log('\n=== CHECKS ===');
console.log('contains {{whisperer}}:', body.includes('{{whisperer}}') || body.includes('{{ whisperer }}'));
console.log('contains {% if whisperer %}:', /\{%\s*if\s+whisperer\s*%\}/.test(body));
await pool.end();
