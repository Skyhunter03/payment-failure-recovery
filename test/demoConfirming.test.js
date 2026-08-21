// Tests mintFreshConfirming: the repeatable CONFIRMING demo's row generator.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as db from '../src/db/index.js';
import { mintFreshConfirming } from '../src/api/demoConfirming.js';
import { demoUpgradeConfirming } from '../src/api/demoUpgrade.js';

beforeEach(() => db.initDb(':memory:'));
afterEach(() => db.closeDb());

describe('mintFreshConfirming', () => {
  it('creates a new CONFIRMING row through the real webhook pipeline', async () => {
    const result = await mintFreshConfirming();
    expect(result.state).toBe('CONFIRMING');
    expect(result.id).toBeTruthy();

    const row = await db.getFailure(result.id);
    expect(row.money_state).toBe('CONFIRMING');
    // source: 'webhook' is what lets /api/demo/upgrade-confirming act on it
    // afterwards -- that endpoint refuses anything sourced otherwise.
    expect(row.source).toBe('webhook');
  });

  it('mints a different id on every call, so reopening the demo link is repeatable', async () => {
    const a = await mintFreshConfirming();
    const b = await mintFreshConfirming();
    expect(a.id).not.toBe(b.id);
  });

  it('end-to-end: a freshly minted row can immediately be demo-upgraded to DEBITED_REVERSAL_EXPECTED', async () => {
    const minted = await mintFreshConfirming();
    const upgraded = await demoUpgradeConfirming({ paymentId: minted.id, rrn: '998877665544' });
    expect(upgraded.moneyState).toBe('DEBITED_REVERSAL_EXPECTED');

    const row = await db.getFailure(minted.id);
    expect(row.money_state).toBe('DEBITED_REVERSAL_EXPECTED');
  });
});
