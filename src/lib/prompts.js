// src/lib/prompts.js
// Reads the four pipeline prompts from the database. Each prompt has a body
// (the template) and a model. Step 5a only uses the speaker; 5b uses all four.

import { query } from '../db/pool.js';

// Return { body, model } for a prompt type, or null if not seeded.
export async function getPrompt(promptType) {
  const res = await query(
    'SELECT body, model FROM prompts WHERE prompt_type = $1',
    [promptType]
  );
  return res.rows[0] || null;
}

// Return all parts as a { name: body } map for template includes.
export async function getParts() {
  const res = await query('SELECT name, body FROM parts');
  const map = {};
  for (const row of res.rows) map[row.name] = row.body;
  return map;
}
