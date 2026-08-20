import { config, getWebhookSecret } from './config.js';
import { initDb } from './db/index.js';
import { createApp } from './server.js';
import { startFollowUpTicker } from './followup-ticker.js';
import { rootLog } from './logger.js';

// Fail fast if the secret is missing — the whole thing is worthless unsigned.
const secret = getWebhookSecret();

initDb(config.dbPath);
rootLog.info('db_ready', { dbPath: config.dbPath });

const app = createApp({ getSecret: () => secret });

if (config.followUpTicker) {
  startFollowUpTicker({ intervalMs: config.followUpTickMs });
  rootLog.info('followup_ticker_started', { intervalMs: config.followUpTickMs });
}

app.listen(config.port, () => {
  rootLog.info('listening', {
    port: config.port,
    webhook: `POST /webhook/razorpay`,
    note: 'Test mode. Messages render to console only — nothing is sent.',
  });
});
