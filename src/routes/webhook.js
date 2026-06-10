// src/routes/webhook.js
// Stripe webhook - the SOURCE OF TRUTH for payments. Stripe calls this endpoint
// directly when a payment completes. We verify the signature, then on
// payment_intent.succeeded we grant tokens + inject the success message.
//
// Signature verification needs the RAW request body (not JSON-parsed), so this
// route registers its own content-type parser on an encapsulated instance.
//
// Local dev: use the Stripe CLI to forward events and get a signing secret:
//   stripe listen --forward-to localhost:3000/webhook
// then put the printed whsec_... into .env as STRIPE_WEBHOOK_SECRET.

import { stripe, STRIPE_WEBHOOK_SECRET } from '../lib/stripe.js';
import { fulfillPayment } from '../lib/payments.js';

export default async function webhookRoutes(app) {
  // Capture the raw body as a Buffer for this encapsulated instance only.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => { done(null, body); }
  );

  app.post('/webhook', async (request, reply) => {
    const sig = request.headers['stripe-signature'];
    let event;

    try {
      if (STRIPE_WEBHOOK_SECRET) {
        event = stripe.webhooks.constructEvent(request.body, sig, STRIPE_WEBHOOK_SECRET);
      } else {
        // No secret configured (e.g. very early dev) - parse without verifying.
        // NOT for production; set STRIPE_WEBHOOK_SECRET.
        request.log.warn('STRIPE_WEBHOOK_SECRET not set - webhook signature NOT verified');
        event = JSON.parse(request.body.toString('utf8'));
      }
    } catch (err) {
      request.log.error({ err: err.message }, 'webhook signature verification failed');
      return reply.code(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object;
      const payToken = pi.metadata?.pay_token;
      const tokens = pi.metadata?.tokens;
      const amountCents = typeof pi.amount === 'number' ? pi.amount : null;
      if (payToken) {
        try {
          const result = await fulfillPayment({ payToken, tokens, amountCents });
          request.log.info({ result }, 'payment fulfilled');
        } catch (err) {
          request.log.error({ err: err.message }, 'fulfillPayment failed');
          // Return 500 so Stripe retries (fulfillment is idempotent, so retries
          // are safe).
          return reply.code(500).send('fulfillment_failed');
        }
      }
    }

    // Acknowledge receipt so Stripe stops retrying.
    return reply.code(200).send({ received: true });
  });
}
