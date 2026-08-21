import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

// Minimal .env loader so we take on zero extra dependencies. Real secrets
// live in the environment; this only fills gaps for local dev. Values already
// present in process.env always win (so a real deploy's env is authoritative).
function loadDotEnv() {
  const envPath = path.join(rootDir, '.env');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in.`
    );
  }
  return value;
}

export const config = {
  rootDir,
  port: Number(process.env.PORT || 3000),
  dbPath: path.resolve(rootDir, process.env.DB_PATH || './data/recovery.sqlite'),
  // Read lazily via getWebhookSecret() so tooling that only needs the pure
  // logic (tests, the simulator) can run without a secret configured.
  followUpTicker: process.env.FOLLOWUP_TICKER !== 'false',
  followUpTickMs: Number(process.env.FOLLOWUP_TICK_MS || 60000),
  // Webhook rate limit: Razorpay's own retries plus a burst of real failures
  // shouldn't come close to this; it's a ceiling against abuse, not normal
  // traffic. 60 req/min per IP by default — override via env if it's ever
  // wrong for real volume.
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX || 60),
  // Number of reverse-proxy hops in front of the app, for Express's
  // trust-proxy setting. MUST be a specific count, never `true` — that trusts
  // an unbounded chain and lets a client set its own X-Forwarded-For to
  // bypass IP-based rate limiting entirely. Render's traffic passes through
  // Cloudflare (their edge) then Render's own load balancer = 2 hops.
  // https://render.com/articles/how-render-handles-ddos-attacks
  trustProxyHops: Number(process.env.TRUST_PROXY_HOPS || 2),
  // Background poller that upgrades CONFIRMING failures once Razorpay's own
  // Payments API has a more definite answer. Needs RAZORPAY_KEY_ID/SECRET
  // (same as /create-order) — a missing key just makes each poll a no-op per
  // row, logged, not a crash. 5 min default: payment resolution isn't
  // real-time-urgent, and it's a courtesy against hammering Razorpay's API.
  confirmingPoller: process.env.CONFIRMING_POLLER !== 'false',
  confirmingPollMs: Number(process.env.CONFIRMING_POLL_MS || 5 * 60_000),
};

export function getWebhookSecret() {
  return required('RAZORPAY_WEBHOOK_SECRET');
}

// Test-mode API credentials, used only by the /create-order test helper so the
// checkout page can open Checkout with a real order_id. Not needed to run the
// webhook service itself.
export function getRazorpayKeys() {
  return {
    keyId: required('RAZORPAY_KEY_ID'),
    keySecret: required('RAZORPAY_KEY_SECRET'),
  };
}
