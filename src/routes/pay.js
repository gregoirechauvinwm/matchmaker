// src/routes/pay.js
// The payment page and its data.
//   GET /pay/:token            -> serves the payment page (static HTML)
//   GET /pay/:token/data       -> JSON the page needs (user photo, look-for image,
//                                 next-Tuesday label, price options)
// Step 2a: no Stripe yet. The pay buttons trigger a mock "processing" state.
// Step 2b will add the create-payment-intent + Stripe Element.

import { join } from 'node:path';
import { getPaymentLink, nextTuesday, lookForImage, PRICE_OPTIONS, priceOptionById, isPaymentLinkPaid } from '../lib/payments.js';
import { getProfile } from '../lib/users.js';
import { stripe, STRIPE_PUBLISHABLE_KEY } from '../lib/stripe.js';

export default async function payRoutes(app) {
  const publicDir = join(process.cwd(), 'public');

  // The page itself. We always serve the same HTML; it fetches its data by token.
  // IMPORTANT: this route's :token wildcard would otherwise also match static
  // assets like /pay/humans.png. If the token looks like a file (has an
  // extension), serve that asset from public/pay/ instead of the HTML page.
  app.get('/pay/:token', async (request, reply) => {
    const t = request.params.token || '';
    if (/\.[a-z0-9]{2,5}$/i.test(t)) {
      // It's an asset request (e.g. humans.png, pola-frame.png) - serve the file.
      return reply.sendFile(`pay/${t}`, publicDir);
    }
    return reply.sendFile('pay/pay.html', publicDir);
  });

  // Data for the page, resolved from the obscure token.
  app.get('/pay/:token/data', async (request, reply) => {
    const link = await getPaymentLink(request.params.token);
    if (!link) return reply.code(404).send({ error: 'invalid_or_expired' });

    const profile = await getProfile(link.user_id);
    const tue = nextTuesday();
    const userPhoto = Array.isArray(profile?.photos) && profile.photos.length > 0 ? profile.photos[0] : null;

    return {
      title_relative: tue.relative,          // "in 3 days" | "tomorrow"
      date_label: tue.label,                 // "Tues Apr 28 - 8PM"
      user_photo: userPhoto,                 // R2 url or null
      look_for_image: lookForImage(profile?.gender_pref),
      already_paid: !!link.paid_at,
      publishable_key: STRIPE_PUBLISHABLE_KEY,
      options: PRICE_OPTIONS.map((o) => ({
        id: o.id, tokens: o.tokens, amount_cents: o.amount_cents,
        label: o.label, sub: o.sub, discount: o.discount,
      })),
    };
  });

  // Status endpoint the return page polls: has the webhook marked this paid yet?
  // Direct lookup (ignores expiry) so a just-paid link always reports paid.
  app.get('/pay/:token/status', async (request, reply) => {
    const paid = await isPaymentLinkPaid(request.params.token);
    return { paid };
  });

  // Where Stripe redirects after the customer completes payment. Step 3 makes
  // this poll for webhook confirmation; for now it serves the same page shell
  // which shows a confirming state and returns to chat.
  app.get('/pay/:token/return', async (request, reply) => {
    return reply.sendFile('pay/return.html', publicDir);
  });

  // Create a PaymentIntent for the chosen option.
  app.post('/pay/:token/intent', async (request, reply) => {
    const link = await getPaymentLink(request.params.token);
    if (!link) return reply.code(404).send({ error: 'invalid_or_expired' });
    if (link.paid_at) return reply.code(409).send({ error: 'already_paid' });

    const optionId = request.body?.option_id;
    const option = priceOptionById(optionId);
    if (!option) return reply.code(400).send({ error: 'bad_option' });

    try {
      const intent = await stripe.paymentIntents.create({
        amount: option.amount_cents,
        currency: 'usd',
        automatic_payment_methods: { enabled: true },
        metadata: {
          pay_token: link.token,
          user_id: link.user_id,
          option_id: option.id,
          tokens: String(option.tokens),
        },
      });
      return { client_secret: intent.client_secret };
    } catch (err) {
      request.log.error({ err }, 'stripe intent create failed');
      return reply.code(500).send({ error: 'intent_failed' });
    }
  });
}
