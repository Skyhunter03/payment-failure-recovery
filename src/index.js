// Process entry point: initialises the DB, builds the Express app, starts the
// background tickers (follow-ups, confirming-poller), and starts listening.
import { config, getWebhookSecret } from './config.js';
import { initDb } from './db/index.js';
import { createApp } from './server.js';
import { startFollowUpTicker } from './followup-ticker.js';
import { startConfirmingPoller } from './confirming-poller.js';
import { rootLog } from './logger.js';

// Fail fast if the secret is missing — the whole thing is worthless unsigned.
const secret = getWebhookSecret();

// Postgres (Neon) when DATABASE_URL is set — production. Falls back to
// better-sqlite3 otherwise — local dev with no network dependency.
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl) {
  await initDb({ databaseUrl });
  rootLog.info('db_ready', { backend: 'postgres' });
} else {
  await initDb(config.dbPath);
  rootLog.info('db_ready', { backend: 'sqlite', dbPath: config.dbPath });
}

const app = createApp({ getSecret: () => secret });

if (config.followUpTicker) {
  startFollowUpTicker({ intervalMs: config.followUpTickMs });
  rootLog.info('followup_ticker_started', { intervalMs: config.followUpTickMs });
}

if (config.confirmingPoller) {
  startConfirmingPoller({ intervalMs: config.confirmingPollMs });
  rootLog.info('confirming_poller_started', { intervalMs: config.confirmingPollMs });
}

app.listen(config.port, () => {
  rootLog.info('listening', {
    port: config.port,
    webhook: `POST /webhook/razorpay`,
    note: 'Test mode. Messages render to console only — nothing is sent.',
  });
});
