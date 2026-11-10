const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PostgresDatabase, toPostgresPlaceholders } = require("../src/postgres-db");
const { DatabaseSessionStore } = require("../src/database-session-store");

test("PostgreSQL SQL conversion preserves aggregate and scalar SQLite expressions", () => {
  const sql = toPostgresPlaceholders(
    "SELECT MIN(a, b), MAX(a, b), MAX(id), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM t WHERE name LIKE ? ESCAPE '\\\\' AND id = ?"
  );
  assert.match(sql, /LEAST\(a, b\)/);
  assert.match(sql, /GREATEST\(a, b\)/);
  assert.match(sql, /MAX\(id\)/);
  assert.match(sql, /to_char\(CURRENT_TIMESTAMP/);
  assert.ok(sql.includes("ESCAPE E'\\\\'"));
  assert.match(sql, /id = \$2/);
});

test("PostgreSQL persists accounts and sessions across queries", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const db = new PostgresDatabase(process.env.DATABASE_URL);
  const store = new DatabaseSessionStore(db);
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const username = `pg_${suffix}`.slice(0, 24);
  const sid = `integration-${suffix}`;
  try {
    await db.ready;
    const inserted = await db.prepare(
      `INSERT INTO users (username, username_key, email, password_hash)
       VALUES (?, ?, ?, ?) RETURNING id`
    ).run(username, username.toLowerCase(), `${suffix}@integration.invalid`, "test-hash");
    const user = await db.prepare("SELECT id, username FROM users WHERE id = ?")
      .get(inserted.lastInsertRowid);
    assert.equal(user.username, username);

    await new Promise((resolve, reject) => {
      store.set(sid, { userId: user.id, cookie: { maxAge: 60000 } },
        (error) => error ? reject(error) : resolve());
    });
    const session = await new Promise((resolve, reject) => {
      store.get(sid, (error, value) => error ? reject(error) : resolve(value));
    });
    assert.equal(session.userId, user.id);
    await new Promise((resolve, reject) => {
      store.destroy(sid, (error) => error ? reject(error) : resolve());
    });
    await db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
    assert.equal(await db.prepare("SELECT id FROM users WHERE id = ?").get(user.id), undefined);
  } finally {
    await db.prepare("DELETE FROM sessions WHERE sid = ?").run(sid).catch(() => {});
    await db.prepare("DELETE FROM users WHERE username_key = ?").run(username.toLowerCase()).catch(() => {});
    await db.close();
  }
});
