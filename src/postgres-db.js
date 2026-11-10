const fs = require("node:fs");
const path = require("node:path");
const { Pool, types } = require("pg");
const { AsyncLocalStorage } = require("node:async_hooks");
const { setTimeout: delay } = require("node:timers/promises");

types.setTypeParser(20, Number);

function toPostgresPlaceholders(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`)
    .replace(/\bMIN\(([^(),]+),\s*([^()]+)\)/gi, "LEAST($1, $2)")
    .replace(/\bMAX\(([^(),]+),\s*([^()]+)\)/gi, "GREATEST($1, $2)")
    .replace(/ESCAPE '\\\\'/gi, "ESCAPE E'\\\\'")
    .replace(/strftime\('%Y-%m-%dT%H:%M:%fZ',\s*'now'\)/gi,
      `to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
}

class PostgresDatabase {
  constructor(connectionString) {
    this.dialect = "postgres";
    this.context = new AsyncLocalStorage();
    this.pool = new Pool({ connectionString, max: 3, idleTimeoutMillis: 10000 });
    this.ready = this.migrate();
    this.ready.catch((error) => {
      console.error("Could not initialize PostgreSQL:", error.code || error.name || "Error");
    });
  }

  async connectWithRetry() {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.pool.connect();
      } catch (error) {
        const retryable = ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH"]
          .includes(error.code);
        if (!retryable || attempt >= 4) throw error;
        await delay(250 * 2 ** attempt);
      }
    }
  }

  async migrate() {
    const client = await this.connectWithRetry();
    try {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query("SELECT pg_advisory_xact_lock($1)", [803240611]);
      const { rows } = await client.query(
        "SELECT version FROM schema_migrations WHERE version = $1",
        ["001_initial"]
      );
      if (rows.length === 0) {
        const sql = fs.readFileSync(path.join(__dirname, "migrations", "001_initial.sql"), "utf8");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", ["001_initial"]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  prepare(sql) {
    const statement = toPostgresPlaceholders(sql);
    return {
      all: async (...values) => (await this.query(statement, values)).rows,
      get: async (...values) => (await this.query(statement, values)).rows[0],
      run: async (...values) => {
        const result = await this.query(statement, values);
        return { changes: result.rowCount, lastInsertRowid: result.rows[0]?.id };
      }
    };
  }

  query(sql, values) {
    const client = this.context.getStore();
    return (client || this.pool).query(sql, values);
  }

  async exec(sql) {
    return this.query(sql);
  }

  async transaction(work) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await this.context.run(client, work);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = { PostgresDatabase, toPostgresPlaceholders };
