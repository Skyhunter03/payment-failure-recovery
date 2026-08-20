import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as db from '../src/db/index.js';
import { handleEvent } from '../src/webhook/handler.js';
import { validateWebhook } from '../src/webhook/validate.js';
import { makePaymentFailed, makePaymentCaptured } from '../src/fixtures.js';

function deliverSpy() {
  const sent = [];
  const fn = (m) => sent.push(m);
  fn.sent = sent;
  return fn;
}
const silentLog = {
  requestId: 't',
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function run(payload, { eventId, now = new Date('2025-08-20T10:00:00Z'), deliver }) {
  const validated = validateWebhook(payload);
  expect(validated.ok).toBe(true);
  return handleEvent({
    eventId,
    validated: validated.value,
    logger: silentLog,
    now,
    deliver: deliver || (() => {}),
  });
}

beforeEach(() => db.initDb(':memory:'));
afterEach(() => db.closeDb());

describe('idempotency', () => {
  it('processes the first delivery and returns 200 on a duplicate event id', () => {
    const payload = makePaymentFailed({ id: 'pay_A', orderId: 'order_A' });
    const deliver = deliverSpy();

    const first = run(payload, { eventId: 'evt_1', deliver });
    const second = run(payload, { eventId: 'evt_1', deliver });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(deliver.sent.length).toBe(1); // never messaged twice
  });

  it('never messages the same payment twice even with a fresh event id', () => {
    const payload = makePaymentFailed({ id: 'pay_B', orderId: 'order_B' });
    const deliver = deliverSpy();
    run(payload, { eventId: 'evt_x', deliver });
    const again = run(payload, { eventId: 'evt_y', deliver }); // different id, same payment
    expect(again.status).toBe(200);
    expect(deliver.sent.length).toBe(1);
  });
});

describe('follow-up suppression', () => {
  it('cancels pending follow-ups when payment.captured arrives for the order', () => {
    const orderId = 'order_C';
    // A failure that schedules a follow-up (insufficient_funds -> ~20h nudge).
    const failed = makePaymentFailed({
      id: 'pay_C1',
      orderId,
      errorReason: 'insufficient_funds',
      errorStep: 'payment_authorization',
    });
    run(failed, { eventId: 'evt_c1' });
    expect(db.pendingFollowUpsForOrder(orderId).length).toBe(1);

    // Customer pays via another attempt -> captured for the SAME order.
    const captured = makePaymentCaptured({ id: 'pay_C2', orderId });
    const res = run(captured, { eventId: 'evt_c2' });

    expect(res.status).toBe(200);
    expect(res.body.cancelledFollowUps).toBe(1);
    expect(db.pendingFollowUpsForOrder(orderId).length).toBe(0);
  });

  it('a due, cancelled follow-up never comes back as due', () => {
    const orderId = 'order_D';
    const failed = makePaymentFailed({
      id: 'pay_D1',
      orderId,
      errorReason: 'payment_cancelled',
      errorStep: 'payment_initiation',
    });
    run(failed, { eventId: 'evt_d1' });
    run(makePaymentCaptured({ id: 'pay_D2', orderId }), { eventId: 'evt_d2' });

    // Far in the future — everything would be "due" by now if still pending.
    const due = db.dueFollowUps(new Date('2030-01-01T00:00:00Z').toISOString());
    expect(due.length).toBe(0);
  });
});

describe('handled vs ignored events', () => {
  it('returns 200 and does nothing for an unhandled event type', () => {
    const validated = validateWebhook({
      event: 'payment.authorized',
      payload: { payment: { entity: { id: 'pay_Z', order_id: 'order_Z' } } },
    });
    const res = handleEvent({
      eventId: 'evt_z',
      validated: validated.value,
      logger: silentLog,
      now: new Date(),
      deliver: () => {},
    });
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe('payment.authorized');
  });
});
