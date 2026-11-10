const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const path = require("node:path");
const multer = require("multer");
const { parsePhoneNumberFromString } = require("libphonenumber-js");
const { createDatabase } = require("./db");
const { SQLiteSessionStore } = require("./sqlite-session-store");
const {
  SmsConfigurationError,
  SmsDeliveryError,
  createTwilioSmsProvider
} = require("./sms");
const {
  MediaValidationError,
  normalizeImage,
  validateAudio,
  storeMedia,
  mediaPath,
  removeMedia
} = require("./media");

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,24}$/;
const BCRYPT_ROUNDS = 12;
const LOGIN_ATTEMPT_LIMIT = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const PHONE_CODE_LENGTH = 6;
const PHONE_CODE_TTL_MS = 10 * 60 * 1000;
const PHONE_CODE_RESEND_DELAY_MS = 60 * 1000;
const PHONE_CODE_RESEND_LIMIT = 3;
const PHONE_CODE_WINDOW_MS = 15 * 60 * 1000;
const PHONE_CODE_ATTEMPT_LIMIT = 5;
const CALL_RING_TIMEOUT_MS = 30 * 1000;
const CALL_CONNECT_TIMEOUT_MS = 30 * 1000;
const CALL_PRESENCE_TIMEOUT_MS = 45 * 1000;
const CALL_HISTORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const STATUS_TTL_MS = 24 * 60 * 60 * 1000;
const STATUS_TEXT_LIMIT = 500;
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(
  crypto.randomBytes(32).toString("hex"),
  BCRYPT_ROUNDS
);

