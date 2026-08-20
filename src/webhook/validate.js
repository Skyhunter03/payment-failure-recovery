// Validate the shape of a Razorpay webhook payload BEFORE any logic touches it.
// We only assert what we actually read; we do not try to model Razorpay's whole
// schema. Returns { ok: true, value } or { ok: false, error }.

const HANDLED_EVENTS = new Set(['payment.failed', 'payment.captured']);

export function validateWebhook(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'body is not a JSON object' };
  }
  const { event, payload } = parsed;
  if (typeof event !== 'string' || event === '') {
    return { ok: false, error: 'missing event' };
  }
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'missing payload' };
  }

  const entity = payload.payment?.entity;
  if (!entity || typeof entity !== 'object') {
    return { ok: false, error: 'missing payload.payment.entity' };
  }
  if (typeof entity.id !== 'string' || entity.id === '') {
    return { ok: false, error: 'missing payment id' };
  }
  // order_id can legitimately be null for some flows, but our follow-up
  // suppression keys on it, so we require it for the events we act on.
  if (event === 'payment.failed' && typeof entity.order_id !== 'string') {
    return { ok: false, error: 'payment.failed missing order_id' };
  }
  if (entity.amount != null && typeof entity.amount !== 'number') {
    return { ok: false, error: 'amount must be a number (paise)' };
  }

  return {
    ok: true,
    value: {
      event,
      handled: HANDLED_EVENTS.has(event),
      entity,
    },
  };
}
