// src/lib/stripe.js
// Stripe client, initialized from env. Use TEST keys in development.
// Required env vars:
//   STRIPE_SECRET_KEY        - sk_test_... (server-side; never sent to the client)
//   STRIPE_PUBLISHABLE_KEY   - pk_test_... (safe to expose to the browser)
//   STRIPE_WEBHOOK_SECRET    - whsec_...   (Step 3, for verifying webhook signatures)

import Stripe from 'stripe';

if (!process.env.STRIPE_SECRET_KEY) {
  console.warn('[stripe] STRIPE_SECRET_KEY is not set - payment endpoints will fail until it is.');
}

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_missing', {
  // Pin a stable API version so behavior doesn't shift under us.
  apiVersion: '2025-09-30.preview',
});

export const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
