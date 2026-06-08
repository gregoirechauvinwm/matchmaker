// src/routes/rate.js
// The photo-rating page and its data (twin of pay.js).
//   GET  /rate/:token            -> serves the rating page (static HTML)
//   GET  /rate/:token/data       -> JSON the page needs (frozen photo list,
//                                   existing scores, resume index, top text)
//   POST /rate/:token/score      -> deferred save of one 1-5 score (fire-and-forget)
//   POST /rate/:token/complete   -> when all photos scored, fulfillRating()
//                                   (idempotent: injects the success line once)
//
// Source of truth is the per-user rating_sessions row; the token just resolves
// to it. The page is fully resumable: it opens on the first unscored photo.

import { join } from 'node:path';
import { getRatingLink, getSessionView, recordScore, fulfillRating } from '../lib/ratings.js';
import { getPublished } from '../lib/config-versions.js';

export default async function rateRoutes(app) {
  const publicDir = join(process.cwd(), 'public');

  // The page itself. Same shell for everyone; it fetches its data by token.
  // The :token wildcard would also catch static assets like /rate/pool/...
  // (those are served by fastifyStatic, registered earlier) and any token that
  // looks like a file - guard with an extension check, exactly like pay.js.
  app.get('/rate/:token', async (request, reply) => {
    const t = request.params.token || '';
    if (/\.[a-z0-9]{2,5}$/i.test(t)) {
      return reply.sendFile(`rate/${t}`, publicDir);
    }
    return reply.sendFile('rate/rate.html', publicDir);
  });

  // Data for the page, resolved from the obscure token.
  app.get('/rate/:token/data', async (request, reply) => {
    const link = await getRatingLink(request.params.token);
    if (!link) return reply.code(404).send({ error: 'invalid_or_expired' });

    const view = await getSessionView(link.session_id);
    if (!view) return reply.code(404).send({ error: 'no_session' });

    const published = await getPublished();
    const topText = published?.snapshot?.rate_prompt || 'Your physical preferences';

    return {
      top_text: topText,
      photos: view.photos.map((p) => ({ id: p.photo_id, url: p.url, score: p.score })),
      total: view.total,
      scored: view.scored,
      complete: view.complete,
      resume_index: view.resume_index,
    };
  });

  // Deferred save: record one score. The page fires this fire-and-forget and
  // slides immediately, so the response is intentionally tiny.
  app.post('/rate/:token/score', async (request, reply) => {
    const link = await getRatingLink(request.params.token);
    if (!link) return reply.code(404).send({ error: 'invalid_or_expired' });

    const { photo_id, score } = request.body || {};
    if (!photo_id) return reply.code(400).send({ error: 'no_photo' });

    const res = await recordScore({ sessionId: link.session_id, photoId: photo_id, score });
    if (!res.ok) return reply.code(400).send({ error: res.error });
    return { ok: true, scored: res.scored, total: res.total, complete: res.complete };
  });

  // Completion: only fires the success line when every photo is scored.
  // Idempotent (fulfillRating claims completed_at once). The page calls this
  // after the last score, then redirects to /chat where the line is waiting.
  app.post('/rate/:token/complete', async (request, reply) => {
    const link = await getRatingLink(request.params.token);
    if (!link) return reply.code(404).send({ error: 'invalid_or_expired' });

    const result = await fulfillRating(link.session_id);
    // completed:true on the first time all-scored; false if not-yet-complete or
    // already completed. Either way the page just heads back to chat.
    return { ok: true, ...result };
  });
}
