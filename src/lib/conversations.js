// src/lib/conversations.js
// Reading and seeding a user's conversation. The turn log is the source of
// truth: on load we rebuild the chat from turns ordered by seq. The scripted
// opener is persisted as the very first turn (with no user_message and the
// opener text as its AI output), so it shows on reload like any other message.

import { query } from '../db/pool.js';
import { PERSONA } from './config.js';
import { ensureInitial } from './config-versions.js';
import { renderTemplate } from './template.js';
import { userContext } from './users.js';

// Return the conversation as a flat list of messages the frontend can render.
// Each message: { id, role: 'user'|'ai', text, seq }.
// For Step 3 the "ai" text for a normal turn will come later (Step 4); right
// now only the opener turn has AI text.
export async function getMessages(userId) {
  const turns = await query(
    `SELECT id, seq, user_message FROM turns WHERE user_id = $1 ORDER BY seq ASC`,
    [userId]
  );
  // All AI (speaker) bubbles, in true execution order, across turns.
  const speakers = await query(
    `SELECT pr.turn_id, pr.output, pr.resolved_prompt, pr.seq_in_turn
       FROM prompt_results pr
       JOIN turns t ON t.id = pr.turn_id
      WHERE t.user_id = $1 AND pr.prompt_type = 'speaker'
        AND pr.status = 'ok' AND pr.output IS NOT NULL
      ORDER BY pr.seq_in_turn ASC NULLS LAST, pr.created_at ASC`,
    [userId]
  );
  const byTurn = new Map();
  for (const s of speakers.rows) {
    if (!byTurn.has(s.turn_id)) byTurn.set(s.turn_id, []);
    byTurn.get(s.turn_id).push(s);
  }

  const messages = [];
  for (const t of turns.rows) {
    if (t.user_message) {
      messages.push({ id: `${t.id}-u`, role: 'user', text: t.user_message, seq: t.seq });
    }
    const aiList = byTurn.get(t.id) || [];
    aiList.forEach((s, i) => {
      // The payment-card bubble is stored with text "Payment link sent" and a
      // marker in resolved_prompt: "(scripted: payment card)|/pay/{token}".
      // The rating-card bubble is the twin: "(scripted: rate card)|/rate/{token}".
      const rp = s.resolved_prompt || '';
      const isCard = rp.startsWith('(scripted: payment card)');
      const payUrl = isCard ? (rp.split('|')[1] || '/pay/placeholder') : null;
      const isRateCard = rp.startsWith('(scripted: rate card)');
      const rateUrl = isRateCard ? (rp.split('|')[1] || '/rate/placeholder') : null;
      messages.push({
        id: `${t.id}-a${i}`,
        role: 'ai',
        text: s.output,
        seq: t.seq,
        ...(isCard ? { kind: 'payment_card', payUrl } : {}),
        ...(isRateCard ? { kind: 'rate_card', rateUrl } : {}),
      });
    });
  }
  return messages;
}

// Make sure the scripted opener exists as the first turn. Called when the chat
// loads; if the user has no turns yet, we create turn seq=1 carrying the opener
// as a speaker prompt_result. Idempotent: does nothing if turns already exist.
export async function ensureOpener(userId) {
  const existing = await query(
    'SELECT 1 FROM turns WHERE user_id = $1 LIMIT 1',
    [userId]
  );
  if (existing.rows.length > 0) return;

  // Create the opener turn (no user message; it's AI-initiated).
  const turn = await query(
    `INSERT INTO turns (user_id, seq, user_message, task_id)
     VALUES ($1, 1, NULL, NULL)
     RETURNING id`,
    [userId]
  );
  const turnId = turn.rows[0].id;

  // Store the opener as a speaker result so it rebuilds like any AI message.
  // Use the real published config version (auto-creates v1 if none yet) and read
  // the editable flow_opener from its snapshot. Render it through the template
  // engine with the user context so variables like {{user.name}} resolve.
  const published = await ensureInitial();
  const rawOpener = published.snapshot?.flow_opener || PERSONA.flowOpener;
  const userRow = await query('SELECT * FROM users WHERE id = $1', [userId]);
  const user = userRow.rows[0] || {};
  const rendered = renderTemplate(rawOpener, { user: userContext(user) }, {});
  const openerText = rendered.ok ? rendered.text : rawOpener;
  await query(
    `INSERT INTO prompt_results
       (turn_id, prompt_type, resolved_prompt, output, status, config_version_id)
     VALUES ($1, 'speaker', $2, $3, 'ok', $4)`,
    [turnId, '(scripted opener - no prompt)', openerText, published.id]
  );
}

// (Config versioning now lives in src/lib/config-versions.js; the opener uses
// the real published version via ensureInitial.)
