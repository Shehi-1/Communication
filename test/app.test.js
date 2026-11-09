const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const sharp = require("sharp");
const { createApp } = require("../src/app");
const { SmsConfigurationError, SmsDeliveryError } = require("../src/sms");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "closeby-test-"));
const smsCodes = new Map();
const generatedPhones = new Map();
let nextTestPhone = 100;
let smsUnavailable = false;
let smsDeliveryUnavailable = false;
const app = createApp({
  dbPath: path.join(tempDir, "test.sqlite"),
  mediaDir: path.join(tempDir, "private-media"),
  sessionSecret: "a-test-only-session-secret-that-is-long-enough",
  smsProvider: {
    async sendVerificationCode(phone, code) {
      if (smsUnavailable) throw new SmsConfigurationError("Provider unavailable in test.");
      if (smsDeliveryUnavailable) throw new SmsDeliveryError("Delivery failed in test.");
      smsCodes.set(phone, code);
    }
  },
  production: false
});
const server = app.listen(0, "127.0.0.1");
let baseUrl;

before(async () => {
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  app.locals.db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function createClient(url = baseUrl) {
  let cookie = "";
  let csrfToken = "";

  async function call(route, { method = "GET", body, formData } = {}) {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;
    const response = await fetch(`${url}/api${route}`, {
      method,
      headers,
      body: formData || (body === undefined ? undefined : JSON.stringify(body))
    });
    const setCookies = response.headers.getSetCookie();
    if (setCookies.length > 0) cookie = setCookies[0].split(";")[0];
    const data = response.status === 204 ? null : await response.json();
    if (data?.csrfToken) csrfToken = data.csrfToken;
    return { response, data };
  }

  async function startRegistration(username, phone = phoneFor(username), password = "correct-horse-battery-42", avatar = createPng()) {
    const initial = await call("/session");
    csrfToken = initial.data.csrfToken;
    const formData = new FormData();
    formData.append("username", username);
    formData.append("phone", phone);
    formData.append("password", password);
    formData.append("avatar", await avatar, "avatar.png");
    const result = await call("/register/start", {
      method: "POST",
      formData
    });
    return result;
  }

  async function verifyRegistration(username, phone = phoneFor(username), password = "correct-horse-battery-42", verificationCode = smsCodes.get(phone), avatar = createPng()) {
    const formData = new FormData();
    formData.append("username", username);
    formData.append("phone", phone);
    formData.append("password", password);
    formData.append("verificationCode", verificationCode);
    formData.append("avatar", await avatar, "avatar.png");
    return call("/register/verify", { method: "POST", formData });
  }

  async function register(username, phone = phoneFor(username), password = "correct-horse-battery-42") {
    const started = await startRegistration(username, phone, password);
    if (started.response.status !== 202) return started;
    return verifyRegistration(username, phone, password);
  }

  async function login(identifier, password = "correct-horse-battery-42") {
    const initial = await call("/session");
    csrfToken = initial.data.csrfToken;
    const result = await call("/login", {
      method: "POST",
      body: { identifier, password }
    });
    if (result.data?.csrfToken) csrfToken = result.data.csrfToken;
    return result;
  }

  async function download(route) {
    return fetch(`${url}/api${route}`, {
      headers: cookie ? { Cookie: cookie } : {}
    });
  }

  return { call, download, login, register, startRegistration, verifyRegistration };
}

function phoneFor(username) {
  if (!generatedPhones.has(username)) {
    generatedPhones.set(username, `+1202555${String(nextTestPhone++).padStart(4, "0")}`);
  }
  return generatedPhones.get(username);
}

async function createPng() {
  return new Blob([
    await sharp({
      create: {
        width: 4,
        height: 4,
        channels: 3,
        background: { r: 35, g: 123, b: 115 }
      }
    }).png().toBuffer()
  ], { type: "image/png" });
}

function multipart(fields, file, filename = "attachment") {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) formData.append(key, value);
  if (file) formData.append("media", file, filename);
  return formData;
}

function createWav(seconds) {
  const sampleRate = 16000;
  const sampleCount = Math.floor(sampleRate * seconds);
  const dataLength = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataLength, 40);
  return buffer;
}

test("registration validates input and returns no private account fields", async () => {
  const client = await createClient();
  const invalid = await client.register("ab");
  assert.equal(invalid.response.status, 400);

  const result = await client.register("alice");
  assert.equal(result.response.status, 201);
  assert.deepEqual(Object.keys(result.data.user).sort(), ["avatarUrl", "id", "username"]);
  assert.match(result.data.user.avatarUrl, /^\/api\/users\/\d+\/avatar$/);

  const duplicate = await client.register("alice");
  assert.equal(duplicate.response.status, 409);

  const stored = app.locals.db
    .prepare("SELECT email, phone_number, password_hash FROM users WHERE id = ?")
    .get(result.data.user.id);
  assert.equal(stored.email, `phone+${phoneFor("alice").replace(/\D/g, "")}@accounts.invalid`);
  assert.equal(stored.phone_number, phoneFor("alice"));
  assert.notEqual(stored.password_hash, "correct-horse-battery-42");
  assert.match(stored.password_hash, /^\$2[aby]\$12\$/);
});

