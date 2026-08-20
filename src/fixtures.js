// Synthetic payment.failed / payment.captured payloads shaped like Razorpay's.
// Used by tests, the simulator, and the manual sender. Not real data.

export function makePaymentFailed({
  id = 'pay_TEST0001',
  orderId = 'order_TEST0001',
  amount = 149900, // paise -> ₹1,499.00
  method = 'card',
  errorReason = 'incorrect_otp',
  errorStep = 'payment_authentication',
  errorSource = 'customer',
  acquirerData = null, // e.g. { rrn: '2288...' } to prove a debit
} = {}) {
  return {
    entity: 'event',
    event: 'payment.failed',
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id,
          entity: 'payment',
          amount,
          currency: 'INR',
          status: 'failed',
          order_id: orderId,
          method,
          error_code: 'BAD_REQUEST_ERROR',
          error_description: 'Human readable text — never parsed for logic.',
          error_source: errorSource,
          error_step: errorStep,
          error_reason: errorReason,
          acquirer_data: acquirerData ?? {},
        },
      },
    },
  };
}

export function makePaymentCaptured({
  id = 'pay_TEST0001',
  orderId = 'order_TEST0001',
  amount = 149900,
} = {}) {
  return {
    entity: 'event',
    event: 'payment.captured',
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id,
          entity: 'payment',
          amount,
          currency: 'INR',
          status: 'captured',
          order_id: orderId,
          method: 'upi',
        },
      },
    },
  };
}
