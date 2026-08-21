import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
  it('redirects to /checkout instead of dead-ending', async () => {
    const res = await fetch(`${baseUrl}/`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/checkout');
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
