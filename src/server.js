import express from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeLogger } from './logger.js';
import { verifySignature } from './webhook/signature.js';
import { validateWebhook } from './webhook/validate.js';
import { handleEvent } from './webhook/handler.js';
import { makeConsoleDeliver } from './render.js';
import { getRazorpayKeys, config } from './config.js';
import * as db from './db/index.js';
import { messageFromFailureRow } from './api/failureLookup.js';
import { simulateFailure } from './api/simulate.js';
import { demoUpgradeConfirming } from './api/demoUpgrade.js';
import { mintFreshConfirming } from './api/demoConfirming.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkoutPage = path.join(rootDir, 'test-checkout.html');
const publicDir = path.join(rootDir, 'public');
const ORDER_AMOUNT_PAISE = 149900; // ₹1,499.00, the single test product

// Builds the Express app. `getSecret` is injected so tests can supply their own
// secret without touching env. rateLimitWindowMs/rateLimitMax default from
// config but are overridable so tests can trip the limiter without sending 60
// real requests.
export function createApp({
  getSecret,
  rateLimitWindowMs = config.rateLimitWindowMs,
  rateLimitMax = config.rateLimitMax,
  trustProxyHops = config.trustProxyHops,
}) {
  const app = express();
  app.disable('x-powered-by');
  // A specific hop COUNT, never `true` — `true` trusts an unbounded chain,
  // letting a client set its own X-Forwarded-For to fake a fresh IP on every
  // request and bypass IP-based rate limiting entirely. Render's traffic
  // passes through Cloudflare then Render's own load balancer (2 hops) before
  // reaching this app — see config.js.
  app.set('trust proxy', trustProxyHops);

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

  // No page is mounted at bare "/" -- redirect it to the demo hub so opening
  // the root URL is a real entry point, not a dead end. Before express.static
  // so it wins over any future public/index.html.
  app.get('/', (_req, res) => res.redirect('/demo'));

  // The demo hub: links to checkout, all three customer-screen states (real
  // persisted webhook ids), and the dashboard. Explicit route (not just
  // static serving) so it resolves at the clean /demo path the redirect above
  // and every demo link use, matching the /checkout convention below.
  app.get('/demo', (_req, res) => res.sendFile(path.join(publicDir, 'demo.html')));

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

  // Demo helper: mints a fresh CONFIRMING row through the real webhook
  // pipeline (see demoConfirming.js) so the CONFIRMING demo link is
  // repeatable -- every fresh page load gets its own row, instead of one
  // fixed id that's spent the first time someone actually clicks through.
  app.post('/api/demo/fresh-confirming', async (req, res) => {
    try {
      const result = await mintFreshConfirming();
      res.status(201).json(result);
    } catch (err) {
      if (err && err.status) return res.status(err.status).json({ error: err.error });
      req.log.error('fresh_confirming_threw', { error: String(err) });
      res.status(500).json({ error: 'internal error' });
    }
  });

  // Demo helper: runs the REAL confirming-poller (pollOnce, unmodified
  // classify.js, a real DB update) against a REAL webhook-originated
  // CONFIRMING row, with only the Razorpay API response simulated -- there is
  // no real Razorpay payment behind a demo id to actually poll. Refuses
  // anything that isn't already a real, currently-CONFIRMING row.
  app.post('/api/demo/upgrade-confirming', express.json(), async (req, res) => {
    try {
      const result = await demoUpgradeConfirming(req.body || {});
      res.json(result);
    } catch (err) {
      if (err && err.status) return res.status(err.status).json({ error: err.error });
      req.log.error('demo_upgrade_threw', { error: String(err) });
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

    // Recovery orders (opened from the failure screen's recovery button)
    // pass the original failed payment's id so a merchant looking at
    // Razorpay's dashboard can trace a fresh order back to what it's
    // recovering. Razorpay's `notes` field is exactly built for this kind
    // of private metadata -- it does NOT link the orders in any functional
    // way, and this order is still a fully standalone payment; nothing here
    // reuses or captures the failed payment's funds. Absent for the plain
    // (non-recovery) checkout flow, which sends no body.
    const { originalPaymentId, originalOrderId } = req.body || {};
    const notes = originalPaymentId
      ? {
          recovery: 'true',
          original_payment_id: originalPaymentId,
          ...(originalOrderId ? { original_order_id: originalOrderId } : {}),
        }
      : undefined;

    try {
      const rzp = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: ORDER_AMOUNT_PAISE,
          currency: 'INR',
          receipt: `rcpt_${req.requestId}`,
          ...(notes ? { notes } : {}),
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

  // Caps abuse volume against the webhook endpoint, not normal traffic —
  // Razorpay's own retries come nowhere close to this. Applied before raw-body
  // parsing / signature verification so an abusive burst doesn't even pay for
  // those. 429 + a warn log, same JSON-error shape as the rest of this route.
  const webhookLimiter = rateLimit({
    windowMs: rateLimitWindowMs,
    max: rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      req.log.warn('rate_limited', { ip: req.ip });
      res.status(429).json({ ok: false, error: 'rate limited' });
    },
  });

  // THE WEBHOOK ROUTE.
  //
  // express.raw() captures the exact bytes. This MUST come before any JSON
  // parser; if JSON parsed first, the re-serialised body would break the HMAC.
  // We never mount express.json() globally, precisely to avoid that trap.
  app.post(
    '/webhook/razorpay',
    webhookLimiter,
    express.raw({ type: '*/*' }),
    async (req, res) => {
      const log = req.log;
      const rawBody = req.body; // Buffer, thanks to express.raw
      const signature = req.get('x-razorpay-signature');

      // Log receipt FIRST, before any check — so if something stops the
      // request from ever reaching us (network, DNS, wrong URL registered in
      // the Razorpay dashboard), that's visible as an ABSENCE of this line in
      // Render's logs, distinct from every failure mode below it.
      log.info('webhook_received', {
        bytes: rawBody ? rawBody.length : 0,
        hasSignature: Boolean(signature),
      });

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
      log.info('signature_verified', {});

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
