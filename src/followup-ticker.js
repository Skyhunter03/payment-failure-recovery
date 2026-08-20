import * as db from './db/index.js';
import { rootLog } from './logger.js';

// Periodically finds due follow-ups and "delivers" them (logs only). Cancelled
// follow-ups are never here because payment.captured flips them to 'cancelled'
// before they come due. This proves suppression: pay, and the nudge vanishes.

export function startFollowUpTicker({ intervalMs }) {
  const tick = () => {
    const nowIso = new Date().toISOString();
    let due;
    try {
      due = db.dueFollowUps(nowIso);
    } catch (err) {
      rootLog.error('followup_tick_failed', { error: String(err) });
      return;
    }
    for (const f of due) {
      rootLog.info('followup_due', {
        followUpId: f.id,
        orderId: f.order_id,
        paymentId: f.payment_id,
        kind: f.kind,
        channel: 'console-only',
      });
      db.markFollowUpSent(f.id);
    }
  };

  const handle = setInterval(tick, intervalMs);
  // Don't keep the process alive just for the ticker.
  if (typeof handle.unref === 'function') handle.unref();
  return () => clearInterval(handle);
}
