// HTTP-level tests: real requests against the Express app (routes, signature, rate limit).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import * as db from '../src/db/index.js';
import { createApp } from '../src/server.js';
import { makePaymentFailed } from '../src/fixtures.js';

const SECRET = 'whsec_integration';
let server;
let baseUrl;

beforeAll(async () => {
  await db.initDb(':memory:');
  const app = createApp({ getSecret: () => SECRET });
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await db.closeDb();
});

// Fresh DB per test so idempotency ledgers don't leak between cases.
beforeEach(async () => {
  await db.closeDb();
  await db.initDb(':memory:');
});

function post(raw, { signature, eventId }) {
  const headers = { 'content-type': 'application/json' };
  if (signature !== undefined) headers['x-razorpay-signature'] = signature;
  if (eventId) headers['x-razorpay-event-id'] = eventId;
  return fetch(`${baseUrl}/webhook/razorpay`, { method: 'POST', headers, body: raw });
}

function sign(raw) {
  return crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
}

describe('GET /', () => {
  it('redirects to /demo instead of dead-ending', async () => {
    const res = await fetch(`${baseUrl}/`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/demo');
  });
});

describe('GET /demo', () => {
  it('serves the demo hub page', async () => {
    const res = await fetch(`${baseUrl}/demo`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/html/);
  });
});

// The recovery-action button on failure.html depends on this route to open a
// FRESH order (never a capture of the failed payment). No prior coverage.
describe('POST /create-order', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
  });

  it('creates a real-shaped order via Basic auth, without hitting the network', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_stub';
    process.env.RAZORPAY_KEY_SECRET = 'stub_secret';
    global.fetch = async (url, opts) => {
      // Only intercept the server's outbound call to Razorpay -- this test's
      // own call to the local server (below) must reach the real fetch.
      if (typeof url === 'string' && url.includes('api.razorpay.com')) {
        expect(url).toBe('https://api.razorpay.com/v1/orders');
        expect(opts.headers.Authorization).toBe(
          `Basic ${Buffer.from('rzp_test_stub:stub_secret').toString('base64')}`
        );
        return { ok: true, json: async () => ({ id: 'order_stub123', amount: 149900, currency: 'INR' }) };
      }
      return originalFetch(url, opts);
    };

    const res = await fetch(`${baseUrl}/create-order`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      orderId: 'order_stub123',
      amount: 149900,
      currency: 'INR',
      keyId: 'rzp_test_stub',
    });
  });

  it('returns 500 with a clear message when keys are not configured', async () => {
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    const res = await fetch(`${baseUrl}/create-order`, { method: 'POST' });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/RAZORPAY_KEY_ID/);
  });

  it('returns 502 when Razorpay itself rejects the order request', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_stub';
    process.env.RAZORPAY_KEY_SECRET = 'stub_secret';
    global.fetch = async (url, opts) => {
      if (typeof url === 'string' && url.includes('api.razorpay.com')) {
        return { ok: false, status: 401, json: async () => ({ error: { description: 'bad key' } }) };
      }
      return originalFetch(url, opts);
    };
    const res = await fetch(`${baseUrl}/create-order`, { method: 'POST' });
    expect(res.status).toBe(502);
  });

  it('attaches original_payment_id / original_order_id notes for a recovery order', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_stub';
    process.env.RAZORPAY_KEY_SECRET = 'stub_secret';
    let capturedBody;
    global.fetch = async (url, opts) => {
      if (typeof url === 'string' && url.includes('api.razorpay.com')) {
        capturedBody = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ id: 'order_recovered', amount: 149900, currency: 'INR' }) };
      }
      return originalFetch(url, opts);
    };

    const res = await fetch(`${baseUrl}/create-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ originalPaymentId: 'pay_failed_123', originalOrderId: 'order_failed_456' }),
    });
    expect(res.status).toBe(200);
    // Still a standalone order -- same amount/currency as any other, the
    // only difference is the notes metadata.
    expect(capturedBody.notes).toEqual({
      recovery: 'true',
      original_payment_id: 'pay_failed_123',
      original_order_id: 'order_failed_456',
    });
  });

  it('omits notes entirely for the plain (non-recovery) checkout flow', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_stub';
    process.env.RAZORPAY_KEY_SECRET = 'stub_secret';
    let capturedBody;
    global.fetch = async (url, opts) => {
      if (typeof url === 'string' && url.includes('api.razorpay.com')) {
        capturedBody = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ id: 'order_plain', amount: 149900, currency: 'INR' }) };
      }
      return originalFetch(url, opts);
    };

    const res = await fetch(`${baseUrl}/create-order`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(capturedBody.notes).toBeUndefined();
  });
});

describe('POST /webhook/razorpay — signature enforcement over the raw body', () => {
  it('ACCEPTS a correctly signed payload (200)', async () => {
    const raw = Buffer.from(JSON.stringify(makePaymentFailed({ id: 'pay_1', orderId: 'order_1' })));
    const res = await post(raw, { signature: sign(raw), eventId: 'evt_ok' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.moneyState).toBe('NOT_DEBITED');
  });

  it('REJECTS a wrong signature (401)', async () => {
    const raw = Buffer.from(JSON.stringify(makePaymentFailed()));
    const res = await post(raw, { signature: 'deadbeef', eventId: 'evt_bad' });
    expect(res.status).toBe(401);
  });

  it('REJECTS a tampered body (401) — valid sig for different bytes', async () => {
    const original = Buffer.from(JSON.stringify(makePaymentFailed({ amount: 100 })));
    const sig = sign(original);
    const tampered = Buffer.from(JSON.stringify(makePaymentFailed({ amount: 9999999 })));
    const res = await post(tampered, { signature: sig, eventId: 'evt_tamper' });
    expect(res.status).toBe(401);
  });

  it('REJECTS a missing signature (401)', async () => {
    const raw = Buffer.from(JSON.stringify(makePaymentFailed()));
    const res = await post(raw, { signature: undefined, eventId: 'evt_missing' });
    expect(res.status).toBe(401);
  });

  it('returns 200 on a duplicate delivery (so Razorpay stops retrying)', async () => {
    const raw = Buffer.from(JSON.stringify(makePaymentFailed({ id: 'pay_d', orderId: 'order_d' })));
    const sig = sign(raw);
    const a = await post(raw, { signature: sig, eventId: 'evt_dup' });
    const b = await post(raw, { signature: sig, eventId: 'evt_dup' });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((await b.json()).duplicate).toBe(true);
  });

  it('REJECTS a correctly signed but malformed-JSON body (400)', async () => {
    const raw = Buffer.from('{not valid json');
    const res = await post(raw, { signature: sign(raw), eventId: 'evt_malformed' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/JSON/i);
  });
});

describe('POST /webhook/razorpay — rate limiting', () => {
  let rlServer;
  let rlBaseUrl;

  beforeAll(async () => {
    // A tiny max so the test trips the limiter without sending dozens of
    // requests; production uses config.rateLimitMax (default 60/min).
    const app = createApp({ getSecret: () => SECRET, rateLimitWindowMs: 60_000, rateLimitMax: 2 });
    await new Promise((resolve) => {
      rlServer = app.listen(0, () => {
        rlBaseUrl = `http://127.0.0.1:${rlServer.address().port}`;
        resolve();
      });
    });
  });

  afterAll(async () => new Promise((r) => rlServer.close(r)));

  it('returns 429 once the per-window cap is exceeded', async () => {
    const raw = Buffer.from(JSON.stringify(makePaymentFailed()));
    const headers = { 'content-type': 'application/json', 'x-razorpay-signature': 'deadbeef' };
    const post = (id) => fetch(`${rlBaseUrl}/webhook/razorpay`, {
      method: 'POST', headers: { ...headers, 'x-razorpay-event-id': id }, body: raw,
    });
    const a = await post('evt_rl_1');
    const b = await post('evt_rl_2');
    const c = await post('evt_rl_3');
    expect(a.status).toBe(401); // under the cap, reaches signature check
    expect(b.status).toBe(401);
    expect(c.status).toBe(429); // 3rd request within the window is capped
    expect((await c.json()).error).toBe('rate limited');
  });
});
