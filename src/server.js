import express from 'express';
import crypto from 'node:crypto';
import { makeLogger } from './logger.js';
import { verifySignature } from './webhook/signature.js';
import { validateWebhook } from './webhook/validate.js';
import { handleEvent } from './webhook/handler.js';
import { makeConsoleDeliver } from './render.js';

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

  // THE WEBHOOK ROUTE.
  //
  // express.raw() captures the exact bytes. This MUST come before any JSON
  // parser; if JSON parsed first, the re-serialised body would break the HMAC.
  // We never mount express.json() globally, precisely to avoid that trap.
  app.post(
    '/webhook/razorpay',
    express.raw({ type: '*/*' }),
    (req, res) => {
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
        const result = handleEvent({
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
