# Two Friends Chat

A small private messaging app built with Node.js, Express, SQLite, and plain browser JavaScript. It supports phone-verified accounts, friend connections, one-to-one messaging, private media, temporary statuses, delivery/read indicators, WebRTC voice/video calls, and account settings. SQLite stores accounts, connection requests, messages, statuses, status views, call history, private call signaling, presence, and sessions. Private profile pictures, shared images, voice notes, and status photos are stored separately on disk. Passwords are hashed with bcrypt; the app does not return phone numbers, email addresses, or password hashes through its public API.

## Requirements

- Node.js 22.x (the app uses Node's built-in `node:sqlite` module)
- npm

## Setup

```powershell
npm install
Copy-Item .env.example .env
```

Set `SESSION_SECRET` in `.env` to a unique random value of at least 32 characters. Keep `.env` private and do not commit it. By default, registration requires SMS delivery: configure a Twilio account and set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER` in `.env` using a Twilio-enabled sender. Provider credentials remain server-side. To skip SMS during local development, set `DEV_SKIP_SMS_VERIFICATION=1`; accounts created this way have unverified phone numbers. This option is ignored when `NODE_ENV=production` and must not be used to bypass phone verification in a production deployment. The defaults use port `3000` and create `data/chat.sqlite` and `data/media` automatically. `DB_PATH` and `MEDIA_DIR` may be absolute paths or paths relative to the project directory. Keep `MEDIA_DIR` outside `public`; the application rejects media directories under its public web root. Back up the media directory along with the SQLite database, and use persistent private storage in production.

For example, generate a secret in PowerShell with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

## Run

```powershell
npm start
```

Open <http://localhost:3000>. Voice/video calls use browser WebRTC APIs, authenticated private signaling through the app, and a public STUN server. Microphone and camera access is requested only when starting or answering a call. Browsers require HTTPS for media outside localhost. STUN-only connectivity can fail on restrictive networks; configure a TURN relay service before production use if callers must connect across those networks. The app does not store or expose TURN credentials. In production, set `NODE_ENV=production` over HTTPS so session cookies are marked `Secure`. If HTTPS terminates at a trusted reverse proxy, also set `TRUST_PROXY=1`.

## Vercel deployment status

`vercel.json` routes requests to `api/index.js`, which exports the app from `src/server.js`; the latter starts a listener only for local development. Set a strong `SESSION_SECRET` in the Vercel project's Production (and Preview, if used) environment variables. Vercel's writable `/tmp` directory is used as a temporary fallback for SQLite and uploaded media so the function can initialize; **this is not durable storage**. Database rows, sessions, and uploads may disappear on cold starts, be isolated between function instances, or be lost on redeploy. Do not use this fallback for real accounts or production data. Before production, migrate SQLite and its session store to a managed PostgreSQL database and move private uploads to durable private object storage. The existing app does not yet support `DATABASE_URL` or a remote object-storage provider; adding those environment variables alone will not migrate it.

## Test

```powershell
npm test
```

The tests use temporary SQLite files and a mock SMS provider; they cover phone verification and its expiry/attempt/resend limits, authentication, settings authorization, password and phone changes, connection requests, status privacy/viewers/expiry/deletion and upload validation, call authorization/signaling/state transitions/offline and timed-out missed calls, receipt transitions/privacy, private media access, media messages, and migration of existing message data.

## Privacy and behavior

- Only accepted connections can view a conversation or send messages; this is enforced by the API.
- New accounts are created only after a normalized international phone number is verified by SMS. Codes are HMAC-hashed at rest, expire after 10 minutes, allow at most five attempts, and are limited to three sends per 15-minute window with a 60-second resend delay. Sign in with the username, verified phone number, or email associated with the account.
- Delivery is recorded when the recipient loads conversation history. Read receipts are recorded only for incoming messages the browser confirms are visible, and the sender sees read state only when the recipient has read receipts enabled. Users can change this preference in account settings.
- Phone changes require the current password and a fresh SMS verification. Password changes also require the current password; settings and preferences are available only to the signed-in account. Theme preference supports light, dark, and device settings.
- Registration requires a PNG, JPEG, or WebP profile picture (maximum 5 MB). Images are decoded and re-encoded as metadata-free WebP; animated or malformed images are rejected. Chat images have a 5 MB upload limit and are resized before private storage.
- Voice notes are limited to 10 MB and 120 seconds. Recording asks for microphone access only after the user presses Record; microphone access requires HTTPS or localhost. Browser recording formats supported by the server are WebM, Ogg, MP4 audio, WAV, and MP3.
- Media is stored using generated filenames outside the static web root. Authenticated users can view their own profile picture; conversation pictures and voice notes are served only to the two connected participants.
- Users can post text statuses, photos, or both. Status photos use the same 5 MB image validation, metadata-stripping WebP normalization, and private storage as chat images. Only the owner and currently connected users can see an active status or its photo; only the owner can see its viewer list. Statuses expire after 24 hours, are hidden immediately after expiry, and their database records, viewer entries, and photos are removed by an hourly cleanup sweep or on the next status access.
- Search results and connection lists contain usernames and IDs only. Phone numbers and email addresses are private to the account owner and are not returned by the API.
- Passwords are validated and hashed with bcrypt. Session cookies are HTTP-only, same-site, and backed by SQLite. Mutating API requests require a session CSRF token, and repeated failed sign-ins are rate-limited per client IP.
- New and existing messages appear through short-interval polling; status feeds refresh every 15 seconds and when a tab becomes visible. No third-party realtime service is used.
- Voice and video calls are limited to accepted connections. The backend checks both participants for every call state and signaling request; incoming call polling and call history return only calls involving the signed-in user. Calls ring for 30 seconds and end with a connection error if WebRTC does not connect within 30 seconds after answer. Recipients with no recent presence heartbeat are logged as missed. Active-call presence expires after 45 seconds without a heartbeat. SDP and ICE signaling events are removed when calls end; call history is retained for up to 90 days.