test("SMS can be skipped in development but never in production", async () => {
  const developmentApp = createApp({
    dbPath: path.join(tempDir, "skip-sms.sqlite"),
    mediaDir: path.join(tempDir, "skip-sms-media"),
    sessionSecret: "a-test-only-session-secret-that-is-long-enough",
    skipSmsVerification: true,
    production: false
  });
  const developmentServer = developmentApp.listen(0, "127.0.0.1");
  await new Promise((resolve) => developmentServer.once("listening", resolve));
  const developmentUrl = `http://127.0.0.1:${developmentServer.address().port}`;
  try {
    const client = await createClient(developmentUrl);
    const session = await client.call("/session");
    assert.equal(session.data.smsVerificationRequired, false);
    const registration = await client.startRegistration(
      "sms_skipped",
      phoneFor("sms_skipped")
    );
    assert.equal(registration.response.status, 201);
    assert.equal(registration.data.phoneVerified, false);
    assert.equal(registration.data.user.username, "sms_skipped");
    assert.equal(
      developmentApp.locals.db
        .prepare("SELECT phone_verified_at FROM users WHERE id = ?")
        .get(registration.data.user.id).phone_verified_at,
      null
    );
  } finally {
    await new Promise((resolve, reject) => {
      developmentServer.close((error) => (error ? reject(error) : resolve()));
    });
    developmentApp.locals.db.close();
  }

  const productionApp = createApp({
    dbPath: path.join(tempDir, "production-sms.sqlite"),
    mediaDir: path.join(tempDir, "production-sms-media"),
    sessionSecret: "a-test-only-session-secret-that-is-long-enough",
    skipSmsVerification: true,
    production: true
  });
  const productionServer = productionApp.listen(0, "127.0.0.1");
  await new Promise((resolve) => productionServer.once("listening", resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${productionServer.address().port}/api/session`
    );
    const session = await response.json();
    assert.equal(session.smsVerificationRequired, true);
  } finally {
    await new Promise((resolve, reject) => {
      productionServer.close((error) => (error ? reject(error) : resolve()));
    });
    productionApp.locals.db.close();
  }
});

test("registration requires a valid image and profile pictures can be changed privately", async () => {
  const client = await createClient();
  const initial = await client.call("/session");
  const missingAvatar = new FormData();
  missingAvatar.append("username", "missing_photo");
  missingAvatar.append("phone", phoneFor("missing_photo"));
  missingAvatar.append("password", "correct-horse-battery-42");
  const missing = await client.call("/register/start", { method: "POST", formData: missingAvatar });
  assert.equal(missing.response.status, 400);

  const invalidAvatar = new FormData();
  invalidAvatar.append("username", "spoofed_photo");
  invalidAvatar.append("phone", phoneFor("spoofed_photo"));
  invalidAvatar.append("password", "correct-horse-battery-42");
  invalidAvatar.append("avatar", new Blob(["not an image"], { type: "image/png" }), "fake.png");
  const invalid = await client.call("/register/start", { method: "POST", formData: invalidAvatar });
  assert.equal(invalid.response.status, 400);
  assert.ok(initial.data.csrfToken);

  const owner = await createClient();
  const created = await owner.register("photo_owner");
  const stranger = await createClient();
  await stranger.register("photo_stranger");
  const forbidden = await stranger.download(`/users/${created.data.user.id}/avatar`);
  assert.equal(forbidden.status, 403);

  const replacement = new FormData();
  replacement.append("avatar", await createPng(), "replacement.png");
  const updated = await owner.call("/profile/avatar", { method: "POST", formData: replacement });
  assert.equal(updated.response.status, 200);
  const picture = await owner.download(`/users/${created.data.user.id}/avatar`);
  assert.equal(picture.status, 200);
  assert.equal(picture.headers.get("content-type"), "image/webp");
  assert.equal(picture.headers.get("cache-control"), "private, no-store");
});

test("authentication uses a generic failure and creates an authenticated session", async () => {
  const registration = await createClient();
  await registration.register("bob");

  const wrongPassword = await createClient();
  const failed = await wrongPassword.login(phoneFor("bob"), "not-the-right-password");
  assert.equal(failed.response.status, 401);
  assert.equal(failed.data.error, "Email or password is incorrect.");

  const client = await createClient();
  const loggedIn = await client.login(phoneFor("bob"));
  assert.equal(loggedIn.response.status, 200);
  assert.equal(loggedIn.data.user.username, "bob");
  const session = await client.call("/session");
  assert.equal(session.data.user.username, "bob");
  const signedOut = await client.call("/logout", { method: "POST" });
  assert.equal(signedOut.response.status, 204);
  const anonymousSession = await client.call("/session");
  assert.equal(anonymousSession.data.user, null);
  const protectedRequest = await client.call("/connections");
  assert.equal(protectedRequest.response.status, 401);
  const signedBackIn = await client.login(phoneFor("bob"));
  assert.equal(signedBackIn.response.status, 200);
});

test("phone verification gates account creation and enforces expiry, attempt, and resend limits", async () => {
  const phone = phoneFor("sms_verified");
  const client = await createClient();
  const started = await client.startRegistration("sms_verified", phone);
  assert.equal(started.response.status, 202);
  assert.equal(
    app.locals.db.prepare("SELECT COUNT(*) AS count FROM users WHERE phone_number = ?").get(phone).count,
    0
  );
  assert.equal(started.data.message, "Verification code sent.");

  const created = await client.verifyRegistration("sms_verified", phone, undefined, "000000");
  assert.equal(created.response.status, 400);
  const verified = await client.verifyRegistration("sms_verified", phone);
  assert.equal(verified.response.status, 201);

  const expiredPhone = phoneFor("sms_expired");
  const expiredClient = await createClient();
  await expiredClient.startRegistration("sms_expired", expiredPhone);
  app.locals.db.prepare(
    "UPDATE phone_verifications SET expires_at = ? WHERE phone_number = ? AND purpose = 'register'"
  ).run(Date.now() - 1, expiredPhone);
  const expired = await expiredClient.verifyRegistration("sms_expired", expiredPhone);
  assert.equal(expired.response.status, 400);
  assert.match(expired.data.error, /expired/i);

  const limitedPhone = phoneFor("sms_attempts");
  const limitedClient = await createClient();
  await limitedClient.startRegistration("sms_attempts", limitedPhone);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const wrong = await limitedClient.verifyRegistration("sms_attempts", limitedPhone, undefined, "000000");
    assert.equal(wrong.response.status, 400);
  }
  const tooManyAttempts = await limitedClient.verifyRegistration(
    "sms_attempts", limitedPhone, undefined, "000000"
  );
  assert.equal(tooManyAttempts.response.status, 429);

  const resendPhone = phoneFor("sms_resend");
  const resendClient = await createClient();
  for (let send = 0; send < 3; send += 1) {
    const result = await resendClient.startRegistration("sms_resend", resendPhone);
    assert.equal(result.response.status, 202);
    app.locals.db.prepare(
      "UPDATE phone_verifications SET last_sent_at = ? WHERE phone_number = ? AND purpose = 'register'"
    ).run(Date.now() - 61_000, resendPhone);
  }
  const resendLimit = await resendClient.startRegistration("sms_resend", resendPhone);
  assert.equal(resendLimit.response.status, 429);
});

test("failed SMS sends do not consume cooldowns or invalidate an existing code", async () => {
  const phone = phoneFor("sms_config_error");
  const client = await createClient();
  smsUnavailable = true;
  try {
    const result = await client.startRegistration("sms_config_error", phone);
    assert.equal(result.response.status, 503);
    assert.match(result.data.error, /not configured/i);
    assert.equal(
      app.locals.db.prepare("SELECT COUNT(*) AS count FROM users WHERE phone_number = ?").get(phone).count,
      0
    );
  } finally {
    smsUnavailable = false;
  }
  const retry = await client.startRegistration("sms_config_error", phone);
  assert.equal(retry.response.status, 202);

  const resendPhone = phoneFor("sms_delivery_error");
  const resendClient = await createClient();
  const initial = await resendClient.startRegistration("sms_delivery_error", resendPhone);
  assert.equal(initial.response.status, 202);
  const originalCode = smsCodes.get(resendPhone);
  app.locals.db.prepare(
    "UPDATE phone_verifications SET last_sent_at = ? WHERE phone_number = ? AND purpose = 'register'"
  ).run(Date.now() - 61_000, resendPhone);
  smsDeliveryUnavailable = true;
  try {
    const failedResend = await resendClient.startRegistration("sms_delivery_error", resendPhone);
    assert.equal(failedResend.response.status, 502);
    assert.match(failedResend.data.error, /could not be sent/i);
  } finally {
    smsDeliveryUnavailable = false;
  }
  const verified = await resendClient.verifyRegistration(
    "sms_delivery_error",
    resendPhone,
    undefined,
    originalCode
  );
  assert.equal(verified.response.status, 201);
});

test("account settings are private and sensitive changes require verification", async () => {
  const owner = await createClient();
  await owner.register("settings_owner");
  const stranger = await createClient();
  await stranger.register("settings_other");

  const settings = await owner.call("/settings");
  assert.equal(settings.response.status, 200);
  assert.equal(settings.data.settings.phoneNumber, phoneFor("settings_owner"));
  assert.equal(settings.data.settings.readReceipts, true);
  assert.equal(settings.data.settings.theme, "light");

  const strangerSettings = await stranger.call("/settings");
  assert.equal(strangerSettings.data.settings.phoneNumber, phoneFor("settings_other"));
  const forbidden = await stranger.call("/settings/password", {
    method: "POST",
    body: { currentPassword: "wrong-password", newPassword: "a-different-long-password" }
  });
  assert.equal(forbidden.response.status, 403);

  const profile = await owner.call("/settings/profile", {
    method: "PATCH",
    body: { username: "settings_renamed" }
  });
  assert.equal(profile.response.status, 200);
  assert.equal(profile.data.user.username, "settings_renamed");

  const preferences = await owner.call("/settings/preferences", {
    method: "PATCH",
    body: { readReceipts: false, theme: "dark" }
  });
  assert.equal(preferences.response.status, 200);
  assert.equal(preferences.data.readReceipts, false);
  assert.equal(app.locals.db.prepare("SELECT theme FROM users WHERE id = ?").get(profile.data.user.id).theme, "dark");

  const invalidPasswordChange = await owner.call("/settings/password", {
    method: "POST",
    body: { currentPassword: "wrong-current-password", newPassword: "new-password-is-long" }
  });
  assert.equal(invalidPasswordChange.response.status, 403);
  const changedPassword = await owner.call("/settings/password", {
    method: "POST",
    body: {
      currentPassword: "correct-horse-battery-42",
      newPassword: "a-new-password-long-enough"
    }
  });
  assert.equal(changedPassword.response.status, 204);
  const oldLogin = await (await createClient()).login(phoneFor("settings_owner"));
  assert.equal(oldLogin.response.status, 401);
  const newLogin = await (await createClient()).login(
    phoneFor("settings_owner"),
    "a-new-password-long-enough"
  );
  assert.equal(newLogin.response.status, 200);

  const newPhone = phoneFor("settings_new_phone");
  const phoneStart = await owner.call("/settings/phone/start", {
    method: "POST",
    body: { phone: newPhone, currentPassword: "a-new-password-long-enough" }
  });
  assert.equal(phoneStart.response.status, 202);
  const phoneVerify = await owner.call("/settings/phone/verify", {
    method: "POST",
    body: {
      phone: newPhone,
      currentPassword: "a-new-password-long-enough",
      verificationCode: smsCodes.get(newPhone)
    }
  });
  assert.equal(phoneVerify.response.status, 200);
  assert.equal(phoneVerify.data.phoneNumber, newPhone);
  assert.equal(
    app.locals.db.prepare("SELECT phone_number FROM users WHERE id = ?").get(profile.data.user.id).phone_number,
    newPhone
  );
});

test("users can request and accept a connection, but cannot accept someone else's request", async () => {
  const alice = await createClient();
  const bob = await createClient();
  const charlie = await createClient();
  const aliceUser = (await alice.register("alice_conn")).data.user;
  const bobUser = (await bob.register("bobby_conn")).data.user;
  await charlie.register("charlie");

  const search = await alice.call("/users?username=bobby_");
  assert.equal(search.response.status, 200, JSON.stringify(search.data));
  assert.deepEqual(search.data.users.map((user) => user.username), ["bobby_conn"]);
  const request = await alice.call(`/connections/${bobUser.id}`, { method: "POST" });
  assert.equal(request.response.status, 201);
  const duplicate = await alice.call(`/connections/${bobUser.id}`, { method: "POST" });
  assert.equal(duplicate.response.status, 409);
  const wrongAccept = await charlie.call(`/connections/${aliceUser.id}/accept`, { method: "POST" });
  assert.equal(wrongAccept.response.status, 404);
  const accepted = await bob.call(`/connections/${aliceUser.id}/accept`, { method: "POST" });
  assert.equal(accepted.response.status, 200);
  const connections = await bob.call("/connections");
  assert.equal(connections.data.connections[0].status, "accepted");
});

test("only accepted participants can read or send conversation messages", async () => {
  const alice = await createClient();
  const bob = await createClient();
  const charlie = await createClient();
  const aliceUser = (await alice.register("alice2")).data.user;
  const bobUser = (await bob.register("bobby2")).data.user;
  await charlie.register("charlie2");

  const blockedRead = await alice.call(`/conversations/${bobUser.id}/messages`);
  assert.equal(blockedRead.response.status, 403);
  const blockedSend = await alice.call(`/conversations/${bobUser.id}/messages`, {
    method: "POST",
    body: { body: "Should not get through" }
  });
  assert.equal(blockedSend.response.status, 403);

  await alice.call(`/connections/${bobUser.id}`, { method: "POST" });
  await bob.call(`/connections/${aliceUser.id}/accept`, { method: "POST" });
  const sent = await alice.call(`/conversations/${bobUser.id}/messages`, {
    method: "POST",
    body: { body: "Hello, friend!" }
  });
  assert.equal(sent.response.status, 201);
  assert.equal(sent.data.message.deliveryStatus, "sent");
  const received = await bob.call(`/conversations/${aliceUser.id}/messages`);
  assert.equal(received.data.messages.length, 1);
  assert.equal(received.data.messages[0].body, "Hello, friend!");
  assert.equal(received.data.messages[0].senderId, aliceUser.id);
  assert.equal(received.data.messages[0].deliveryStatus, null);
  const delivered = await alice.call(`/conversations/${bobUser.id}/messages`);
  assert.equal(delivered.data.messages[0].deliveryStatus, "delivered");
  const read = await bob.call(`/conversations/${aliceUser.id}/read`, {
    method: "POST",
    body: { messageIds: [sent.data.message.id] }
  });
  assert.equal(read.response.status, 200);
  const readBySender = await alice.call(`/conversations/${bobUser.id}/messages`);
  assert.equal(readBySender.data.messages[0].deliveryStatus, "read");

  const forbidden = await charlie.call(`/conversations/${aliceUser.id}/messages`);
  assert.equal(forbidden.response.status, 403);
  const forbiddenReceipt = await charlie.call(`/conversations/${aliceUser.id}/read`, {
    method: "POST",
    body: { messageIds: [sent.data.message.id] }
  });
  assert.equal(forbiddenReceipt.response.status, 403);
  const list = await bob.call("/conversations");
  assert.equal(list.data.conversations[0].lastMessage, "Hello, friend!");
});

test("statuses are private to accepted connections, record private viewers, and delete safely", async () => {
  const { alice, aliceUser, bob, bobUser } = await createConnectedPair("statuses");
  const stranger = await createClient();
  await stranger.register("status_stranger");

  const textStatus = await alice.call("/statuses", {
    method: "POST",
    body: { body: "A private update" }
  });
  assert.equal(textStatus.response.status, 201);
  assert.equal(textStatus.data.status.body, "A private update");
  assert.equal(
    Date.parse(textStatus.data.status.expiresAt) - Date.parse(textStatus.data.status.createdAt),
    24 * 60 * 60 * 1000
  );

  const photoStatus = await alice.call("/statuses", {
    method: "POST",
    formData: multipart({ body: "A photo update" }, await createPng(), "status.png")
  });
  assert.equal(photoStatus.response.status, 201);
  assert.equal(photoStatus.data.status.mediaUrl, `/api/statuses/${photoStatus.data.status.id}/media`);
  const mediaKey = app.locals.db.prepare("SELECT media_key FROM statuses WHERE id = ?")
    .get(photoStatus.data.status.id).media_key;

  const bobFeed = await bob.call("/statuses");
  assert.equal(bobFeed.response.status, 200);
  assert.deepEqual(
    bobFeed.data.statuses.map((status) => status.id).sort(),
    [textStatus.data.status.id, photoStatus.data.status.id].sort()
  );
  assert.equal(bobFeed.data.statuses[0].viewerCount, null);
  const strangerFeed = await stranger.call("/statuses");
  assert.equal(strangerFeed.data.statuses.length, 0);

  const opened = await bob.call(`/statuses/${photoStatus.data.status.id}`);
  assert.equal(opened.response.status, 200);
  assert.equal(Object.hasOwn(opened.data.status, "viewers"), false);
  await bob.call(`/statuses/${photoStatus.data.status.id}`);
  const image = await bob.download(`/statuses/${photoStatus.data.status.id}/media`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/webp");
  const forbiddenStatus = await stranger.call(`/statuses/${photoStatus.data.status.id}`);
  assert.equal(forbiddenStatus.response.status, 403);
  const forbiddenMedia = await stranger.download(`/statuses/${photoStatus.data.status.id}/media`);
  assert.equal(forbiddenMedia.status, 403);

  const ownerView = await alice.call(`/statuses/${photoStatus.data.status.id}`);
  assert.equal(ownerView.response.status, 200);
  assert.deepEqual(ownerView.data.status.viewers.map((viewer) => viewer.id), [bobUser.id]);
  const forbiddenDelete = await bob.call(`/statuses/${photoStatus.data.status.id}`, {
    method: "DELETE"
  });
  assert.equal(forbiddenDelete.response.status, 404);
  const deleted = await alice.call(`/statuses/${photoStatus.data.status.id}`, {
    method: "DELETE"
  });
  assert.equal(deleted.response.status, 204);
  assert.equal(fs.existsSync(path.join(tempDir, "private-media", mediaKey)), false);
  assert.equal((await bob.call(`/statuses/${photoStatus.data.status.id}`)).response.status, 404);
  assert.equal((await bob.download(`/statuses/${photoStatus.data.status.id}/media`)).status, 404);
  const remainingFeed = await bob.call("/statuses");
  assert.deepEqual(remainingFeed.data.statuses.map((status) => status.id), [textStatus.data.status.id]);
  assert.ok(aliceUser.id);
});

test("expired statuses are hidden and their photo files are removed", async () => {
  const { alice, bob } = await createConnectedPair("expiredstatus");
  const created = await alice.call("/statuses", {
    method: "POST",
    formData: multipart({ body: "" }, await createPng(), "expired.png")
  });
  assert.equal(created.response.status, 201);
  const id = created.data.status.id;
  const mediaKey = app.locals.db.prepare("SELECT media_key FROM statuses WHERE id = ?")
    .get(id).media_key;
  app.locals.db.prepare("UPDATE statuses SET expires_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 1000).toISOString(), id);

  const feed = await bob.call("/statuses");
  assert.equal(feed.data.statuses.length, 0);
  assert.equal((await alice.call(`/statuses/${id}`)).response.status, 404);
  assert.equal((await alice.download(`/statuses/${id}/media`)).status, 404);
  assert.equal(app.locals.db.prepare("SELECT id FROM statuses WHERE id = ?").get(id), undefined);
  assert.equal(fs.existsSync(path.join(tempDir, "private-media", mediaKey)), false);
});

test("status uploads reject unsupported image payloads and empty statuses", async () => {
  const { alice } = await createConnectedPair("invalidstatus");
  const empty = await alice.call("/statuses", { method: "POST", body: { body: "  " } });
  assert.equal(empty.response.status, 400);
  const invalid = await alice.call("/statuses", {
    method: "POST",
    formData: multipart({ body: "" }, new Blob(["not an image"], { type: "image/png" }), "invalid.png")
  });
  assert.equal(invalid.response.status, 400);
  const tooLarge = await alice.call("/statuses", {
    method: "POST",
    formData: multipart(
      { body: "" },
      new Blob([Buffer.alloc(5 * 1024 * 1024 + 1)], { type: "image/png" }),
      "large.png"
    )
  });
  assert.equal(tooLarge.response.status, 413);
  const longText = await alice.call("/statuses", {
    method: "POST",
    body: { body: "x".repeat(501) }
  });
  assert.equal(longText.response.status, 400);
});

test("calls require an accepted connection and enforce private call state transitions", async () => {
  const { alice, aliceUser, bob, bobUser } = await createConnectedPair("calls");
  const stranger = await createClient();
  const strangerUser = (await stranger.register("call_stranger")).data.user;
  const denied = await alice.call("/calls", {
    method: "POST",
    body: { recipientId: strangerUser.id, callType: "voice" }
  });
  assert.equal(denied.response.status, 403);
  await bob.call("/presence", { method: "POST" });

  const started = await alice.call("/calls", {
    method: "POST",
    body: { recipientId: bobUser.id, callType: "video" }
  });
  assert.equal(started.response.status, 201);
  assert.equal(started.data.call.status, "ringing");
  assert.equal(started.data.call.callType, "video");

  const forbiddenHistory = await stranger.call(`/conversations/${aliceUser.id}/calls`);
  assert.equal(forbiddenHistory.response.status, 403);
  const bobUpdates = await bob.call("/calls/updates");
  assert.ok(bobUpdates.data.events.some(
    (event) => event.callId === started.data.call.id &&
      event.payload.status === "ringing"
  ));

  const offer = await alice.call(`/calls/${started.data.call.id}/signals`, {
    method: "POST",
    body: { kind: "offer", payload: { type: "offer", sdp: "test-sdp" } }
  });
  assert.equal(offer.response.status, 202);
  const receivedOffer = await bob.call("/calls/updates");
  assert.ok(receivedOffer.data.events.some(
    (event) => event.callId === started.data.call.id &&
      event.kind === "offer" && event.payload.sdp === "test-sdp"
  ));
  const senderEvents = await alice.call("/calls/updates");
  assert.equal(senderEvents.data.events.some((event) => event.kind === "offer"), false);

  const answered = await bob.call(`/calls/${started.data.call.id}/answer`, {
    method: "POST"
  });
  assert.equal(answered.response.status, 200);
  assert.equal(answered.data.call.status, "connecting");
  const prematureConnect = await alice.call(`/calls/${started.data.call.id}/connected`, {
    method: "POST"
  });
  assert.equal(prematureConnect.response.status, 409);
  const answer = await bob.call(`/calls/${started.data.call.id}/signals`, {
    method: "POST",
    body: { kind: "answer", payload: { type: "answer", sdp: "test-answer" } }
  });
  assert.equal(answer.response.status, 202);
  const connected = await alice.call(`/calls/${started.data.call.id}/connected`, {
    method: "POST"
  });
  assert.equal(connected.data.call.status, "connected");
  await alice.call(`/calls/${started.data.call.id}/end`, {
    method: "POST",
    body: {}
  });
  const history = await alice.call(`/conversations/${bobUser.id}/calls`);
  assert.equal(history.data.calls[0].status, "ended");
  assert.equal(history.data.calls[0].callType, "video");
  assert.equal(app.locals.db.prepare(
    "SELECT COUNT(*) AS count FROM call_events WHERE call_id = ? AND kind = 'offer'"
  ).get(started.data.call.id).count, 0);
  const lateDecline = await bob.call(`/calls/${started.data.call.id}/decline`, {
    method: "POST"
  });
  assert.equal(lateDecline.response.status, 409);

  const declinedCall = await alice.call("/calls", {
    method: "POST",
    body: { recipientId: bobUser.id, callType: "voice" }
  });
  const declined = await bob.call(`/calls/${declinedCall.data.call.id}/decline`, {
    method: "POST"
  });
  assert.equal(declined.response.status, 204);
  const callerUpdates = await alice.call("/calls/updates");
  assert.ok(callerUpdates.data.events.some(
    (event) => event.callId === declinedCall.data.call.id &&
      event.payload.status === "declined"
  ));

  const failedCall = await alice.call("/calls", {
    method: "POST",
    body: { recipientId: bobUser.id, callType: "voice" }
  });
  await alice.call(`/calls/${failedCall.data.call.id}/signals`, {
    method: "POST",
    body: { kind: "offer", payload: { type: "offer", sdp: "test-sdp" } }
  });
  await bob.call(`/calls/${failedCall.data.call.id}/answer`, { method: "POST" });
  await bob.call(`/calls/${failedCall.data.call.id}/signals`, {
    method: "POST",
    body: { kind: "answer", payload: { type: "answer", sdp: "test-answer" } }
  });
  await bob.call(`/calls/${failedCall.data.call.id}/connected`, { method: "POST" });
  app.locals.db.prepare("UPDATE calls SET connected_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 65_000).toISOString(), failedCall.data.call.id);
  await alice.call(`/calls/${failedCall.data.call.id}/end`, {
    method: "POST",
    body: { connectionError: true }
  });
  const failedHistory = await bob.call(`/conversations/${aliceUser.id}/calls`);
  assert.equal(failedHistory.data.calls[0].status, "connection_error");
  assert.ok(failedHistory.data.calls[0].durationSeconds >= 60);
});

test("calls to offline connections are logged as missed and ringing calls expire", async () => {
  const { alice, aliceUser, bob, bobUser } = await createConnectedPair("offlinecall");
  const missed = await alice.call("/calls", {
    method: "POST",
    body: { recipientId: bobUser.id, callType: "voice" }
  });
  assert.equal(missed.response.status, 201);
  assert.equal(missed.data.call.status, "missed");
  const history = await bob.call(`/conversations/${aliceUser.id}/calls`);
  assert.equal(history.data.calls[0].status, "missed");

  const online = await createConnectedPair("expirycall");
  await online.bob.call("/presence", { method: "POST" });
  const started = await online.alice.call("/calls", {
    method: "POST",
    body: { recipientId: online.bobUser.id, callType: "voice" }
  });
  app.locals.db.prepare("UPDATE calls SET created_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 31_000).toISOString(), started.data.call.id);
  const lateDecline = await online.bob.call(`/calls/${started.data.call.id}/decline`, {
    method: "POST"
  });
  assert.equal(lateDecline.response.status, 410);
  const updates = await online.bob.call("/calls/updates");
  assert.ok(updates.data.events.some(
    (event) => event.callId === started.data.call.id &&
      event.payload.status === "missed"
  ));
  const callerHistory = await online.alice.call(`/conversations/${online.bobUser.id}/calls`);
  assert.equal(callerHistory.data.calls[0].status, "missed");

  const connecting = await createConnectedPair("connecttimeout");
  await connecting.bob.call("/presence", { method: "POST" });
  const call = await connecting.alice.call("/calls", {
    method: "POST",
    body: { recipientId: connecting.bobUser.id, callType: "video" }
  });
  await connecting.alice.call(`/calls/${call.data.call.id}/signals`, {
    method: "POST",
    body: { kind: "offer", payload: { type: "offer", sdp: "test-sdp" } }
  });
  await connecting.bob.call(`/calls/${call.data.call.id}/answer`, { method: "POST" });
  await connecting.bob.call(`/calls/${call.data.call.id}/signals`, {
    method: "POST",
    body: { kind: "answer", payload: { type: "answer", sdp: "test-answer" } }
  });
  app.locals.db.prepare("UPDATE calls SET answered_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 31_000).toISOString(), call.data.call.id);
  const expiredConnection = await connecting.alice.call("/calls/updates");
  assert.ok(expiredConnection.data.events.some(
    (event) => event.callId === call.data.call.id &&
      event.payload.status === "connection_error"
  ));
});

test("read receipts follow recipient preferences and only appear to the sender", async () => {
  const { alice, aliceUser, bob, bobUser } = await createConnectedPair("receipts");
  const prefs = await bob.call("/settings/preferences", {
    method: "PATCH",
    body: { readReceipts: false, theme: "system" }
  });
  assert.equal(prefs.response.status, 200);
  const sent = await alice.call(`/conversations/${bobUser.id}/messages`, {
    method: "POST",
    body: { body: "Private read state" }
  });
  await bob.call(`/conversations/${aliceUser.id}/messages`);
  const marked = await bob.call(`/conversations/${aliceUser.id}/read`, {
    method: "POST",
    body: { messageIds: [sent.data.message.id] }
  });
  assert.equal(marked.data.updated, 1);
  const hiddenRead = await alice.call(`/conversations/${bobUser.id}/messages`);
  assert.equal(hiddenRead.data.messages[0].deliveryStatus, "delivered");
  const recipientView = await bob.call(`/conversations/${aliceUser.id}/messages`);
  assert.equal(recipientView.data.messages[0].deliveryStatus, null);

  await bob.call("/settings/preferences", {
    method: "PATCH",
    body: { readReceipts: true, theme: "system" }
  });
  await bob.call(`/conversations/${aliceUser.id}/read`, {
    method: "POST",
    body: { messageIds: [sent.data.message.id] }
  });
  const visibleRead = await alice.call(`/conversations/${bobUser.id}/messages`);
  assert.equal(visibleRead.data.messages[0].deliveryStatus, "read");
  assert.equal(aliceUser.id, sent.data.message.senderId);
});

async function createConnectedPair(prefix) {
  const alice = await createClient();
  const bob = await createClient();
  const aliceUser = (await alice.register(`alice_${prefix}`)).data.user;
  const bobUser = (await bob.register(`bobby_${prefix}`)).data.user;
  await alice.call(`/connections/${bobUser.id}`, { method: "POST" });
  const accepted = await bob.call(`/connections/${aliceUser.id}/accept`, { method: "POST" });
  assert.equal(accepted.response.status, 200);
  return { alice, aliceUser, bob, bobUser };
}

test("image uploads are validated, normalized, and private to connected friends", async () => {
  const { alice, aliceUser, bob, bobUser } = await createConnectedPair("image");
  const stranger = await createClient();
  await stranger.register("stranger_image");

  const sent = await alice.call(`/conversations/${bobUser.id}/messages`, {
    method: "POST",
    formData: multipart(
      { body: "", mediaType: "image" },
      await createPng(),
      "photo.png"
    )
  });
  assert.equal(sent.response.status, 201);
  assert.equal(sent.data.message.mediaType, "image");
  assert.equal(sent.data.message.mediaMime, "image/webp");
  assert.equal(sent.data.message.body, "");
  assert.equal(JSON.stringify(sent.data).includes("media_key"), false);

  const history = await bob.call(`/conversations/${aliceUser.id}/messages`);
  assert.equal(history.data.messages[0].mediaType, "image");
  assert.match(history.data.messages[0].mediaUrl, /^\/api\/conversations\/\d+\/media\/\d+$/);
  const mediaRoute = history.data.messages[0].mediaUrl.replace(/^\/api/, "");
  const received = await bob.download(mediaRoute);
  assert.equal(received.status, 200);
  assert.equal(received.headers.get("content-type"), "image/webp");
  const bytes = Buffer.from(await received.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(bytes.subarray(8, 12).toString("ascii"), "WEBP");

  const privateMedia = await stranger.download(mediaRoute);
  assert.equal(privateMedia.status, 403);
  const privateAvatar = await stranger.download(`/users/${aliceUser.id}/avatar`);
  assert.equal(privateAvatar.status, 403);
  const unauthorizedUpload = await stranger.call(`/conversations/${aliceUser.id}/messages`, {
    method: "POST",
    formData: multipart({ body: "", mediaType: "image" }, await createPng(), "blocked.png")
  });
  assert.equal(unauthorizedUpload.response.status, 403);

  const invalid = await alice.call(`/conversations/${bobUser.id}/messages`, {
    method: "POST",
    formData: multipart(
      { body: "", mediaType: "image" },
      new Blob(["not an image"], { type: "image/png" }),
      "spoof.png"
    )
  });
  assert.equal(invalid.response.status, 400);

  const oversized = await alice.call(`/conversations/${bobUser.id}/messages`, {
    method: "POST",
    formData: multipart(
      { body: "", mediaType: "image" },
      new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: "image/png" }),
      "large.png"
    )
  });
  assert.equal(oversized.response.status, 413);
});

test("voice notes validate audio, preserve duration, and remain conversation-private", async () => {
  const { alice, aliceUser, bob, bobUser } = await createConnectedPair("voice");
  const stranger = await createClient();
  await stranger.register("stranger_voice");
  const audioBytes = createWav(0.25);
  const sent = await alice.call(`/conversations/${bobUser.id}/messages`, {
    method: "POST",
    formData: multipart(
      { body: "", mediaType: "voice", duration: "121" },
      new Blob([audioBytes], { type: "audio/wav" }),
      "voice-note.wav"
    )
  });
  assert.equal(sent.response.status, 201);
  assert.equal(sent.data.message.mediaType, "voice");
  assert.equal(sent.data.message.mediaDuration, 0.25);

  const history = await bob.call(`/conversations/${aliceUser.id}/messages`);
  const mediaRoute = history.data.messages[0].mediaUrl.replace(/^\/api/, "");
  const received = await bob.download(mediaRoute);
  assert.equal(received.status, 200);
  assert.equal(received.headers.get("content-type"), "audio/wav");
  assert.deepEqual(Buffer.from(await received.arrayBuffer()), audioBytes);
  const forbidden = await stranger.download(mediaRoute);
  assert.equal(forbidden.status, 403);

  const invalid = await alice.call(`/conversations/${bobUser.id}/messages`, {
    method: "POST",
    formData: multipart(
      { body: "", mediaType: "voice", duration: "3" },
      new Blob(["not audio"], { type: "audio/wav" }),
      "fake.wav"
    )
  });
  assert.equal(invalid.response.status, 400);
  const tooLong = await alice.call(`/conversations/${bobUser.id}/messages`, {
    method: "POST",
    formData: multipart(
      { body: "", mediaType: "voice", duration: "1" },
      new Blob([createWav(120.1)], { type: "audio/wav" }),
      "long.wav"
    )
  });
  assert.equal(tooLong.response.status, 400);
});

test("legacy message rows survive the media schema migration", (context) => {
  const legacyPath = path.join(tempDir, "legacy.sqlite");
  const { DatabaseSync } = require("node:sqlite");
  const legacyDb = new DatabaseSync(legacyPath);
  legacyDb.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      username_key TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE connections (
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
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CHECK (sender_id != recipient_id)
    );
    INSERT INTO users (username, username_key, email, password_hash) VALUES
      ('old_sender', 'old_sender', 'old_sender@example.com', 'hash'),
      ('old_recipient', 'old_recipient', 'old_recipient@example.com', 'hash');
    INSERT INTO messages (sender_id, recipient_id, body) VALUES (1, 2, 'Before media migration');
    CREATE INDEX messages_conversation_idx ON messages(sender_id, recipient_id, id);
  `);
  legacyDb.close();

  const { createDatabase } = require("../src/db");
  const migrated = createDatabase(legacyPath);
  const message = migrated.prepare("SELECT body, media_key FROM messages WHERE id = 1").get();
  assert.equal(message.body, "Before media migration");
  assert.equal(message.media_key, null);
  assert.ok(migrated.prepare("PRAGMA table_info(users)").all().some((column) => column.name === "avatar_key"));
  assert.deepEqual(migrated.prepare("PRAGMA foreign_key_check").all(), []);
  migrated.close();
});

test("mutating routes require a valid CSRF token", async () => {
  const client = await createClient();
  const initial = await client.call("/session");
  const response = await fetch(`${baseUrl}/api/register/start`, {
    method: "POST",
    headers: { Cookie: "chat.sid=invalid", "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "csrfuser",
      phone: phoneFor("csrfuser"),
      password: "correct-horse-battery-42"
    })
  });
  assert.equal(response.status, 403);
  assert.ok(initial.data.csrfToken);
});

test("repeated failed sign-ins are rate-limited", async () => {
  const registration = await createClient();
  await registration.register("rate_limit_user");

  const client = await createClient();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const failed = await client.login(phoneFor("rate_limit_user"), "wrong-password-123");
    assert.equal(failed.response.status, 401);
  }
  const limited = await client.login(phoneFor("rate_limit_user"), "wrong-password-123");
  assert.equal(limited.response.status, 429);
});
