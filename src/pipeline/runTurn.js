// src/pipeline/runTurn.js
// THE FULL PIPELINE (Model A). Reads prompts + parts from the PUBLISHED config
// snapshot (not the live draft tables). Task identity/progression uses live
// task rows by id. Stamps every result with the published version's id.
//
// Yields events: typing / bubble / done.

import { query } from '../db/pool.js';
import { SPEAKER as SPEAKER_FALLBACK } from '../lib/config.js';
import { renderTemplate } from '../lib/template.js';
import { streamSpeaker } from '../lib/openai.js';
import { chunkIntoSentences } from '../lib/chunker.js';
import { buildHistories } from '../lib/history.js';
import { runDetection, runEvaluation, runWhisperer, runInitialThought } from './helpers.js';
import { getTaskById, getNextTask, getFirstTask, setCurrentTask, markComplete, startTaskInstance, finishTaskInstance, getUserTaskOutcomes } from '../lib/tasks.js';
import { getPublished, ensureInitial } from '../lib/config-versions.js';
import { promptFromSnapshot, partsFromSnapshot } from '../lib/published-config.js';
import { userContext } from '../lib/users.js';
import { createPaymentLink } from '../lib/payments.js';
import { createRatingLink } from '../lib/ratings.js';

function buildContext({ user, task, histories, detection = '', whisperer = '', initialThought = '', parts = {}, outcomes = [], isClosing = false }) {
  const u = userContext(user);
  // outcomes: list of {task_name, status}. Expose as a map for branching, e.g.
  // {% if outcomes['Dating criteria'] == 'accepted' %}. Also the CURRENT task's
  // status as {{task_status}} (e.g. 'accepted'|'refused'|'completed'|'started').
  const outcomeMap = {};
  for (const o of outcomes) { if (o && o.task_name) outcomeMap[o.task_name] = o.status; }
  const taskStatus = task ? (outcomeMap[task.name] || '') : '';

  // Base context for rendering TASK FIELDS (so {{user.name}}, {{chat_history}},
  // {{initial_thought}} etc. inside a task's instruction/end_message/initial_thought
  // actually resolve). We deliberately exclude `task` here to avoid self-reference
  // loops - a task field referencing itself stays literal.
  const fieldCtx = {
    user: u,
    detection, whisperer,
    initial_thought: initialThought,
    outcomes: outcomeMap,
    task_status: taskStatus,
    chat_history: histories.chat_history,
    chat_history_with_whisperer: histories.chat_history_with_whisperer,
    random: Math.random(),
  };
  const renderField = (s) => {
    if (!s) return s;
    const r = renderTemplate(s, fieldCtx, parts);
    return r.ok ? r.text : s;
  };

  const renderedTask = task
    ? {
        name: task.name,
        instruction: renderField(task.instruction),
        evaluation: renderField(task.evaluation),
        initial_thought: renderField(task.initial_thought),
        end_message: renderField(task.end_message),
        data: {},
      }
    : { data: {} };

  return {
    user: u,
    task: renderedTask,
    features: {},
    detection,
    whisperer,
    // Result of the per-task initial-thought call (empty when none/timed out).
    // `{% if initial_thought %}` is truthy only when a result exists.
    initial_thought: initialThought,
    // The task's initial_thought *instruction* field (rendered), for the IT prompt.
    initial_thought_instruction: renderedTask.initial_thought || '',
    task_instruction: renderedTask.instruction || '',
    // Per-user task outcomes for branching in prompts/task fields.
    outcomes: outcomeMap,
    task_status: taskStatus,
    // True ONLY on the turn that closes the current task (END_TASK/ACCEPT/REFUSE
    // or cap-hit). Lets the speaker branch: {% if is_closing %}...{% endif %}.
    // `end_message` is that task's rendered end_message text, for convenience.
    is_closing: isClosing,
    end_message: isClosing ? (renderedTask.end_message || '') : '',
    chat_history: histories.chat_history,
    chat_history_with_whisperer: histories.chat_history_with_whisperer,
  };
}