class HttpError extends Error {
  constructor(status, message, { expose = status < 500 } = {}) {
    super(message);
    this.status = status;
    this.expose = expose;
  }
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function safeUser(row) {
  const user = { id: row.id, username: row.username };
  if (row.avatar_key) user.avatarUrl = `/api/users/${row.id}/avatar`;
  return user;
}

function validateCredentials({ username, password }) {
  if (typeof username !== "string" || !USERNAME_PATTERN.test(username)) {
    throw new HttpError(400, "Username must be 3–24 letters, numbers, or underscores.");
  }
  validatePassword(password);
}

function validatePassword(password) {
  if (
    typeof password !== "string" ||
    password.length < 12 ||
    Buffer.byteLength(password, "utf8") > 72
  ) {
    throw new HttpError(400, "Password must be at least 12 characters and no more than 72 bytes.");
  }
}

function relationship(db, userId, otherId) {
  return db
    .prepare(
      `SELECT id, requester_id, recipient_id, status FROM connections
       WHERE user_low = ? AND user_high = ?`
    )
    .get(Math.min(userId, otherId), Math.max(userId, otherId));
}

function createCsrfToken(secret, now = Date.now()) {
  const issuedAt = Math.floor(now / 1000);
  const nonce = crypto.randomBytes(32).toString("hex");
  const value = `${issuedAt}.${nonce}`;
  const signature = crypto.createHmac("sha256", secret).update(value).digest("hex");
  return `${value}.${signature}`;
}

function csrfMatches(secret, supplied, now = Date.now()) {
  if (typeof supplied !== "string") {
    return false;
  }
  const match = /^(\d{10})\.([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(supplied);
  if (!match) return false;

  const issuedAt = Number(match[1]);
  const nowSeconds = Math.floor(now / 1000);
  if (issuedAt > nowSeconds + 60 || nowSeconds - issuedAt > 24 * 60 * 60) {
    return false;
  }

  const value = `${match[1]}.${match[2]}`;
  const expectedBuffer = crypto.createHmac("sha256", secret).update(value).digest();
  const suppliedBuffer = Buffer.from(match[3], "hex");
  return (
    expectedBuffer.length === suppliedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)
  );
}

function createApp(options = {}) {
  const db =
    options.db ||
    createDatabase(options.dbPath || process.env.DB_PATH || "./data/chat.sqlite");
  const secret = options.sessionSecret || process.env.SESSION_SECRET;
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters.");
  }

  const isProduction = options.production ?? process.env.NODE_ENV === "production";
  const skipSmsVerification =
    !isProduction &&
    (options.skipSmsVerification ?? process.env.DEV_SKIP_SMS_VERIFICATION === "1");
  const smsProvider = options.smsProvider || createTwilioSmsProvider();
  let lastCallPruneAt = 0;
  const app = express();
  const publicDir = path.join(__dirname, "..", "public");
  const mediaDir = path.resolve(options.mediaDir || process.env.MEDIA_DIR || "./data/media");
  const mediaRelativeToPublic = path.relative(publicDir, mediaDir);
  if (
    mediaRelativeToPublic === "" ||
    (mediaRelativeToPublic !== ".." &&
      !mediaRelativeToPublic.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(mediaRelativeToPublic))
  ) {
    throw new Error("MEDIA_DIR must be outside the public directory.");
  }
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 5, fieldSize: 16 * 1024 }
  });
  const uploadProfile = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 4, fieldSize: 16 * 1024 }
  });
  const uploadStatus = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 2, fieldSize: 4 * 1024 }
  });
  async function pruneExpiredStatuses(now = Date.now()) {
    const nowIso = new Date(now).toISOString();
    const expired = db.prepare(
      "SELECT id, media_key FROM statuses WHERE expires_at <= ?"
    ).all(nowIso);
    if (expired.length === 0) return;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM statuses WHERE expires_at <= ?").run(nowIso);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    for (const status of expired) {
      await removeMedia(mediaDir, status.media_key);
    }
  }
  const statusPruneTimer = setInterval(() => {
    pruneExpiredStatuses().catch((error) => {
      console.error("Could not prune expired statuses:", error.code || error.name || "Error");
    });
  }, 60 * 60 * 1000);
  statusPruneTimer.unref();
  app.disable("x-powered-by");
  if (options.trustProxy ?? process.env.TRUST_PROXY === "1") {
    app.set("trust proxy", 1);
  }
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "img-src": ["'self'", "data:", "blob:"],
          "media-src": ["'self'", "blob:"]
        }
      }
    })
  );
  app.use((_req, res, next) => {
    res.setHeader("Permissions-Policy", "microphone=(self), camera=(self)");
    next();
  });
  app.use(express.json({ limit: "16kb" }));
  app.use(
    session({
      name: isProduction ? "__Host-chat.sid" : "chat.sid",
      secret,
      store: new SQLiteSessionStore(db),
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: isProduction,
        sameSite: "lax",
        maxAge: 24 * 60 * 60 * 1000,
        path: "/"
      }
    })
  );

  const api = express.Router();
  app.use("/api", api);

  const requireCsrf = (req, _res, next) => {
    if (!csrfMatches(secret, req.get("X-CSRF-Token"))) {
      return next(new HttpError(403, "Invalid or missing CSRF token."));
    }
    next();
  };
  const requireAuth = (req, _res, next) => {
    if (!Number.isSafeInteger(req.session.userId)) {
      return next(new HttpError(401, "Please sign in to continue."));
    }
    next();
  };
  const requireAuthAndCsrf = [requireAuth, requireCsrf];

  function recordCallEvent(callId, senderId, kind, payload) {
    return db.prepare(
      `INSERT INTO call_events (call_id, sender_id, kind, payload)
       VALUES (?, ?, ?, ?)`
    ).run(callId, senderId, kind, JSON.stringify(payload));
  }

  function setCallStatus(call, status) {
    if (!["ringing", "connecting", "connected"].includes(call.status)) return false;
    const now = new Date();
    const endedAt = now.toISOString();
    const durationSeconds = call.connected_at
      ? Math.max(0, Math.floor((now.getTime() - Date.parse(call.connected_at)) / 1000))
      : 0;
    const result = db.prepare(
      `UPDATE calls SET status = ?, ended_at = ?, duration_seconds = ?
       WHERE id = ? AND status IN ('ringing', 'connecting', 'connected')`
    ).run(status, endedAt, durationSeconds, call.id);
    if (result.changes) {
      recordCallEvent(call.id, null, "state", { status });
      db.prepare("DELETE FROM call_events WHERE call_id = ? AND kind != 'state'")
        .run(call.id);
      return true;
    }
    return false;
  }

  function getCallSummary(callId, userId) {
    const row = db.prepare(
      `SELECT c.id, c.caller_id, c.recipient_id, c.call_type, c.status,
              c.created_at, c.answered_at, c.connected_at, c.ended_at, c.duration_seconds,
              caller.username AS caller_username, caller.avatar_key AS caller_avatar_key,
              recipient.username AS recipient_username, recipient.avatar_key AS recipient_avatar_key
       FROM calls c
       JOIN users caller ON caller.id = c.caller_id
       JOIN users recipient ON recipient.id = c.recipient_id
       WHERE c.id = ? AND (c.caller_id = ? OR c.recipient_id = ?)`
    ).get(callId, userId, userId);
    if (!row) return null;
    const caller = { id: row.caller_id, username: row.caller_username };
    if (row.caller_avatar_key) caller.avatarUrl = `/api/users/${row.caller_id}/avatar`;
    const recipient = { id: row.recipient_id, username: row.recipient_username };
    if (row.recipient_avatar_key) recipient.avatarUrl = `/api/users/${row.recipient_id}/avatar`;
    return {
      id: row.id,
      caller,
      recipient,
      otherUser: row.caller_id === userId ? recipient : caller,
      callType: row.call_type,
      status: row.status,
      createdAt: row.created_at,
      answeredAt: row.answered_at,
      connectedAt: row.connected_at,
      endedAt: row.ended_at,
      durationSeconds: row.duration_seconds
    };
  }

  function getCallForParticipant(callId, userId) {
    const call = db.prepare(
      `SELECT * FROM calls
       WHERE id = ? AND (caller_id = ? OR recipient_id = ?)`
    ).get(callId, userId, userId);
    if (!call) throw new HttpError(404, "Call not found.");
    return call;
  }

  function updatePresence(userId, now = Date.now()) {
    db.prepare(
      `INSERT INTO user_presence (user_id, last_seen_at) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`
    ).run(userId, now);
  }

  function refreshCallLiveness(userId, now = Date.now()) {
    updatePresence(userId, now);
    if (now - lastCallPruneAt >= 60 * 60 * 1000) {
      db.prepare("DELETE FROM calls WHERE ended_at IS NOT NULL AND ended_at <= ?")
        .run(new Date(now - CALL_HISTORY_RETENTION_MS).toISOString());
      lastCallPruneAt = now;
    }
    const activeCalls = db.prepare(
      `SELECT * FROM calls
       WHERE status IN ('ringing', 'connecting', 'connected')
         AND (caller_id = ? OR recipient_id = ?)`
    ).all(userId, userId);
    for (const call of activeCalls) {
      if (
        call.status === "ringing" &&
        now - Date.parse(call.created_at) >= CALL_RING_TIMEOUT_MS
      ) {
        setCallStatus(call, "missed");
        continue;
      }
      if (call.status === "connecting" &&
          now - Date.parse(call.answered_at) >= CALL_CONNECT_TIMEOUT_MS) {
        setCallStatus(call, "connection_error");
        continue;
      }
      if (call.status === "connected" || call.status === "connecting") {
        const peerId = call.caller_id === userId ? call.recipient_id : call.caller_id;
        const peer = db.prepare("SELECT last_seen_at FROM user_presence WHERE user_id = ?")
          .get(peerId);
        if (!peer || now - peer.last_seen_at >= CALL_PRESENCE_TIMEOUT_MS) {
          setCallStatus(call, call.status === "connecting" ? "connection_error" : "ended");
        }
      }
    }
  }

  function requireCallConnection(call) {
    const connection = relationship(db, call.caller_id, call.recipient_id);
    if (!connection || connection.status !== "accepted") {
      setCallStatus(call, "ended");
      throw new HttpError(403, "Calls are only available to connected users.");
    }
  }

  function setAuthenticatedSession(req, userId) {
    return new Promise((resolve, reject) => {
      req.session.regenerate((error) => {
        if (error) return reject(error);
        req.session.userId = userId;
        req.session.csrfToken = createCsrfToken(secret);
        req.session.save((saveError) => {
          if (saveError) return reject(saveError);
          resolve(req.session.csrfToken);
        });
      });
    });
  }

  function loginAttemptKey(req) {
    return crypto
      .createHmac("sha256", secret)
      .update(req.ip || req.socket.remoteAddress || "unknown")
      .digest("hex");
  }

  function normalizePhone(value) {
    if (typeof value !== "string" || value.length > 40) {
      throw new HttpError(400, "Enter a valid phone number with country code.");
    }
    const parsed = parsePhoneNumberFromString(value);
    if (!parsed || !parsed.isValid() || parsed.ext) {
      throw new HttpError(400, "Enter a valid phone number with country code.");
    }
    return parsed.number;
  }

  function phoneAccountAlias(phoneNumber) {
    return `phone+${phoneNumber.replace(/\D/g, "")}@accounts.invalid`;
  }

  function phoneCodeHash(phoneNumber, purpose, code) {
    return crypto
      .createHmac("sha256", secret)
      .update(`${phoneNumber}\0${purpose}\0${code}`)
      .digest("hex");
  }

  async function createRegisteredAccount({
    username,
    phoneNumber,
    password,
    file,
    verificationCode = null
  }) {
    const avatar = await normalizeImage(file, { avatar: true });
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const avatarKey = await storeMedia(mediaDir, avatar.buffer, "webp");
    let result;
    let transactionStarted = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      if (verificationCode !== null) {
        checkPhoneCode(phoneNumber, "register", verificationCode);
      }
      result = db.prepare(
        `INSERT INTO users
          (username, username_key, email, password_hash, avatar_key,
           phone_number, phone_verified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        username.trim(),
        username.trim().toLowerCase(),
        phoneAccountAlias(phoneNumber),
        passwordHash,
        avatarKey,
        phoneNumber,
        verificationCode === null ? null : new Date().toISOString()
      );
      if (verificationCode !== null) {
        db.prepare(
          "DELETE FROM phone_verifications WHERE phone_number = ? AND purpose = 'register'"
        ).run(phoneNumber);
      }
      db.exec("COMMIT");
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) db.exec("ROLLBACK");
      await removeMedia(mediaDir, avatarKey);
      if (
        error.errcode === 2067 ||
        (error.code === "ERR_SQLITE_ERROR" &&
          typeof error.message === "string" &&
          error.message.startsWith("UNIQUE constraint failed: users."))
      ) {
        throw new HttpError(409, "That username or phone number is already registered.");
      }
      throw error;
    }
    return Number(result.lastInsertRowid);
  }

  function checkPhoneCode(phoneNumber, purpose, code, now = Date.now()) {
    const verification = db
      .prepare(
        `SELECT code_hash, expires_at, attempt_count
         FROM phone_verifications WHERE phone_number = ? AND purpose = ?`
      )
      .get(phoneNumber, purpose);
    if (!verification || verification.expires_at <= now) {
      throw new HttpError(400, "Verification code expired. Request a new one.");
    }
    if (verification.attempt_count >= PHONE_CODE_ATTEMPT_LIMIT) {
      throw new HttpError(429, "Too many incorrect codes. Request a new code.");
    }
    const expected = Buffer.from(verification.code_hash, "hex");
    const supplied = Buffer.from(phoneCodeHash(phoneNumber, purpose, code), "hex");
    if (!crypto.timingSafeEqual(expected, supplied)) {
      db.prepare(
        `UPDATE phone_verifications SET attempt_count = attempt_count + 1
         WHERE phone_number = ? AND purpose = ?`
      ).run(phoneNumber, purpose);
      if (verification.attempt_count + 1 >= PHONE_CODE_ATTEMPT_LIMIT) {
        throw new HttpError(429, "Too many incorrect codes. Request a new code.");
      }
      throw new HttpError(400, "Verification code is incorrect.");
    }
  }

  async function sendPhoneCode(phoneNumber, purpose) {
    const now = Date.now();
    db.prepare("DELETE FROM phone_verifications WHERE window_started_at <= ?")
      .run(now - PHONE_CODE_WINDOW_MS);
    const previous = db
      .prepare(
        `SELECT code_hash, expires_at, attempt_count, window_started_at,
                send_count, last_sent_at
         FROM phone_verifications WHERE phone_number = ? AND purpose = ?`
      )
      .get(phoneNumber, purpose);
    const windowActive =
      previous && now - previous.window_started_at < PHONE_CODE_WINDOW_MS;
    if (
      windowActive &&
      now - previous.last_sent_at < PHONE_CODE_RESEND_DELAY_MS
    ) {
      throw new HttpError(429, "Wait a minute before requesting another code.");
    }
    if (windowActive && previous.send_count >= PHONE_CODE_RESEND_LIMIT) {
      throw new HttpError(429, "Code resend limit reached. Try again later.");
    }

    const code = String(crypto.randomInt(100000, 1000000));
    const codeHash = phoneCodeHash(phoneNumber, purpose, code);
    const sendCount = windowActive ? previous.send_count + 1 : 1;
    const windowStartedAt = windowActive ? previous.window_started_at : now;
    db.prepare(
      `INSERT INTO phone_verifications
        (phone_number, purpose, code_hash, expires_at, attempt_count,
         window_started_at, send_count, last_sent_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT(phone_number, purpose) DO UPDATE SET
         code_hash = excluded.code_hash,
         expires_at = excluded.expires_at,
         attempt_count = 0,
         window_started_at = excluded.window_started_at,
         send_count = excluded.send_count,
         last_sent_at = excluded.last_sent_at`
    ).run(
      phoneNumber,
      purpose,
      codeHash,
      now + PHONE_CODE_TTL_MS,
      windowStartedAt,
      sendCount,
      now
    );

    try {
      await smsProvider.sendVerificationCode(phoneNumber, code);
    } catch (error) {
      if (previous) {
        db.prepare(
          `UPDATE phone_verifications SET code_hash = ?, expires_at = ?,
             attempt_count = ?, window_started_at = ?, send_count = ?,
             last_sent_at = ?
           WHERE phone_number = ? AND purpose = ? AND code_hash = ?`
        ).run(
          previous.code_hash,
          previous.expires_at,
          previous.attempt_count,
          previous.window_started_at,
          previous.send_count,
          previous.last_sent_at,
          phoneNumber,
          purpose,
          codeHash
        );
      } else {
        db.prepare(
          `DELETE FROM phone_verifications
           WHERE phone_number = ? AND purpose = ? AND code_hash = ?`
        ).run(phoneNumber, purpose, codeHash);
      }
      if (error instanceof SmsConfigurationError) {
        throw new HttpError(
          503,
          "Phone verification is not configured. Contact the app administrator.",
          { expose: true }
        );
      }
      if (error instanceof SmsDeliveryError) {
        throw new HttpError(
          502,
          "The verification message could not be sent. Try again later.",
          { expose: true }
        );
      }
      throw error;
    }
  }

  function recordLoginFailure(key, now) {
    const previous = db
      .prepare("SELECT window_started_at FROM login_attempts WHERE ip_key = ?")
      .get(key);
    if (previous && now - previous.window_started_at < LOGIN_WINDOW_MS) {
      db.prepare(
        "UPDATE login_attempts SET attempt_count = attempt_count + 1 WHERE ip_key = ?"
      ).run(key);
    } else {
      db.prepare(
        `INSERT INTO login_attempts (ip_key, window_started_at, attempt_count)
         VALUES (?, ?, 1)
         ON CONFLICT(ip_key) DO UPDATE SET
           window_started_at = excluded.window_started_at,
           attempt_count = 1`
      ).run(key, now);
    }
  }

  api.get(
    "/session",
    asyncRoute(async (req, res) => {
      req.session.csrfToken = createCsrfToken(secret);
      const user = Number.isSafeInteger(req.session.userId)
        ? db.prepare("SELECT id, username, avatar_key FROM users WHERE id = ?").get(req.session.userId)
        : null;
      if (user) updatePresence(user.id);
      res.set("Cache-Control", "no-store");
      res.json({
        user: user ? safeUser(user) : null,
        csrfToken: req.session.csrfToken,
        smsVerificationRequired: !skipSmsVerification
      });
    })
  );

  api.post(
    "/register/start",
    requireCsrf,
    uploadProfile.single("avatar"),
    asyncRoute(async (req, res) => {
      const { username, phone, password } = req.body || {};
      if (!req.file) {
        throw new HttpError(400, "Choose a profile picture to create your account.");
      }
      validateCredentials({ username, password });
      const phoneNumber = normalizePhone(phone);
      if (
        db.prepare("SELECT id FROM users WHERE username_key = ?").get(username.toLowerCase()) ||
        db.prepare("SELECT id FROM users WHERE phone_number = ?").get(phoneNumber)
      ) {
        throw new HttpError(409, "That username or phone number is already registered.");
      }
      if (skipSmsVerification) {
        const userId = await createRegisteredAccount({
          username,
          phoneNumber,
          password,
          file: req.file
        });
        const csrfToken = await setAuthenticatedSession(req, userId);
        res.status(201).json({
          user: {
            id: userId,
            username: username.trim(),
            avatarUrl: `/api/users/${userId}/avatar`
          },
          csrfToken,
          phoneVerified: false
        });
        return;
      }
      await normalizeImage(req.file, { avatar: true });
      await sendPhoneCode(phoneNumber, "register");
      res.status(202).json({ message: "Verification code sent." });
    })
  );

  api.post(
    "/register/verify",
    requireCsrf,
    uploadProfile.single("avatar"),
    asyncRoute(async (req, res) => {
      const { username, phone, password, verificationCode } = req.body || {};
      if (!req.file) {
        throw new HttpError(400, "Choose a profile picture to create your account.");
      }
      validateCredentials({ username, password });
      const phoneNumber = normalizePhone(phone);
      if (typeof verificationCode !== "string" || !/^\d{6}$/.test(verificationCode)) {
        throw new HttpError(400, "Enter the 6-digit verification code.");
      }
      checkPhoneCode(phoneNumber, "register", verificationCode);
      if (
        db.prepare("SELECT id FROM users WHERE username_key = ?").get(username.toLowerCase()) ||
        db.prepare("SELECT id FROM users WHERE phone_number = ?").get(phoneNumber)
      ) {
        throw new HttpError(409, "That username or phone number is already registered.");
      }
      const userId = await createRegisteredAccount({
        username,
        phoneNumber,
        password,
        file: req.file,
        verificationCode
      });
      const csrfToken = await setAuthenticatedSession(req, userId);
      res.status(201).json({
        user: {
          id: userId,
          username: username.trim(),
          avatarUrl: `/api/users/${userId}/avatar`
        },
        csrfToken
      });
    })
  );

  api.post(
    "/login",
    requireCsrf,
    asyncRoute(async (req, res) => {
      const { identifier, password } = req.body || {};
      if (
        typeof identifier !== "string" ||
        identifier.length > 254 ||
        typeof password !== "string" ||
        Buffer.byteLength(password, "utf8") > 72
      ) {
        throw new HttpError(400, "Enter a valid phone number or email and password.");
      }
      const now = Date.now();
      db.prepare("DELETE FROM login_attempts WHERE window_started_at <= ?")
        .run(now - LOGIN_WINDOW_MS);
      const attemptKey = loginAttemptKey(req);
      const attempts = db
        .prepare("SELECT attempt_count FROM login_attempts WHERE ip_key = ?")
        .get(attemptKey);
      if (attempts && attempts.attempt_count >= LOGIN_ATTEMPT_LIMIT) {
        throw new HttpError(429, "Too many sign-in attempts. Try again later.");
      }
      const trimmedIdentifier = identifier.trim();
      const identifierColumn = trimmedIdentifier.includes("@")
        ? "email"
        : trimmedIdentifier.startsWith("+")
          ? "phone_number"
          : "username_key";
      let normalizedIdentifier = trimmedIdentifier.toLowerCase();
      if (identifierColumn === "phone_number") {
        normalizedIdentifier = normalizePhone(trimmedIdentifier);
      }
      const user = db.prepare(
        `SELECT id, username, password_hash, avatar_key FROM users
         WHERE ${identifierColumn} = ?`
      ).get(normalizedIdentifier);
      const validPassword = await bcrypt.compare(
        password,
        user?.password_hash || DUMMY_PASSWORD_HASH
      );
      if (!user || !validPassword) {
        recordLoginFailure(attemptKey, now);
        throw new HttpError(401, "Sign-in details are incorrect.");
      }
      db.prepare("DELETE FROM login_attempts WHERE ip_key = ?").run(attemptKey);
      const csrfToken = await setAuthenticatedSession(req, user.id);
      res.json({ user: safeUser(user), csrfToken });
    })
  );

  api.post(
    "/logout",
    ...requireAuthAndCsrf,
    (req, res, next) => {
      const activeCalls = db.prepare(
        `SELECT * FROM calls
         WHERE status IN ('ringing', 'connecting', 'connected')
           AND (caller_id = ? OR recipient_id = ?)`
      ).all(req.session.userId, req.session.userId);
      activeCalls.forEach((call) => setCallStatus(call, "ended"));
      req.session.destroy((error) => {
        if (error) return next(error);
        res.clearCookie(isProduction ? "__Host-chat.sid" : "chat.sid", {
          httpOnly: true,
          secure: isProduction,
          sameSite: "lax",
          path: "/"
        });
        res.status(204).end();
      });
    }
  );

  api.post(
    "/profile/avatar",
    ...requireAuthAndCsrf,
    uploadProfile.single("avatar"),
    asyncRoute(async (req, res) => {
      if (!req.file) throw new HttpError(400, "Choose a profile picture.");
      const image = await normalizeImage(req.file, { avatar: true });
      const newKey = await storeMedia(mediaDir, image.buffer, "webp");
      const current = db
        .prepare("SELECT avatar_key FROM users WHERE id = ?")
        .get(req.session.userId);
      try {
        db.prepare("UPDATE users SET avatar_key = ? WHERE id = ?").run(
          newKey,
          req.session.userId
        );
        await removeMedia(mediaDir, current?.avatar_key);
      } catch (error) {
        if (db.prepare("SELECT avatar_key FROM users WHERE id = ?").get(req.session.userId)?.avatar_key !== newKey) {
          await removeMedia(mediaDir, newKey);
        }
        throw error;
      }
      res.json({
        user: {
          id: req.session.userId,
          username: db.prepare("SELECT username FROM users WHERE id = ?").get(req.session.userId).username,
          avatarUrl: `/api/users/${req.session.userId}/avatar`
        }
      });
    })
  );

  api.get(
    "/settings",
    requireAuth,
    asyncRoute(async (req, res) => {
      const user = db
        .prepare(
          `SELECT username, phone_number, phone_verified_at, theme, read_receipts
           FROM users WHERE id = ?`
        )
        .get(req.session.userId);
      if (!user) throw new HttpError(401, "Please sign in to continue.");
      res.json({
        settings: {
          username: user.username,
          phoneNumber: user.phone_number,
          phoneVerified: Boolean(user.phone_verified_at),
          theme: user.theme,
          readReceipts: Boolean(user.read_receipts)
        }
      });
    })
  );

  api.patch(
    "/settings/profile",
    ...requireAuthAndCsrf,
    asyncRoute(async (req, res) => {
      const { username } = req.body || {};
      if (typeof username !== "string" || !USERNAME_PATTERN.test(username)) {
        throw new HttpError(400, "Username must be 3–24 letters, numbers, or underscores.");
      }
      try {
        db.prepare("UPDATE users SET username = ?, username_key = ? WHERE id = ?")
          .run(username, username.toLowerCase(), req.session.userId);
      } catch (error) {
        if (error.errcode === 2067) throw new HttpError(409, "That username is already in use.");
        throw error;
      }
      res.json({
        user: {
          id: req.session.userId,
          username,
          avatarUrl: db.prepare("SELECT avatar_key FROM users WHERE id = ?").get(req.session.userId)
            ?.avatar_key
            ? `/api/users/${req.session.userId}/avatar`
            : null
        }
      });
    })
  );

  api.patch(
    "/settings/preferences",
    ...requireAuthAndCsrf,
    asyncRoute(async (req, res) => {
      const { readReceipts, theme } = req.body || {};
      if (
        typeof readReceipts !== "boolean" ||
        !["light", "dark", "system"].includes(theme)
      ) {
        throw new HttpError(400, "Choose valid theme and read-receipt preferences.");
      }
      db.prepare("UPDATE users SET read_receipts = ?, theme = ? WHERE id = ?")
        .run(Number(readReceipts), theme, req.session.userId);
      res.json({ readReceipts, theme });
    })
  );

  async function requireCurrentPassword(userId, password) {
    if (typeof password !== "string" || Buffer.byteLength(password, "utf8") > 72) {
      throw new HttpError(400, "Enter your current password.");
    }
    const user = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      throw new HttpError(403, "Current password is incorrect.");
    }
  }

  api.post(
    "/settings/password",
    ...requireAuthAndCsrf,
    asyncRoute(async (req, res) => {
      const { currentPassword, newPassword } = req.body || {};
      await requireCurrentPassword(req.session.userId, currentPassword);
      validatePassword(newPassword);
      const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
        .run(passwordHash, req.session.userId);
      res.status(204).end();
    })
  );

  api.post(
    "/settings/phone/start",
    ...requireAuthAndCsrf,
    asyncRoute(async (req, res) => {
      const { phone, currentPassword } = req.body || {};
      await requireCurrentPassword(req.session.userId, currentPassword);
      const phoneNumber = normalizePhone(phone);
      if (
        db.prepare("SELECT id FROM users WHERE phone_number = ? AND id != ?")
          .get(phoneNumber, req.session.userId)
      ) {
        throw new HttpError(409, "That phone number is already registered.");
      }
      await sendPhoneCode(phoneNumber, "change_phone");
      res.status(202).json({ message: "Verification code sent." });
    })
  );

  api.post(
    "/settings/phone/verify",
    ...requireAuthAndCsrf,
    asyncRoute(async (req, res) => {
      const { phone, currentPassword, verificationCode } = req.body || {};
      await requireCurrentPassword(req.session.userId, currentPassword);
      const phoneNumber = normalizePhone(phone);
      if (typeof verificationCode !== "string" || !/^\d{6}$/.test(verificationCode)) {
        throw new HttpError(400, "Enter the 6-digit verification code.");
      }
      checkPhoneCode(phoneNumber, "change_phone", verificationCode);
      if (
        db.prepare("SELECT id FROM users WHERE phone_number = ? AND id != ?")
          .get(phoneNumber, req.session.userId)
      ) {
        throw new HttpError(409, "That phone number is already registered.");
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        checkPhoneCode(phoneNumber, "change_phone", verificationCode);
        db.prepare(
          "UPDATE users SET phone_number = ?, phone_verified_at = ? WHERE id = ?"
        ).run(phoneNumber, new Date().toISOString(), req.session.userId);
        db.prepare(
          "DELETE FROM phone_verifications WHERE phone_number = ? AND purpose = 'change_phone'"
        ).run(phoneNumber);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        if (error.errcode === 2067) {
          throw new HttpError(409, "That phone number is already registered.");
        }
        throw error;
      }
      res.json({ phoneNumber, phoneVerified: true });
    })
  );

  api.get(
    "/users/:userId/avatar",
    requireAuth,
    asyncRoute(async (req, res, next) => {
      const userId = Number(req.params.userId);
      if (!Number.isSafeInteger(userId) || userId <= 0) {
        throw new HttpError(404, "Profile picture not found.");
      }
      const user = db.prepare("SELECT avatar_key FROM users WHERE id = ?").get(userId);
      if (!user?.avatar_key) throw new HttpError(404, "Profile picture not found.");
      if (userId !== req.session.userId) requireConnection(req.session.userId, userId);
      res.set({
        "Cache-Control": "private, no-store",
        "Content-Type": "image/webp",
        "Content-Disposition": 'inline; filename="profile.webp"',
        "X-Content-Type-Options": "nosniff"
      });
      res.sendFile(mediaPath(mediaDir, user.avatar_key), (error) => {
        if (error && !res.headersSent) next(error);
      });
    })
  );

  api.get(
    "/users",
    requireAuth,
    asyncRoute(async (req, res) => {
      const query = typeof req.query.username === "string" ? req.query.username.trim() : "";
      if (query.length < 2 || query.length > 24) {
        throw new HttpError(400, "Search with 2–24 username characters.");
      }
      const rows = db
        .prepare(
          `SELECT id, username FROM users
           WHERE username_key LIKE ? ESCAPE '\\' AND id != ?
           ORDER BY username_key LIMIT 10`
        )
        .all(`${query.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`, req.session.userId);
      res.json({
        users: rows.map((row) => {
          const connection = relationship(db, req.session.userId, row.id);
          return {
            ...safeUser(row),
            status: connection?.status || "none",
            direction: connection
              ? connection.requester_id === req.session.userId
                ? "outgoing"
                : "incoming"
              : null
          };
        })
      });
    })
  );

  api.get(
    "/connections",
    requireAuth,
    asyncRoute(async (req, res) => {
      const rows = db
        .prepare(
          `SELECT c.requester_id, c.recipient_id, c.status, u.id, u.username, u.avatar_key
           FROM connections c
           JOIN users u ON u.id = CASE
             WHEN c.user_low = ? THEN c.user_high ELSE c.user_low END
           WHERE (c.user_low = ? OR c.user_high = ?)
           ORDER BY c.status, u.username_key`
        )
        .all(req.session.userId, req.session.userId, req.session.userId);
      res.json({
        connections: rows.map((row) => ({
          ...safeUser({
            ...row,
            avatar_key: row.status === "accepted" ? row.avatar_key : null
          }),
          status: row.status,
          direction: row.requester_id === req.session.userId ? "outgoing" : "incoming"
        }))
      });
    })
  );

  api.post(
    "/connections/:userId",
    ...requireAuthAndCsrf,
    asyncRoute(async (req, res) => {
      const otherId = Number(req.params.userId);
      if (!Number.isSafeInteger(otherId) || otherId <= 0 || otherId === req.session.userId) {
        throw new HttpError(400, "Choose a valid user.");
      }
      const otherUser = db.prepare("SELECT id FROM users WHERE id = ?").get(otherId);
      if (!otherUser) throw new HttpError(404, "User not found.");
      const existing = relationship(db, req.session.userId, otherId);
      if (existing) {
        throw new HttpError(409, "A connection request or connection already exists.");
      }
      db.prepare(
        `INSERT INTO connections
          (user_low, user_high, requester_id, recipient_id, status)
         VALUES (?, ?, ?, ?, 'pending')`
      ).run(
        Math.min(req.session.userId, otherId),
        Math.max(req.session.userId, otherId),
        req.session.userId,
        otherId
      );
      res.status(201).json({ status: "pending" });
    })
  );

  api.post(
    "/connections/:userId/accept",
    ...requireAuthAndCsrf,
    asyncRoute(async (req, res) => {
      const otherId = Number(req.params.userId);
      if (!Number.isSafeInteger(otherId) || otherId <= 0 || otherId === req.session.userId) {
        throw new HttpError(400, "Choose a valid user.");
      }
      const existing = relationship(db, req.session.userId, otherId);
      if (
        !existing ||
        existing.status !== "pending" ||
        existing.recipient_id !== req.session.userId
      ) {
        throw new HttpError(404, "Incoming connection request not found.");
      }
      db.prepare("UPDATE connections SET status = 'accepted' WHERE id = ?").run(existing.id);
      res.json({ status: "accepted" });
    })
  );

  function requireConnection(userId, otherId) {
    const connection = relationship(db, userId, otherId);
    if (!connection || connection.status !== "accepted") {
      throw new HttpError(403, "You can only message an accepted connection.");
    }
  }

  const authorizeConversation = (req, _res, next) => {
    const otherId = Number(req.params.userId);
    if (!Number.isSafeInteger(otherId) || otherId <= 0 || otherId === req.session.userId) {
      return next(new HttpError(400, "Choose a valid conversation."));
    }
    try {
      requireConnection(req.session.userId, otherId);
      next();
    } catch (error) {
      next(error);
    }
  };

  api.get(
    "/statuses",
    requireAuth,
    asyncRoute(async (req, res) => {
      await pruneExpiredStatuses();
      const userId = req.session.userId;
      const rows = db.prepare(
        `SELECT s.id, s.user_id, s.body, s.media_key, s.created_at, s.expires_at,
                u.username, u.avatar_key,
                CASE WHEN s.user_id = ? THEN (
                  SELECT COUNT(*) FROM status_views sv
                  JOIN connections c ON c.status = 'accepted'
                    AND c.user_low = MIN(s.user_id, sv.viewer_id)
                    AND c.user_high = MAX(s.user_id, sv.viewer_id)
                  WHERE sv.status_id = s.id
                ) ELSE NULL END AS viewer_count
         FROM statuses s
         JOIN users u ON u.id = s.user_id
         WHERE s.expires_at > ?
           AND (
             s.user_id = ?
             OR EXISTS (
               SELECT 1 FROM connections c
               WHERE c.status = 'accepted'
                 AND c.user_low = MIN(?, s.user_id)
                 AND c.user_high = MAX(?, s.user_id)
             )
           )
         ORDER BY s.created_at DESC, s.id DESC
         LIMIT 100`
      ).all(
        userId,
        new Date().toISOString(),
        userId,
        userId,
        userId
      );
      res.json({
        statuses: rows.map((row) => {
          const user = safeUser(row);
          return {
            id: row.id,
            user,
            body: row.body,
            mediaUrl: row.media_key ? `/api/statuses/${row.id}/media` : null,
            createdAt: row.created_at,
            expiresAt: row.expires_at,
            viewerCount: row.user_id === userId ? row.viewer_count : null
          };
        })
      });
    })
  );

  api.post(
    "/statuses",
    ...requireAuthAndCsrf,
    uploadStatus.single("media"),
    asyncRoute(async (req, res) => {
      const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
      if (body.length > STATUS_TEXT_LIMIT) {
        throw new HttpError(400, `Status text must be no more than ${STATUS_TEXT_LIMIT} characters.`);
      }
      if (req.file && req.file.size > 5 * 1024 * 1024) {
        throw new HttpError(413, "Status photos must be no larger than 5 MB.");
      }
      if (!body && !req.file) {
        throw new HttpError(400, "Write a status or attach a photo.");
      }
      let media = null;
      if (req.file) {
        const normalized = await normalizeImage(req.file);
        media = {
          key: await storeMedia(mediaDir, normalized.buffer, "webp"),
          mime: normalized.mime
        };
      }
      const createdAt = new Date();
      const expiresAt = new Date(createdAt.getTime() + STATUS_TTL_MS);
      let result;
      try {
        result = db.prepare(
          `INSERT INTO statuses (user_id, body, media_key, media_mime, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
          req.session.userId,
          body,
          media?.key || null,
          media?.mime || null,
          createdAt.toISOString(),
          expiresAt.toISOString()
        );
      } catch (error) {
        await removeMedia(mediaDir, media?.key);
        throw error;
      }
      const row = db.prepare(
        `SELECT users.id, users.username, users.avatar_key
         FROM users WHERE users.id = ?`
      ).get(req.session.userId);
      res.status(201).json({
        status: {
          id: Number(result.lastInsertRowid),
          user: safeUser(row),
          body,
          mediaUrl: media ? `/api/statuses/${Number(result.lastInsertRowid)}/media` : null,
          createdAt: createdAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          viewerCount: 0
        }
      });
    })
  );

  api.get(
    "/statuses/:statusId",
    requireAuth,
    asyncRoute(async (req, res) => {
      await pruneExpiredStatuses();
      const statusId = Number(req.params.statusId);
      if (!Number.isSafeInteger(statusId) || statusId <= 0) {
        throw new HttpError(404, "Status not found.");
      }
      const row = db.prepare(
        `SELECT s.id, s.user_id, s.body, s.media_key, s.created_at, s.expires_at,
                u.username, u.avatar_key
         FROM statuses s JOIN users u ON u.id = s.user_id
         WHERE s.id = ? AND s.expires_at > ?`
      ).get(statusId, new Date().toISOString());
      if (!row) throw new HttpError(404, "Status not found.");
      const viewerId = req.session.userId;
      const isOwner = row.user_id === viewerId;
      if (!isOwner) requireConnection(viewerId, row.user_id);
      if (!isOwner) {
        db.prepare(
          `INSERT INTO status_views (status_id, viewer_id, viewed_at)
           VALUES (?, ?, ?) ON CONFLICT(status_id, viewer_id) DO NOTHING`
        ).run(row.id, viewerId, new Date().toISOString());
      }
      const status = {
        id: row.id,
        user: safeUser(row),
        body: row.body,
        mediaUrl: row.media_key ? `/api/statuses/${row.id}/media` : null,
        createdAt: row.created_at,
        expiresAt: row.expires_at
      };
      if (isOwner) {
        status.viewers = db.prepare(
          `SELECT u.id, u.username, u.avatar_key, sv.viewed_at
           FROM status_views sv JOIN users u ON u.id = sv.viewer_id
           JOIN statuses s ON s.id = sv.status_id
           JOIN connections c ON c.status = 'accepted'
             AND c.user_low = MIN(s.user_id, sv.viewer_id)
             AND c.user_high = MAX(s.user_id, sv.viewer_id)
           WHERE sv.status_id = ?
           ORDER BY sv.viewed_at DESC`
        ).all(row.id).map((viewer) => ({
          ...safeUser(viewer),
          viewedAt: viewer.viewed_at
        }));
      }
      res.json({ status });
    })
  );

  api.delete(
    "/statuses/:statusId",
    ...requireAuthAndCsrf,
    asyncRoute(async (req, res) => {
      const statusId = Number(req.params.statusId);
      if (!Number.isSafeInteger(statusId) || statusId <= 0) {
        throw new HttpError(404, "Status not found.");
      }
      const status = db.prepare(
        "SELECT id, media_key FROM statuses WHERE id = ? AND user_id = ?"
      ).get(statusId, req.session.userId);
      if (!status) throw new HttpError(404, "Status not found.");
      db.prepare("DELETE FROM statuses WHERE id = ? AND user_id = ?")
        .run(statusId, req.session.userId);
      await removeMedia(mediaDir, status.media_key);
      res.status(204).end();
    })
  );

  api.get(
    "/statuses/:statusId/media",
    requireAuth,
    asyncRoute(async (req, res, next) => {
      await pruneExpiredStatuses();
      const statusId = Number(req.params.statusId);
      if (!Number.isSafeInteger(statusId) || statusId <= 0) {
        throw new HttpError(404, "Status media not found.");
      }
      const status = db.prepare(
        `SELECT id, user_id, media_key, media_mime
         FROM statuses WHERE id = ? AND expires_at > ?`
      ).get(statusId, new Date().toISOString());
      if (!status?.media_key) throw new HttpError(404, "Status media not found.");
      if (status.user_id !== req.session.userId) {
        requireConnection(req.session.userId, status.user_id);
      }
      res.set({
        "Cache-Control": "private, no-store",
        "Content-Type": status.media_mime,
        "Content-Disposition": 'inline; filename="status.webp"',
        "X-Content-Type-Options": "nosniff"
      });
      res.sendFile(mediaPath(mediaDir, status.media_key), (error) => {
        if (error && !res.headersSent) next(error);
      });
    })
  );

  api.post(
    "/presence",
    ...requireAuthAndCsrf,
    (req, res) => {
      refreshCallLiveness(req.session.userId);
      res.status(204).end();
    }
  );

  api.post(
    "/calls",
    ...requireAuthAndCsrf,
    asyncRoute(async (req, res) => {
      const recipientId = Number(req.body?.recipientId);
      const callType = req.body?.callType;
      if (!Number.isSafeInteger(recipientId) || recipientId <= 0 ||
          recipientId === req.session.userId || !["voice", "video"].includes(callType)) {
        throw new HttpError(400, "Choose a connected user and a valid call type.");
      }
      requireConnection(req.session.userId, recipientId);
      refreshCallLiveness(req.session.userId);
      const busyCall = db.prepare(
        `SELECT id FROM calls
         WHERE status IN ('ringing', 'connecting', 'connected')
           AND (caller_id IN (?, ?) OR recipient_id IN (?, ?))
         LIMIT 1`
      ).get(req.session.userId, recipientId, req.session.userId, recipientId);
      if (busyCall) throw new HttpError(409, "One of you is already in a call.");

      const presence = db.prepare("SELECT last_seen_at FROM user_presence WHERE user_id = ?")
        .get(recipientId);
      const online = presence && Date.now() - presence.last_seen_at < CALL_PRESENCE_TIMEOUT_MS;
      const callId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO calls (id, caller_id, recipient_id, call_type, status, created_at)
         VALUES (?, ?, ?, ?, 'ringing', ?)`
      ).run(callId, req.session.userId, recipientId, callType, new Date().toISOString());
      const call = getCallForParticipant(callId, req.session.userId);
      recordCallEvent(callId, null, "state", { status: "ringing" });
      if (!online) setCallStatus(call, "missed");
      res.status(201).json({ call: getCallSummary(callId, req.session.userId) });
    })
  );

  api.get(
    "/calls/updates",
    requireAuth,
    asyncRoute(async (req, res) => {
      const after = req.query.after === undefined ? 0 : Number(req.query.after);
      if (!Number.isSafeInteger(after) || after < 0) {
        throw new HttpError(400, "Invalid call update cursor.");
      }
      refreshCallLiveness(req.session.userId);
      const rows = db.prepare(
        `SELECT e.id, e.call_id, e.sender_id, e.kind, e.payload, e.created_at
         FROM call_events e JOIN calls c ON c.id = e.call_id
         WHERE e.id > ? AND (c.caller_id = ? OR c.recipient_id = ?)
           AND (e.kind = 'state' OR e.sender_id IS NULL OR e.sender_id != ?)
         ORDER BY e.id LIMIT 100`
      ).all(after, req.session.userId, req.session.userId, req.session.userId);
      const events = rows.map((row) => ({
        id: row.id,
        callId: row.call_id,
        senderId: row.sender_id,
        kind: row.kind,
        payload: JSON.parse(row.payload),
        createdAt: row.created_at,
        call: getCallSummary(row.call_id, req.session.userId)
      }));
      const active = db.prepare(
        `SELECT id FROM calls
         WHERE status IN ('ringing', 'connecting', 'connected')
           AND (caller_id = ? OR recipient_id = ?)
         ORDER BY created_at DESC LIMIT 1`
      ).get(req.session.userId, req.session.userId);
      const activeSignals = active
        ? db.prepare(
          `SELECT id, call_id, sender_id, kind, payload, created_at
           FROM call_events
           WHERE call_id = ? AND kind IN ('offer', 'answer', 'ice')
             AND sender_id != ?
           ORDER BY id LIMIT 100`
        ).all(active.id, req.session.userId).map((row) => ({
          id: row.id,
          callId: row.call_id,
          senderId: row.sender_id,
          kind: row.kind,
          payload: JSON.parse(row.payload),
          createdAt: row.created_at
        }))
        : [];
      const latestEvent = db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM call_events").get();
      res.json({
        events,
        activeCall: active ? getCallSummary(active.id, req.session.userId) : null,
        activeSignals,
        latestEventId: latestEvent.id
      });
    })
  );

  api.get(
    "/conversations/:userId/calls",
    requireAuth,
    authorizeConversation,
    (req, res) => {
      const otherId = Number(req.params.userId);
      const rows = db.prepare(
        `SELECT id FROM calls
         WHERE (caller_id = ? AND recipient_id = ?)
            OR (caller_id = ? AND recipient_id = ?)
         ORDER BY created_at DESC LIMIT 50`
      ).all(req.session.userId, otherId, otherId, req.session.userId);
      res.json({
        calls: rows.map((row) => getCallSummary(row.id, req.session.userId))
      });
    }
  );

  api.post(
    "/calls/:callId/answer",
    ...requireAuthAndCsrf,
    (req, res) => {
      const call = getCallForParticipant(req.params.callId, req.session.userId);
      requireCallConnection(call);
      if (call.recipient_id !== req.session.userId || call.status !== "ringing") {
        throw new HttpError(409, "This call can no longer be answered.");
      }
      const offer = db.prepare(
        "SELECT id FROM call_events WHERE call_id = ? AND kind = 'offer' AND sender_id = ?"
      ).get(call.id, call.caller_id);
      if (!offer) throw new HttpError(409, "The caller has not sent a call offer yet.");
      const now = Date.now();
      if (now - Date.parse(call.created_at) >= CALL_RING_TIMEOUT_MS) {
        setCallStatus(call, "missed");
        return res.status(410).json({ error: "This call was missed." });
      }
      updatePresence(req.session.userId, now);
      const answeredAt = new Date(now).toISOString();
      db.prepare(
        `UPDATE calls SET status = 'connecting', answered_at = ?
         WHERE id = ? AND status = 'ringing'`
      ).run(answeredAt, call.id);
      recordCallEvent(call.id, null, "state", { status: "connecting" });
      res.json({ call: getCallSummary(call.id, req.session.userId) });
    }
  );

  api.post(
    "/calls/:callId/connected",
    ...requireAuthAndCsrf,
    (req, res) => {
      const call = getCallForParticipant(req.params.callId, req.session.userId);
      requireCallConnection(call);
      if (call.status === "connecting") {
        const descriptions = db.prepare(
          `SELECT
             SUM(CASE WHEN kind = 'offer' AND sender_id = ? THEN 1 ELSE 0 END) AS offers,
             SUM(CASE WHEN kind = 'answer' AND sender_id = ? THEN 1 ELSE 0 END) AS answers
           FROM call_events WHERE call_id = ?`
        ).get(call.caller_id, call.recipient_id, call.id);
        if (!descriptions.offers || !descriptions.answers) {
          throw new HttpError(409, "Both call participants must exchange connection details first.");
        }
        const connectedAt = new Date().toISOString();
        const result = db.prepare(
          `UPDATE calls SET status = 'connected', connected_at = ?
           WHERE id = ? AND status = 'connecting'`
        ).run(connectedAt, call.id);
        if (result.changes) recordCallEvent(call.id, null, "state", { status: "connected" });
      } else if (call.status !== "connected") {
        throw new HttpError(409, "This call is not connecting.");
      }
      updatePresence(req.session.userId);
      res.json({ call: getCallSummary(call.id, req.session.userId) });
    }
  );

  api.post(
    "/calls/:callId/decline",
    ...requireAuthAndCsrf,
    (req, res) => {
      const call = getCallForParticipant(req.params.callId, req.session.userId);
      requireCallConnection(call);
      if (call.recipient_id !== req.session.userId || call.status !== "ringing") {
        throw new HttpError(409, "This call can no longer be declined.");
      }
      if (Date.now() - Date.parse(call.created_at) >= CALL_RING_TIMEOUT_MS) {
        setCallStatus(call, "missed");
        return res.status(410).json({ error: "This call was missed." });
      }
      setCallStatus(call, "declined");
      res.status(204).end();
    }
  );

  api.post(
    "/calls/:callId/end",
    ...requireAuthAndCsrf,
    (req, res) => {
      const call = getCallForParticipant(req.params.callId, req.session.userId);
      requireCallConnection(call);
      if (req.body?.connectionError !== undefined &&
          typeof req.body.connectionError !== "boolean") {
        throw new HttpError(400, "Invalid call end reason.");
      }
      setCallStatus(call, req.body?.connectionError ? "connection_error" : "ended");
      res.status(204).end();
    }
  );

  api.post(
    "/calls/:callId/signals",
    ...requireAuthAndCsrf,
    (req, res) => {
      const call = getCallForParticipant(req.params.callId, req.session.userId);
      requireCallConnection(call);
      const { kind, payload } = req.body || {};
      if (!["offer", "answer", "ice"].includes(kind) ||
          !payload || typeof payload !== "object" || Array.isArray(payload) ||
          Buffer.byteLength(JSON.stringify(payload), "utf8") > 12_000) {
        throw new HttpError(400, "Invalid call signaling data.");
      }
      if (kind === "offer" &&
          (req.session.userId !== call.caller_id || call.status !== "ringing" ||
           payload.type !== "offer" || typeof payload.sdp !== "string")) {
        throw new HttpError(409, "This call offer is not valid.");
      }
      if (kind === "answer" &&
          (req.session.userId !== call.recipient_id || call.status !== "connecting" ||
           payload.type !== "answer" || typeof payload.sdp !== "string")) {
        throw new HttpError(409, "This call answer is not valid.");
      }
      if (["offer", "answer"].includes(kind) &&
          (!payload.sdp.length || payload.sdp.length > 12_000)) {
        throw new HttpError(400, "Invalid call session description.");
      }
      if (kind === "ice" &&
          (typeof payload.candidate !== "string" || payload.candidate.length > 8_192)) {
        throw new HttpError(400, "Invalid network candidate.");
      }
      if (kind === "ice" && !["ringing", "connecting", "connected"].includes(call.status)) {
        throw new HttpError(409, "This call is no longer active.");
      }
      const signalCount = db.prepare(
        "SELECT COUNT(*) AS count FROM call_events WHERE call_id = ? AND kind != 'state'"
      ).get(call.id).count;
      if (signalCount >= 256) throw new HttpError(429, "Call signaling limit reached.");
      recordCallEvent(call.id, req.session.userId, kind, payload);
      res.status(202).json({ accepted: true });
    }
  );

  api.get(
    "/conversations",
    requireAuth,
    asyncRoute(async (req, res) => {
      const rows = db
        .prepare(
          `SELECT u.id, u.username, u.avatar_key,
             m.body AS last_message, m.media_type AS last_media_type,
             m.created_at AS last_message_at
           FROM connections c
           JOIN users u ON u.id = CASE
             WHEN c.user_low = ? THEN c.user_high ELSE c.user_low END
           LEFT JOIN messages m ON m.id = (
             SELECT latest.id FROM messages latest
             WHERE (latest.sender_id = ? AND latest.recipient_id = u.id)
                OR (latest.sender_id = u.id AND latest.recipient_id = ?)
             ORDER BY latest.id DESC LIMIT 1
           )
           WHERE c.status = 'accepted' AND (c.user_low = ? OR c.user_high = ?)
           ORDER BY COALESCE(m.id, 0) DESC, u.username_key`
        )
        .all(
          req.session.userId,
          req.session.userId,
          req.session.userId,
          req.session.userId,
          req.session.userId
        );
      res.json({
        conversations: rows.map((row) => ({
          ...safeUser(row),
          lastMessage: row.last_message || (row.last_media_type === "image" ? "Photo" : row.last_media_type === "voice" ? "Voice note" : ""),
          lastMessageAt: row.last_message_at
        }))
      });
    })
  );

  api.get(
    "/conversations/:userId/messages",
    requireAuth,
    authorizeConversation,
    asyncRoute(async (req, res) => {
      const otherId = Number(req.params.userId);
      db.prepare(
        `UPDATE messages
         SET delivered_at = COALESCE(delivered_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         WHERE sender_id = ? AND recipient_id = ?`
      ).run(otherId, req.session.userId);
      const rows = db
        .prepare(
          `SELECT messages.id, sender_id, recipient_id, body, media_key, media_type,
             media_mime, media_duration, messages.created_at, delivered_at,
             CASE WHEN recipient.read_receipts = 1 THEN messages.read_at ELSE NULL END AS read_at
           FROM messages
           JOIN users recipient ON recipient.id = messages.recipient_id
           WHERE (sender_id = ? AND recipient_id = ?)
              OR (sender_id = ? AND recipient_id = ?)
           ORDER BY messages.id DESC LIMIT 200`
        )
        .all(req.session.userId, otherId, otherId, req.session.userId)
        .reverse();
      res.json({
        messages: rows.map((row) => ({
          id: row.id,
          senderId: row.sender_id,
          recipientId: row.recipient_id,
          body: row.body,
          deliveryStatus:
            row.sender_id === req.session.userId
              ? row.read_at
                ? "read"
                : row.delivered_at
                  ? "delivered"
                  : "sent"
              : null,
          mediaType: row.media_type,
          mediaMime: row.media_mime,
          mediaDuration: row.media_duration,
          mediaUrl: row.media_key
            ? `/api/conversations/${otherId}/media/${row.id}`
            : null,
          createdAt: row.created_at
        }))
      });
    })
  );

  api.post(
    "/conversations/:userId/read",
    ...requireAuthAndCsrf,
    authorizeConversation,
    asyncRoute(async (req, res) => {
      const { messageIds } = req.body || {};
      if (
        !Array.isArray(messageIds) ||
        messageIds.length > 100 ||
        messageIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
      ) {
        throw new HttpError(400, "Provide up to 100 valid message IDs.");
      }
      if (messageIds.length === 0) {
        res.json({ updated: 0 });
        return;
      }
      const preference = db
        .prepare("SELECT read_receipts FROM users WHERE id = ?")
        .get(req.session.userId);
      const placeholders = messageIds.map(() => "?").join(", ");
      const result = db
        .prepare(
          `UPDATE messages SET
             delivered_at = COALESCE(delivered_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
             read_at = CASE WHEN ? = 1
               THEN COALESCE(read_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
               ELSE read_at END
           WHERE recipient_id = ? AND sender_id = ?
             AND id IN (${placeholders})`
        )
        .run(
          preference.read_receipts,
          req.session.userId,
          Number(req.params.userId),
          ...messageIds
        );
      res.json({ updated: Number(result.changes) });
    })
  );

  api.post(
    "/conversations/:userId/messages",
    ...requireAuthAndCsrf,
    authorizeConversation,
    upload.single("media"),
    asyncRoute(async (req, res) => {
      const otherId = Number(req.params.userId);
      const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
      if (body.length > 4000) {
        throw new HttpError(400, "Message must be between 1 and 4000 characters.");
      }
      let media = null;
      let duration = null;
      if (req.file) {
        if (req.body?.mediaType === "image") {
          if (req.file.size > 5 * 1024 * 1024) {
            throw new HttpError(413, "Images must be no larger than 5 MB.");
          }
          const normalized = await normalizeImage(req.file);
          media = {
            ...normalized,
            key: await storeMedia(mediaDir, normalized.buffer, "webp"),
            type: "image"
          };
        } else if (req.body?.mediaType === "voice") {
          const normalized = await validateAudio(req.file);
          duration = normalized.duration;
          media = {
            ...normalized,
            key: await storeMedia(mediaDir, normalized.buffer, "wav"),
            type: "voice"
          };
        } else {
          throw new HttpError(400, "Choose an image or voice note attachment.");
        }
      } else if (req.body?.mediaType !== undefined) {
        throw new HttpError(400, "Choose a file to attach.");
      }
      if (!body && !media) {
        throw new HttpError(400, "Write a message or attach a picture or voice note.");
      }

      let result;
      try {
        result = db
          .prepare(
            `INSERT INTO messages
              (sender_id, recipient_id, body, media_key, media_type, media_mime, media_duration)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            req.session.userId,
            otherId,
            body,
            media?.key || null,
            media?.type || null,
            media?.mime || null,
            duration
          );
      } catch (error) {
        await removeMedia(mediaDir, media?.key);
        throw error;
      }
      const row = db
        .prepare("SELECT created_at FROM messages WHERE id = ?")
        .get(Number(result.lastInsertRowid));
      res.status(201).json({
        message: {
          id: Number(result.lastInsertRowid),
          senderId: req.session.userId,
          recipientId: otherId,
          body,
          deliveryStatus: "sent",
          mediaType: media?.type || null,
          mediaMime: media?.mime || null,
          mediaDuration: duration,
          mediaUrl: media
            ? `/api/conversations/${otherId}/media/${Number(result.lastInsertRowid)}`
            : null,
          createdAt: row.created_at
        }
      });
    })
  );

  api.get(
    "/conversations/:userId/media/:messageId",
    requireAuth,
    authorizeConversation,
    asyncRoute(async (req, res, next) => {
      const otherId = Number(req.params.userId);
      const messageId = Number(req.params.messageId);
      if (
        !Number.isSafeInteger(otherId) ||
        otherId <= 0 ||
        otherId === req.session.userId ||
        !Number.isSafeInteger(messageId) ||
        messageId <= 0
      ) {
        throw new HttpError(404, "Media not found.");
      }
      const message = db
        .prepare(
          `SELECT media_key, media_mime, media_type FROM messages
           WHERE id = ? AND (
             (sender_id = ? AND recipient_id = ?) OR
             (sender_id = ? AND recipient_id = ?)
           )`
        )
        .get(messageId, req.session.userId, otherId, otherId, req.session.userId);
      if (!message?.media_key) throw new HttpError(404, "Media not found.");
      res.set({
        "Cache-Control": "private, no-store",
        "Content-Type": message.media_mime,
        "Content-Disposition": `inline; filename="${message.media_type === "image" ? "image.webp" : "voice-note"}"`,
        "X-Content-Type-Options": "nosniff"
      });
      res.sendFile(mediaPath(mediaDir, message.media_key), (error) => {
        if (error && !res.headersSent) next(error);
      });
    })
  );

  app.use(express.static(publicDir));
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/")) {
      return next(new HttpError(404, "API route not found."));
    }
    res.sendFile(path.join(__dirname, "..", "public", "index.html"));
  });
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return;
    const uploadError = error instanceof multer.MulterError;
    const status =
      uploadError && error.code === "LIMIT_FILE_SIZE"
        ? 413
        : uploadError
          ? 400
          : error instanceof MediaValidationError
            ? 400
            : Number.isInteger(error.status)
              ? error.status
              : 500;
    if (status >= 500) {
      console.error("Request failed:", error.code || error.name || "Error");
    }
    res.status(status).json({
      error:
        status >= 500 && !error.expose
          ? "Something went wrong. Please try again."
          : uploadError
            ? status === 413
              ? "File exceeds upload size limit."
              : "Invalid upload."
            : error.message
    });
  });

  app.locals.db = db;
  return app;
}

module.exports = { createApp };
