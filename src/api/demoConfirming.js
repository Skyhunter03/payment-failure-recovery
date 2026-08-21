import crypto from 'node:crypto';
import { validateWebhook } from '../webhook/validate.js';
import { handleEvent } from '../webhook/handler.js';
import { makeLogger } from '../logger.js';
import { makeConsoleDeliver } from '../render.js';

// Mints a fresh CONFIRMING failure for the live demo, through the SAME
// pipeline a real webhook uses (validateWebhook -> handleEvent -> classify
// -> decide -> message -> store). The only thing skipped is the HTTP layer
// and the HMAC signature, since there's no real bank behind a demo page
// load to sign anything. The resulting row is indistinguishable in the DB
// from a real webhook delivery (source: 'webhook'), which is what lets
// /api/demo/upgrade-confirming act on it afterwards -- that endpoint
// deliberately refuses anything that isn't source: 'webhook' (see
// demoUpgrade.js), and this keeps that guarantee intact rather than
// punching a hole in it for demo rows.
//
// One representative real-world CONFIRMING cause -- bank/gateway down at
// authorization, no acquirer reference yet -- the same scenario
// src/api/simulate.js uses for its 'confirming' case.
export async function mintFreshConfirming() {
  const paymentId = `pay_confirming_demo_${crypto.randomUUID().slice(0, 12)}`;
  const orderId = `order_confirming_demo_${crypto.randomUUID().slice(0, 12)}`;

  const validated = validateWebhook({
    event: 'payment.failed',
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: orderId,
          amount: 149900,
          method: 'card',
          error_reason: 'issuer_down',
          error_step: 'payment_authorization',
          acquirer_data: {},
        },
      },
    },
  });
  if (!validated.ok) {
    // The payload above is fixed and known-valid -- this should never
    // trip, but fail loudly rather than silently if it ever does.
    throw { status: 500, error: `internal: demo payload failed validation (${validated.error})` };
  }

  const eventId = `evt_demo_confirming_${crypto.randomUUID()}`;
  const logger = makeLogger(eventId);
  await handleEvent({
    eventId,
    validated: validated.value,
    logger,
    now: new Date(),
    deliver: makeConsoleDeliver(logger),
  });

  return { id: paymentId, orderId, state: 'CONFIRMING' };
}
