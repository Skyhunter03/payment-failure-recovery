// Tests decideRecovery: one recovery decision per cause, not one blind retry.
import { describe, it, expect } from 'vitest';
import { decideRecovery } from '../src/core/recovery.js';

describe('decideRecovery — one decision per cause, not one blind retry', () => {
  it('acts immediately when the customer is present (OTP / auth / CVV)', () => {
    for (const reason of ['incorrect_otp', 'authentication_failed', 'invalid_cvv']) {
      const d = decideRecovery(reason, { originalMethod: 'card' });
      expect(d.delayMinutes, reason).toBe(0);
      expect(d.method, reason).toBe('same');
      expect(d.switchMethod, reason).toBe(false);
      expect(d.followUps.length).toBe(0);
    }
  });

  it('keeps a wrong UPI ID on UPI and retries now (no switch)', () => {
    const d = decideRecovery('invalid_vpa', { originalMethod: 'upi' });
    expect(d.delayMinutes).toBe(0);
    expect(d.method).toBe('upi');
    expect(d.switchMethod).toBe(false);
  });

  it('NEVER retries an expired/dead card on the same instrument — switches to UPI now', () => {
    for (const reason of [
      'card_expired',
      'invalid_card_number',
      'invalid_expiry',
      'international_transaction_not_allowed',
      'card_not_supported',
    ]) {
      const d = decideRecovery(reason, { originalMethod: 'card' });
      expect(d.method, reason).toBe('upi');
      expect(d.switchMethod, reason).toBe(true);
      expect(d.method, reason).not.toBe('same');
      expect(d.delayMinutes, reason).toBe(0);
    }
  });

  it('WAITS rather than retrying on low balance, then offers UPI', () => {
    const d = decideRecovery('insufficient_funds', { originalMethod: 'card' });
    expect(d.delayMinutes).toBeGreaterThanOrEqual(20 * 60); // ~20 hours
    expect(d.method).toBe('upi');
    expect(d.followUps.length).toBe(1);
  });

  it('waits ~40 min on infra failures and drops the card if the original was a card', () => {
    const card = decideRecovery('issuer_down', { originalMethod: 'card' });
    expect(card.delayMinutes).toBe(40);
    expect(card.method).toBe('upi');
    expect(card.switchMethod).toBe(true);

    const upi = decideRecovery('gateway_technical_error', { originalMethod: 'upi' });
    expect(upi.delayMinutes).toBe(40);
    expect(upi.switchMethod).toBe(false); // nothing to switch off
  });

  it('sends exactly one quiet reminder for a cancelled payment (no chasing)', () => {
    const d = decideRecovery('payment_cancelled', { originalMethod: 'upi' });
    expect(d.delayMinutes).toBe(4 * 60);
    expect(d.followUps.length).toBe(1);
    expect(d.switchMethod).toBe(false);
  });

  it('gives an unknown cause a single conservative follow-up at 30 min', () => {
    const d = decideRecovery('mystery', { originalMethod: 'card' });
    expect(d.delayMinutes).toBe(30);
    expect(d.followUps.length).toBe(1);
  });

  it('every decision carries a plain-English rationale', () => {
    for (const reason of ['incorrect_otp', 'card_expired', 'insufficient_funds', 'issuer_down']) {
      const d = decideRecovery(reason, { originalMethod: 'card' });
      expect(typeof d.rationale).toBe('string');
      expect(d.rationale.length).toBeGreaterThan(10);
    }
  });
});
