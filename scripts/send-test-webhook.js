import crypto from 'node:crypto';
import { makePaymentFailed, makePaymentCaptured } from '../src/fixtures.js';

// Signs a sample payload exactly like Razorpay would and POSTs it to a running
// local server, so you can watch the customer message render in its console.
//
// Usage:
//   RAZORPAY_WEBHOOK_SECRET=whsec_xxx node scripts/send-test-webhook.js otp
//   RAZORPAY_WEBHOOK_SECRET=whsec_xxx node scripts/send-test-webhook.js debited
//   RAZORPAY_WEBHOOK_SECRET=whsec_xxx node scripts/send-test-webhook.js infra
//   RAZORPAY_WEBHOOK_SECRET=whsec_xxx node scripts/send-test-webhook.js captured

const SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
if (!SECRET) {
  console.error('Set RAZORPAY_WEBHOOK_SECRET to match your running server.');
  process.exit(1);
}
const URL = process.env.WEBHOOK_URL || 'http://localhost:3000/webhook/razorpay';
const scenario = process.argv[2] || 'otp';

// Distinct payment/order ids per scenario so each one is messaged on its own
// (the service refuses to message the same payment twice). `captured` shares
// the `debited` order id so it visibly cancels that order's pending follow-up.
const SCENARIOS = {
  otp: makePaymentFailed({
    id: 'pay_otp',
    orderId: 'order_otp',
    errorReason: 'incorrect_otp',
    errorStep: 'payment_authentication',
  }),
  debited: makePaymentFailed({
    id: 'pay_dbt',
    orderId: 'order_dbt',
    errorReason: 'insufficient_funds',
    errorStep: 'payment_authorization',
    acquirerData: { rrn: '123456789012' }, // a proven debit
  }),
  infra: makePaymentFailed({
    id: 'pay_inf',
    orderId: 'order_inf',
    errorReason: 'issuer_down',
    errorStep: 'payment_authorization',
    method: 'card',
  }),
  expired: makePaymentFailed({
    id: 'pay_exp',
    orderId: 'order_exp',
    errorReason: 'card_expired',
    errorStep: 'payment_initiation',
  }),
  captured: makePaymentCaptured({ id: 'pay_dbt2', orderId: 'order_dbt' }),
};

const payload = SCENARIOS[scenario];
if (!payload) {
  console.error(`Unknown scenario "${scenario}". Try: ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(1);
}

const raw = Buffer.from(JSON.stringify(payload), 'utf8');
const signature = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
const eventId = `evt_${scenario}_${raw.length}`; // stable per scenario => idempotent

const res = await fetch(URL, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-razorpay-signature': signature,
    'x-razorpay-event-id': eventId,
  },
  body: raw,
});
console.log(`-> ${scenario}: HTTP ${res.status}`);
console.log(await res.text());
