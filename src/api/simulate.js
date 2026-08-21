import crypto from 'node:crypto';
import { classifyMoneyState } from '../core/classify.js';
import * as db from '../db/index.js';

const DEFAULT_AMOUNT_PAISE = 149900; // ₹1,499.00, matches the test-checkout product

// One representative real-world cause per funds state, run through the SAME
// classify.js logic as a real webhook — not hardcoded outcomes. See
// src/core/reasons.js for why each maps where it does.
const SCENARIOS = {
  not_debited: { error_reason: 'incorrect_otp', error_step: 'payment_authentication', acquirer_data: {} },
  debited: {
    error_reason: 'insufficient_funds',
    error_step: 'payment_authorization',
    acquirer_data: { rrn: () => crypto.randomInt(100000000000, 999999999999).toString() },
  },
  confirming: { error_reason: 'issuer_down', error_step: 'payment_authorization', acquirer_data: {} },
};

export const SIMULATE_TYPES = Object.keys(SCENARIOS);

// Creates a demo failure row (source: 'demo') and returns { id, orderId, state }.
// Throws { status, error } for the route to translate into an HTTP response.
export async function simulateFailure({ type, amountPaise }) {
  const scenario = SCENARIOS[type];
  if (!scenario) {
    throw { status: 400, error: `type must be one of: ${SIMULATE_TYPES.join(', ')}` };
  }
  const amount = amountPaise ?? DEFAULT_AMOUNT_PAISE;
  if (!Number.isInteger(amount) || amount <= 0) {
    throw { status: 400, error: 'amountPaise must be a positive integer' };
  }

  const acquirerData = {};
  for (const [key, value] of Object.entries(scenario.acquirer_data)) {
    acquirerData[key] = typeof value === 'function' ? value() : value;
  }
  const entity = {
    error_reason: scenario.error_reason,
    error_step: scenario.error_step,
    acquirer_data: acquirerData,
    amount,
  };
  const classification = classifyMoneyState(entity);

  const id = `demo_${crypto.randomUUID()}`;
  const orderId = `demo_order_${crypto.randomUUID()}`;
  const nowIso = new Date().toISOString();

  await db.saveFailure({
    paymentId: id,
    orderId,
    reason: entity.error_reason,
    errorStep: entity.error_step,
    acquirerDataJson: JSON.stringify(entity.acquirer_data),
    moneyState: classification.state,
    amountPaise: amount,
    source: 'demo',
    nowIso,
  });

  return { id, orderId, state: classification.state };
}
