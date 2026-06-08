// src/routes/chat.js
// Serves the chat page and the chat API:
//   GET  /chat            -> the chat HTML (logged-in only)
//   GET  /api/messages    -> conversation history (rebuilds the UI on load)
//   POST /api/message     -> STREAMING. Persists the user's message, runs the
//                            pipeline, and streams events back as newline-
//                            delimited JSON (one event per line).

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSessionUserId } from '../lib/session.js';
import { getUserById } from '../lib/users.js';
import { getMessages, ensureOpener } from '../lib/conversations.js';
import { query } from '../db/pool.js';
import { acquire, release } from '../lib/lock.js';
import { runTurn } from '../pipeline/runTurn.js';
import { incrementUserMessageCount } from '../lib/tasks.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', '..', 'public');

async function currentUser(request) {
  const userId = getSessionUserId(request);
  if (!userId) return null;
  return getUserById(userId);
}

export default async function chatRoutes(app) {
  app.get('/chat', async (request, reply) => {
    const user = await currentUser(request);
    if (!user) return reply.redirect('/');
    return reply.sendFile('chat.html', publicDir);
  });

  app.get('/api/messages', async (request, reply) => {
    const user = await currentUser(request);
    if (!user) return reply.code(401).send({ error: 'not_authenticated' });
    await ensureOpener(user.id);
    const messages = await getMessages(user.id);
    return { messages };
  });

  // Streaming turn. The response body is a stream of newline-delimited JSON
  // events the browser reads as they arrive.
  app.post('/api/message', async (request, reply) => {
    const user = await currentUser(request);
    if (!user) return reply.code(401).send({ error: 'not_authenticated' });

    const text = String((request.body && request.body.text) || '').trim();
    if (!text) return reply.code(400).send({ error: 'empty' });

    // One turn at a time per user.
    if (!acquire(user.id)) {
      return reply.code(409).send({ error: 'busy' });
    }

    // Flow start detection: is this the user's FIRST real message (they're not
    // on a task yet)? If so, this message is PRE-TASK - it runs no pipeline
    // (no detection/eval/whisperer). Instead it triggers Task 1's opener.
    let openFirstTask = false;
    let turnId;
    try {
      let currentTaskId = user.current_task_id;
      if (!currentTaskId && !user.completed_at) {
        // Do NOT assign the task or count the message here. The first user
        // message is pre-task; runTurn will enter Task 1 and emit its opener.
        openFirstTask = true;
      }

      // Count this user message against the current task only when we're already
      // inside a task (i.e. NOT the pre-task first message).
      if (currentTaskId) {
        await incrementUserMessageCount(user.id);
      }

      const seqRow = await query(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM turns WHERE user_id = $1',
        [user.id]
      );
      const seq = seqRow.rows[0].next;
      // Pre-task turn carries task_id NULL (it belongs to no task).
      const turn = await query(
        `INSERT INTO turns (user_id, seq, user_message, task_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [user.id, seq, text, currentTaskId || null]
      );
      turnId = turn.rows[0].id;
    } catch (err) {
      release(user.id);
      request.log.error(err);
      return reply.code(500).send({ error: 'persist_failed' });
    }

    // Switch to manual streaming mode: we write the raw response ourselves.
    reply.raw.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const write = (event) => {
      reply.raw.write(JSON.stringify(event) + '\n');
    };

    try {
      for await (const event of runTurn({ userId: user.id, turnId, openFirstTask })) {
        write(event);
      }
    } catch (err) {
      request.log.error(err);
      write({ type: 'error', message: 'pipeline_failed' });
    } finally {
      release(user.id);
      reply.raw.end();
    }

    // Tell Fastify we've handled the response ourselves.
    return reply;
  });
}
