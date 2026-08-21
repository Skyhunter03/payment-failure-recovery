// Tests the core honesty rule: never claim a debit without proof.
import { describe, it, expect } from 'vitest';
import { classifyMoneyState } from '../src/core/classify.js';
import { MoneyState } from '../src/core/reasons.js';

const base = (over = {}) => ({
  error_reason: 'incorrect_otp',
  error_step: 'payment_authentication',
  method: 'card',
  acquirer_data: {},
  amount: 149900,
  ...over,
});

describe('classifyMoneyState — the core honesty rule', () => {
  it('NEVER claims a debit for a pre-authorisation failure with no reference', () => {
    for (const reason of [
      'incorrect_otp',
      'invalid_cvv',
      'invalid_vpa',
      'card_expired',
      'payment_cancelled',
      'insufficient_funds',
      'invalid_card_number',
      'international_transaction_not_allowed',
    ]) {
      const r = classifyMoneyState(base({ error_reason: reason, acquirer_data: {} }));
      expect(r.state, reason).toBe(MoneyState.NOT_DEBITED);
    }
  });

  it('ONLY claims a debit when an acquirer reference is present', () => {
    for (const field of ['rrn', 'upi_transaction_id', 'bank_transaction_id']) {
      const r = classifyMoneyState(base({ acquirer_data: { [field]: 'REF123' } }));
      expect(r.state, field).toBe(MoneyState.DEBITED_REVERSAL_EXPECTED);
      expect(r.reference.field).toBe(field);
      expect(r.reference.value).toBe('REF123');
    }
  });

  it('does not treat empty-string references as proof of a debit', () => {
    const r = classifyMoneyState(base({ acquirer_data: { rrn: '   ' } }));
    expect(r.state).toBe(MoneyState.NOT_DEBITED); // reason is pre-auth, no real ref
  });

  it('insufficient_funds WITH a reference still counts as DEBITED', () => {
    const r = classifyMoneyState(
      base({ error_reason: 'insufficient_funds', acquirer_data: { rrn: '99887766' } })
    );
    expect(r.state).toBe(MoneyState.DEBITED_REVERSAL_EXPECTED);
  });

  it('stays CONFIRMING when the bank/infra fails and there is NO reference', () => {
    for (const reason of [
      'issuer_down',
      'gateway_technical_error',
      'network_error',
      'payment_timeout',
      'upi_timeout',
      'server_error',
    ]) {
      const r = classifyMoneyState(
        base({ error_reason: reason, error_step: 'payment_authorization', acquirer_data: {} })
      );
      expect(r.state, reason).toBe(MoneyState.CONFIRMING);
    }
  });

  it('stays CONFIRMING when failing at authorization/response with no reference', () => {
    const r = classifyMoneyState(
      base({ error_reason: 'unknown_thing', error_step: 'payment_authorization', acquirer_data: {} })
    );
    expect(r.state).toBe(MoneyState.CONFIRMING);
  });

  it('defaults an unknown cause with no reference to CONFIRMING, never NOT_DEBITED', () => {
    const r = classifyMoneyState(
      base({ error_reason: 'something_new', error_step: 'payment_initiation', acquirer_data: {} })
    );
    expect(r.state).toBe(MoneyState.CONFIRMING);
  });

  it('CONFIRMING does not collapse into the other two', () => {
    // A reference wins over a "risk step"; absence of a reference + infra stays uncertain.
    const withRef = classifyMoneyState(
      base({ error_reason: 'issuer_down', acquirer_data: { rrn: 'R1' } })
    );
    const noRef = classifyMoneyState(
      base({ error_reason: 'issuer_down', acquirer_data: {} })
    );
    expect(withRef.state).toBe(MoneyState.DEBITED_REVERSAL_EXPECTED);
    expect(noRef.state).toBe(MoneyState.CONFIRMING);
  });
});
