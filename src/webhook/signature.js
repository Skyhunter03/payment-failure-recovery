import crypto from 'node:crypto';

// Verify a Razorpay webhook signature.
//
//   signature = HMAC_SHA256( rawBody, webhookSecret )  as lowercase hex
//
// CRITICAL: this must run over the RAW request bytes. If any JSON parser has
// re-serialised the body first, whitespace and key order change and the HMAC
// will never match. The server mounts the raw body parser before JSON.
//
// Comparison is timing-safe: we never early-return on the first differing byte.
export function verifySignature({ rawBody, signature, secret }) {
  if (!secret) return false;
  if (!signature || typeof signature !== 'string') return false;
  if (!rawBody || rawBody.length === 0) return false;

  const bodyBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);

  const expected = crypto
    .createHmac('sha256', secret)
    .update(bodyBuf)
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(signature, 'utf8');

  // timingSafeEqual throws on length mismatch, so guard it. A length mismatch
  // is itself a rejection, but we still avoid leaking timing on equal lengths.
  if (expectedBuf.length !== providedBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}
