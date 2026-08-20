// The vocabulary of failure. Every set here maps to a decision elsewhere; keep
// them in one place so the classifier and the recovery engine can never drift.
//
// Razorpay exposes on a failed payment: error_code, error_description,
// error_source, error_step, error_reason, and acquirer_data. We key off
// error_reason (the machine string) and error_step, and treat error_reason as
// the "cause". Descriptions are free text and MUST NOT be parsed for logic.

// Pre-authorisation failures: the transaction was rejected BEFORE any money
// could move. If there is also no acquirer reference, nothing was debited.
export const PRE_AUTH_REASONS = new Set([
  'incorrect_otp',
  'invalid_cvv',
  'invalid_vpa',
  'card_expired',
  'payment_cancelled',
  'insufficient_funds',
  'invalid_card_number',
  'international_transaction_not_allowed',
]);

// Infrastructure / timeout failures: the request may have reached the bank, so
// with no reference we genuinely cannot say whether money moved.
export const INFRA_REASONS = new Set([
  'issuer_down',
  'gateway_technical_error',
  'network_error',
  'payment_timeout',
  'upi_timeout',
  'server_error',
]);

// error_step values where money can plausibly have moved before the failure.
export const MONEY_RISK_STEPS = new Set([
  'payment_authorization',
  'authorization',
  'payment_response',
  'response',
]);

// The three money states. Exactly three, never a guess.
export const MoneyState = Object.freeze({
  NOT_DEBITED: 'NOT_DEBITED',
  DEBITED_REVERSAL_EXPECTED: 'DEBITED_REVERSAL_EXPECTED',
  CONFIRMING: 'CONFIRMING',
});

// Reasons that mean "the customer is still on the page, let them retry now".
export const RETRY_NOW_SAME = new Set([
  'incorrect_otp',
  'authentication_failed',
  'invalid_cvv',
]);

// Reasons where the card instrument can NEVER succeed — switch rails.
export const DEAD_CARD_REASONS = new Set([
  'card_expired',
  'invalid_card_number',
  'invalid_expiry',
  'international_transaction_not_allowed',
  'card_not_supported',
]);
