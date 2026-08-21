// Tests buildCustomerMessage: the deterministic, honest customer-facing message.
import { describe, it, expect } from 'vitest';
import { classifyMoneyState } from '../src/core/classify.js';
import { decideRecovery } from '../src/core/recovery.js';
import { buildCustomerMessage } from '../src/core/message.js';
import { MoneyState } from '../src/core/reasons.js';

const eventDate = new Date('2025-08-20T10:00:00.000Z');

function messageFor(entity) {
  const classification = classifyMoneyState(entity);
  const recovery = decideRecovery(entity.error_reason, { originalMethod: entity.method });
  return buildCustomerMessage({
    classification,
    recovery,
    amountPaise: entity.amount,
    eventDate,
  });
}

describe('customer message — deterministic, honest, 3-step tracker', () => {
  it('NOT_DEBITED: says no money left; tracker fully skipped; no reversal date', () => {
    const m = messageFor({
      error_reason: 'incorrect_otp',
      error_step: 'payment_authentication',
      method: 'card',
      acquirer_data: {},
      amount: 149900,
    });
    expect(m.state).toBe(MoneyState.NOT_DEBITED);
    expect(m.headline.toLowerCase()).toContain('no money left');
    expect(m.tracker.every((s) => s.status === 'skipped')).toBe(true);
    expect(m.reference).toBeNull();
  });

  it('DEBITED: shows the reference, a reversal date, and money-on-its-way-back', () => {
    const m = messageFor({
      error_reason: 'insufficient_funds',
      error_step: 'payment_authorization',
      method: 'card',
      acquirer_data: { rrn: '123456789012' },
      amount: 250000,
    });
    expect(m.state).toBe(MoneyState.DEBITED_REVERSAL_EXPECTED);
    expect(m.reference).toBe('123456789012');
    expect(m.questions.isItComingBack).toContain('123456789012');
    expect(m.tracker[0].status).toBe('done');
    expect(m.tracker[2].status).toBe('pending');
    expect(m.tracker[2].expectedDate).toBeTruthy();
    expect(m.amount).toBe('₹2,500.00');
  });

  it('CONFIRMING: invents no reversal date and marks the tracker unknown', () => {
    const m = messageFor({
      error_reason: 'issuer_down',
      error_step: 'payment_authorization',
      method: 'card',
      acquirer_data: {},
      amount: 500000,
    });
    expect(m.state).toBe(MoneyState.CONFIRMING);
    expect(m.tracker.every((s) => s.status === 'unknown')).toBe(true);
    // No date anywhere in the "coming back" answer.
    expect(m.questions.isItComingBack).not.toMatch(/\b20\d\d\b/);
    expect(m.tracker.some((s) => s.expectedDate)).toBe(false);
  });

  it('answers all four questions in order', () => {
    const m = messageFor({
      error_reason: 'incorrect_otp',
      error_step: 'payment_authentication',
      method: 'card',
      acquirer_data: {},
      amount: 149900,
    });
    expect(m.questions.didMyMoneyLeave).toBeTruthy();
    expect(m.questions.isItComingBack).toBeTruthy();
    expect(m.questions.shouldIPayAgainNow).toBeTruthy();
    expect(m.questions.howDoIStillGetWhatIWanted).toBeTruthy();
  });

  it('is deterministic: same input yields byte-identical output', () => {
    const entity = {
      error_reason: 'card_expired',
      error_step: 'payment_initiation',
      method: 'card',
      acquirer_data: {},
      amount: 99900,
    };
    expect(JSON.stringify(messageFor(entity))).toBe(JSON.stringify(messageFor(entity)));
  });
});
