# Twiller 2.0 - Internship Features

These features are **extensions** of the original Twiller 2.0 training project.
Nothing in the original application was rewritten, deleted or replaced. The
stack is unchanged: **Next.js + React + TypeScript + Tailwind + Firebase Auth**
on the frontend, **Express + Mongoose + MongoDB** on the backend.

---

## Feature 6 - Forgot Password  (implemented)

### What the assignment asked for
- Recover the account using **email or phone**
- **Maximum one request per day**
- A **warning** when extra attempts are made
- A **password generator** producing **uppercase and lowercase English letters
  only** - no numbers, no special characters
- No plaintext passwords stored, no secrets exposed in production

### Key design decision: Firebase stays the only credential store
Twiller authenticates with **Firebase Auth**, and Firebase already ships
`sendPasswordResetEmail`, `verifyPasswordResetCode` and `confirmPasswordReset`.
Rather than inventing a competing password system, this feature **reuses those
exact APIs**. The backend owns the *workflow* (who is asking, are they allowed
to ask, did they prove ownership, is the new password legal) while Firebase
continues to own the actual credentials.

### The flow

| Step | Channel | What happens |
|---|---|---|
| 1. Identify | email **or** phone | `POST /auth/forgot-password/request` applies the once-per-day limit and records the attempt |
| 2. Verify | phone only | `POST /auth/forgot-password/verify-otp` checks the 6-digit SMS OTP and issues a single-use recovery token |
| 3. New password | both | The browser calls Firebase `confirmPasswordReset`; the backend validates the password policy |

> **Note on the phone channel.** Firebase can only *deliver* a reset by email,
> so phone recovery is a two-factor flow: the SMS OTP proves the user owns the
> phone, then Firebase's email reset applies the change. Every Twiller account
> already has an email (it is a required, unique field on the User model), so
> this always works. Adding the `firebase-admin` SDK later would allow a fully
> phone-only reset by replacing one branch in one route.

### Files added (backend)
| File | Purpose |
|---|---|
| `models/passwordreset.js` | New Mongoose model. Stores hashes only - never an OTP, token or password in the clear. Has a MongoDB **TTL index** so unused OTPs are physically deleted once expired. |
| `utils/istTime.js` | Reusable Asia/Kolkata helper. Will also serve Features 1, 2 and 5. Zero dependencies (`Intl` only). |
| `utils/otp.js` | Generates OTPs and secure tokens, hashes them with `node:crypto` SHA-256 + salt, compares with `timingSafeEqual`. |
| `utils/passwordGenerator.js` | Server-side authority for the letters-only rule, plus the salted fingerprint used for the audit trail. |
| `utils/mailer.js` | Email provider abstraction (`console` / `smtp`). |
| `utils/sms.js` | SMS provider abstraction (`console` / `twilio`). |
| `tests/feature6.test.js` | 38 automated assertions. |
| `tests/regression.test.js` | 23 assertions proving the **original** Twiller endpoints still work. |
| `tests/production-guard.test.js` | 4 assertions proving no secret leaks when `NODE_ENV=production`. |

### Files changed (backend)
| File | Change |
|---|---|
| `index.js` | **Added** 5 routes. Existing routes are unchanged (verified: 0 deletions in the diff). |
| `models/user.js` | **Added** optional `phone` field (default `""`, so existing documents are unaffected). |


### Files added (frontend)
| File | Purpose |
|---|---|
| `src/components/ForgotPassword.tsx` | Three-step modal built from Twiller's existing shadcn components and styling. |
| `src/lib/passwordGenerator.ts` | Mirror of the server generator so the user can see and copy the password. |

### Files changed (frontend)
| File | Change |
|---|---|
| `src/components/Authmodel.tsx` | Added a "Forgot password?" link (login mode only) that opens the new modal. |
| `src/context/firebase.tsx` | Re-exports Firebase's `sendPasswordResetEmail` / `confirmPasswordReset` / `verifyPasswordResetCode`. |

### API added
| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/forgot-password/request` | Start recovery. Enforces the daily limit. |
| POST | `/auth/forgot-password/verify-otp` | Verify the SMS OTP, issue a recovery token. |
| POST | `/auth/forgot-password/complete` | Server-side password-policy gate + audit record. |
| POST | `/auth/forgot-password/validate-password` | Advisory check used by the Generate button. |
| GET | `/auth/forgot-password/history` | Audit trail; never returns secrets. |

### Database changes
- **New collection:** `passwordresets`
- **New field:** `users.phone` (optional string, default `""`)
- No migration script is needed - MongoDB is schemaless and both changes are
  purely additive.

### Security measures
1. `devCode` (the OTP) is attached to API responses **only** when
   `NODE_ENV !== "production"`, verified automatically by
   `tests/production-guard.test.js`.
2. OTPs and recovery tokens are stored **hashed**; both hashes are destroyed the
   moment they are used (single use).
3. Passwords are **never stored**. Only a salted SHA-256 fingerprint is kept.
4. Unknown accounts return a **generic 200** so the endpoint cannot be used to
   discover which emails or phone numbers are registered.
5. Rate limiting per IP (5 requests / 15 minutes) plus a per-user once-per-IST-day limit.
6. OTP brute-force cap of 5 attempts, enforced server-side.
7. `.env` files are git-ignored; only `.env.example` is committed.

### How to run the tests
```bash
# terminal 1 - backend
cd backend
node index.js

# terminal 2 - tests
cd backend
npm test                            # Feature 6         (38 assertions)
node tests/regression.test.js      # original Twiller  (23 assertions)
node tests/production-guard.test.js # production safety  (4 assertions)
```
> Start a **fresh** backend before running `npm test` - the per-IP rate limiter
> is held in memory, so a long-running process changes the last test's result.

### Known limitation
The phone channel completes the change through Firebase's email reset. This is
documented above and is a deliberate design choice, not an oversight.

---
