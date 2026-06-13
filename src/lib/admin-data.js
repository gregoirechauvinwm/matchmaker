// src/lib/admin-data.js
// Read queries for the back-office conversation view.

import { query, pool } from '../db/pool.js';

// All users, newest first, with enough to show in the list and a status.
// By default hides archived users; pass includeArchived=true to show them.
export async function listUsers(includeArchived = false) {
  const res = await query(
    `SELECT u.id, u.phone_e164, u.phone_entered, u.created_at, u.completed_at,
            u.name, u.photos, u.archived_at, u.status,
            u.current_task_id, u.current_task_user_message_count,
            u.token_count, u.onboarding_done,
            u.phone_verified_at, u.email, u.birth_date, u.gender,
            u.gender_pref, u.partner_age_min, u.neighborhood, u.education,
            u.has_kids, u.ethnicity, u.religion, u.chosen_amata,
            t.name AS current_task_name
       FROM users u
       LEFT JOIN task_types t ON t.id = u.current_task_id
      ${includeArchived ? '' : 'WHERE u.archived_at IS NULL'}
      ORDER BY u.created_at DESC`
  );
  return res.rows;
}

// Archive / unarchive: reversible, hides from the default list only. Does not
// touch the user's data or their login - an archived user can still log in.
export async function archiveUser(userId) {
  await query(`UPDATE users SET archived_at = now() WHERE id = $1`, [userId]);
}
export async function unarchiveUser(userId) {
  await query(`UPDATE users SET archived_at = NULL WHERE id = $1`, [userId]);
}

// Hard delete: removes the user and ALL their data, in one transaction. After
// this the phone number is free again - re-registering starts a fresh account.
//
// Order matters: child rows whose FKs do NOT cascade must go first, then the
// user row (whose deletion cascades turns->prompt_results, media, rating_*).
//   non-cascading: payment_links, tasks
//   cascading on user delete: turns (->prompt_results), media,
//                             rating_sessions (->ratings, ->rating_session_photos),
//                             rating_links
export async function deleteUser(userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM payment_links WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM tasks WHERE user_id = $1`, [userId]);
    const res = await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await client.query('COMMIT');
    return { deleted: res.rowCount > 0 };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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
