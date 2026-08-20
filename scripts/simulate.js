import { mulberry32, weightedPick } from './rng.js';
import { classifyMoneyState } from '../src/core/classify.js';
import { decideRecovery } from '../src/core/recovery.js';
import { formatInr } from '../src/core/money.js';
import { MoneyState } from '../src/core/reasons.js';

// ===========================================================================
//  EVERY NUMBER BELOW IS AN ASSUMPTION, NOT A MEASUREMENT.
//  They are declared here, commented, and printed in the output so nobody can
//  mistake a modelled result for a real one. Change them and re-run; the point
//  of this script is to show the SHAPE of the effect, never to promise a number.
// ===========================================================================

const ASSUMPTIONS = {
  // --- Traffic ------------------------------------------------------------
  N_FAILURES: 5000, // synthetic failed payments to simulate
  SEED: 42, // seeded RNG => identical run every time

  // Amount distribution (paise). Assumed, roughly e-commerce shaped.
  AMOUNT_MIN_PAISE: 9900, // ₹99
  AMOUNT_MAX_PAISE: 4999900, // ₹49,999

  // --- Cause mix (weights) ------------------------------------------------
  // Assumed relative frequency of each failure cause. NOT from real data.
  CAUSE_MIX: [
    { value: 'incorrect_otp', weight: 22 },
    { value: 'insufficient_funds', weight: 18 },
    { value: 'payment_cancelled', weight: 14 },
    { value: 'invalid_cvv', weight: 6 },
    { value: 'invalid_vpa', weight: 8 },
    { value: 'card_expired', weight: 5 },
    { value: 'invalid_card_number', weight: 3 },
    { value: 'international_transaction_not_allowed', weight: 2 },
    { value: 'issuer_down', weight: 8 },
    { value: 'gateway_technical_error', weight: 5 },
    { value: 'network_error', weight: 3 },
    { value: 'payment_timeout', weight: 3 },
    { value: 'upi_timeout', weight: 2 },
    { value: 'server_error', weight: 1 },
  ],

  // Assumed share of payments on card vs UPI (affects switch decisions).
  SHARE_CARD: 0.55,

  // Assumed probability the payload carries an acquirer reference (a real
  // debit) GIVEN the cause. Infra/authorization failures are likelier to have
  // touched the bank; clean pre-auth rejects almost never do.
  DEBIT_REFERENCE_PROB: {
    insufficient_funds: 0.15, // sometimes the bank debits then reverses
    issuer_down: 0.35,
    gateway_technical_error: 0.3,
    network_error: 0.25,
    payment_timeout: 0.4,
    upi_timeout: 0.4,
    server_error: 0.3,
    _default: 0.02, // clean pre-auth rejects: essentially never
  },

  // --- Behaviour: SILENT handling (today's status quo) --------------------
  // Assumed probability a customer recovers on their own with no guidance.
  SILENT_RECOVERY_PROB: 0.35,
  // Assumed probability a customer contacts support when left in the dark.
  // Higher when money actually left and nobody told them where it is.
  SILENT_SUPPORT_PROB_NOT_DEBITED: 0.08,
  SILENT_SUPPORT_PROB_DEBITED: 0.55,
  SILENT_SUPPORT_PROB_CONFIRMING: 0.35,

  // --- Behaviour: GUIDED recovery (this service) --------------------------
  // Assumed recovery probability by how good the guided path is for the cause.
  // "Retry now, same method" (customer present) recovers best; "wait" cases
  // recover less because time passes and intent decays.
  GUIDED_RECOVERY_PROB_RETRY_NOW: 0.62, // delay 0, same/upi correct
  GUIDED_RECOVERY_PROB_SWITCH_NOW: 0.55, // delay 0, switched rail
  GUIDED_RECOVERY_PROB_WAIT: 0.4, // delayed nudge (infra/low balance)
  GUIDED_RECOVERY_PROB_CANCELLED: 0.2, // they chose to cancel; low intent

  // Assumed support-contact probability once we've clearly told them where
  // their money is. Telling a debited customer "it's coming back, here's the
  // reference, here's the date" is where the biggest drop happens.
  GUIDED_SUPPORT_PROB_NOT_DEBITED: 0.02,
  GUIDED_SUPPORT_PROB_DEBITED: 0.12,
  GUIDED_SUPPORT_PROB_CONFIRMING: 0.18,
};

