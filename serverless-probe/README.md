# Twiller 2.0 — Throwaway SMTP egress probe (Vercel only)

> **Branch:** `test/serverless-probe` · **Scope:** probe only · **Deleted after testing**

## What it does

Answers **three separate questions** from inside a deployed Vercel Function, each
reported in its own JSON block so the phases can never be confused:

| Block | Question | How |
|---|---|---|
| `connectivity` | Can this runtime open an outbound **TCP** connection to 465 / 587? | `net.connect()`, 8 s budget each |
| `tls` | Does the **TLS** layer really run on 465? | raw `tls.connect()` — reports protocol, cipher, certificate authorization and the `220` SMTP greeting |
| `authentication` | Do the credentials **authenticate**? | `nodemailer.verify()` on **every** reachable port (implicit TLS on 465, STARTTLS **enforced** on 587) |
| `send` | (optional) Did ONE requested message go out? | `sendOne()`, reachable only through the triple gate below |

| Never | Always |
|---|---|
| Sends on deploy, startup or a plain probe request | Requires `PROBE_KEY`, else **404** |
| Sends to a recipient that is not allow-listed | Returns error **codes** + sanitized text only |
| Sends without an explicit `confirm` step | Strips stack traces, credentials and the username |
| Touches Mongo / Firebase / app code / Render / `main` | Bounds every step with a timeout + a 45 s handler budget |

**Why this order:** Render's Free plan blocks outbound SMTP, which is why the
Language/Audio OTP emails never leave the backend. Vercel's and Netlify's docs do
**not** document SMTP egress, so the only reliable answer comes from a deployed
function. If this probe says *blocked*, the full migration cannot fix email — and
we will have spent 15 minutes instead of days.

## Files (self-contained; nothing else in the repo imports them)

```
serverless-probe/
  api/smtp-probe.mjs   the probe endpoint
  package.json         nodemailer only (used solely for verify())
  vercel.json          maxDuration: 60
  README.md            this file
```

## Deploy (new project — your Render app and `main` are untouched)

```powershell
# 0. Generate a strong temporary key LOCALLY. Never paste it into chat or commit it.
$key = -join (48..57 + 65..90 + 97..122 | Get-Random -Count 48 | ForEach-Object { [char]$_ })
$key

# 1. CLI (once)
npm i -g vercel
vercel login

# 2. A DEDICATED, revocable Gmail App Password for this probe:
#    Google Account -> Security -> 2-Step Verification -> App passwords
#    (Do NOT reuse the production SMTP password.)

# 3. From the probe folder
cd serverless-probe
vercel                              # choose "Create a new project" (e.g. twiller-smtp-probe)
vercel env add PROBE_KEY production # paste $key
vercel env add SMTP_USER production # the Gmail address
vercel env add SMTP_PASS production # the APP PASSWORD (never the account password)
vercel --prod                       # deploy ONLY this folder
```

**Before deploying, confirm the cost/plan (do not assume):** Vercel Dashboard →
your account → **Settings → Plan** (Hobby vs Pro), and confirm the new project is
listed with **$0** usage. Already having your frontend on Vercel implies an
existing plan; a second project on Hobby adds no per-project charge — *verify it
in the dashboard*. Hobby's documented limits include max duration 300 s, 4.5 MB
request body, 2 GB memory, and it is intended for **non-commercial** use.

## Test 1 — read-only probe (sends nothing)

```powershell
curl.exe -s "https://twiller-smtp-probe.vercel.app/api/smtp-probe" -H "x-probe-key: $key"
```

Answer the three phases **independently**:

| Block | Field | Meaning |
|---|---|---|
| `connectivity` | `reachablePorts: []` | **TCP blocked** — stop; porting the app cannot fix email |
| `tls` | `handshakeOk: true` | TLS layer works: read `protocol` and `cipher` |
| `tls` | `handshakeOk: false` + `error` | TLS failed — report the code |
| `authentication` | `configured: false` | Credentials not set; AUTH was not tested |
| `authentication` | `ok: true`, `okPorts: [465]` | **Creds accepted** on that port |
| `authentication` | `ok: false` + `results[].code` | e.g. `EAUTH` → report the code, fix credentials/policy |

Then compare `elapsedMs` with the platform's function timeout: a send that
outlives the function is still a failure even when the ports are open.

## Test 2 — authentication with real credentials

Enter the secrets through the **Vercel dashboard or CLI only** (never in a URL,
never in chat). A dedicated, **revocable** Gmail App Password is required —
Google Account → Security → 2-Step Verification → App passwords — and it must
**not** be the production password:

```powershell
vercel env add SMTP_USER production   # the Gmail address
vercel env add SMTP_PASS production   # the APP PASSWORD (hidden input)
vercel --prod
```

`verify()` opens the session, negotiates TLS (STARTTLS is mandatory on 587),
authenticates and disconnects. It sends no message. Re-run **Test 1** and read
`authentication`.

## Test 3 — ONE real message, with an explicit confirmation step

This is deliberately awkward: it needs **three independent switches** plus a
confirmation, so it can never fire by accident.

1. Enable sending (dashboard → Settings → Environment Variables, or CLI):
   ```powershell
   vercel env add PROBE_SEND_ENABLED production          # value: true
   vercel env add PROBE_ALLOWED_RECIPIENTS production    # value: you@yourdomain.tld
   vercel --prod
   ```
2. Send exactly one message to **your own** allow-listed address. `confirm` must
   equal `to` exactly — that is the separate explicit confirmation:
   ```powershell
   curl.exe -s -X POST "https://twiller-smtp-probe.vercel.app/api/smtp-probe?action=send" `
     -H "x-probe-key: $key" -H "content-type: application/json" `
     -d '{"to":"you@yourdomain.tld","confirm":"you@yourdomain.tld"}'
   ```
3. Read `send`: `sentRealEmail: true` with `accepted`/`messageId` means the host
   accepted it — **still confirm the message actually arrived in the inbox**
   before calling delivery verified.

| Refusal code | HTTP | Meaning |
|---|---|---|
| `send-disabled` | 403 | `PROBE_SEND_ENABLED` is not `true` (the default) |
| `no-allowlist` | 403 | `PROBE_ALLOWED_RECIPIENTS` is empty |
| `invalid-recipient` | 400 | not exactly one plain address |
| `recipient-not-allowed` | 403 | address is not in the allow-list |
| `confirmation-required` | 400 | `confirm` ≠ `to` |

`GET`, `POST` without `action=send`, and any unknown action **never send**.

## Cleanup (required — this must not linger)

```powershell
# 1. Remove the probe's secrets and switches first
vercel env rm SMTP_PASS production
vercel env rm SMTP_USER production
vercel env rm PROBE_SEND_ENABLED production
vercel env rm PROBE_ALLOWED_RECIPIENTS production
vercel env rm PROBE_KEY production

# 2. Delete the project/deployment
vercel remove twiller-smtp-probe
```

Then, in this order:

3. **Revoke the Gmail App Password** in Google (Account → Security → App passwords).
4. Delete the branch: `git push origin --delete test/serverless-probe`
5. Delete the `serverless-probe/` folder.
6. Confirm `git status` on `main` is unchanged and Render still runs the same commit.

## Response shape (changed in this revision)

The old deployment returned `ports` / `reachablePorts` / `verify` at the top
level. The current version groups them as **`connectivity`** (TCP),
**`tls`** (handshake evidence) and **`authentication`** (per-port AUTH), plus
**`send`** — so a TCP success can never be mistaken for an authenticated one.
Top-level `ok`, `sentRealEmail`, `verdict`, `runtime` and `elapsedMs` remain.
