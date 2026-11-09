const session = require("express-session");

class SQLiteSessionStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    this.getStatement = db.prepare(
      "SELECT sess FROM sessions WHERE sid = ? AND expires_at > ?"
    );
    this.setStatement = db.prepare(
      `INSERT INTO sessions (sid, sess, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires_at = excluded.expires_at`
    );
    this.destroyStatement = db.prepare("DELETE FROM sessions WHERE sid = ?");
    this.touchStatement = db.prepare(
      "UPDATE sessions SET expires_at = ? WHERE sid = ?"
    );
    this.cleanupStatement = db.prepare(
      "DELETE FROM sessions WHERE expires_at <= ?"
    );
    this.lastCleanup = 0;
  }

  get(sid, callback) {
    try {
      const row = this.getStatement.get(sid, Date.now());
      callback(null, row ? JSON.parse(row.sess) : null);
    } catch (error) {
      callback(error);
    }
  }

  set(sid, sess, callback = () => {}) {
    try {
      const expiresAt = this.expiry(sess);
      this.setStatement.run(sid, JSON.stringify(sess), expiresAt);
      this.cleanupExpired();
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      this.destroyStatement.run(sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, sess, callback = () => {}) {
    try {
      this.touchStatement.run(this.expiry(sess), sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  expiry(sess) {
    return sess.cookie?.expires
      ? new Date(sess.cookie.expires).getTime()
      : Date.now() + (sess.cookie?.maxAge ?? 24 * 60 * 60 * 1000);
  }

  cleanupExpired() {
    if (Date.now() - this.lastCleanup > 60 * 60 * 1000) {
      this.cleanupStatement.run(Date.now());
      this.lastCleanup = Date.now();
    }
  }
}

module.exports = { SQLiteSessionStore };
