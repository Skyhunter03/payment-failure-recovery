import { classifyMoneyState } from '../core/classify.js';
import { decideRecovery } from '../core/recovery.js';
import { buildCustomerMessage } from '../core/message.js';
import * as db from '../db/index.js';

// Orchestrates a validated webhook into: classify -> decide -> message -> store.
// Enforces idempotency and follow-up suppression. Pure of HTTP concerns.
//
// `deliver` is how a message reaches the customer. Here it only logs. There is
// deliberately no code path that contacts a real person.
//
// Async throughout (db.js call sites) since the DB may be Postgres over the
// network — see src/db/index.js.

export async function handleEvent({ eventId, validated, logger, now, deliver }) {
  const nowIso = now.toISOString();

  // --- Idempotency: claim the event id first. Duplicate => 200, no work. ---
  const firstTime = await db.markEventSeen(eventId, validated.event, nowIso);
  if (!firstTime) {
    logger.info('duplicate_event_ignored', {
      eventId,
      event: validated.event,
    });
    return { status: 200, body: { ok: true, duplicate: true } };
  }

  if (!validated.handled) {
    logger.info('event_not_handled', { eventId, event: validated.event });
    return { status: 200, body: { ok: true, ignored: validated.event } };
  }

  if (validated.event === 'payment.captured') {
    return handleCaptured({ validated, logger, nowIso });
  }
  return handleFailed({ validated, logger, now, nowIso, deliver });
}

async function handleFailed({ validated, logger, now, nowIso, deliver }) {
  const entity = validated.entity;
  const orderId = entity.order_id;
  const paymentId = entity.id;

  // Classify first (cheap, pure) so the ONE insert below carries the real
  // result — avoids a "placeholder, then update" pattern where the update
  // would silently be a no-op (ON CONFLICT DO NOTHING on the same PK) and
  // money_state would never leave a placeholder value.
  const classification = classifyMoneyState(entity);
  const recovery = decideRecovery(entity.error_reason, {
    originalMethod: entity.method,
  });

  // Idempotency guard: never message the same payment twice, even if a fresh
  // event id slipped through (e.g. Razorpay re-emits with a new id).
  const newFailure = await db.saveFailure({
    paymentId,
    orderId,
    reason: entity.error_reason ?? null,
    errorStep: entity.error_step ?? null,
    acquirerDataJson: JSON.stringify(entity.acquirer_data ?? {}),
    moneyState: classification.state,
    amountPaise: entity.amount ?? null,
    source: 'webhook',
    nowIso,
  });
  if (!newFailure) {
    logger.info('failure_already_messaged', { paymentId, orderId });
    return { status: 200, body: { ok: true, duplicatePayment: true } };
  }

  const message = buildCustomerMessage({
    classification,
    recovery,
    amountPaise: entity.amount ?? 0,
    eventDate: now,
  });

  // Schedule follow-ups (nothing is sent yet — the ticker will log them).
  for (const f of recovery.followUps) {
    const dueAt = new Date(now.getTime() + f.atMinutes * 60_000);
    await db.scheduleFollowUp({
      orderId,
      paymentId,
      kind: f.kind,
      dueAtIso: dueAt.toISOString(),
      nowIso,
    });
  }

  logger.info('failure_handled', {
    paymentId,
    orderId,
    reason: entity.error_reason ?? null,
    step: entity.error_step ?? null,
    moneyState: classification.state,
    why: classification.why,
    recovery: {
      delayMinutes: recovery.delayMinutes,
      method: recovery.method,
      switchMethod: recovery.switchMethod,
    },
    followUps: recovery.followUps.length,
  });

  // "Deliver" the message. It only renders/logs — never sends.
  deliver({ paymentId, orderId, message });

  return {
    status: 200,
    body: { ok: true, moneyState: classification.state, message },
  };
}

async function handleCaptured({ validated, logger, nowIso }) {
  const entity = validated.entity;
  const orderId = entity.order_id;
  if (!orderId) {
    logger.info('captured_without_order', { paymentId: entity.id });
    return { status: 200, body: { ok: true } };
  }

  // The customer already paid. Cancel any pending nudges for this order —
  // chasing someone who has paid is how this feature gets hated.
  const cancelled = await db.markOrderResolved(orderId, nowIso);
  logger.info('captured_suppressed_followups', {
    orderId,
    paymentId: entity.id,
    cancelled,
  });
  return { status: 200, body: { ok: true, cancelledFollowUps: cancelled } };
}
