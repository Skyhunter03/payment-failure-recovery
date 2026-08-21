# Deployment verification

Run 2026-08-21 against the live production deployment — **not local, not mocked**.

- **App:** https://payment-failure-recovery.onrender.com
- **Webhook URL:** https://payment-failure-recovery.onrender.com/webhook/razorpay
- **Database:** Neon Postgres (via `DATABASE_URL`, set in the Render dashboard only)
- **Host:** Render free web-service tier

Every check below hit the real URL and, where noted, the real Neon database — no local server, no `:memory:` SQLite, no stubbed responses.

## 1. Health & pages

| Check | Result |
|---|---|
| `GET /healthz` | `200`, `{"ok":true}` — verified with full verbose TLS/header trace, not just a status code |
| `render.yaml` `healthCheckPath` vs. the code's actual route | both `/healthz` — confirmed to match |
| `GET /checkout` | `200` |
| `GET /failure.html` | `200` |
| `GET /dashboard.html` | `200` |
| `GET /showcase/` | `200` |
| `GET /` (bare root) | `302` → `/checkout` |

## 2. One real webhook, end to end — the customer screen it produced

`payment.failed`, cause `issuer_down`, no acquirer reference → classified `CONFIRMING`. Rendered with the service's own `render.js`, fed the live `GET /api/failure/pay_step5_e2e` response (the same endpoint `/failure.html` fetches):

```
──────────────────────────────────────────────
  We're checking with your bank about ₹2,999.00.
──────────────────────────────────────────────
1. Did my money leave?      We can't yet confirm whether ₹2,999.00 left your account.
                             We do not want to guess, so we're verifying it with your
                             bank right now.
2. Is it coming back?       If any money did leave, it comes back automatically — but
                             we won't invent a date until we've confirmed it actually
                             left.
3. Pay again right now?     Not right this second. A temporary bank/gateway problem.
                             Give it ~40 minutes and try again; it usually clears on
                             its own. (Best to wait about 40 minutes.)
4. Still get what I wanted? To still get what you wanted, stay with the same method
                             (the way you just tried).

  Where your money is:
    [?] Left your account — We're confirming with your bank whether this happened.
    [?] Held at your bank — Depends on the step above, which we have not confirmed.
    [?] Back in your account — Depends on the step above, which we have not confirmed.
──────────────────────────────────────────────
```

No visual screenshot — the Chrome extension wasn't connected in this session — but this is the exact content `/failure.html?id=pay_step5_e2e` fetches and renders; the page itself returned `200`.

## 3. All three funds states, via real webhooks (not the demo endpoint), fresh IDs

| State | Cause | Reference | Result |
|---|---|---|---|
| `NOT_DEBITED` | `incorrect_otp` | none | correct |
| `DEBITED_REVERSAL_EXPECTED` | `insufficient_funds` | `rrn: 990011223344` | correct |
| `CONFIRMING` | `issuer_down` | none | correct |

(All three states were also exercised earlier via `POST /api/simulate-failure` → `GET /api/failure/:id`, with every field `failure.html`'s JS reads checked present and correctly shaped — zero mismatches, against the live Neon-backed API.)

## 4. Idempotency

Replayed the identical `x-razorpay-event-id` (`evt_step5_e2e`) for the webhook in §2:

```json
{"ok":true,"duplicate":true}
```
`200` — never re-messaged.

## 5. Follow-up suppression

- `insufficient_funds` failure → scheduled a real ~20h follow-up (`recovery.delayMinutes: 1200`).
- `payment.captured` sent for the **same** `order_id` →
  ```json
  {"ok":true,"cancelledFollowUps":1}
  ```
  `200` — the pending nudge was cancelled, proven against the live Neon row, not a mock.

## 6. Security (from the hardening pass, re-confirmed live)

| Check | Result |
|---|---|
| Forged webhook signature | `401` |
| Correctly HMAC-signed webhook | `200`, processed |
| Correctly signed but malformed-JSON body | `400`, `{"ok":false,"error":"invalid JSON"}` |
| Rate-limit headers present on `/webhook/razorpay` | `ratelimit-limit: 60`, `ratelimit-remaining: 59` — confirms the limiter is live and the app booted cleanly under the corrected `trust proxy: 2` setting (a permissive `trust proxy: true` would have thrown a validation error on every request) |

## Not covered by this pass

- No pixel-level visual screenshot of the rendered pages (Chrome extension unavailable) — verified structurally/via API contract instead.
- No sustained load or true rate-limit trip test against production, to avoid disrupting the live free-tier service.
- Full secrets audit and CI `secret-scan` job are documented in `README.md` / `.github/workflows/ci.yml`, not repeated here.

## Reproducing

Every request above was a real HMAC-SHA256-signed `POST` to `/webhook/razorpay` with `RAZORPAY_WEBHOOK_SECRET=whsec_local_test_secret` (the value currently set on Render — rotate it before using this for anything beyond a demo). See `scripts/send-test-webhook.js` for a scripted equivalent against a local instance.
