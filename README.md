# Two Friends Chat

A small private messaging app built with Node.js, Express, SQLite/PostgreSQL, and plain browser JavaScript. It supports username-and-password accounts, friend connections, one-to-one messaging, private media, temporary statuses, delivery/read indicators, WebRTC voice/video calls, and account settings. SQLite stores data for local development by default; setting `DATABASE_URL` selects PostgreSQL for application data and sessions. Private profile pictures, shared images, voice notes, and status photos are stored separately on disk. Passwords are hashed with bcrypt; the app does not return phone numbers, email addresses, or password hashes through its public API.

## Requirements

- Node.js 22.x
- npm

## Setup

```powershell
npm install
Copy-Item .env.example .env
```

Set `SESSION_SECRET` in `.env` to a unique random value of at least 32 characters. Keep `.env` private and do not commit it. Account creation requires a username, password, and profile picture; it does not require a phone number or SMS verification. Configure a Twilio account and set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER` only if users should be able to add or change a phone number in settings. Provider credentials remain server-side. Without `DATABASE_URL`, the defaults use port `3000` and create `data/chat.sqlite` and `data/media` automatically. Set `DATABASE_URL` to use PostgreSQL instead; the app applies its versioned schema migration at startup. `DB_PATH` and `MEDIA_DIR` may be absolute paths or paths relative to the project directory. Keep `MEDIA_DIR` outside `public`; the application rejects media directories under its public web root. Back up private media separately from the database.

For example, generate a secret in PowerShell with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

## Run

```powershell
npm start
```

Open <http://localhost:3000>. Voice/video calls use browser WebRTC APIs, authenticated private signaling through the app, and a public STUN server. Microphone and camera access is requested only when starting or answering a call. Browsers require HTTPS for media outside localhost. STUN-only connectivity can fail on restrictive networks; configure a TURN relay service before production use if callers must connect across those networks. The app does not store or expose TURN credentials. In production, set `NODE_ENV=production` over HTTPS so session cookies are marked `Secure`. If HTTPS terminates at a trusted reverse proxy, set `TRUST_PROXY=1`; the Vercel entrypoint enables proxy trust automatically.

## Vercel deployment status

`vercel.json` routes requests to `api/index.js`, which exports the app from `src/server.js`; the latter starts a listener only for local development. Configure `SESSION_SECRET` and `DATABASE_URL` in the Vercel project's Production (and Preview, if used) environment variables. Obtain `DATABASE_URL` from the Neon project's **Connect** dialog (use its pooled connection string for serverless deployments); keep it secret and never commit it. The app creates/updates its PostgreSQL schema automatically and uses PostgreSQL for accounts, messages, statuses, calls, presence, rate-limit records, phone-verification records, and Express sessions. On Vercel, startup fails if `DATABASE_URL` is absent rather than silently falling back to an ephemeral SQLite database. Existing SQLite rows are not imported automatically; transfer any accounts/data you need before switching deployments. Uploaded media still uses local disk and the Vercel `/tmp` fallback, which is ephemeral; use private durable object storage for profile pictures, chat attachments, and status photos before relying on those features in production.

## Test

```powershell
npm test
```

The tests use temporary SQLite files and a mock SMS provider; they cover username-and-password registration without SMS, authentication, settings authorization, password and phone changes, connection requests, status privacy/viewers/expiry/deletion and upload validation, call authorization/signaling/state transitions/offline and timed-out missed calls, receipt transitions/privacy, private media access, media messages, and migration of existing message data. A PostgreSQL integration test is skipped unless `DATABASE_URL` is set; when configured, it tests account and session database roundtrips.

## Privacy and behavior

- Only accepted connections can view a conversation or send messages; this is enforced by the API.
- Accounts are created with a unique username and password, without phone or SMS verification. A profile picture is still required. Sign in with the username; existing accounts that have a phone number or email can continue using those identifiers too.
- Delivery is recorded when the recipient loads conversation history. Read receipts are recorded only for incoming messages the browser confirms are visible, and the sender sees read state only when the recipient has read receipts enabled. Users can change this preference in account settings.
- Phone changes require the current password and a fresh SMS verification. Password changes also require the current password; settings and preferences are available only to the signed-in account. Theme preference supports light, dark, and device settings.
- Registration requires a PNG, JPEG, or WebP profile picture (maximum 5 MB). Images are decoded and re-encoded as metadata-free WebP; animated or malformed images are rejected. Chat images have a 5 MB upload limit and are resized before private storage.
- Voice notes are limited to 10 MB and 120 seconds. Recording asks for microphone access only after the user presses Record; microphone access requires HTTPS or localhost. Browser recording formats supported by the server are WebM, Ogg, MP4 audio, WAV, and MP3.
- Media is stored using generated filenames outside the static web root. Authenticated users can view their own profile picture; conversation pictures and voice notes are served only to the two connected participants.
- Users can post text statuses, photos, or both. Status photos use the same 5 MB image validation, metadata-stripping WebP normalization, and private storage as chat images. Only the owner and currently connected users can see an active status or its photo; only the owner can see its viewer list. Statuses expire after 24 hours, are hidden immediately after expiry, and their database records, viewer entries, and photos are removed by an hourly cleanup sweep or on the next status access.
- Search results and connection lists contain usernames and IDs only. Phone numbers and email addresses are private to the account owner and are not returned by the API.
- Passwords are validated and hashed with bcrypt. Session cookies are HTTP-only, same-site, and backed by SQLite locally or PostgreSQL when `DATABASE_URL` is set. Mutating API requests require a signed, expiring CSRF token; repeated failed sign-ins are rate-limited per client IP.
- New and existing messages appear through short-interval polling; status feeds refresh every 15 seconds and when a tab becomes visible. No third-party realtime service is used.
- Voice and video calls are limited to accepted connections. The backend checks both participants for every call state and signaling request; incoming call polling and call history return only calls involving the signed-in user. Calls ring for 30 seconds and end with a connection error if WebRTC does not connect within 30 seconds after answer. Recipients with no recent presence heartbeat are logged as missed. Active-call presence expires after 45 seconds without a heartbeat. SDP and ICE signaling events are removed when calls end; call history is retained for up to 90 days.
