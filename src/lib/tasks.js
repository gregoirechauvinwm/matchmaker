// src/lib/tasks.js
// Task progression: which task a user is on, advancing to the next active task,
// and starting the flow. Progression only ever considers is_active = true tasks,
// ordered by position.

import { query } from '../db/pool.js';

// All active tasks in order.
export async function getActiveTasks() {
  const res = await query(
    'SELECT * FROM task_types WHERE is_active = true ORDER BY position ASC'
  );
  return res.rows;
}

export async function getTaskById(id) {
  if (!id) return null;
  const res = await query('SELECT * FROM task_types WHERE id = $1', [id]);
  return res.rows[0] || null;
}

// The first active task (where a brand-new user's flow begins).
export async function getFirstTask() {
  const res = await query(
    'SELECT * FROM task_types WHERE is_active = true ORDER BY position ASC LIMIT 1'
  );
  return res.rows[0] || null;
}

// The next active task after a given position, or null if that was the last.
export async function getNextTask(afterPosition) {
  const res = await query(
    'SELECT * FROM task_types WHERE is_active = true AND position > $1 ORDER BY position ASC LIMIT 1',
    [afterPosition]
  );
  return res.rows[0] || null;
}

// Set the user's current task and reset their per-task message count.
export async function setCurrentTask(userId, taskId) {
  await query(
    `UPDATE users
        SET current_task_id = $2, current_task_user_message_count = 0,
            current_task_initial_thought = NULL
      WHERE id = $1`,
    [userId, taskId]
  );
}

// Increment the user's per-task user-message count and return the new value.
export async function incrementUserMessageCount(userId) {
  const res = await query(
    `UPDATE users
        SET current_task_user_message_count = current_task_user_message_count + 1
      WHERE id = $1
      RETURNING current_task_user_message_count`,
    [userId]
  );
  return res.rows[0].current_task_user_message_count;
}

// Mark the whole flow complete.
export async function markComplete(userId) {
  await query('UPDATE users SET completed_at = now() WHERE id = $1', [userId]);
}

// --- per-user task EXECUTION instances (Step B) ----------------------------
// `task_types` are definitions; `tasks` are per-user runs carrying status.

// Mark a task as started for this user (idempotent: one instance per
// user+task_type). Called when a task opens. Does not overwrite a finished
// status if the row already exists (re-opening shouldn't reset an outcome).
export async function startTaskInstance(userId, taskTypeId) {
  if (!userId || !taskTypeId) return;
  await query(
    `INSERT INTO tasks (user_id, task_type_id, status)
     VALUES ($1, $2, 'started')
     ON CONFLICT (user_id, task_type_id) DO NOTHING`,
    [userId, taskTypeId]
  );
}

// Record the final outcome of a task for this user. status is one of
// 'completed' | 'accepted' | 'refused'. Upserts so it works even if the
// 'started' row was somehow never created.
export async function finishTaskInstance(userId, taskTypeId, status) {
  if (!userId || !taskTypeId) return;
  await query(
    `INSERT INTO tasks (user_id, task_type_id, status, decided_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id, task_type_id)
       DO UPDATE SET status = EXCLUDED.status, decided_at = now()`,
    [userId, taskTypeId, status]
  );
}

// All of a user's task instances joined to their type name, for prompts/branching.
export async function getUserTaskOutcomes(userId) {
  const res = await query(
    `SELECT tt.name AS task_name, t.task_type_id, t.status, t.decided_at
       FROM tasks t JOIN task_types tt ON tt.id = t.task_type_id
      WHERE t.user_id = $1
      ORDER BY tt.position ASC`,
    [userId]
  );
  return res.rows;
}
