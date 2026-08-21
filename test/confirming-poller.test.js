// Tests pollOnce's CONFIRMING-upgrade logic with a stubbed Razorpay response.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as db from '../src/db/index.js';
import { pollOnce } from '../src/confirming-poller.js';

const silentLog = { info() {}, warn() {}, error() {} };

async function seedConfirming({
  paymentId,
  orderId = `order_${paymentId}`,
  reason = 'issuer_down',
  errorStep = 'payment_authorization',
  source = 'webhook',
  nowIso = new Date().toISOString(),
}) {
  await db.saveFailure({
    paymentId,
    orderId,
    reason,
    errorStep,
    acquirerDataJson: '{}',
    moneyState: 'CONFIRMING',
    amountPaise: 149900,
    source,
    nowIso,
  });
}

beforeEach(() => db.initDb(':memory:'));
afterEach(() => db.closeDb());

describe('pollOnce — the CONFIRMING upgrade path', () => {
  it('upgrades to DEBITED_REVERSAL_EXPECTED once Razorpay reports an acquirer reference', async () => {
    await seedConfirming({ paymentId: 'pay_upgrade_1' });

    const fetchPayment = async (id) => {
      expect(id).toBe('pay_upgrade_1');
      return {
        error_reason: 'issuer_down',
        error_step: 'payment_authorization',
        acquirer_data: { rrn: '778899001122' },
        amount: 149900,
      };
    };

    const result = await pollOnce({ fetchPayment, log: silentLog });
    expect(result).toEqual({ checked: 1, upgraded: 1 });

    const row = await db.getFailure('pay_upgrade_1');
    expect(row.money_state).toBe('DEBITED_REVERSAL_EXPECTED');
    expect(JSON.parse(row.acquirer_data_json).rrn).toBe('778899001122');
  });

  it('upgrades to NOT_DEBITED once Razorpay settles on a pre-authorisation reason with no reference', async () => {
    await seedConfirming({ paymentId: 'pay_upgrade_2', reason: 'gateway_technical_error' });

    const fetchPayment = async () => ({
      error_reason: 'card_expired',
      error_step: 'payment_initiation',
      acquirer_data: {},
      amount: 149900,
    });

    const result = await pollOnce({ fetchPayment, log: silentLog });
    expect(result).toEqual({ checked: 1, upgraded: 1 });

    const row = await db.getFailure('pay_upgrade_2');
    expect(row.money_state).toBe('NOT_DEBITED');
    expect(row.reason).toBe('card_expired');
  });

  it('stays CONFIRMING when the recheck still has no reference and an infra reason', async () => {
    await seedConfirming({ paymentId: 'pay_stays_confirming' });

    const fetchPayment = async () => ({
      error_reason: 'issuer_down',
      error_step: 'payment_authorization',
      acquirer_data: {},
      amount: 149900,
    });

    const result = await pollOnce({ fetchPayment, log: silentLog });
    expect(result).toEqual({ checked: 1, upgraded: 0 });

    const row = await db.getFailure('pay_stays_confirming');
    expect(row.money_state).toBe('CONFIRMING');
  });

  it('never polls a demo_ (simulated) row — there is no real Razorpay payment behind it', async () => {
    await seedConfirming({ paymentId: 'demo_never_polled', source: 'demo' });

    let called = false;
    const fetchPayment = async () => {
      called = true;
      return { error_reason: 'issuer_down', error_step: 'payment_authorization', acquirer_data: { rrn: 'x' } };
    };

    const result = await pollOnce({ fetchPayment, log: silentLog });
    expect(result).toEqual({ checked: 0, upgraded: 0 });
    expect(called).toBe(false);

    const row = await db.getFailure('demo_never_polled');
    expect(row.money_state).toBe('CONFIRMING'); // untouched
  });

  it('never polls a failure created outside the recheck window', async () => {
    const oldIso = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(); // 72h ago
    await seedConfirming({ paymentId: 'pay_too_old', nowIso: oldIso });

    let called = false;
    const fetchPayment = async () => {
      called = true;
      return { error_reason: 'issuer_down', error_step: 'payment_authorization', acquirer_data: { rrn: 'x' } };
    };

    // Default window is 48h — this row is 72h old, so it's outside it.
    const result = await pollOnce({ fetchPayment, log: silentLog });
    expect(result).toEqual({ checked: 0, upgraded: 0 });
    expect(called).toBe(false);
  });

  it('a fetchPayment failure for one row does not stop the rest from being checked', async () => {
    await seedConfirming({ paymentId: 'pay_throws' });
    await seedConfirming({ paymentId: 'pay_fine' });

    const fetchPayment = async (id) => {
      if (id === 'pay_throws') throw new Error('network blip');
      return { error_reason: 'issuer_down', error_step: 'payment_authorization', acquirer_data: { rrn: 'ref123' } };
    };

    const result = await pollOnce({ fetchPayment, log: silentLog });
    expect(result.checked).toBe(2);
    expect(result.upgraded).toBe(1); // pay_fine upgraded; pay_throws logged and skipped

    expect((await db.getFailure('pay_throws')).money_state).toBe('CONFIRMING');
    expect((await db.getFailure('pay_fine')).money_state).toBe('DEBITED_REVERSAL_EXPECTED');
  });

  it('a null fetchPayment result (not found / API error) leaves the row untouched for next tick', async () => {
    await seedConfirming({ paymentId: 'pay_not_found_yet' });
    const fetchPayment = async () => null;

    const result = await pollOnce({ fetchPayment, log: silentLog });
    expect(result).toEqual({ checked: 1, upgraded: 0 });
    expect((await db.getFailure('pay_not_found_yet')).money_state).toBe('CONFIRMING');
  });
});
