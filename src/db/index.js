import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import pg from 'pg';

// The ONLY file that knows about SQLite or Postgres. Everything above talks
// to the small async interface exported here.
//
// Two backends, chosen at initDb() time:
//   - Postgres (`pg`), used when DATABASE_URL is set — production (Render + Neon).
//   - better-sqlite3, used otherwise — local dev with no network dependency,
//     and CI/tests (fast, hermetic, no secret to provision). Kept deliberately,
//     not dropped: the existing GitHub Actions workflow has zero secrets and
//     must stay green without adding a live Postgres dependency to CI, and the
//     test suite's per-test `:memory:` databases stay fast and isolated.
//
// Every exported function is async (pg is network I/O; sqlite isn't, but the
// interface is uniform so callers never care which backend is active).

let backend = null; // 'pg' | 'sqlite'
let pgPool = null;
let sqliteDb = null;

// initDb(opts): a string forces the sqlite backend at that path (':memory:' or
// a file path) — this is what tests pass, unchanged. An object {databaseUrl}
// forces the Postgres backend.
export async function initDb(opts) {
  if (typeof opts === 'string') {
    backend = 'sqlite';
    sqliteDb = openSqlite(opts);
    return;
  }
  backend = 'pg';
  pgPool = new pg.Pool({ connectionString: opts.databaseUrl });
  await createPgSchema(pgPool);
}

function openSqlite(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SQLITE_SCHEMA);
  return db;
}

async function createPgSchema(pool) {
  await pool.query(PG_SCHEMA);
}

