# payment-failure-recovery

When an online payment fails in India, three things happen at once: the bank
fires a debit SMS, the checkout says "failed", and **nobody tells the customer
whether the money actually left, whether it's coming back, or whether paying
again will double-charge them.**

This service closes that gap. On a Razorpay `payment.failed` webhook it does two
things, in order:

1. Tells the customer, in plain language, **where their money is**.
2. Offers the **recovery path most likely to succeed for that specific cause** —
   not one blind "try again".

Test mode, SQLite, no paid services, free-tier deployable. **Nothing is ever
sent to anyone** — messages render to the console and to structured logs.

---

## The one rule the whole codebase is built around

> **Never claim money was debited unless the payload proves it.**

Every failure is classified into exactly one of three states — never a guess:

| State | When | What the customer is told |
|---|---|---|
| `NOT_DEBITED` | A pre-authorisation reason (`incorrect_otp`, `invalid_cvv`, `invalid_vpa`, `card_expired`, `payment_cancelled`, `insufficient_funds`, `invalid_card_number`, `international_transaction_not_allowed`) **and no acquirer reference** | "No money left your account." |
| `DEBITED_REVERSAL_EXPECTED` | `acquirer_data` contains an **`rrn`, `upi_transaction_id`, or `bank_transaction_id`** — a reference only minted once the bank has seen the transaction | "Your money is on its way back." Shows the reference and an expected date 5 working days out. |
| `CONFIRMING` | Failed at `payment_authorization` / `payment_response`, or an infra reason (`issuer_down`, `gateway_technical_error`, `network_error`, `payment_timeout`, `upi_timeout`, `server_error`), **with no reference** | "We are checking with your bank." **No invented reversal date.** |

The proof of a debit is the acquirer reference, nothing else. So
`insufficient_funds` **with** a reference is `DEBITED` (the bank debited, then
reverses); `issuer_down` **without** one stays `CONFIRMING`. The third state is
the important one — it is not allowed to collapse into either of the others.

---

## Recovery decisions (per cause)

Each returns `delayMinutes`, `method`, `switchMethod`, `followUps`, and a
plain-English `rationale`. See `src/core/recovery.js`.

| Cause | Decision |
|---|---|
| `incorrect_otp` / `authentication_failed` / `invalid_cvv` | Retry **now**, same method — the customer is still on the page |
| `invalid_vpa` | Correct **now**, stay on UPI |
| `card_expired` / `invalid_card_number` / `invalid_expiry` / `international_transaction_not_allowed` / `card_not_supported` | Switch to UPI **now** — that card can never succeed |
| `insufficient_funds` | Wait ~20 hours, then offer UPI |
| `issuer_down` / gateway / network / timeouts | Wait 40 min; switch off card if the original was a card |
| `payment_cancelled` | One quiet reminder after 4 hours, then stop |
| anything else | A single conservative follow-up at 30 min |

---

## What is REAL vs what is MODELLED

**Real — this is actual working logic, verify it by reading and running it:**

- The three-state money classification (`src/core/classify.js`).
- The per-cause recovery decisions (`src/core/recovery.js`).
- The deterministic customer message + 3-step money tracker (`src/core/message.js`).
- **Webhook signature verification** — HMAC-SHA256 over the **raw** body, with a
  timing-safe compare (`src/webhook/signature.js`), wired so the raw bytes are
  never re-serialised before the check (`src/server.js`).
- **Idempotency** — event ids are stored; duplicate deliveries return `200`
  without re-messaging (`src/db/index.js`, `src/webhook/handler.js`).
- **Follow-up suppression** — a later `payment.captured` for the same `order_id`
  cancels pending nudges.
- ₹ formatting with Indian digit grouping, and reversal dates that skip weekends.

**Modelled — every number here is an assumption, not a measurement:**

- **Everything the simulator prints** (`scripts/simulate.js`): the cause mix,
  the debit-reference probabilities, the recovery uplift, and the
  support-contact rates for silent vs guided handling. They are declared as
  named constants at the top of that file, printed in its own output, and exist
  to show the *shape* of the effect — **not to promise a number about your
  traffic.**

