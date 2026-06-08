// src/lib/config-versions.js
// The heart of Model A. The live tables (prompts, tasks, parts) are the DRAFT.
// The latest config_versions row is the PUBLISHED config the pipeline reads.
//
//   publish()          serialize current draft tables -> new snapshot
//   getPublished()     the latest snapshot (what the pipeline uses)
//   ensureInitial()    if no real version exists, auto-snapshot the draft as v1
//   cancelToPublished()overwrite draft tables from latest snapshot
//   reloadVersion(id)  overwrite draft tables from a chosen snapshot
//   listVersions()     for the version-history UI
//
// Snapshot shape (JSONB in config_versions.snapshot):
//   { prompts: [{prompt_type, body, model}],
//     parts:   [{name, body}],
//     tasks:   [{id, name, position, is_active, instruction, evaluation,
//                initial_thought, end_message, max_user_messages, has_pretask_hook}],
//     flow_opener: "..." }
// Tasks keep their id in the snapshot so progression (which is keyed on live
// task ids) stays consistent with what was published.

import { query, pool } from '../db/pool.js';
import { PERSONA } from './config.js';

// --- read the draft tables into a snapshot object --------------------------
async function readDraft() {
  const prompts = await query('SELECT prompt_type, body, model FROM prompts ORDER BY prompt_type');
  const parts = await query('SELECT name, body FROM parts ORDER BY name');
  const tasks = await query(
    `SELECT id, name, position, is_active, instruction, evaluation,
            initial_thought, end_message, max_user_messages, has_pretask_hook
       FROM task_types ORDER BY position`
  );
  const cfg = await query('SELECT flow_opener, payment_prompt, payment_success, rate_prompt, rate_success FROM app_config WHERE id = 1');
  return {
    prompts: prompts.rows,
    parts: parts.rows,
    tasks: tasks.rows,
    flow_opener: cfg.rows[0]?.flow_opener ?? PERSONA.flowOpener,
    payment_prompt: cfg.rows[0]?.payment_prompt ?? '',
    payment_success: cfg.rows[0]?.payment_success ?? '',
    rate_prompt: cfg.rows[0]?.rate_prompt ?? '',
    rate_success: cfg.rows[0]?.rate_success ?? '',
  };
}

// --- publish: snapshot the draft as a new version -------------------------
export async function publish(label = null, publishedBy = 'admin') {
  const snapshot = await readDraft();
  const res = await query(
    `INSERT INTO config_versions (snapshot, label, published_by)
     VALUES ($1, $2, $3) RETURNING id, published_at`,
    [JSON.stringify(snapshot), label, publishedBy]
  );
  return res.rows[0];
}

// --- the latest published snapshot (what the pipeline reads) ---------------
// We treat the placeholder version (snapshot has no `prompts`) as "not real".
export async function getPublished() {
  const res = await query(
    `SELECT id, snapshot, published_at
       FROM config_versions
      WHERE snapshot ? 'prompts'
      ORDER BY published_at DESC
      LIMIT 1`
  );
  return res.rows[0] || null;
}

// --- ensure there is at least one real published version -------------------
// Called on first editor load (and by the pipeline as a safety net): if no
// real version exists yet, snapshot the current seeded draft as v1.
export async function ensureInitial() {
  const published = await getPublished();
  if (published) return published;
  return publish('initial', 'system');
}

// --- list versions for history UI -----------------------------------------
export async function listVersions() {
  const res = await query(
    `SELECT id, label, published_by, published_at,
            (snapshot ? 'prompts') AS is_real
       FROM config_versions
      ORDER BY published_at DESC`
  );
  return res.rows;
}

export async function getVersion(id) {
  const res = await query('SELECT id, snapshot, label, published_at FROM config_versions WHERE id = $1', [id]);
  return res.rows[0] || null;
}

