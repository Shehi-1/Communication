require("dotenv").config();

const path = require("node:path");
const { createApp } = require("./app");

const isVercel = process.env.VERCEL === "1";
const app = createApp({
  trustProxy: isVercel,
  dbPath: process.env.DB_PATH || (
    isVercel ? path.join("/tmp", "closeby", "chat.sqlite") : undefined
  ),
  mediaDir: process.env.MEDIA_DIR || (
    isVercel ? path.join("/tmp", "closeby", "media") : undefined
  )
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
    server.close(() => {
      app.locals.db.close();
      process.exit(0);
    });
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
