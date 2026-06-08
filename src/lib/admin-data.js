// src/lib/admin-data.js
// Read queries for the back-office conversation view.

import { query } from '../db/pool.js';

// All users, newest first, with enough to show in the list and a status.
export async function listUsers() {
  const res = await query(
    `SELECT u.id, u.phone_e164, u.created_at, u.completed_at,
            u.name, u.photos,
            u.current_task_id, u.current_task_user_message_count,
            t.name AS current_task_name
       FROM users u
       LEFT JOIN task_types t ON t.id = u.current_task_id
      ORDER BY u.created_at DESC`
  );
  return res.rows;
}

export async function getUserBasic(userId) {
  const res = await query('SELECT * FROM users WHERE id = $1', [userId]);
  return res.rows[0] || null;
}

// A user's full conversation: every turn in order, each with its prompt_results
export async function getConversation(userId) {
  const turns = await query(
    `SELECT id, seq, user_message, task_id, created_at
       FROM turns
      WHERE user_id = $1
      ORDER BY seq ASC`,
    [userId]
  );

  const results = await query(
    `SELECT pr.turn_id, pr.prompt_type, pr.resolved_prompt, pr.output,
            pr.status, pr.fell_back_to, pr.model, pr.config_version_id,
            pr.latency_ms, pr.prompt_tokens, pr.completion_tokens,
            pr.created_at, pr.seq_in_turn, pr.task_id,
            tk.name AS task_name
       FROM prompt_results pr
       JOIN turns t ON t.id = pr.turn_id
       LEFT JOIN task_types tk ON tk.id = pr.task_id
      WHERE t.user_id = $1
      ORDER BY pr.seq_in_turn ASC NULLS LAST, pr.created_at ASC`,
    [userId]
  );

  // Group results by turn.
  const byTurn = new Map();
  for (const r of results.rows) {
    if (!byTurn.has(r.turn_id)) byTurn.set(r.turn_id, []);
    byTurn.get(r.turn_id).push(r);
  }

  return turns.rows.map((t) => ({
    ...t,
    results: byTurn.get(t.id) || [],
  }));
}
