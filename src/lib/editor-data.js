// src/lib/editor-data.js
// Read the DRAFT tables for the editor's initial load. Writing is now handled
// atomically by saveAndPublish() in config-versions.js (the editor sends the
// whole config at once), so individual write helpers are no longer needed here.

import { query } from '../db/pool.js';

export async function getDraft() {
  const prompts = await query('SELECT prompt_type, body, model FROM prompts ORDER BY prompt_type');
  const parts = await query('SELECT id, name, body FROM parts ORDER BY name');
  const tasks = await query(
    `SELECT id, name, position, is_active, instruction, evaluation,
            initial_thought, end_message, max_user_messages, has_pretask_hook
       FROM task_types ORDER BY position`
  );
  const cfg = await query('SELECT flow_opener, payment_prompt, payment_success, rate_prompt, rate_success, rsvp_prompt, rsvp_success FROM app_config WHERE id = 1');
  return {
    prompts: prompts.rows,
    parts: parts.rows,
    tasks: tasks.rows,
    flow_opener: cfg.rows[0]?.flow_opener ?? '',
    payment_prompt: cfg.rows[0]?.payment_prompt ?? '',
    payment_success: cfg.rows[0]?.payment_success ?? '',
    rate_prompt: cfg.rows[0]?.rate_prompt ?? '',
    rate_success: cfg.rows[0]?.rate_success ?? '',
    rsvp_prompt: cfg.rows[0]?.rsvp_prompt ?? '',
    rsvp_success: cfg.rows[0]?.rsvp_success ?? '',
  };
}