async function saveResult(turnId, rec, configVersionId, seq, taskId) {
  await query(
    `INSERT INTO prompt_results
       (turn_id, prompt_type, resolved_prompt, output, status, fell_back_to, model,
        latency_ms, prompt_tokens, completion_tokens, config_version_id, seq_in_turn, task_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [turnId, rec.prompt_type, rec.resolved_prompt, rec.output ?? null, rec.status,
     rec.fell_back_to ?? null, rec.model ?? null, rec.latency_ms ?? null,
     rec.prompt_tokens ?? null, rec.completion_tokens ?? null, configVersionId, seq ?? null, taskId ?? null]
  );
}

export async function* runTurn({ userId, turnId, openFirstTask = false }) {
  yield { type: 'typing' };

  // Per-turn monotonic counter -> deterministic display order in the back-office
  // (created_at ties at sub-second granularity, so it cannot be relied on).
  let _seq = 0;
  const nextSeq = () => ++_seq;

  // Published config snapshot drives prompts + parts (Model A).
  const published = (await getPublished()) || (await ensureInitial());
  const snapshot = published.snapshot;
  const configVersionId = published.id;
  const parts = partsFromSnapshot(snapshot);

  const userRow = await query('SELECT * FROM users WHERE id = $1', [userId]);
  const user = userRow.rows[0] || { id: userId };

  // Per-user task outcomes (for {{outcomes}} / {{task_status}} branching).
  let outcomes = await getUserTaskOutcomes(userId);

  // --- FIRST-TASK ENTRY ----------------------------------------------------
  // The user's first message is pre-task (no detection/eval/whisperer). Enter
  // Task 1 and emit its opener (initial_thought -> speaker), exactly like a task
  // transition's opener. Then we're done for this turn.
  if (openFirstTask) {
    const first = await getFirstTask();
    if (!first) { yield { type: 'done' }; return; }
    await setCurrentTask(userId, first.id);
    await startTaskInstance(userId, first.id);
    const histories0 = await buildHistories(userId);   // includes the just-stored 1st user msg
    const itText = await openTask({ userId, taskId: first.id, snapshot, parts, configVersionId, turnId, histories: histories0, user, nextSeq });
    const firstOutcomes = await getUserTaskOutcomes(userId);
    const openerCtx = buildContext({
      user, task: first, histories: histories0, parts, outcomes: firstOutcomes,
      detection: '', whisperer: '', initialThought: itText,
    });
    yield { type: 'typing' };
    yield* speakerMessage({ snapshot, parts, configVersionId, turnId, nextSeq, taskId: first.id, ctx: openerCtx });
    yield { type: 'done' };
    return;
  }

  let task = await getTaskById(user.current_task_id);
  let histories = await buildHistories(userId);

  // Open the current task if it hasn't been opened yet (NULL marker). This runs
  // the initial-thought ONCE per task - here it covers the very first task (and
  // any task whose thought wasn't computed at transition time). Subsequent turns
  // see a non-NULL marker and skip. Proactive openers set the marker themselves.
  if (task && user.current_task_initial_thought == null) {
    await startTaskInstance(userId, task.id);
    const itText = await openTask({ userId, taskId: task.id, snapshot, parts, configVersionId, turnId, histories, user, nextSeq });
    user.current_task_initial_thought = itText;
  }

  // --- detection + evaluation in parallel ---------------------------------
  const baseContext = buildContext({
    user, task, histories, parts, outcomes,
    initialThought: user.current_task_initial_thought || '',
  });
  const [detRes, evalRes] = await Promise.all([
    runDetection({ promptRow: promptFromSnapshot(snapshot, 'detection'), context: baseContext, parts }),
    runEvaluation({ promptRow: promptFromSnapshot(snapshot, 'evaluation'), context: baseContext, parts }),
  ]);
  const curTaskId = task?.id ?? null;
  await saveResult(turnId, detRes.record, configVersionId, nextSeq(), curTaskId);
  await saveResult(turnId, evalRes.record, configVersionId, nextSeq(), curTaskId);

  // --- [SEND_PAYMENT]: skip whisperer + speaker, inject a scripted payment
  // prompt message + a payment-card bubble, and STAY in the current task. -----
  if (evalRes.value === 'SEND_PAYMENT') {
    // Mark whisperer + speaker skipped (for the back-office transcript).
    await saveResult(turnId, {
      prompt_type: 'whisperer', resolved_prompt: '(skipped: send payment)',
      output: null, status: 'skipped', model: null,
    }, configVersionId, nextSeq(), curTaskId);
    await saveResult(turnId, {
      prompt_type: 'speaker', resolved_prompt: '(skipped: send payment)',
      output: null, status: 'skipped', model: null,
    }, configVersionId, nextSeq(), curTaskId);

    // 1) Scripted payment prompt message (editable; rendered with user context).
    const promptCtx = buildContext({ user, task, histories, parts, outcomes });
    const rawPrompt = snapshot?.payment_prompt || '';
    const renderedPrompt = renderTemplate(rawPrompt, promptCtx, parts);
    const promptText = (renderedPrompt.ok ? renderedPrompt.text : rawPrompt) || 'Here is your link to secure your spot.';
    await saveResult(turnId, {
      prompt_type: 'speaker', resolved_prompt: '(scripted: payment prompt)',
      output: promptText, status: 'ok', model: null,
    }, configVersionId, nextSeq(), curTaskId);
    yield { type: 'typing' };
    yield { type: 'bubble', text: promptText };

    // 2) Payment-card bubble. Stored as a speaker result whose TEXT is
    // "Payment link sent" (used by {{chat_history}} + back-office). The chat UI
    // renders it as a card via the `kind: 'payment_card'` event. Generate a fresh
    // obscure /pay/{token} link tied to this user.
    const payToken = await createPaymentLink(userId);
    const payUrl = `/pay/${payToken}`;
    await saveResult(turnId, {
      prompt_type: 'speaker', resolved_prompt: `(scripted: payment card)|${payUrl}`,
      output: 'Payment link sent', status: 'ok', model: null,
    }, configVersionId, nextSeq(), curTaskId);
    yield { type: 'bubble', kind: 'payment_card', text: 'Payment link sent', payUrl };

    yield { type: 'done' };
    return;
  }

  // --- [RATE_PHOTOS]: skip whisperer + speaker, inject a scripted prompt
  // message + a rating-card bubble, and STAY in the current task. Twin of
  // [SEND_PAYMENT]; the only difference is the destination (/rate vs /pay) and
  // that completion is driven by the user finishing the rating page (which
  // calls fulfillRating to inject the success line), not by a webhook. --------
  if (evalRes.value === 'RATE_PHOTOS') {
    // Mark whisperer + speaker skipped (for the back-office transcript).
    await saveResult(turnId, {
      prompt_type: 'whisperer', resolved_prompt: '(skipped: rate photos)',
      output: null, status: 'skipped', model: null,
    }, configVersionId, nextSeq(), curTaskId);
    await saveResult(turnId, {
      prompt_type: 'speaker', resolved_prompt: '(skipped: rate photos)',
      output: null, status: 'skipped', model: null,
    }, configVersionId, nextSeq(), curTaskId);

    // 1) Scripted rating prompt message (editable; rendered with user context).
    const promptCtx = buildContext({ user, task, histories, parts, outcomes });
    const rawPrompt = snapshot?.rate_prompt || '';
    const renderedPrompt = renderTemplate(rawPrompt, promptCtx, parts);
    const promptText = (renderedPrompt.ok ? renderedPrompt.text : rawPrompt) || 'Your physical preferences';
    await saveResult(turnId, {
      prompt_type: 'speaker', resolved_prompt: '(scripted: rate prompt)',
      output: promptText, status: 'ok', model: null,
    }, configVersionId, nextSeq(), curTaskId);

    // Mint the link + (find-or-create) the session NOW, before the first bubble,
    // so this DB work happens while the typing indicator is up rather than in a
    // visible gap between the line and the card.
    const rateToken = await createRatingLink(userId);
    const rateUrl = `/rate/${rateToken}`;

    yield { type: 'typing' };
    yield { type: 'bubble', text: promptText };

    // 2) Rating-card bubble. Stored as a speaker result whose TEXT is "Rating
    // link sent" (used by {{chat_history}} + back-office). The chat UI renders
    // it as a card via the `kind: 'rate_card'` event.
    await saveResult(turnId, {
      prompt_type: 'speaker', resolved_prompt: `(scripted: rate card)|${rateUrl}`,
      output: 'Rating link sent', status: 'ok', model: null,
    }, configVersionId, nextSeq(), curTaskId);
    yield { type: 'bubble', kind: 'rate_card', text: 'Rating link sent', rateUrl };

    yield { type: 'done' };
    return;
  }

  // --- closing decision ----------------------------------------------------
  // Three tokens end a task: [END_TASK], [ACCEPT], [REFUSE]. Cap-hit also ends
  // (neutral). All behave identically for now (close + advance); the outcome is
  // recorded per-user on the task instance for future branching.
  const cap = task?.max_user_messages ?? null;
  const count = user.current_task_user_message_count ?? 0;
  const capHit = cap != null && count >= cap;
  const endsByToken = evalRes.value === 'END_TASK' || evalRes.value === 'ACCEPT' || evalRes.value === 'REFUSE';
  const closing = !!task && (endsByToken || capHit);
  // Map the closing reason to an instance status.
  const closingStatus =
    evalRes.value === 'ACCEPT' ? 'accepted' :
    evalRes.value === 'REFUSE' ? 'refused' :
    'completed';   // END_TASK or cap-hit

  // For the CLOSING message, the end_message should be able to branch on the
  // outcome just decided (it isn't persisted until the transition below). So
  // build an outcomes view that reflects the pending status for this task.
  const speakerOutcomes = (closing && task)
    ? [...outcomes.filter((o) => o.task_type_id !== task.id), { task_name: task.name, task_type_id: task.id, status: closingStatus }]
    : outcomes;

  // --- whisperer (skipped when closing) -----------------------------------
  let whispererText = '';
  if (closing) {
    whispererText = task.end_message || '';
    await saveResult(turnId, {
      prompt_type: 'whisperer', resolved_prompt: '(skipped: task closing)',
      output: null, status: 'skipped', model: null,
    }, configVersionId, nextSeq(), curTaskId);
  } else {
    const wRes = await runWhisperer({ promptRow: promptFromSnapshot(snapshot, 'whisperer'), context: baseContext, parts });
    whispererText = wRes.value;
    await saveResult(turnId, wRes.record, configVersionId, nextSeq(), curTaskId);
  }

  // --- speaker (closing or normal message) --------------------------------
  yield* speakerMessage({
    snapshot, parts, configVersionId, turnId, nextSeq, taskId: curTaskId,
    ctx: buildContext({
      user, task, histories, parts, outcomes: speakerOutcomes,
      detection: detRes.value, whisperer: whispererText,
      initialThought: user.current_task_initial_thought || '',
      isClosing: closing,
    }),
  });

  // --- task transition: close, advance, open the next task, emit its opener --
  if (closing && task) {
    // Record this task's per-user outcome (accepted/refused/completed).
    await finishTaskInstance(userId, task.id, closingStatus);

    const next = await getNextTask(task.position);
    if (next) {
      await setCurrentTask(userId, next.id);
      // Mark the new task started for this user.
      await startTaskInstance(userId, next.id);
      // Open the new task NOW (same turn): run its initial-thought once, persist
      // it, then emit the task's first message proactively.
      const itText = await openTask({ userId, taskId: next.id, snapshot, parts, configVersionId, turnId, histories, user, nextSeq });
      // Rebuild histories so the opener sees the full conversation INCLUDING the
      // closing message that was just sent. Refresh outcomes so the opener can
      // branch on the just-closed task's status and sees the new task 'started'.
      const openerHistories = await buildHistories(userId);
      const openerOutcomes = await getUserTaskOutcomes(userId);
      const openerCtx = buildContext({
        user, task: next, histories: openerHistories, parts, outcomes: openerOutcomes,
        detection: '', whisperer: '', initialThought: itText,
      });
      yield { type: 'typing' };
      yield* speakerMessage({ snapshot, parts, configVersionId, turnId, nextSeq, taskId: next.id, ctx: openerCtx });
    } else {
      await markComplete(userId);
    }
  }

  yield { type: 'done' };
}

// Render + stream the speaker for a given context, saving the result. Shared by
// the normal/closing message and the proactive opener so there is ONE speaker
// path. Yields bubble/typing events.
async function* speakerMessage({ snapshot, parts, configVersionId, turnId, ctx, nextSeq, taskId }) {
  const speakerPrompt = promptFromSnapshot(snapshot, 'speaker');
  const speakerBody = speakerPrompt?.body ?? SPEAKER_FALLBACK.prompt;
  const speakerModel = speakerPrompt?.model ?? SPEAKER_FALLBACK.model;
  const speakerRender = renderTemplate(speakerBody, ctx, parts);
  const prompt = speakerRender.ok ? speakerRender.text : speakerBody;

  let full = '';
  let sawAny = false;
  let speakerStatus = 'ok';
  let speakerUsage = { promptTokens: null, completionTokens: null, durationMs: null };
  const speakerT0 = Date.now();

  try {
    const tokens = streamSpeaker({ model: speakerModel, prompt, onUsage: (u) => { speakerUsage = u; } });
    for await (const sentence of chunkIntoSentences(tokens)) {
      full += (full ? ' ' : '') + sentence;
      sawAny = true;
      yield { type: 'bubble', text: sentence };
      yield { type: 'typing' };
    }
    if (!sawAny) {
      full = "Sorry, I lost my train of thought - can you say that again?";
      speakerStatus = 'fallback';
      yield { type: 'bubble', text: full };
    }
  } catch {
    full = "Sorry, something hiccuped on my end. Could you try that again?";
    speakerStatus = 'error';
    yield { type: 'bubble', text: full };
  }

  await saveResult(turnId, {
    prompt_type: 'speaker', resolved_prompt: prompt, output: full,
    status: speakerStatus, model: speakerModel,
    latency_ms: speakerUsage.durationMs ?? (Date.now() - speakerT0),
    prompt_tokens: speakerUsage.promptTokens,
    completion_tokens: speakerUsage.completionTokens,
  }, configVersionId, nextSeq ? nextSeq() : null, taskId ?? null);
}

// Open a task: run its initial-thought prompt ONCE (10s timeout inside the
// helper), persist the result on the user for the task's lifetime, and return
// the text (''=none). Called when a task becomes the user's current task.
async function openTask({ userId, taskId, snapshot, parts, configVersionId, turnId, histories, user, nextSeq }) {
  const task = await getTaskById(taskId);
  if (!task) { await query('UPDATE users SET current_task_initial_thought = NULL WHERE id = $1', [userId]); return ''; }
  const ctx = buildContext({ user, task, histories, parts });
  const res = await runInitialThought({ promptRow: promptFromSnapshot(snapshot, 'initial_thought'), context: ctx, parts });
  await saveResult(turnId, res.record, configVersionId, nextSeq ? nextSeq() : null, taskId);
  // Store '' (not NULL) so "opened, produced nothing" is distinct from "not yet
  // opened" (NULL). runTurn opens a task lazily only when this is NULL.
  await query('UPDATE users SET current_task_initial_thought = $1 WHERE id = $2', [res.value || '', userId]);
  return res.value || '';
}
