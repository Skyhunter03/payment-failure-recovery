import {
  MoneyState,
  PRE_AUTH_REASONS,
  INFRA_REASONS,
  MONEY_RISK_STEPS,
} from './reasons.js';

// The one rule the whole codebase is built around:
//   Never claim money was debited unless the payload PROVES it.
//
// Proof = an acquirer reference. That reference is minted by the bank/network
// only after it has actually seen the transaction, so its presence is the only
// honest evidence that money left the account.

const REFERENCE_FIELDS = ['rrn', 'upi_transaction_id', 'bank_transaction_id'];

// Pull the acquirer reference out of acquirer_data, if any. Returns
// { field, value } or null. Empty strings / nulls do not count as a reference.
export function findAcquirerReference(paymentEntity) {
  const acq = paymentEntity?.acquirer_data;
  if (!acq || typeof acq !== 'object') return null;
  for (const field of REFERENCE_FIELDS) {
    const value = acq[field];
    if (typeof value === 'string' && value.trim() !== '') {
      return { field, value: value.trim() };
    }
    if (typeof value === 'number') {
      return { field, value: String(value) };
    }
  }
  return null;
}

// Classify into exactly one of the three money states. Never guesses.
//
// Precedence:
//   1. A reference exists  -> DEBITED_REVERSAL_EXPECTED. Always. Even for a
//      "pre-auth" reason like insufficient_funds: if the bank minted a
//      reference, money moved and is coming back.
//   2. No reference, pre-auth reason -> NOT_DEBITED.
//   3. No reference, money-risk step or infra reason -> CONFIRMING.
//   4. No reference, anything else (unknown cause) -> CONFIRMING.
//      The safe default is uncertainty, never a false "you're fine".
export function classifyMoneyState(paymentEntity) {
  const reason = paymentEntity?.error_reason ?? null;
  const step = paymentEntity?.error_step ?? null;
  const reference = findAcquirerReference(paymentEntity);

  if (reference) {
    return {
      state: MoneyState.DEBITED_REVERSAL_EXPECTED,
      reference,
      reason,
      step,
      why: `Acquirer reference (${reference.field}) present: the bank has seen this transaction, so money left the account.`,
    };
  }

  if (reason && PRE_AUTH_REASONS.has(reason)) {
    return {
      state: MoneyState.NOT_DEBITED,
      reference: null,
      reason,
      step,
      why: `Pre-authorisation failure (${reason}) and no acquirer reference: the transaction was rejected before money could move.`,
    };
  }

  if ((step && MONEY_RISK_STEPS.has(step)) || (reason && INFRA_REASONS.has(reason))) {
    return {
      state: MoneyState.CONFIRMING,
      reference: null,
      reason,
      step,
      why: `Failure at ${step || reason} with no reference yet: money may or may not have moved, so we do not claim either way.`,
    };
  }

  // Unknown cause, no reference. We refuse to pretend we know.
  return {
    state: MoneyState.CONFIRMING,
    reference: null,
    reason,
    step,
    why: `Unrecognised cause (${reason || 'none'}) with no reference: defaulting to CONFIRMING rather than guessing.`,
  };
}
