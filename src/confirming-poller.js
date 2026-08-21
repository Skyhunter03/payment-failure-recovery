import { classifyMoneyState } from './core/classify.js';
import { getRazorpayKeys } from './config.js';
import * as db from './db/index.js';
import { rootLog } from './logger.js';

// Upgrades CONFIRMING failures automatically. When a webhook produces
// CONFIRMING (failed at authorization/an infra reason, no acquirer reference
// yet), that's a genuinely open question -- the bank hasn't told us the
// outcome. This periodically re-asks Razorpay's own Payments API for the
// SAME payment; if a later answer carries a reference or a pre-auth reason,
// re-run the exact classify.js logic and, if the state actually changed,
// correct the stored row so /api/failure/:id (and failure.html) reflect the
// new truth on next load. Same in-process setInterval ticker pattern as
// followup-ticker.js -- no queue, no new infra.
//
// Deliberately does NOT touch classify.js, recovery.js, message.js, or the
// webhook handler -- this only feeds classify.js the SAME entity shape a
// webhook would and reacts to its (unmodified) output.

// Only bother rechecking rows from the last 48h -- Razorpay's own failure
// classification settles well within that window in practice; an unbounded
// recheck list would otherwise grow forever for a long-running instance.
const DEFAULT_POLL_WINDOW_MS = 48 * 60 * 60 * 1000;

async function defaultFetchPayment(paymentId) {
  const { keyId, keySecret } = getRazorpayKeys(); // throws if unconfigured -- caller catches per-row
  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const res = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) return null;
  return res.json();
}

// One recheck pass. Exported directly (not just via the ticker) so tests can
// run it once, synchronously, with a stubbed fetchPayment -- no real timers,
// no real network.
export async function pollOnce({
  fetchPayment = defaultFetchPayment,
  nowMs = Date.now(),
  windowMs = DEFAULT_POLL_WINDOW_MS,
  log = rootLog,
} = {}) {
  const cutoffIso = new Date(nowMs - windowMs).toISOString();
  const rows = await db.confirmingFailuresToRecheck(cutoffIso);
  let upgraded = 0;

  for (const row of rows) {
    try {
      const payment = await fetchPayment(row.payment_id);
      if (!payment) continue; // not found / API error this round -- try again next tick

      const entity = {
        error_reason: payment.error_reason ?? null,
        error_step: payment.error_step ?? null,
        acquirer_data: payment.acquirer_data ?? {},
        amount: payment.amount ?? row.amount_paise,
      };
      const classification = classifyMoneyState(entity);
      if (classification.state === 'CONFIRMING') continue; // still genuinely open

      await db.upgradeFailureClassification(row.payment_id, {
        reason: entity.error_reason,
        errorStep: entity.error_step,
        acquirerDataJson: JSON.stringify(entity.acquirer_data),
        moneyState: classification.state,
      });
      upgraded += 1;
      log.info('confirming_upgraded', {
        paymentId: row.payment_id,
        from: 'CONFIRMING',
        to: classification.state,
      });
    } catch (err) {
      log.error('confirming_poll_row_failed', { paymentId: row.payment_id, error: String(err) });
    }
  }

  return { checked: rows.length, upgraded };
}

export function startConfirmingPoller({ intervalMs, fetchPayment }) {
  const tick = async () => {
    try {
      await pollOnce({ fetchPayment });
    } catch (err) {
      rootLog.error('confirming_poller_tick_failed', { error: String(err) });
    }
  };
  const handle = setInterval(tick, intervalMs);
  if (typeof handle.unref === 'function') handle.unref();
  return () => clearInterval(handle);
}
