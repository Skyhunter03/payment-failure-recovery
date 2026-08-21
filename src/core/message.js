import { MoneyState } from './reasons.js';
import { formatInr, addWorkingDays, formatDate } from './money.js';

// Deterministic templates. No LLM. Same input -> byte-identical output.
//
// The message answers the four questions in the order a person actually panics:
//   1. Did my money leave?
//   2. Is it coming back, and when?
//   3. Should I pay again right now?
//   4. How do I still get what I wanted?
//
// Plus a 3-step money tracker whose steps are marked:
//   done | active | pending | unknown | skipped

const TRACKER_LABELS = [
  'Left your account',
  'Held at your bank',
  'Back in your account',
];

// How many working days a card/UPI reversal typically takes to land.
const REVERSAL_WORKING_DAYS = 5;

export function buildCustomerMessage({
  classification,
  recovery,
  amountPaise,
  eventDate,
}) {
  const amount = formatInr(amountPaise);
  const tracker = buildTracker(classification, eventDate);

  const q1 = didMyMoneyLeave(classification, amount);
  const q2 = isItComingBack(classification, tracker);
  const q3 = shouldIPayAgainNow(recovery);
  const q4 = howDoIStillGetIt(recovery, classification.state);

  return {
    state: classification.state,
    amount,
    reference: classification.reference?.value ?? null,
    headline: q1.headline,
    questions: {
      didMyMoneyLeave: q1.text,
      isItComingBack: q2,
      shouldIPayAgainNow: q3,
      howDoIStillGetWhatIWanted: q4,
    },
    tracker,
    // The recovery decision, surfaced so a UI can wire buttons to it.
    recovery: {
      delayMinutes: recovery.delayMinutes,
      method: recovery.method,
      switchMethod: recovery.switchMethod,
      rationale: recovery.rationale,
    },
  };
}

function didMyMoneyLeave(classification, amount) {
  switch (classification.state) {
    case MoneyState.NOT_DEBITED:
      return {
        headline: `No money left your account.`,
        text: `Good news: ${amount} was never debited. The payment was declined before any money could move.`,
      };
    case MoneyState.DEBITED_REVERSAL_EXPECTED:
      return {
        headline: `${amount} left your account — and it's on its way back.`,
        text: `Yes, ${amount} was debited. Your bank has already recorded the transaction, and because the payment failed it will be reversed automatically.`,
      };
    case MoneyState.CONFIRMING:
    default:
      return {
        headline: `We're checking with your bank about ${amount}.`,
        text: `We can't yet confirm whether ${amount} left your account. We do not want to guess, so we're verifying it with your bank right now.`,
      };
  }
}

function isItComingBack(classification, tracker) {
  switch (classification.state) {
    case MoneyState.NOT_DEBITED:
      return `There's nothing to come back — the money never left.`;
    case MoneyState.DEBITED_REVERSAL_EXPECTED: {
      const back = tracker[2];
      const ref = classification.reference;
      const refLine = ref
        ? ` Your bank reference is ${ref.value} (${refLabel(ref.field)}) — keep it if you ever need to ask your bank.`
        : '';
      return `Yes. Expect it back by ${back.expectedDate} at the latest.${refLine}`;
    }
    case MoneyState.CONFIRMING:
    default:
      return `If any money did leave, it comes back automatically — but we won't invent a date until we've confirmed it actually left.`;
  }
}

function shouldIPayAgainNow(recovery) {
  if (recovery.delayMinutes === 0) {
    return `Yes — you can pay again right now. ${recovery.rationale}`;
  }
  const wait = humanDelay(recovery.delayMinutes);
  return `Not right this second. ${recovery.rationale} (Best to wait about ${wait}.)`;
}

// The right "how do I still get it" copy depends on the funds state, not
// just the recovery decision: retrying reads fine when nothing was ever
// debited, but the same phrasing is actively wrong once money is confirmed
// debited (sounds like a retry of the same payment, when recovery always
// means a fresh one) or still unconfirmed (retrying before we know risks a
// double charge).
function howDoIStillGetIt(recovery, state) {
  const method = methodLabel(recovery.method);

  if (state === MoneyState.DEBITED_REVERSAL_EXPECTED) {
    return `This reversal happens on its own — you don't need to do anything to get your money back. If you'd rather not wait, you can make a fresh payment now with ${method}; that's a new, separate payment, not a retry of this one.`;
  }

  if (state === MoneyState.CONFIRMING) {
    return `Hold off paying again until we've confirmed what happened to this one — going again before we know risks a double charge. We'll update this the moment we hear back from your bank.`;
  }

  // NOT_DEBITED: nothing was charged, so retrying (on whatever method
  // recovery recommends) is genuinely safe right away.
  if (recovery.switchMethod) {
    return `Just pay by ${method} instead — that should get it through this time.`;
  }
  return recovery.method === 'same'
    ? `Just try again — the same method should work this time.`
    : `Just try again with ${method} — that should work this time.`;
}

// Build the 3-step tracker honestly for each state.
function buildTracker(classification, eventDate) {
  const state = classification.state;

  if (state === MoneyState.NOT_DEBITED) {
    // Money never moved: every step is skipped, not "done".
    return TRACKER_LABELS.map((label) => ({
      label,
      status: 'skipped',
      note: 'Did not happen — no debit.',
    }));
  }

  if (state === MoneyState.DEBITED_REVERSAL_EXPECTED) {
    const expected = formatDate(
      addWorkingDays(eventDate, REVERSAL_WORKING_DAYS)
    );
    return [
      {
        label: TRACKER_LABELS[0],
        status: 'done',
        note: 'Debited — confirmed by a bank reference.',
      },
      {
        label: TRACKER_LABELS[1],
        status: 'active',
        note: 'Your bank is holding it and processing the reversal.',
      },
      {
        label: TRACKER_LABELS[2],
        status: 'pending',
        expectedDate: expected,
        note: `Expected back by ${expected}.`,
      },
    ];
  }

  // CONFIRMING: we don't know whether it left, so we say so.
  return TRACKER_LABELS.map((label, i) => ({
    label,
    status: 'unknown',
    note:
      i === 0
        ? "We're confirming with your bank whether this happened."
        : 'Depends on the step above, which we have not confirmed.',
  }));
}

function refLabel(field) {
  if (field === 'rrn') return 'RRN';
  if (field === 'upi_transaction_id') return 'UPI transaction ID';
  if (field === 'bank_transaction_id') return 'bank transaction ID';
  return field;
}

function methodLabel(method) {
  if (method === 'upi') return 'UPI';
  if (method === 'card') return 'a card';
  return 'the same method';
}

function humanDelay(minutes) {
  if (minutes >= 60) {
    const hours = Math.round(minutes / 60);
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${minutes} minutes`;
}
