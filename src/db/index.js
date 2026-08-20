import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// The ONLY file that knows about SQLite. Everything above talks to the small
// interface exported here, so swapping to Postgres is a single-file change:
// re-implement these functions against pg and keep the signatures identical.

let db = null;

export function initDb(dbPath) {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    -- Idempotency ledger. Razorpay retries deliveries; a seen event id here
    -- means "already handled, do nothing but return 200".
    CREATE TABLE IF NOT EXISTS processed_events (
      event_id     TEXT PRIMARY KEY,
      event_type   TEXT NOT NULL,
      received_at  TEXT NOT NULL
    );

    -- One row per failure we have messaged about (also idempotency-guarded by
    -- payment_id, so a retried delivery never messages twice).
    CREATE TABLE IF NOT EXISTS failures (
      payment_id   TEXT PRIMARY KEY,
      order_id     TEXT NOT NULL,
      reason       TEXT,
      money_state  TEXT NOT NULL,
      amount_paise INTEGER,
      created_at   TEXT NOT NULL
    );

    -- Scheduled follow-up nudges. Cancelled when payment.captured arrives for
    -- the same order_id. Nothing is ever actually sent; the ticker only logs.
    CREATE TABLE IF NOT EXISTS followups (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id     TEXT NOT NULL,
      payment_id   TEXT NOT NULL,
      kind         TEXT NOT NULL,
      due_at       TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending', -- pending|sent|cancelled
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_followups_order  ON followups(order_id);
    CREATE INDEX IF NOT EXISTS idx_followups_status ON followups(status, due_at);
  `);

  return db;
}

function requireDb() {
  if (!db) throw new Error('DB not initialised — call initDb() first');
  return db;
}

// --- Idempotency ----------------------------------------------------------

// Atomically claim an event id. Returns true if this is the FIRST time we've
// seen it (caller should process), false if it's a duplicate (caller returns
// 200 and does nothing). INSERT OR IGNORE + changes() makes this race-safe.
export function claimEvent(eventId, eventType, nowIso) {
  const info = requireDb()
    .prepare(
      `INSERT OR IGNORE INTO processed_events (event_id, event_type, received_at)
       VALUES (?, ?, ?)`
    )
    .run(eventId, eventType, nowIso);
  return info.changes === 1;
}

// --- Failures -------------------------------------------------------------

// Record a failure we've messaged about. Returns true if newly inserted,
// false if we'd already messaged this payment (second guard against dup sends).
export function recordFailure({
  paymentId,
  orderId,
  reason,
  moneyState,
  amountPaise,
  nowIso,
}) {
  const info = requireDb()
    .prepare(
      `INSERT OR IGNORE INTO failures
         (payment_id, order_id, reason, money_state, amount_paise, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(paymentId, orderId, reason, moneyState, amountPaise, nowIso);
  return info.changes === 1;
}

// --- Follow-ups -----------------------------------------------------------

export function scheduleFollowUp({ orderId, paymentId, kind, dueAtIso, nowIso }) {
  return requireDb()
    .prepare(
      `INSERT INTO followups (order_id, payment_id, kind, due_at, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`
    )
    .run(orderId, paymentId, kind, dueAtIso, nowIso).lastInsertRowid;
}

// Cancel every pending follow-up for an order. Returns count cancelled.
export function cancelFollowUpsForOrder(orderId) {
  const info = requireDb()
    .prepare(
      `UPDATE followups SET status = 'cancelled'
       WHERE order_id = ? AND status = 'pending'`
    )
    .run(orderId);
  return info.changes;
}

// Due, still-pending follow-ups at or before nowIso.
export function dueFollowUps(nowIso) {
  return requireDb()
    .prepare(
      `SELECT id, order_id, payment_id, kind, due_at
       FROM followups
       WHERE status = 'pending' AND due_at <= ?
       ORDER BY due_at ASC`
    )
    .all(nowIso);
}

export function markFollowUpSent(id) {
  requireDb()
    .prepare(`UPDATE followups SET status = 'sent' WHERE id = ? AND status = 'pending'`)
    .run(id);
}

export function pendingFollowUpsForOrder(orderId) {
  return requireDb()
    .prepare(
      `SELECT id, kind, due_at FROM followups
       WHERE order_id = ? AND status = 'pending'`
    )
    .all(orderId);
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
