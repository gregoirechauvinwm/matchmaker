// src/routes/rsvp.js
// The RSVP / no-show-fee page and its data. This is the ALTERNATIVE to the
// pay-upfront paywall: the date is free, but we save a card (Stripe SetupIntent,
// $0.00 shown now) so a $30 cancellation/no-show fee can be charged later
// off-session. Charging the fee itself is handled off-app (a manual process),
// so there is no charge endpoint here.
//
//   GET  /rsvp/:token          -> serves the RSVP page (static HTML)
//   GET  /rsvp/:token/data     -> JSON the page needs (photos, date label, key)
//   GET  /rsvp/:token/status   -> has the card been saved yet (webhook-confirmed)
//   GET  /rsvp/:token/return   -> Stripe redirect target after confirmSetup
//   POST /rsvp/:token/intent   -> creates a SetupIntent, returns client_secret
//
// SLICE 1 NOTE: this route is directly reachable for any valid payment_links
// token (no eval-keyword wiring yet) so the Apple Pay / card $0.00 rendering can
// be verified on a real device via staging + Stripe test mode. The eval keyword
// [SEND_RSVP] routing and the analytics `kind` differentiation come next.

import { join } from 'node:path';
import { getPaymentLink, nextTuesday, lookForImage } from '../lib/payments.js';
import { getProfile } from '../lib/users.js';
import { stripe, STRIPE_PUBLISHABLE_KEY } from '../lib/stripe.js';

export default async function rsvpRoutes(app) {
  const publicDir = join(process.cwd(), 'public');

  // The page itself. Like /pay, the :token wildcard would also catch static
  // assets (e.g. /rsvp/torn-edge.png) - if the token looks like a file, serve
  // it from public/pay/ (assets are shared with the paywall).
  app.get('/rsvp/:token', async (request, reply) => {
    const t = request.params.token || '';
    if (/\.[a-z0-9]{2,5}$/i.test(t)) {
      return reply.sendFile(`pay/${t}`, publicDir);
    }
    return reply.sendFile('pay/rsvp.html', publicDir);
  });

  // Data for the page, resolved from the token.
  app.get('/rsvp/:token/data', async (request, reply) => {
    const link = await getPaymentLink(request.params.token);
    if (!link) return reply.code(404).send({ error: 'invalid_or_expired' });

    const profile = await getProfile(link.user_id);
    const tue = nextTuesday();
    const userPhoto = Array.isArray(profile?.photos) && profile.photos.length > 0 ? profile.photos[0] : null;

    return {
      title_relative: tue.relative,
      date_label: tue.label,                 // "Tues Apr 28 - 8PM"
      user_photo: userPhoto,
      look_for_image: lookForImage(profile?.gender_pref),
      already_confirmed: !!link.paid_at,     // reuse paid_at as "card saved" marker
      publishable_key: STRIPE_PUBLISHABLE_KEY,
    };
  });

  // Has the card been saved (webhook-confirmed) yet?
  app.get('/rsvp/:token/status', async (request, reply) => {
    const link = await getPaymentLink(request.params.token);
    return { confirmed: !!(link && link.paid_at) };
  });

  // Stripe redirects here after confirmSetup. Serve the dedicated RSVP return
  // page (separate from the paywall's, so the copy is correct by construction).
  app.get('/rsvp/:token/return', async (request, reply) => {
    return reply.sendFile('pay/rsvp-return.html', publicDir);
  });

  // Create a SetupIntent (save card for a later off-session $30 fee). Shows
  // $0.00 now - no money moves. metadata carries the token + a kind marker so
  // the webhook can record this as a card-authorization (vs a token purchase).
  app.post('/rsvp/:token/intent', async (request, reply) => {
    const link = await getPaymentLink(request.params.token);
    if (!link) return reply.code(404).send({ error: 'invalid_or_expired' });
    if (link.paid_at) return reply.code(409).send({ error: 'already_confirmed' });

    try {
      const intent = await stripe.setupIntents.create({
        usage: 'off_session',                // we will charge later, off-session
        automatic_payment_methods: { enabled: true },
        metadata: {
          pay_token: link.token,
          user_id: link.user_id,
          kind: 'rsvp_card',
        },
      });
      return { client_secret: intent.client_secret };
    } catch (err) {
      request.log.error({ err }, 'stripe setup intent create failed');
      return reply.code(500).send({ error: 'intent_failed' });
    }
  });
}
