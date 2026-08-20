import { RETRY_NOW_SAME, DEAD_CARD_REASONS } from './reasons.js';

// One decision per cause. Not one blind retry.
//
// A decision is:
//   delayMinutes  how long to wait before the recovery nudge (0 = now)
//   method        the payment method to recover WITH ('same' | 'upi' | 'card')
//   switchMethod  true if we are moving the customer off their original rail
//   followUps     scheduled nudges: [{ atMinutes, kind }]  (empty = none)
//   rationale     plain-English reason a human can read
//
// 'same' means "the same method/instrument you just tried". We only ever say
// 'same' when retrying it could actually work.

const MINUTES = { h: 60 };

export function decideRecovery(reason, ctx = {}) {
  const originalMethod = ctx.originalMethod || 'unknown'; // 'card' | 'upi' | ...
  const cause = reason || 'unknown';

  // --- Customer is still on the page; retrying now can succeed --------------
  if (RETRY_NOW_SAME.has(cause)) {
    const label =
      cause === 'invalid_cvv'
        ? 'The CVV was wrong'
        : 'Authentication (OTP) did not complete';
    return decision({
      cause,
      delayMinutes: 0,
      method: 'same',
      switchMethod: false,
      followUps: [],
      rationale: `${label}. You're still here and nothing was charged — just enter it again and retry the same way now.`,
    });
  }

  // --- Wrong UPI ID: fix it, stay on UPI -----------------------------------
  if (cause === 'invalid_vpa') {
    return decision({
      cause,
      delayMinutes: 0,
      method: 'upi',
      switchMethod: false,
      followUps: [],
      rationale:
        'The UPI ID was not recognised. Correct it and pay again on UPI now — no need to switch anything else.',
    });
  }

  // --- The card can never succeed: switch rails now ------------------------
  if (DEAD_CARD_REASONS.has(cause)) {
    return decision({
      cause,
      delayMinutes: 0,
      method: 'upi',
      switchMethod: true,
      followUps: [],
      rationale:
        'That card cannot complete this payment (expired / not usable here). Retrying it will fail again — pay by UPI now instead.',
    });
  }

  // --- Low balance: don't hammer it, wait then offer UPI -------------------
  if (cause === 'insufficient_funds') {
    const delay = 20 * MINUTES.h; // ~20 hours
    return decision({
      cause,
      delayMinutes: delay,
      method: 'upi',
      switchMethod: true,
      followUps: [{ atMinutes: delay, kind: 'retry_after_topup' }],
      rationale:
        'The account did not have enough balance. Retrying right now will just fail again — we will remind you in about 20 hours, and UPI is the quickest way to pay once funds are in.',
    });
  }

  // --- Infra / timeout: give the network time, drop card if it was card ----
  if (isInfra(cause)) {
    const switchOffCard = originalMethod === 'card';
    return decision({
      cause,
      delayMinutes: 40,
      method: switchOffCard ? 'upi' : 'same',
      switchMethod: switchOffCard,
      followUps: [{ atMinutes: 40, kind: 'retry_after_recovery' }],
      rationale: switchOffCard
        ? 'A temporary bank/gateway problem, not your card. Give it ~40 minutes, then pay by UPI — it routes around whatever was down.'
        : 'A temporary bank/gateway problem. Give it ~40 minutes and try again; it usually clears on its own.',
    });
  }

  // --- Customer cancelled: one quiet reminder, then leave them alone -------
  if (cause === 'payment_cancelled') {
    const delay = 4 * MINUTES.h;
    return decision({
      cause,
      delayMinutes: delay,
      method: 'same',
      switchMethod: false,
      followUps: [{ atMinutes: delay, kind: 'gentle_reminder' }],
      rationale:
        'You cancelled this payment yourself — nothing was charged. We will send one quiet reminder in 4 hours and then stop; no chasing.',
    });
  }

  // --- Unknown: a single conservative follow-up ----------------------------
  return decision({
    cause,
    delayMinutes: 30,
    method: 'same',
    switchMethod: false,
    followUps: [{ atMinutes: 30, kind: 'conservative_followup' }],
    rationale:
      'We could not pin down the exact cause. We will check back once in about 30 minutes rather than guess or nag.',
  });
}

function isInfra(cause) {
  return (
    cause === 'issuer_down' ||
    cause === 'gateway_technical_error' ||
    cause === 'network_error' ||
    cause === 'payment_timeout' ||
    cause === 'upi_timeout' ||
    cause === 'server_error'
  );
}

function decision(d) {
  return {
    cause: d.cause,
    delayMinutes: d.delayMinutes,
    method: d.method,
    switchMethod: d.switchMethod,
    followUps: d.followUps,
    rationale: d.rationale,
  };
}
