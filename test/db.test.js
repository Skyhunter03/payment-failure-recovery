import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as db from '../src/db/index.js';

beforeEach(() => db.initDb(':memory:'));
afterEach(() => db.closeDb());

describe('markEventSeen — the idempotency guard that matters most', () => {
  it('the FIRST insert of an event id is not a duplicate; the SECOND is', async () => {
    const first = await db.markEventSeen('evt_dup_1', 'payment.failed', '2025-08-20T10:00:00Z');
    const second = await db.markEventSeen('evt_dup_1', 'payment.failed', '2025-08-20T10:00:05Z');
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('two DIFFERENT event ids are each treated as new', async () => {
    const a = await db.markEventSeen('evt_a', 'payment.failed', '2025-08-20T10:00:00Z');
    const b = await db.markEventSeen('evt_b', 'payment.failed', '2025-08-20T10:00:00Z');
    expect(a).toBe(true);
    expect(b).toBe(true);
  });
});

describe('saveFailure', () => {
  const row = {
    paymentId: 'pay_dup',
    orderId: 'order_dup',
    reason: 'incorrect_otp',
    errorStep: 'payment_authentication',
    acquirerDataJson: '{}',
    moneyState: 'NOT_DEBITED',
    amountPaise: 149900,
    source: 'webhook',
    nowIso: '2025-08-20T10:00:00Z',
  };

  it('the first save is new; a second save of the same payment_id is not (never re-message)', async () => {
    expect(await db.saveFailure(row)).toBe(true);
    expect(await db.saveFailure({ ...row, moneyState: 'CONFIRMING' })).toBe(false);
    const stored = await db.getFailure('pay_dup');
    expect(stored.money_state).toBe('NOT_DEBITED'); // first write wins, never overwritten
  });
});

describe('markOrderResolved / isOrderResolved', () => {
  it('marks resolved, cancels pending follow-ups, and is idempotent', async () => {
    expect(await db.isOrderResolved('order_x')).toBe(false);
    await db.scheduleFollowUp({
      orderId: 'order_x',
      paymentId: 'pay_x',
      kind: 'conservative_followup',
      dueAtIso: '2099-01-01T00:00:00Z',
      nowIso: '2025-08-20T10:00:00Z',
    });

    const cancelled = await db.markOrderResolved('order_x', '2025-08-20T10:05:00Z');
    expect(cancelled).toBe(1);
    expect(await db.isOrderResolved('order_x')).toBe(true);

    // Idempotent: marking again doesn't throw and finds nothing left to cancel.
    expect(await db.markOrderResolved('order_x', '2025-08-20T10:06:00Z')).toBe(0);
  });
});

describe('listFailures and stats', () => {
  it('reflect what was saved', async () => {
    await db.saveFailure({
      paymentId: 'pay_1',
      orderId: 'order_1',
      reason: 'incorrect_otp',
      errorStep: 'payment_authentication',
      acquirerDataJson: '{}',
      moneyState: 'NOT_DEBITED',
      amountPaise: 100000,
      source: 'demo',
      nowIso: '2025-08-20T10:00:00Z',
    });
    await db.saveFailure({
      paymentId: 'pay_2',
      orderId: 'order_2',
      reason: 'issuer_down',
      errorStep: 'payment_authorization',
      acquirerDataJson: '{}',
      moneyState: 'CONFIRMING',
      amountPaise: 200000,
      source: 'webhook',
      nowIso: '2025-08-20T10:01:00Z',
    });

    const list = await db.listFailures();
    expect(list.length).toBe(2);
    expect(list[0].payment_id).toBe('pay_2'); // newest first

    const s = await db.stats();
    expect(s.totalFailures).toBe(2);
    expect(s.byState.NOT_DEBITED).toBe(1);
    expect(s.byState.CONFIRMING).toBe(1);
  });
});
