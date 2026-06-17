// src/pipeline/helpers.js
// The three helper prompts: detection, evaluation, whisperer. Each receives its
// prompt row { body, model }, renders it (the whole prompt = the entire payload),
// calls the model, and applies the error policy. Returns { value, record }.
//
// complete() returns { text, promptTokens, completionTokens, durationMs }.
// We store ONLY .text in `output`. Token counts + duration are separate metadata
// fields on the record (their own columns) - they never enter `output`, the
// transparent bubbles, the history, or the prompt text.

import { renderTemplate } from '../lib/template.js';
import { complete } from '../lib/openai.js';

function render(promptRow, context, parts) {
  if (!promptRow) return null;
  const r = renderTemplate(promptRow.body, context, parts);
  const prompt = r.ok ? r.text : promptRow.body;
  return { prompt, model: promptRow.model, resolvedPrompt: prompt };
}

// Common metadata shape pulled from a complete() result.
function meta(res, model) {
  return {
    model,
    latency_ms: res.durationMs ?? null,
    prompt_tokens: res.promptTokens ?? null,
    completion_tokens: res.completionTokens ?? null,
  };
}

export async function runDetection({ promptRow, context, parts }) {
  const r = render(promptRow, context, parts);
  if (!r) return { value: '', record: skipped('detection') };
  try {
    const res = await complete({ model: r.model, prompt: r.prompt, maxTokens: 16 });
    return {
      value: normalizeLabel(res.text),
      record: { prompt_type: 'detection', resolved_prompt: r.resolvedPrompt, output: res.text, status: 'ok', ...meta(res, r.model) },
    };
  } catch {
    return {
      value: '',
      record: { prompt_type: 'detection', resolved_prompt: r.resolvedPrompt, output: null, status: 'error', model: r.model },
    };
  }
}

export async function runEvaluation({ promptRow, context, parts }) {
  const r = render(promptRow, context, parts);
  if (!r) return { value: 'CONTINUE', record: skipped('evaluation') };
  try {
    const res = await complete({ model: r.model, prompt: r.prompt, maxTokens: 8 });
    const decision = parseEvaluation(res.text);
    return {
      value: decision,
      record: { prompt_type: 'evaluation', resolved_prompt: r.resolvedPrompt, output: res.text, status: 'ok', ...meta(res, r.model) },
    };
  } catch {
    return {
      value: 'CONTINUE',
      record: { prompt_type: 'evaluation', resolved_prompt: r.resolvedPrompt, output: null, status: 'fallback', fell_back_to: 'CONTINUE', model: r.model },
    };
  }
}

// Parse the evaluation decision. The model must emit a BRACKETED token; brackets
// are required (so a stray "I accept that" in reasoning text can't trigger an
// ending). We scan for all recognized bracket tokens and take the LAST one
// (models often reason, then conclude). Anything unrecognized -> CONTINUE.
// Returns one of: 'CONTINUE' | 'END_TASK' | 'ACCEPT' | 'REFUSE' | 'SEND_PAYMENT' | 'SEND_RSVP' | 'RATE_PHOTOS'.
export function parseEvaluation(text) {
  if (!text) return 'CONTINUE';
  const matches = String(text).toUpperCase().match(/\[(END_TASK|ACCEPT|REFUSE|SEND_PAYMENT|SEND_RSVP|RATE_PHOTOS|CONTINUE)\]/g);
  if (!matches || matches.length === 0) return 'CONTINUE';
  const last = matches[matches.length - 1].replace(/[[\]]/g, '');
  return last; // END_TASK | ACCEPT | REFUSE | SEND_PAYMENT | SEND_RSVP | RATE_PHOTOS | CONTINUE
}

export async function runWhisperer({ promptRow, context, parts }) {
  const r = render(promptRow, context, parts);
  if (!r) return { value: '', record: skipped('whisperer') };
  try {
    const res = await complete({ model: r.model, prompt: r.prompt, maxTokens: 120 });
    return {
      value: res.text,
      record: { prompt_type: 'whisperer', resolved_prompt: r.resolvedPrompt, output: res.text, status: 'ok', ...meta(res, r.model) },
    };
  } catch {
    return {
      value: '',
      record: { prompt_type: 'whisperer', resolved_prompt: r.resolvedPrompt, output: null, status: 'error', model: r.model },
    };
  }
}

// The 5th prompt: a per-task preliminary reasoning call, run ONCE when a task
// opens. Hard 10s timeout - if it doesn't return in time, we proceed without it
// (value '' -> {% if initial_thought %} is false). Never blocks a turn longer
// than the timeout.
const INITIAL_THOUGHT_TIMEOUT_MS = 10000;

export async function runInitialThought({ promptRow, context, parts }) {
  const r = render(promptRow, context, parts);
  // No prompt configured, or the task's instruction field is empty -> skip.
  if (!r || !(context.initial_thought_instruction || '').trim()) {
    return { value: '', record: skipped('initial_thought') };
  }
  const t0 = Date.now();
  try {
    const res = await Promise.race([
      complete({ model: r.model, prompt: r.prompt, maxTokens: 400 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('it_timeout')), INITIAL_THOUGHT_TIMEOUT_MS)),
    ]);
    return {
      value: res.text,
      record: { prompt_type: 'initial_thought', resolved_prompt: r.resolvedPrompt, output: res.text, status: 'ok', ...meta(res, r.model) },
    };
  } catch (err) {
    const timedOut = err && err.message === 'it_timeout';
    return {
      value: '',
      record: {
        prompt_type: 'initial_thought', resolved_prompt: r.resolvedPrompt, output: null,
        status: timedOut ? 'fallback' : 'error',
        fell_back_to: timedOut ? '(timeout: proceeded without initial thought)' : null,
        model: r.model, latency_ms: Date.now() - t0,
      },
    };
  }
}

function skipped(promptType) {
  return { prompt_type: promptType, resolved_prompt: '(not in published config)', output: null, status: 'skipped', model: null };
}

function normalizeLabel(raw) {
  const t = (raw || '').trim().toLowerCase().replace(/[^a-z_]/g, '');
  if (!t || t === 'nothing' || t === 'none') return '';
  return t;
}