function run() {
  const rng = mulberry32(ASSUMPTIONS.SEED);

  const silent = { recovered: 0, valueRecovered: 0, support: 0 };
  const guided = { recovered: 0, valueRecovered: 0, support: 0 };
  const byState = {
    [MoneyState.NOT_DEBITED]: 0,
    [MoneyState.DEBITED_REVERSAL_EXPECTED]: 0,
    [MoneyState.CONFIRMING]: 0,
  };

  for (let i = 0; i < ASSUMPTIONS.N_FAILURES; i++) {
    const cause = weightedPick(rng, ASSUMPTIONS.CAUSE_MIX);
    const method = rng() < ASSUMPTIONS.SHARE_CARD ? 'card' : 'upi';
    const amount = randInt(
      rng,
      ASSUMPTIONS.AMOUNT_MIN_PAISE,
      ASSUMPTIONS.AMOUNT_MAX_PAISE
    );

    // Does the payload carry a reference (a proven debit)?
    const pDebit =
      ASSUMPTIONS.DEBIT_REFERENCE_PROB[cause] ??
      ASSUMPTIONS.DEBIT_REFERENCE_PROB._default;
    const hasReference = rng() < pDebit;

    const entity = {
      error_reason: cause,
      error_step: stepFor(cause),
      method,
      acquirer_data: hasReference ? { rrn: `SIM${i}` } : {},
      amount,
    };

    const classification = classifyMoneyState(entity);
    byState[classification.state] += 1;

    const recovery = decideRecovery(cause, { originalMethod: method });

    // --- Silent path ------------------------------------------------------
    if (rng() < ASSUMPTIONS.SILENT_RECOVERY_PROB) {
      silent.recovered += 1;
      silent.valueRecovered += amount;
    }
    if (rng() < silentSupportProb(classification.state)) silent.support += 1;

    // --- Guided path ------------------------------------------------------
    if (rng() < guidedRecoveryProb(recovery)) {
      guided.recovered += 1;
      guided.valueRecovered += amount;
    }
    if (rng() < guidedSupportProb(classification.state)) guided.support += 1;
  }

  print(ASSUMPTIONS, silent, guided, byState);
}

function stepFor(cause) {
  // A plausible error_step per cause, matching Razorpay's vocabulary.
  if (cause === 'incorrect_otp') return 'payment_authentication';
  if (['issuer_down', 'gateway_technical_error', 'server_error'].includes(cause))
    return 'payment_authorization';
  if (['network_error', 'payment_timeout', 'upi_timeout'].includes(cause))
    return 'payment_response';
  return 'payment_initiation';
}

function silentSupportProb(state) {
  if (state === MoneyState.NOT_DEBITED)
    return ASSUMPTIONS.SILENT_SUPPORT_PROB_NOT_DEBITED;
  if (state === MoneyState.DEBITED_REVERSAL_EXPECTED)
    return ASSUMPTIONS.SILENT_SUPPORT_PROB_DEBITED;
  return ASSUMPTIONS.SILENT_SUPPORT_PROB_CONFIRMING;
}

function guidedSupportProb(state) {
  if (state === MoneyState.NOT_DEBITED)
    return ASSUMPTIONS.GUIDED_SUPPORT_PROB_NOT_DEBITED;
  if (state === MoneyState.DEBITED_REVERSAL_EXPECTED)
    return ASSUMPTIONS.GUIDED_SUPPORT_PROB_DEBITED;
  return ASSUMPTIONS.GUIDED_SUPPORT_PROB_CONFIRMING;
}

function guidedRecoveryProb(recovery) {
  if (recovery.cause === 'payment_cancelled')
    return ASSUMPTIONS.GUIDED_RECOVERY_PROB_CANCELLED;
  if (recovery.delayMinutes > 0) return ASSUMPTIONS.GUIDED_RECOVERY_PROB_WAIT;
  if (recovery.switchMethod) return ASSUMPTIONS.GUIDED_RECOVERY_PROB_SWITCH_NOW;
  return ASSUMPTIONS.GUIDED_RECOVERY_PROB_RETRY_NOW;
}

function randInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function pct(n, d) {
  return d === 0 ? '0.0%' : `${((100 * n) / d).toFixed(1)}%`;
}

function print(a, silent, guided, byState) {
  const N = a.N_FAILURES;
  const out = [];
  out.push('');
  out.push('=== Razorpay failure recovery — SIMULATION (modelled, not real) ===');
  out.push(`Seed: ${a.SEED}   Failures simulated: ${N}`);
  out.push('');
  out.push('Money-state classification of the synthetic failures:');
  out.push(`  NOT_DEBITED               ${byState.NOT_DEBITED}  (${pct(byState.NOT_DEBITED, N)})`);
  out.push(`  DEBITED_REVERSAL_EXPECTED ${byState.DEBITED_REVERSAL_EXPECTED}  (${pct(byState.DEBITED_REVERSAL_EXPECTED, N)})`);
  out.push(`  CONFIRMING                ${byState.CONFIRMING}  (${pct(byState.CONFIRMING, N)})`);
  out.push('');
  out.push('                         SILENT handling      GUIDED recovery      Delta');
  out.push(
    `  Orders recovered       ${col(silent.recovered)} ${pctCol(silent.recovered, N)}   ${col(guided.recovered)} ${pctCol(guided.recovered, N)}   +${guided.recovered - silent.recovered}`
  );
  out.push(
    `  Value recovered        ${col(formatInr(silent.valueRecovered))}        ${col(formatInr(guided.valueRecovered))}        +${formatInr(guided.valueRecovered - silent.valueRecovered)}`
  );
  out.push(
    `  Support contacts       ${col(silent.support)} ${pctCol(silent.support, N)}   ${col(guided.support)} ${pctCol(guided.support, N)}   ${guided.support - silent.support}`
  );
  out.push('');
  out.push('--- ASSUMPTIONS USED (all modelled — verify them yourself) ---');
  out.push(JSON.stringify(a, null, 2));
  out.push('');
  out.push('These deltas are the product of the assumptions above and nothing');
  out.push('else. They are a hypothesis to test in Razorpay test mode + a real');
  out.push('pilot, not a claim about your traffic.');
  out.push('');
  process.stdout.write(out.join('\n') + '\n');
}

function col(v) {
  return String(v).padStart(8);
}
function pctCol(n, d) {
  return `(${pct(n, d)})`.padEnd(8);
}

run();
