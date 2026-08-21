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
