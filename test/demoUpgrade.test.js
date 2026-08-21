import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as db from '../src/db/index.js';
import { demoUpgradeConfirming } from '../src/api/demoUpgrade.js';

beforeEach(() => db.initDb(':memory:'));
afterEach(() => db.closeDb());

async function seed({ paymentId, source = 'webhook', moneyState = 'CONFIRMING', reason = 'issuer_down' }) {
  await db.saveFailure({
    paymentId,
    orderId: `order_${paymentId}`,
    reason,
    errorStep: 'payment_authorization',
    acquirerDataJson: '{}',
    moneyState,
    amountPaise: 149900,
    source,
    nowIso: new Date().toISOString(),
  });
}

describe('demoUpgradeConfirming', () => {
  it('upgrades a real, currently-CONFIRMING webhook row to DEBITED_REVERSAL_EXPECTED', async () => {
    await seed({ paymentId: 'pay_demo_upgrade' });
    const result = await demoUpgradeConfirming({ paymentId: 'pay_demo_upgrade', rrn: '112233445566' });
    expect(result.moneyState).toBe('DEBITED_REVERSAL_EXPECTED');
    expect(result.upgraded).toBe(1);
    const row = await db.getFailure('pay_demo_upgrade');
    expect(row.money_state).toBe('DEBITED_REVERSAL_EXPECTED');
    expect(JSON.parse(row.acquirer_data_json).rrn).toBe('112233445566');
  });

  it('rejects an unknown payment id (404)', async () => {
    await expect(demoUpgradeConfirming({ paymentId: 'pay_does_not_exist' })).rejects.toMatchObject({ status: 404 });
  });

  it('rejects a demo_ (simulated) row -- there is no real payment behind it', async () => {
    await seed({ paymentId: 'demo_cannot_upgrade', source: 'demo' });
    await expect(demoUpgradeConfirming({ paymentId: 'demo_cannot_upgrade' })).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a row that is not currently CONFIRMING', async () => {
    await seed({ paymentId: 'pay_already_not_debited', moneyState: 'NOT_DEBITED' });
    await expect(demoUpgradeConfirming({ paymentId: 'pay_already_not_debited' })).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a missing paymentId (400)', async () => {
    await expect(demoUpgradeConfirming({})).rejects.toMatchObject({ status: 400 });
  });
});
