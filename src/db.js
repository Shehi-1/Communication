const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function createDatabase(dbPath, databaseUrl) {
  if (databaseUrl) {
    const { PostgresDatabase } = require("./postgres-db");
    return new PostgresDatabase(databaseUrl);
  }
  const resolvedPath = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  const db = new DatabaseSync(resolvedPath);
  db.dialect = "sqlite";
  db.transaction = async (work) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = await work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      username_key TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      avatar_key TEXT,
      phone_number TEXT UNIQUE,
      phone_verified_at TEXT,
      theme TEXT NOT NULL DEFAULT 'light',
      read_receipts INTEGER NOT NULL DEFAULT 1 CHECK (read_receipts IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS connections (
      id INTEGER PRIMARY KEY,
      user_low INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_high INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CHECK (user_low < user_high),
      CHECK (requester_id != recipient_id),
      UNIQUE (user_low, user_high)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL CHECK (length(body) <= 4000 AND (length(body) > 0 OR media_key IS NOT NULL)),
      media_key TEXT,
      media_type TEXT CHECK (media_type IS NULL OR media_type IN ('image', 'voice')),
      media_mime TEXT,
      media_duration REAL,
      delivered_at TEXT,
      read_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CHECK (sender_id != recipient_id),
      CHECK (
        (media_key IS NULL AND media_type IS NULL AND media_mime IS NULL)
        OR (
          media_key IS NOT NULL AND media_type IS NOT NULL
          AND media_mime IN ('image/webp', 'audio/webm', 'audio/ogg', 'audio/wav', 'audio/mpeg', 'audio/mp4')
        )
      )
    );
    CREATE TABLE IF NOT EXISTS statuses (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL CHECK (length(body) <= 500 AND (length(body) > 0 OR media_key IS NOT NULL)),
      media_key TEXT,
      media_mime TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      CHECK (
        (media_key IS NULL AND media_mime IS NULL)
        OR (media_key IS NOT NULL AND media_mime = 'image/webp')
      )
    );
    CREATE TABLE IF NOT EXISTS status_views (
      status_id INTEGER NOT NULL REFERENCES statuses(id) ON DELETE CASCADE,
      viewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      viewed_at TEXT NOT NULL,
      PRIMARY KEY (status_id, viewer_id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS login_attempts (
      ip_key TEXT PRIMARY KEY,
      window_started_at INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS phone_verifications (
      phone_number TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('register', 'change_phone')),
      code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL,
      window_started_at INTEGER NOT NULL,
      send_count INTEGER NOT NULL,
      last_sent_at INTEGER NOT NULL,
      PRIMARY KEY (phone_number, purpose)
    );
    CREATE TABLE IF NOT EXISTS calls (
      id TEXT PRIMARY KEY,
      caller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      call_type TEXT NOT NULL CHECK (call_type IN ('voice', 'video')),
      status TEXT NOT NULL CHECK (
        status IN ('ringing', 'connecting', 'connected', 'declined', 'missed', 'ended', 'connection_error')
      ),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      answered_at TEXT,
      connected_at TEXT,
      ended_at TEXT,
      duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
      CHECK (caller_id != recipient_id)
    );
    CREATE TABLE IF NOT EXISTS call_events (
      id INTEGER PRIMARY KEY,
      call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
      sender_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (
        kind IN ('state', 'offer', 'answer', 'ice')
      ),
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS user_presence (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      last_seen_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS phone_verification_expiry_idx
      ON phone_verifications(expires_at);
    CREATE INDEX IF NOT EXISTS calls_participants_idx
      ON calls(caller_id, recipient_id, status, created_at);
    CREATE INDEX IF NOT EXISTS call_events_call_idx
      ON call_events(call_id, id);
    CREATE INDEX IF NOT EXISTS call_events_sender_idx
      ON call_events(sender_id, id);
  `);

  const callsSql = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'calls'"
  ).get().sql;
  const callColumns = new Set(db.prepare("PRAGMA table_info(calls)").all().map((column) => column.name));
  if (!callsSql.includes("'connecting'") || !callColumns.has("connected_at")) {
    const connectedAtExpression = callColumns.has("connected_at")
      ? "connected_at"
      : "CASE WHEN status = 'connected' THEN answered_at ELSE NULL END";
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
      DROP INDEX IF EXISTS calls_participants_idx;
      DROP INDEX IF EXISTS call_events_call_idx;
      DROP INDEX IF EXISTS call_events_sender_idx;
      ALTER TABLE call_events RENAME TO call_events_legacy;
      ALTER TABLE calls RENAME TO calls_legacy;
      CREATE TABLE calls (
        id TEXT PRIMARY KEY,
        caller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        call_type TEXT NOT NULL CHECK (call_type IN ('voice', 'video')),
        status TEXT NOT NULL CHECK (
          status IN ('ringing', 'connecting', 'connected', 'declined', 'missed', 'ended', 'connection_error')
        ),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        answered_at TEXT,
        connected_at TEXT,
        ended_at TEXT,
        duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
        CHECK (caller_id != recipient_id)
      );
      INSERT INTO calls
        (id, caller_id, recipient_id, call_type, status, created_at,
         answered_at, connected_at, ended_at, duration_seconds)
      SELECT id, caller_id, recipient_id, call_type, status, created_at,
             answered_at, ${connectedAtExpression}, ended_at, duration_seconds
      FROM calls_legacy;
      CREATE TABLE call_events (
        id INTEGER PRIMARY KEY,
        call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
        sender_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('state', 'offer', 'answer', 'ice')),
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      INSERT INTO call_events (id, call_id, sender_id, kind, payload, created_at)
      SELECT id, call_id, sender_id, kind, payload, created_at FROM call_events_legacy;
      DROP TABLE call_events_legacy;
      DROP TABLE calls_legacy;
      CREATE INDEX calls_participants_idx ON calls(caller_id, recipient_id, status, created_at);
      CREATE INDEX call_events_call_idx ON call_events(call_id, id);
      CREATE INDEX call_events_sender_idx ON call_events(sender_id, id);
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }

  const userColumns = db.prepare("PRAGMA table_info(users)").all();
  const knownUserColumns = new Set(userColumns.map((column) => column.name));
  if (!knownUserColumns.has("avatar_key")) db.exec("ALTER TABLE users ADD COLUMN avatar_key TEXT");
  if (!knownUserColumns.has("phone_number")) db.exec("ALTER TABLE users ADD COLUMN phone_number TEXT");
  if (!knownUserColumns.has("phone_verified_at")) db.exec("ALTER TABLE users ADD COLUMN phone_verified_at TEXT");
  if (!knownUserColumns.has("theme")) db.exec("ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'light'");
  if (!knownUserColumns.has("read_receipts")) {
    db.exec("ALTER TABLE users ADD COLUMN read_receipts INTEGER NOT NULL DEFAULT 1 CHECK (read_receipts IN (0, 1))");
  }

  const messageColumns = db.prepare("PRAGMA table_info(messages)").all();
  if (!messageColumns.some((column) => column.name === "media_key")) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
      ALTER TABLE messages RENAME TO messages_legacy;
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        body TEXT NOT NULL CHECK (length(body) <= 4000 AND (length(body) > 0 OR media_key IS NOT NULL)),
        media_key TEXT,
        media_type TEXT CHECK (media_type IS NULL OR media_type IN ('image', 'voice')),
        media_mime TEXT,
        media_duration REAL,
        delivered_at TEXT,
        read_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        CHECK (sender_id != recipient_id),
        CHECK (
          (media_key IS NULL AND media_type IS NULL AND media_mime IS NULL)
          OR (
            media_key IS NOT NULL AND media_type IS NOT NULL
            AND media_mime IN ('image/webp', 'audio/webm', 'audio/ogg', 'audio/wav', 'audio/mpeg', 'audio/mp4')
          )
        )
      );
      INSERT INTO messages (id, sender_id, recipient_id, body, created_at)
        SELECT id, sender_id, recipient_id, body, created_at FROM messages_legacy;
      DROP TABLE messages_legacy;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }

  const updatedMessageColumns = new Set(
    db.prepare("PRAGMA table_info(messages)").all().map((column) => column.name)
  );
  if (!updatedMessageColumns.has("delivered_at")) {
    db.exec("ALTER TABLE messages ADD COLUMN delivered_at TEXT");
  }
  if (!updatedMessageColumns.has("read_at")) {
    db.exec("ALTER TABLE messages ADD COLUMN read_at TEXT");
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS messages_conversation_idx
      ON messages(sender_id, recipient_id, id);
    CREATE INDEX IF NOT EXISTS users_phone_unique_idx
      ON users(phone_number) WHERE phone_number IS NOT NULL;
    CREATE INDEX IF NOT EXISTS messages_delivery_idx
      ON messages(recipient_id, delivered_at, read_at);
    CREATE INDEX IF NOT EXISTS statuses_expiry_idx
      ON statuses(expires_at, user_id);
    CREATE INDEX IF NOT EXISTS status_views_viewer_idx
      ON status_views(viewer_id, status_id);
  `);

  return db;
}

module.exports = { createDatabase };
