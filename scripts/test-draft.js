// Tests the live /api/draft data source directly (read-only).
import { getDraft } from '../src/lib/editor-data.js';
const d = await getDraft();
console.log('prompts:', d.prompts.length, '->', d.prompts.map(p=>p.prompt_type).join(', '));
console.log('tasks:', d.tasks.length, '->', d.tasks.map(t=>t.name).join(', '));
console.log('parts:', d.parts.length);
process.exit(0);
