import { pollOnce } from '../confirming-poller.js';
import * as db from '../db/index.js';

// Demonstrates the confirming-poller with everything real EXCEPT the
// Razorpay API response: the CONFIRMING row must already exist from a real
// signed webhook (source: 'webhook') -- there is no way to "really" poll a
// synthetic demo id, since it was never a real Razorpay payment to begin
// with. What runs is the actual pollOnce(), the actual unmodified
// classify.js, and the actual db.upgradeFailureClassification() against the
// live row -- the ONLY simulated input is what Razorpay's API would
// eventually have said. Never touches a row that isn't already CONFIRMING
// from a real webhook, so this can't be used to fabricate a state a real
// failure never had.

const DEFAULT_RRN = () => Math.floor(100000000000 + Math.random() * 900000000000).toString();

// Throws { status, error } for the route to translate into an HTTP response.
export async function demoUpgradeConfirming({ paymentId, rrn }) {
  if (!paymentId) throw { status: 400, error: 'paymentId is required' };
  const row = await db.getFailure(paymentId);
  if (!row) throw { status: 404, error: 'no failure stored for that payment id' };
  if (row.source !== 'webhook') {
    throw { status: 400, error: 'only a real webhook-originated failure can be demo-upgraded' };
  }
  if (row.money_state !== 'CONFIRMING') {
    throw { status: 400, error: `payment is already ${row.money_state}, nothing to upgrade` };
  }

  const simulated = {
    error_reason: row.reason,
    error_step: row.error_step,
    acquirer_data: { rrn: rrn || DEFAULT_RRN() },
    amount: row.amount_paise,
  };

  const result = await pollOnce({
    fetchPayment: async (id) => (id === paymentId ? simulated : null),
  });

  const updated = await db.getFailure(paymentId);
  return { paymentId, ...result, moneyState: updated.money_state, simulatedRazorpayResponse: simulated };
}
