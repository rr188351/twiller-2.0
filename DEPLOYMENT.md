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
     `OTP_DELIVERY`, `PAYMENT_MODE`, `SMTP_*`, `OTP_TTL_MINUTES`, …
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
- Switching language sends an **email** OTP for every locale (check the inbox).

## 4. OTP delivery — EMAIL ONLY

Twiller sends **every** one-time code by email: language switching, sign-in
verification and password recovery. The mobile/SMS channel has been removed from
the product (`backend/utils/sms.js` and all `SMS_*` variables are gone), so there
is no locale-to-channel mapping and no SMS/Twilio configuration.

| Flow | Destination |
|---|---|
| Language switch (any locale: `fr`, `en`, `hi`, `es`, `pt`, `zh`) | the account's email address |
| Chrome sign-in code | the account's email address |
| Audio-upload code | the account's email address |
| Password recovery | the account's email address (emailed OTP, then Firebase's reset email) |

**No phone number is ever required** to send or verify a code.

## 5. Provider configuration checklist (Render)

Set these on the backend service and then **redeploy** — environment variables are
read when the process starts.

**Email / SMTP (REQUIRED in production)**
- `OTP_DELIVERY=smtp`
- `SMTP_HOST`
- `SMTP_PORT` (the repo example uses `465`)
- `SMTP_SECURE` (`true` for implicit TLS on 465, `false` for 587 + STARTTLS)
- `SMTP_USER`
- `SMTP_PASS`
- `MAIL_FROM` (e.g. `Twiller <no-reply@your-domain>`)

**Fail-closed behaviour — delivery is never faked**
- `NODE_ENV=production` and the email provider is unset/`console` → the OTP
  endpoints answer **`502 delivery-failed`** (`provider: "unconfigured"` or
  `"console"`) and the message names the missing `SMTP_*` variables.
- `NODE_ENV=production`, `OTP_DELIVERY=smtp`, but a `SMTP_*` value is missing →
  **`502 delivery-failed`** naming the missing variables.
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
