import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeLogger } from './logger.js';
import { verifySignature } from './webhook/signature.js';
import { validateWebhook } from './webhook/validate.js';
import { handleEvent } from './webhook/handler.js';
import { makeConsoleDeliver } from './render.js';
import { getRazorpayKeys } from './config.js';
import * as db from './db/index.js';
import { messageFromFailureRow } from './api/failureLookup.js';
import { simulateFailure } from './api/simulate.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkoutPage = path.join(rootDir, 'test-checkout.html');
const publicDir = path.join(rootDir, 'public');
const ORDER_AMOUNT_PAISE = 149900; // ₹1,499.00, the single test product

// Builds the Express app. `getSecret` is injected so tests can supply their own
// secret without touching env.
export function createApp({ getSecret }) {
  const app = express();
  app.disable('x-powered-by');

  // Attach a request id to every request, and a logger bound to it.
  app.use((req, _res, next) => {
    req.requestId =
      req.get('x-razorpay-event-id') /* stable across retries */ ||
      crypto.randomUUID();
    req.log = makeLogger(req.requestId);
    next();
  });

  // A tiny JSON body parser ONLY for non-webhook routes.
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // Static demo UI: public/failure.html (live customer screen) and
  // public/showcase/ (static three-state page for the demo video).
  app.use(express.static(publicDir));

  // The live customer screen's data source. Works for both a real webhook
  // failure (source: 'webhook') and a demo one (source: 'demo', created via
  // POST /api/simulate-failure below) — same table, same lookup.
  app.get('/api/failure/:id', async (req, res) => {
    const row = await db.getFailure(req.params.id);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(messageFromFailureRow(row));
  });

  // Creates a demo failure (source: 'demo') so /api/failure/:id and
  // failure.html can be exercised without a real webhook. type is one of
  // 'not_debited' | 'debited' | 'confirming'.
  app.post('/api/simulate-failure', express.json(), async (req, res) => {
    try {
      const result = await simulateFailure(req.body || {});
      res.status(201).json(result);
    } catch (err) {
      if (err && err.status) return res.status(err.status).json({ error: err.error });
      req.log.error('simulate_failure_threw', { error: String(err) });
      res.status(500).json({ error: 'internal error' });
    }
  });

  // ── Test-mode checkout helpers (not part of the webhook service) ──────────
  // Serve the checkout page from here so its fetch('/create-order') is
  // same-origin (a file:// page would hit CORS). Open http://localhost:PORT/checkout.
  app.get('/checkout', (_req, res) => res.sendFile(checkoutPage));

  // Create a real test-mode order so the failure webhook carries an order_id
  // (validate.js requires it). Uses the test API keys via the Razorpay Orders API.
  app.post('/create-order', express.json(), async (req, res) => {
    let keyId, keySecret;
    try {
      ({ keyId, keySecret } = getRazorpayKeys());
    } catch {
      return res.status(500).json({
        error: 'Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env to use /create-order.',
      });
    }
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    try {
      const rzp = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: ORDER_AMOUNT_PAISE,
          currency: 'INR',
          receipt: `rcpt_${req.requestId}`,
        }),
      });
      const order = await rzp.json();
      if (!rzp.ok) {
        req.log.warn('order_create_failed', { status: rzp.status });
        return res.status(502).json({ error: 'order create failed', detail: order });
      }
      res.json({
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        keyId,
      });
    } catch (err) {
      req.log.error('order_create_threw', { error: String(err) });
      res.status(502).json({ error: 'could not reach Razorpay' });
    }
  });

  // THE WEBHOOK ROUTE.
  //
  // express.raw() captures the exact bytes. This MUST come before any JSON
  // parser; if JSON parsed first, the re-serialised body would break the HMAC.
  // We never mount express.json() globally, precisely to avoid that trap.
  app.post(
    '/webhook/razorpay',
    express.raw({ type: '*/*' }),
    async (req, res) => {
      const log = req.log;
      const rawBody = req.body; // Buffer, thanks to express.raw
      const signature = req.get('x-razorpay-signature');

      // 1. Signature FIRST, over the raw bytes. No signature => never trust it.
      const ok = verifySignature({
        rawBody,
        signature,
        secret: getSecret(),
      });
      if (!ok) {
        log.warn('signature_rejected', {
          hasSignature: Boolean(signature),
          bytes: rawBody ? rawBody.length : 0,
        });
        // 401, and NOT a 2xx — but this is an auth failure, not "please retry".
        return res.status(401).json({ ok: false, error: 'invalid signature' });
      }

      // 2. Parse only after the signature proves the bytes are authentic.
      let parsed;
      try {
        parsed = JSON.parse(rawBody.toString('utf8'));
      } catch {
        log.warn('body_not_json', {});
        // Malformed but signed: returning 400 (Razorpay won't sign junk in
        // practice; a non-2xx here is fine because it won't loop on real data).
        return res.status(400).json({ ok: false, error: 'invalid JSON' });
      }

      // 3. Validate shape before touching it.
      const validated = validateWebhook(parsed);
      if (!validated.ok) {
        log.warn('payload_invalid', { error: validated.error });
        return res.status(400).json({ ok: false, error: validated.error });
      }

      // 4. Handle. Idempotency + suppression live in handleEvent.
      // IMPORTANT: any duplicate or ignorable event returns 200 so Razorpay
      // stops retrying. Only genuine auth/shape errors are non-2xx.
      try {
        const result = await handleEvent({
          eventId: req.requestId,
          validated: validated.value,
          logger: log,
          now: new Date(),
          deliver: makeConsoleDeliver(log),
        });
        return res.status(result.status).json(result.body);
      } catch (err) {
        log.error('handler_threw', { error: String(err) });
        // 500 => Razorpay retries. That's what we want on an unexpected crash.
        return res.status(500).json({ ok: false, error: 'internal error' });
      }
    }
  );

  return app;
}
