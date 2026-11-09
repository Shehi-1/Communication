# Two Friends Chat

A small private messaging app built with Node.js, Express, SQLite, and plain browser JavaScript. It supports phone-verified accounts, friend connections, one-to-one messaging, private media, delivery/read indicators, and account settings. SQLite stores accounts, connection requests, message metadata, and sessions. Private profile pictures, shared images, and voice notes are stored separately on disk. Passwords are hashed with bcrypt; the app does not return phone numbers, email addresses, or password hashes through its public API.

## Requirements

- Node.js 22.5 or newer (the app uses Node's built-in `node:sqlite` module)
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

Open <http://localhost:3000>. In production, set `NODE_ENV=production` over HTTPS so session cookies are marked `Secure`. If HTTPS terminates at a trusted reverse proxy, also set `TRUST_PROXY=1`.

## Test

```powershell
npm test
```

The tests use temporary SQLite files and a mock SMS provider; they cover phone verification and its expiry/attempt/resend limits, authentication, settings authorization, password and phone changes, connection requests, receipt transitions/privacy, upload validation, private media access, media messages, and migration of existing message data.

## Privacy and behavior

- Only accepted connections can view a conversation or send messages; this is enforced by the API.
- New accounts are created only after a normalized international phone number is verified by SMS. Codes are HMAC-hashed at rest, expire after 10 minutes, allow at most five attempts, and are limited to three sends per 15-minute window with a 60-second resend delay. Legacy email accounts can continue signing in with their existing email and password.
- Delivery is recorded when the recipient loads conversation history. Read receipts are recorded only for incoming messages the browser confirms are visible, and the sender sees read state only when the recipient has read receipts enabled. Users can change this preference in account settings.
- Phone changes require the current password and a fresh SMS verification. Password changes also require the current password; settings and preferences are available only to the signed-in account. Theme preference supports light, dark, and device settings.
- Registration requires a PNG, JPEG, or WebP profile picture (maximum 5 MB). Images are decoded and re-encoded as metadata-free WebP; animated or malformed images are rejected. Chat images have a 5 MB upload limit and are resized before private storage.
- Voice notes are limited to 10 MB and 120 seconds. Recording asks for microphone access only after the user presses Record; microphone access requires HTTPS or localhost. Browser recording formats supported by the server are WebM, Ogg, MP4 audio, WAV, and MP3.
- Media is stored using generated filenames outside the static web root. Authenticated users can view their own profile picture; conversation pictures and voice notes are served only to the two connected participants.
- Search results and connection lists contain usernames and IDs only. Phone numbers and email addresses are private to the account owner and are not returned by the API.
- Passwords are validated and hashed with bcrypt. Session cookies are HTTP-only, same-site, and backed by SQLite. Mutating API requests require a session CSRF token, and repeated failed sign-ins are rate-limited per client IP.
- New and existing messages appear through short-interval polling; no third-party realtime service is used.