// Same four tables on both backends: processed_events (idempotency ledger),
// failures (one row per messaged failure), followups (scheduled nudges),
// resolved_orders (orders a payment.captured has resolved).
const SQLITE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS processed_events (
    event_id     TEXT PRIMARY KEY,
    event_type   TEXT NOT NULL,
    received_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS failures (
    payment_id         TEXT PRIMARY KEY,
    order_id            TEXT NOT NULL,
    reason              TEXT,
    error_step          TEXT,
    acquirer_data_json  TEXT,
    money_state         TEXT NOT NULL,
    amount_paise        INTEGER,
    source              TEXT NOT NULL DEFAULT 'webhook',
    created_at          TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS followups (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id     TEXT NOT NULL,
    payment_id   TEXT NOT NULL,
    kind         TEXT NOT NULL,
    due_at       TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    created_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_followups_order  ON followups(order_id);
  CREATE INDEX IF NOT EXISTS idx_followups_status ON followups(status, due_at);
  CREATE TABLE IF NOT EXISTS resolved_orders (
    order_id     TEXT PRIMARY KEY,
    resolved_at  TEXT NOT NULL
  );
`;

const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS processed_events (
    event_id     TEXT PRIMARY KEY,
    event_type   TEXT NOT NULL,
    received_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS failures (
    payment_id         TEXT PRIMARY KEY,
    order_id            TEXT NOT NULL,
    reason              TEXT,
    error_step          TEXT,
    acquirer_data_json  TEXT,
    money_state         TEXT NOT NULL,
    amount_paise        INTEGER,
    source              TEXT NOT NULL DEFAULT 'webhook',
    created_at          TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS followups (
    id           SERIAL PRIMARY KEY,
    order_id     TEXT NOT NULL,
    payment_id   TEXT NOT NULL,
    kind         TEXT NOT NULL,
    due_at       TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    created_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_followups_order  ON followups(order_id);
  CREATE INDEX IF NOT EXISTS idx_followups_status ON followups(status, due_at);
  CREATE TABLE IF NOT EXISTS resolved_orders (
    order_id     TEXT PRIMARY KEY,
    resolved_at  TEXT NOT NULL
  );
`;

function requireBackend() {
  if (!backend) throw new Error('DB not initialised — call initDb() first');
}

// run(sql, sqliteParams, pgSql, pgParams) would be over-engineered for ~10
// queries; each function below just branches on `backend` directly, since the
// two dialects differ in placeholder syntax (? vs $1) and a couple of clauses
// (INSERT OR IGNORE vs ON CONFLICT, AUTOINCREMENT id vs RETURNING id).

// --- Idempotency ------------------------------------------------------------

// Atomically claim an event id. Returns true if this is the FIRST time we've
// seen it (caller should process), false if it's a duplicate (caller returns
// 200 and does nothing). This is THE guard against double-firing a webhook —
// get it exactly right: a duplicate delivery must never look like a fresh one.
export async function markEventSeen(eventId, eventType, nowIso) {
  requireBackend();
  if (backend === 'sqlite') {
    const info = sqliteDb
      .prepare(
        `INSERT OR IGNORE INTO processed_events (event_id, event_type, received_at)
         VALUES (?, ?, ?)`
      )
      .run(eventId, eventType, nowIso);
    return info.changes === 1;
  }
  const result = await pgPool.query(
    `INSERT INTO processed_events (event_id, event_type, received_at)
     VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING`,
    [eventId, eventType, nowIso]
  );
  return result.rowCount === 1;
}

// --- Failures ---------------------------------------------------------------

// Record a failure we've messaged about. Returns true if newly inserted,
// false if we'd already recorded this payment (idempotency guard — see the
// note above the export: intentionally ON CONFLICT DO NOTHING, not an update,
// so a second write for the same payment_id can never re-trigger a message).
export async function saveFailure({
  paymentId,
  orderId,
  reason,
  errorStep,
  acquirerDataJson,
  moneyState,
  amountPaise,
  source,
  nowIso,
}) {
  requireBackend();
  if (backend === 'sqlite') {
    const info = sqliteDb
      .prepare(
        `INSERT OR IGNORE INTO failures
           (payment_id, order_id, reason, error_step, acquirer_data_json, money_state, amount_paise, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(paymentId, orderId, reason, errorStep, acquirerDataJson, moneyState, amountPaise, source, nowIso);
    return info.changes === 1;
  }
  const result = await pgPool.query(
    `INSERT INTO failures
       (payment_id, order_id, reason, error_step, acquirer_data_json, money_state, amount_paise, source, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (payment_id) DO NOTHING`,
    [paymentId, orderId, reason, errorStep, acquirerDataJson, moneyState, amountPaise, source, nowIso]
  );
  return result.rowCount === 1;
}

// Look up a stored failure by payment id (real Razorpay payment id, or a
// demo_ id from /api/simulate-failure). Returns the row or undefined.
export async function getFailure(paymentId) {
  requireBackend();
  if (backend === 'sqlite') {
    return sqliteDb.prepare(`SELECT * FROM failures WHERE payment_id = ?`).get(paymentId);
  }
  const result = await pgPool.query(`SELECT * FROM failures WHERE payment_id = $1`, [paymentId]);
  return result.rows[0];
}

// Most recent failures, newest first. Capped — this backs an observability
// listing, not a paginated export.
const LIST_FAILURES_LIMIT = 200;
export async function listFailures() {
  requireBackend();
  if (backend === 'sqlite') {
    return sqliteDb
      .prepare(`SELECT * FROM failures ORDER BY created_at DESC LIMIT ?`)
      .all(LIST_FAILURES_LIMIT);
  }
  const result = await pgPool.query(
    `SELECT * FROM failures ORDER BY created_at DESC LIMIT $1`,
    [LIST_FAILURES_LIMIT]
  );
  return result.rows;
}

// --- Follow-ups ---------------------------------------------------------------

export async function scheduleFollowUp({ orderId, paymentId, kind, dueAtIso, nowIso }) {
  requireBackend();
  if (backend === 'sqlite') {
    return sqliteDb
      .prepare(
        `INSERT INTO followups (order_id, payment_id, kind, due_at, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`
      )
      .run(orderId, paymentId, kind, dueAtIso, nowIso).lastInsertRowid;
  }
  const result = await pgPool.query(
    `INSERT INTO followups (order_id, payment_id, kind, due_at, status, created_at)
     VALUES ($1, $2, $3, $4, 'pending', $5) RETURNING id`,
    [orderId, paymentId, kind, dueAtIso, nowIso]
  );
  return result.rows[0].id;
}

// Due, still-pending follow-ups at or before nowIso.
export async function duePendingFollowUps(nowIso) {
  requireBackend();
  if (backend === 'sqlite') {
    return sqliteDb
      .prepare(
        `SELECT id, order_id, payment_id, kind, due_at
         FROM followups WHERE status = 'pending' AND due_at <= ?
         ORDER BY due_at ASC`
      )
      .all(nowIso);
  }
  const result = await pgPool.query(
    `SELECT id, order_id, payment_id, kind, due_at
     FROM followups WHERE status = 'pending' AND due_at <= $1
     ORDER BY due_at ASC`,
    [nowIso]
  );
  return result.rows;
}

export async function markFollowUpSent(id) {
  requireBackend();
  if (backend === 'sqlite') {
    sqliteDb.prepare(`UPDATE followups SET status = 'sent' WHERE id = ? AND status = 'pending'`).run(id);
    return;
  }
  await pgPool.query(`UPDATE followups SET status = 'sent' WHERE id = $1 AND status = 'pending'`, [id]);
}

// Kept alongside the renamed public API (not in the requested list, but still
// used by tests to assert on suppression) — same query either backend used
// under the old cancelFollowUpsForOrder name.
export async function pendingFollowUpsForOrder(orderId) {
  requireBackend();
  if (backend === 'sqlite') {
    return sqliteDb
      .prepare(`SELECT id, kind, due_at FROM followups WHERE order_id = ? AND status = 'pending'`)
      .all(orderId);
  }
  const result = await pgPool.query(
    `SELECT id, kind, due_at FROM followups WHERE order_id = $1 AND status = 'pending'`,
    [orderId]
  );
  return result.rows;
}

// --- Order resolution ---------------------------------------------------------

// The customer already paid (payment.captured for this order). Records the
// resolution AND cancels any pending nudges for it — chasing someone who
// already paid is how this feature gets hated. Idempotent: marking an
// already-resolved order again just re-cancels (harmlessly) any newly
// pending rows and returns the count cancelled this call.
export async function markOrderResolved(orderId, nowIso) {
  requireBackend();
  if (backend === 'sqlite') {
    sqliteDb
      .prepare(`INSERT OR IGNORE INTO resolved_orders (order_id, resolved_at) VALUES (?, ?)`)
      .run(orderId, nowIso);
    const info = sqliteDb
      .prepare(`UPDATE followups SET status = 'cancelled' WHERE order_id = ? AND status = 'pending'`)
      .run(orderId);
    return info.changes;
  }
  await pgPool.query(
    `INSERT INTO resolved_orders (order_id, resolved_at) VALUES ($1, $2) ON CONFLICT (order_id) DO NOTHING`,
    [orderId, nowIso]
  );
  const result = await pgPool.query(
    `UPDATE followups SET status = 'cancelled' WHERE order_id = $1 AND status = 'pending'`,
    [orderId]
  );
  return result.rowCount;
}

export async function isOrderResolved(orderId) {
  requireBackend();
  if (backend === 'sqlite') {
    return Boolean(sqliteDb.prepare(`SELECT 1 FROM resolved_orders WHERE order_id = ?`).get(orderId));
  }
  const result = await pgPool.query(`SELECT 1 FROM resolved_orders WHERE order_id = $1`, [orderId]);
  return result.rowCount > 0;
}

// --- Observability ------------------------------------------------------------

// Counts for the demo/showcase UI — read-only aggregates over what's already
// stored, not a new data path.
export async function stats() {
  requireBackend();
  if (backend === 'sqlite') {
    const byState = sqliteDb
      .prepare(`SELECT money_state, COUNT(*) AS n FROM failures GROUP BY money_state`)
      .all();
    const totalFailures = sqliteDb.prepare(`SELECT COUNT(*) AS n FROM failures`).get().n;
    const pendingFollowUps = sqliteDb
      .prepare(`SELECT COUNT(*) AS n FROM followups WHERE status = 'pending'`)
      .get().n;
    const resolvedOrders = sqliteDb.prepare(`SELECT COUNT(*) AS n FROM resolved_orders`).get().n;
    return { totalFailures, byState: toStateMap(byState), pendingFollowUps, resolvedOrders };
  }
  const [byStateRes, totalRes, pendingRes, resolvedRes] = await Promise.all([
    pgPool.query(`SELECT money_state, COUNT(*) AS n FROM failures GROUP BY money_state`),
    pgPool.query(`SELECT COUNT(*) AS n FROM failures`),
    pgPool.query(`SELECT COUNT(*) AS n FROM followups WHERE status = 'pending'`),
    pgPool.query(`SELECT COUNT(*) AS n FROM resolved_orders`),
  ]);
  return {
    totalFailures: Number(totalRes.rows[0].n),
    byState: toStateMap(byStateRes.rows),
    pendingFollowUps: Number(pendingRes.rows[0].n),
    resolvedOrders: Number(resolvedRes.rows[0].n),
  };
}

function toStateMap(rows) {
  const map = {};
  for (const row of rows) map[row.money_state] = Number(row.n);
  return map;
}

export async function closeDb() {
  if (backend === 'sqlite' && sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
  }
  if (backend === 'pg' && pgPool) {
    await pgPool.end();
    pgPool = null;
  }
  backend = null;
}
