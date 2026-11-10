const session = require("express-session");

class DatabaseSessionStore extends session.Store {
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
    Promise.resolve()
      .then(() => this.getStatement.get(sid, Date.now()))
      .then((row) => callback(null, row ? JSON.parse(row.sess) : null), callback);
  }

  set(sid, sess, callback = () => {}) {
    Promise.resolve()
      .then(async () => {
      const expiresAt = this.expiry(sess);
      await this.setStatement.run(sid, JSON.stringify(sess), expiresAt);
      await this.cleanupExpired();
    })
      .then(() => callback(null), callback);
  }

  destroy(sid, callback = () => {}) {
    Promise.resolve()
      .then(() => this.destroyStatement.run(sid))
      .then(() => callback(null), callback);
  }

  touch(sid, sess, callback = () => {}) {
    Promise.resolve()
      .then(() => this.touchStatement.run(this.expiry(sess), sid))
      .then(() => callback(null), callback);
  }

  expiry(sess) {
    return sess.cookie?.expires
      ? new Date(sess.cookie.expires).getTime()
      : Date.now() + (sess.cookie?.maxAge ?? 24 * 60 * 60 * 1000);
  }

  async cleanupExpired() {
    if (Date.now() - this.lastCleanup > 60 * 60 * 1000) {
      await this.cleanupStatement.run(Date.now());
      this.lastCleanup = Date.now();
    }
  }
}

module.exports = { DatabaseSessionStore };
