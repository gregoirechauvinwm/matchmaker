// src/lib/openai.js
// Wrapper around the OpenAI SDK. The rendered prompt is the ENTIRE payload,
// sent as a single system message; nothing else is added.
//
// Both functions also report usage (token counts) and duration so the back-office
// can show them.

import OpenAI from 'openai';
import 'dotenv/config';

if (!process.env.OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY. Add it to your .env file.');
}

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Stream the speaker. `prompt` is the sole system message. Yields token chunks.
// Calls onUsage({ promptTokens, completionTokens, durationMs }) once at the end
// (best-effort; usage requires stream_options.include_usage).
export async function* streamSpeaker({ model, prompt, onUsage }) {
  const start = Date.now();
  const stream = await client.chat.completions.create({
    model,
    messages: [{ role: 'system', content: prompt }],
    stream: true,
    stream_options: { include_usage: true },
  });

  let usage = null;
  for await (const chunk of stream) {
    if (chunk?.usage) usage = chunk.usage; // final chunk carries usage
    const delta = chunk?.choices?.[0]?.delta?.content;
    if (delta) yield delta;
  }

  if (typeof onUsage === 'function') {
    onUsage({
      promptTokens: usage?.prompt_tokens ?? null,
      completionTokens: usage?.completion_tokens ?? null,
      durationMs: Date.now() - start,
    });
  }
}

// Single non-streaming completion for helper prompts. Returns
// { text, promptTokens, completionTokens, durationMs }.
export async function complete({ model, prompt, maxTokens }) {
  const start = Date.now();
  const res = await client.chat.completions.create({
    model,
    messages: [{ role: 'system', content: prompt }],
    stream: false,
    max_tokens: maxTokens,
  });
  return {
    text: (res?.choices?.[0]?.message?.content || '').trim(),
    promptTokens: res?.usage?.prompt_tokens ?? null,
    completionTokens: res?.usage?.completion_tokens ?? null,
    durationMs: Date.now() - start,
  };
}