**One thing to check yourself before trusting any of this:** the whole premise
is that an acquirer reference in `acquirer_data` reliably indicates a real debit,
and that its absence on a pre-auth failure reliably indicates no debit. That is
the assumption everything rests on. **Verify it in Razorpay _test mode_**: fire
real test-mode failures, inspect the exact `payload.payment.entity` your account
sends (`error_reason`, `error_step`, `acquirer_data`), and confirm the mapping
in `src/core/reasons.js` matches what you actually receive before relying on a
single word of the customer message.

Also note: the reversal-date math skips **weekends only**. It does not know
Indian bank holidays, so a real reversal can land a day or two later.

---

## Run it

Requires **Node 20+**. `better-sqlite3` is a native module, so a first
`npm install` compiles it (needs build tools on your platform).

```bash
npm install
cp .env.example .env          # then set RAZORPAY_WEBHOOK_SECRET
npm test                      # the logic + security tests (63 tests)
npm run simulate              # prints the modelled comparison + its assumptions
npm start                     # starts the webhook service on $PORT (default 3000)
```

Send yourself a signed test webhook and watch the message render (server must be
running, same secret in your env):

```bash
RAZORPAY_WEBHOOK_SECRET=whsec_xxx node scripts/send-test-webhook.js otp
RAZORPAY_WEBHOOK_SECRET=whsec_xxx node scripts/send-test-webhook.js debited
RAZORPAY_WEBHOOK_SECRET=whsec_xxx node scripts/send-test-webhook.js infra
RAZORPAY_WEBHOOK_SECRET=whsec_xxx node scripts/send-test-webhook.js captured
```

### Point Razorpay at it

In the Razorpay Dashboard (**test mode**) → Settings → Webhooks, add a webhook
to `https://<your-host>/webhook/razorpay`, subscribe to `payment.failed` and
`payment.captured`, and set the secret to the same value as
`RAZORPAY_WEBHOOK_SECRET`. For local testing, expose the port with a tunnel
(e.g. `ssh -R`, `cloudflared`, `ngrok`).

---

## Security & operational notes

- **Raw body first.** `express.raw()` is mounted on the webhook route and
  `express.json()` is never mounted globally — parsing before verifying would
  change the bytes and break every signature. This is the most common way to get
  webhook verification silently wrong.
- **Non-2xx means "retry".** Only genuine auth (`401`) and malformed-payload
  (`400`) responses are non-2xx. Duplicates and unhandled event types return
  `200` so Razorpay stops retrying.
- **Secrets live in the environment.** `.env` is git-ignored; `.env.example`
  documents the shape.
- **Structured logs**, one JSON object per line, request id on every line.

---

## Layout

```
src/
  config.js            env loading (+ tiny .env reader, no dependency)
  logger.js            one-line JSON logs, request id on every line
  render.js            renders the message to the console (this IS "delivery")
  server.js            Express; raw body -> verify -> parse -> validate -> handle
  index.js             process entry point
  fixtures.js          synthetic Razorpay-shaped payloads
  followup-ticker.js   logs due follow-ups (never contacts anyone)
  core/
    reasons.js         the reason vocabulary (single source of truth)
    classify.js        the three money states
    recovery.js        per-cause recovery decisions
    message.js         deterministic customer message + tracker
    money.js           ₹ Indian grouping + working-day math
  webhook/
    signature.js       HMAC-SHA256 raw-body, timing-safe
    validate.js        payload shape validation
    handler.js         classify + decide + message + idempotency + suppression
  db/
    index.js           the ONLY file that knows SQLite (swap to Postgres here)
scripts/
  simulate.js          seeded simulation; assumptions declared + printed
  send-test-webhook.js signs and posts a sample payload to a running server
  rng.js               seeded PRNG
test/                  vitest, 63 tests: classify, recovery, signature, message,
                       money, handler (idempotency/suppression), server (HTTP)
```

## Swapping SQLite → Postgres

Re-implement the functions in `src/db/index.js` against `pg`, keeping the same
signatures. No other file imports a database driver.
