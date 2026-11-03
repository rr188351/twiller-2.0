# Twiller 2.0 — Deployment Guide

> No secrets belong in this file or in git. Every value below is an
> environment-variable **name**; set the real values in the hosting
> provider's dashboard.

The project is a monorepo-style repo:

| Path | What | Host |
|---|---|---|
| `twiller/` | Next.js 15 (React 19, TypeScript, Tailwind) frontend | **Netlify** |
| `backend/` | Express 5 + Mongoose (MongoDB) API, Firebase Admin auth, multer uploads | **Node host** (Render / Railway / Fly / etc.) |

The backend is a long-running Express server with **persistent file uploads**
and an optional `ffprobe` binary, so it **cannot** be hosted as a Netlify
Function. It needs its own Node service.

---

## 1. Deploy the backend (do this first — the frontend needs its URL)

1. Create a Node web service pointing at this repo, **root directory `backend`**.
2. Build: none (plain Node). Start command: `npm start` (runs `node index.js`).
3. Attach a **persistent disk** and point the upload dirs at it, e.g.
   `AUDIO_UPLOAD_DIR=/var/data/uploads`, `IMAGE_UPLOAD_DIR=/var/data/uploads/images`.
   (The default container filesystem is ephemeral — uploads would vanish.)
4. Install `ffmpeg`/`ffprobe` on the host, **or** set `FFPROBE_PATH` to its
   absolute path. Without it, `POST /audio/upload` answers `503`.
5. Set environment variables (see `backend/.env.example` for the full list):
   - Required: `MONOGDB_URL` (mentor-provided MongoDB URI — **not** localhost),
     `NODE_ENV=production`, `FIREBASE_PROJECT_ID`,
     `FIREBASE_SERVICE_ACCOUNT_JSON` **or**
     `FIREBASE_SERVICE_ACCOUNT_PATH`/`GOOGLE_APPLICATION_CREDENTIALS`.
   - Recommended: `CORS_ORIGINS=https://<your-netlify-site>`,
     `OTP_DELIVERY`, `PAYMENT_MODE`, `SMTP_*`, `SMS_*`, `OTP_TTL_MINUTES`, …
6. Verify: `GET /` → `Twiller backend is running successfully`;
   `GET /plans` → JSON plans; an authenticated route without a token → `401`.

## 2. Deploy the frontend (Netlify)

1. Import this repo into Netlify. `netlify.toml` already sets
   `base = "twiller"`, `command = "npm run build"`, `publish = ".next"` and the
   `@netlify/plugin-nextjs` runtime.
2. Netlify → **Site settings → Environment variables** (never in source):
   - `NEXT_PUBLIC_BACKEND_URL` = the **HTTPS** backend URL from step 1
     (e.g. `https://twiller-backend.onrender.com`). It must NOT be `localhost`.
   - `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`,
     `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`,
     `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID`.
     These must belong to the **same Firebase project** the backend verifies
     (`FIREBASE_PROJECT_ID`), or secured routes answer `401 auth-invalid`.
3. Deploy, then add the Netlify URL to the backend's `CORS_ORIGINS` and redeploy
   the backend.
4. In Firebase Console → Authentication → Settings → **Authorized domains**,
   add the Netlify domain (needed for Google popup + reCAPTCHA).

## 3. Post-deploy checks

- Home page loads; language can be switched **before** login and survives refresh.
- Email/Google sign-in works; secured calls return data (no `401`).
- Image upload returns a `/uploads/images/...` URL that renders.
- Audio upload (inside 14:00–19:00 IST) returns a `/uploads/...` URL that plays.
- No browser console error mentions `localhost`.

## 4. Language-switch OTP — required configuration

The assignment fixes the verification channel **per locale** (implemented in
`backend/index.js` → `languageOtpChannel()`); this was deliberately left
unchanged:

| Locale | Channel | Configured by |
|---|---|---|
| `fr` (French) | **email** OTP | `OTP_DELIVERY=smtp` + `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` |
| `en`, `hi`, `es`, `pt`, `zh` | **SMS** OTP | `SMS_DELIVERY=twilio` + `SMS_ACCOUNT_SID`, `SMS_AUTH_TOKEN`, `SMS_FROM` |

**Current state of this repo:** the five SMS locales run on the development
**mock** — the code is printed to the backend console
(`MOCK SMS (no SMS was sent)`), the API returns `deliveryStatus: "mock"`, and
**no real SMS is sent**. This is a configuration gap, not a code defect: no
`SMS_*` value is set in `backend/.env`.

**Two prerequisites for the five SMS locales to work end-to-end**
1. Set `SMS_DELIVERY=twilio` **plus** `SMS_ACCOUNT_SID`, `SMS_AUTH_TOKEN`,
   `SMS_FROM` on the backend (server-side secrets — never `NEXT_PUBLIC_*`,
   never committed), then restart the backend.
2. The signed-in user must have a **phone number saved on their profile**,
   otherwise `/auth/language/otp/request` answers `422 phone-setup-required`.
   Optional: `SMS_DEFAULT_COUNTRY_CODE` (default `91`) is applied to short
   local numbers before they are formatted to E.164.

Until then only French can be verified for real. The mock is **disabled in
production**, so an unconfigured production deploy fails safely with
`502 delivery-failed` rather than reporting a message that was never sent.

## 5. Provider configuration checklist (Render)

Set these on the backend service and then **redeploy** — environment variables are
read when the process starts.

**SMS / Twilio** (required for `en`, `hi`, `es`, `pt`, `zh`)
- `SMS_DELIVERY=twilio`
- `SMS_ACCOUNT_SID`
- `SMS_AUTH_TOKEN`
- `SMS_FROM` (an E.164 Twilio sender number, e.g. `+1...`)
- optional `SMS_DEFAULT_COUNTRY_CODE` (default `91`), applied to short local numbers

**Email / SMTP** (required for `fr`)
- `OTP_DELIVERY=smtp`
- `SMTP_HOST`
- `SMTP_PORT` (the repo example uses `465`)
- `SMTP_SECURE` (`true` for implicit TLS on 465, `false` for 587 + STARTTLS)
- `SMTP_USER`
- `SMTP_PASS`
- `MAIL_FROM` (e.g. `Twiller <no-reply@your-domain>`)

**Fail-closed behaviour — delivery is never faked**
- `NODE_ENV=production` and the email provider is unset/`console` → the email OTP
  endpoint answers **`502 delivery-failed`** (`provider: "unconfigured"` or
  `"console"`) and the message names the missing `SMTP_*` variables.
- `NODE_ENV=production`, `OTP_DELIVERY=smtp`, but a `SMTP_*` value is missing →
  **`502 delivery-failed`** naming the missing variables.
- SMS locales with `SMS_DELIVERY` unset in production → **`502 delivery-failed`**
  (`provider: "unconfigured"`) naming the Twilio variables.
- The development console mock is **never** used in production, so an
  unconfigured provider can no longer look like "the code was sent".

**Database**
- `MONOGDB_URL` (the name the code reads; `MONGODB_URL` is accepted as a fallback)
- optional `MONGODB_DB=twiller` to pin the database explicitly (see
  `backend/utils/dbName.js`). Both `test` and `twiller` data are left untouched.

## Notes / limitations

- Audio uploads are restricted to **14:00–19:00 IST** by design;
  `AUDIO_UPLOAD_FORCE_WINDOW_OPEN=true` bypasses this for demos/tests only.
- `CORS_ORIGINS` empty = permissive (development default). Set it in production.
- The Firebase web config keys (`NEXT_PUBLIC_*`) are **not** secrets; the
  service-account JSON **is** — keep it server-side only.