// --- restore draft tables from a snapshot ----------------------------------
// Used by cancel (latest) and reload (chosen). Overwrites prompts and parts
// wholesale. For tasks we upsert by id and deactivate any not present, so that
// users still pointing at a task id keep a valid row.
async function restoreDraftFrom(snapshot) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Prompts: upsert each, by type.
    for (const p of snapshot.prompts || []) {
      await client.query(
        `INSERT INTO prompts (prompt_type, body, model)
         VALUES ($1, $2, $3)
         ON CONFLICT (prompt_type)
         DO UPDATE SET body = EXCLUDED.body, model = EXCLUDED.model, updated_at = now()`,
        [p.prompt_type, p.body, p.model]
      );
    }

    // Parts: clear and re-insert (parts have no foreign keys).
    await client.query('DELETE FROM parts');
    for (const part of snapshot.parts || []) {
      await client.query('INSERT INTO parts (name, body) VALUES ($1, $2)', [part.name, part.body]);
    }

    // Tasks: upsert by id; deactivate any live task not in the snapshot (we
    // never hard-delete, to keep replay + in-flight users valid).
    const ids = [];
    for (const t of snapshot.tasks || []) {
      ids.push(t.id);
      await client.query(
        `INSERT INTO task_types (id, name, position, is_active, instruction, evaluation,
                            initial_thought, end_message, max_user_messages, has_pretask_hook)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO UPDATE SET
           name=EXCLUDED.name, position=EXCLUDED.position, is_active=EXCLUDED.is_active,
           instruction=EXCLUDED.instruction, evaluation=EXCLUDED.evaluation,
           initial_thought=EXCLUDED.initial_thought, end_message=EXCLUDED.end_message,
           max_user_messages=EXCLUDED.max_user_messages, has_pretask_hook=EXCLUDED.has_pretask_hook,
           updated_at=now()`,
        [t.id, t.name, t.position, t.is_active, t.instruction, t.evaluation,
         t.initial_thought, t.end_message, t.max_user_messages, t.has_pretask_hook]
      );
    }
    if (ids.length > 0) {
      await client.query(
        `UPDATE task_types SET is_active = false WHERE id <> ALL($1::uuid[])`,
        [ids]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function cancelToPublished() {
  const published = await getPublished();
  if (!published) return;
  await restoreDraftFrom(published.snapshot);
}

export async function reloadVersion(id) {
  const v = await getVersion(id);
  if (!v) throw new Error('version not found');
  await restoreDraftFrom(v.snapshot);
}

// Write an entire config (from the editor's in-memory working copy) into the
// draft tables in one transaction, then publish it as a new snapshot. This is
// the single save action: prompts, tasks (incl. new ones + order), and parts
// all committed together, then snapshotted.
//
// config = { prompts:[{prompt_type,body,model}],
//            parts:[{id?,name,body}],
//            tasks:[{id?,name,position,is_active,instruction,evaluation,
//                    initial_thought,end_message,max_user_messages,has_pretask_hook}] }
export async function saveAndPublish(config, label = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Prompts: upsert by type.
    for (const p of config.prompts || []) {
      await client.query(
        `INSERT INTO prompts (prompt_type, body, model) VALUES ($1,$2,$3)
         ON CONFLICT (prompt_type) DO UPDATE SET body=EXCLUDED.body, model=EXCLUDED.model, updated_at=now()`,
        [p.prompt_type, p.body, p.model]
      );
    }

    // Parts: replace the set with what the editor holds.
    await client.query('DELETE FROM parts');
    for (const part of config.parts || []) {
      await client.query('INSERT INTO parts (name, body) VALUES ($1,$2)', [part.name, part.body]);
    }

    // Tasks: upsert provided (existing keep id; new get one); position by array
    // order; any active task not present is deactivated (soft-delete).
    const keptIds = [];
    const tasks = config.tasks || [];
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      const position = i + 1;
      if (t.id) {
        keptIds.push(t.id);
        await client.query(
          `UPDATE task_types SET name=$2, position=$3, is_active=$4, instruction=$5, evaluation=$6,
                  initial_thought=$7, end_message=$8, max_user_messages=$9, has_pretask_hook=$10, updated_at=now()
            WHERE id=$1`,
          [t.id, t.name, position, t.is_active !== false, t.instruction, t.evaluation,
           t.initial_thought, t.end_message, t.max_user_messages, t.has_pretask_hook || false]
        );
      } else {
        const r = await client.query(
          `INSERT INTO task_types (name, position, is_active, instruction, evaluation,
                              initial_thought, end_message, max_user_messages, has_pretask_hook)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [t.name, position, t.is_active !== false, t.instruction, t.evaluation,
           t.initial_thought, t.end_message, t.max_user_messages, t.has_pretask_hook || false]
        );
        keptIds.push(r.rows[0].id);
      }
    }
    if (keptIds.length > 0) {
      await client.query(`UPDATE task_types SET is_active=false WHERE id <> ALL($1::uuid[])`, [keptIds]);
    }

    // App-wide editable settings: the scripted lines.
    if (typeof config.flow_opener === 'string' ||
        typeof config.payment_prompt === 'string' ||
        typeof config.payment_success === 'string' ||
        typeof config.rate_prompt === 'string' ||
        typeof config.rate_success === 'string') {
      await client.query(
        `INSERT INTO app_config (id, flow_opener, payment_prompt, payment_success, rate_prompt, rate_success)
         VALUES (1, $1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           flow_opener     = COALESCE($1, app_config.flow_opener),
           payment_prompt  = COALESCE($2, app_config.payment_prompt),
           payment_success = COALESCE($3, app_config.payment_success),
           rate_prompt     = COALESCE($4, app_config.rate_prompt),
           rate_success    = COALESCE($5, app_config.rate_success)`,
        [
          config.flow_opener ?? null,
          config.payment_prompt ?? null,
          config.payment_success ?? null,
          config.rate_prompt ?? null,
          config.rate_success ?? null,
        ]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Snapshot the freshly-written draft.
  return publish(label, 'admin');
}
