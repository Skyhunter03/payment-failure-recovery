import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { verifySignature } from '../src/webhook/signature.js';

const SECRET = 'whsec_test_secret';
const raw = Buffer.from(JSON.stringify({ event: 'payment.failed', hello: 'world' }));
const goodSig = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');

describe('verifySignature — HMAC SHA256 over raw bytes, timing-safe', () => {
  it('ACCEPTS a correct signature', () => {
    expect(verifySignature({ rawBody: raw, signature: goodSig, secret: SECRET })).toBe(true);
  });

  it('REJECTS a signature made with the wrong secret', () => {
    const bad = crypto.createHmac('sha256', 'wrong').update(raw).digest('hex');
    expect(verifySignature({ rawBody: raw, signature: bad, secret: SECRET })).toBe(false);
  });

  it('REJECTS a TAMPERED body (one byte changed after signing)', () => {
    const tampered = Buffer.from(
      JSON.stringify({ event: 'payment.failed', hello: 'w0rld' })
    );
    expect(verifySignature({ rawBody: tampered, signature: goodSig, secret: SECRET })).toBe(false);
  });

  it('REJECTS a MISSING signature', () => {
    expect(verifySignature({ rawBody: raw, signature: undefined, secret: SECRET })).toBe(false);
    expect(verifySignature({ rawBody: raw, signature: '', secret: SECRET })).toBe(false);
  });

  it('REJECTS when the secret is missing', () => {
    expect(verifySignature({ rawBody: raw, signature: goodSig, secret: '' })).toBe(false);
  });

  it('REJECTS an empty body', () => {
    expect(verifySignature({ rawBody: Buffer.alloc(0), signature: goodSig, secret: SECRET })).toBe(false);
  });

  it('is byte-sensitive: reserialised body with different whitespace fails', () => {
    // Same object, different bytes (spaces) => different HMAC. This is exactly
    // why the raw body must be preserved end to end.
    const spaced = Buffer.from('{ "event": "payment.failed", "hello": "world" }');
    expect(verifySignature({ rawBody: spaced, signature: goodSig, secret: SECRET })).toBe(false);
  });
});
