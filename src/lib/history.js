// src/lib/history.js
// Renders the conversation into the two history strings the templates use.
// Format (exact):
//   {{chat_history}}                 one line per turn: "ai: ..." / "user: ..."
//   {{chat_history_with_whisperer}}  same, but each ai line is preceded by its
//                                    "thinking: ..." line (the whisperer result)
// Lowercase labels, colon, space, one line per entry.

import { query } from '../db/pool.js';

// Pull the ordered turns for a user, with the speaker output and whisperer
// output for each turn. Returns rows in seq order.
async function loadTurns(userId) {
  const res = await query(
    `SELECT
        t.seq,
        t.user_message,
        sp.output  AS ai_output,
        wh.output  AS whisperer_output
      FROM turns t
      LEFT JOIN prompt_results sp
        ON sp.turn_id = t.id AND sp.prompt_type = 'speaker'
      LEFT JOIN prompt_results wh
        ON wh.turn_id = t.id AND wh.prompt_type = 'whisperer'
      WHERE t.user_id = $1
      ORDER BY t.seq ASC`,
    [userId]
  );
  return res.rows;
}

// Build both history strings. The ordering within a turn is:
//   (the user's message for that turn, if any) then
//   (the whisperer "thinking" line, if any - only in the _with_whisperer view)
//   (the ai message for that turn, if any)
// Because the opener turn has an ai message with no user message, and a normal
// turn has user then ai, walking turns in seq order and emitting user-before-ai
// per turn yields the correct interleaved transcript.
export async function buildHistories(userId) {
  const turns = await loadTurns(userId);

  const plain = [];
  const withWhisperer = [];

  for (const t of turns) {
    if (t.user_message) {
      const line = `user: ${t.user_message}`;
      plain.push(line);
      withWhisperer.push(line);
    }
    if (t.ai_output) {
      if (t.whisperer_output) {
        withWhisperer.push(`thinking: ${t.whisperer_output}`);
      }
      const aiLine = `ai: ${t.ai_output}`;
      plain.push(aiLine);
      withWhisperer.push(aiLine);
    }
  }

  return {
    chat_history: plain.join('\n'),
    chat_history_with_whisperer: withWhisperer.join('\n'),
  };
}
