require("dotenv").config();

const path = require("node:path");
const { createApp } = require("./app");

const isVercel = process.env.VERCEL === "1";
if (isVercel && !process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required on Vercel for persistent accounts and sessions.");
}
const app = createApp({
  trustProxy: isVercel,
  dbPath: process.env.DB_PATH || (
    isVercel ? path.join("/tmp", "closeby", "chat.sqlite") : undefined
  ),
  mediaDir: process.env.MEDIA_DIR || (
    isVercel ? path.join("/tmp", "closeby", "media") : undefined
  ),
  databaseUrl: process.env.DATABASE_URL || null
});

module.exports = app;

if (!isVercel) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be a valid TCP port.");
  }

  const server = app.listen(port, () => {
    console.log(`Chat app listening on http://localhost:${port}`);
  });

  function shutdown() {
    server.close(async (error) => {
      if (error) throw error;
      await app.locals.db.close();
      process.exit(0);
    });
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
