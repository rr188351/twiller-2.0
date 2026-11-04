# Twiller 2.0 — Throwaway SMTP egress probe (Vercel only)

> **Branch:** `test/serverless-probe` · **Scope:** probe only · **Deleted after testing**

## What it does

Answers exactly one question, from **inside a deployed Vercel Function**:

> Can this runtime open an outbound TCP connection to `smtp.gmail.com:465` / `:587`,
> and if so, does the SMTP handshake + AUTH succeed?

| Does | Does NOT |
|---|---|
| `net.connect()` to 465 and 587, with an 8 s budget each | **Never sends an email** (`sendMail` is never imported) |
| `nodemailer.verify()` — handshake + AUTH only | No MongoDB, no Firebase, no app imports |
| Reports ports, timings, error **codes**, a verdict | Never logs or returns a password/token |
| Requires `PROBE_KEY`, else 404 | Does not touch Render, `main`, or the frontend |

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

## Test

```powershell
curl.exe -s "https://<project>.vercel.app/api/smtp-probe" -H "x-probe-key: $key"
```

### Reading the result

| `reachablePorts` | `verify` | Meaning | Action |
|---|---|---|---|
| `[]` | skipped | **Egress blocked** | Stop. Migration cannot deliver email. |
| `[465]`/`[587]` | `attempted:false` (no creds) | Port open, handshake untested | Add SMTP creds and re-run. |
| any | `ok:true` | **Egress works + AUTH accepted** | Proceed to the wrapped-app test. |
| any | `ok:false` + `code` | Port open, AUTH/policy failed | Report the code; fix credentials/policy. |

Also record `elapsedMs` and compare it against the platform's function timeout:
even if egress works, a send that outlives the function is still a failure.

## Cleanup (required — this must not linger)

```powershell
vercel remove twiller-smtp-probe     # delete the deployment/project
```

Then: revoke the App Password in Google, delete this branch, and delete the
`serverless-probe/` folder. Confirm `git status` on `main` is unchanged.
