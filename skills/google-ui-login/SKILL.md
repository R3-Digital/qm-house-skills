---
name: google-ui-login
description: Google login for testing. Use this when you test an R3 web app that uses "Sign in with Google" in a Kernel browser. Signs in as the dedicated Google test account from the GOOGLE_UITEST_* org credentials (email, password and, if Google asks, an authenticator code), accepts the app's consent screen and reports the landing URL. Never uses a personal Google account.
scope: org
---

# Google login for testing (test account, Kernel browser)

When you test a web app that signs people in with Google, sign in as the dedicated Google test account, never as a real person. These org env vars hold its login:

| Var                         | What it is                                   |
| --------------------------- | -------------------------------------------- |
| `GOOGLE_UITEST_USERNAME`    | The test account email                       |
| `GOOGLE_UITEST_PASSWORD`    | Its password (secret)                        |
| `GOOGLE_UITEST_TOTP_SECRET` | Its authenticator app key, base32 (secret)   |

## Rules

1. Use only the `GOOGLE_UITEST_*` vars. Never sign in with any other Google account, and never use a Kernel profile for this (a profile can already be signed in to someone's own Google account).
2. If any `GOOGLE_UITEST_*` var is missing, ask the user once in the main chat that this session needs the Google test account credentials, then stop. Do not look for another login.
3. Never print, log, store or post the password, the TOTP key or a TOTP code. The script keeps them out of its output and masks them. Do not add debug prints that show them, and never run with `set -x`.
4. Never screenshot a Google sign in, verification or consent page. Screenshots are fine once the app has loaded.
5. TOTP: one fresh code, and at most one retry in the next 30 second window. If both fail, stop and report.
6. If Google asks for something the script cannot do (a phone prompt, SMS code, passkey, security key, captcha or another "Verify it's you" step), stop and report it. Do not click through by hand or retry in a loop; repeated attempts can get the account locked.
7. Do not use this for Salesforce. Use salesforce-ui-login for that.

## Steps

1. Check the vars without printing values:

   ```bash
   for v in USERNAME PASSWORD TOTP_SECRET; do
     [ -n "$(printenv GOOGLE_UITEST_$v)" ] && echo "GOOGLE_UITEST_$v set" || echo "GOOGLE_UITEST_$v MISSING"
   done
   ```

   If anything is missing, follow rule 2.

2. Create a fresh Kernel browser as the browse skill describes (`skills/browse/providers/kernel.md`), always without a profile. You need `CDP_URL` and `KERNEL_SID`. Do not post the live view link in a channel.

   ```bash
   CREATE=$(curl -fsS -X POST https://api.onkernel.com/browsers \
     -H "Authorization: Bearer $KERNEL_API_KEY" -H 'content-type: application/json' \
     -d '{"stealth":true,"headless":false,"timeout_seconds":1800}')
   CDP_URL=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('cdp_ws_url',''))")
   KERNEL_SID=$(printf '%s' "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('session_id',''))")
   ```

3. Sign in. Pass the app's login page, or the Google OAuth URL the app redirects to:

   ```bash
   CDP_URL="$CDP_URL" node skills/google-ui-login/scripts/google-ui-login.mjs \
     --url "https://app.example.com/login"
   ```

   Options:
   - `--url` (required) is where to start. On an app page the script clicks the "Sign in with Google" or "Continue with Google" button, including Google's own button iframe, and follows a sign in popup if the app opens one.
   - `--click-selector "CSS"` clicks this element instead, when the app's button has unusual text.
   - `--expect "REGEX"` only counts it as done when the landing URL matches, for example `--expect "app\.example\.com/dashboard"`.
   - `--timeout 120` sets the wait in seconds (default 120).
   - `--screenshot /tmp/app.png` saves a screenshot of the landing page after sign in.
   - `--self-test` checks the built in TOTP code against RFC 6238 vectors, with no network use.

   The script needs Node 22 or newer and has no dependencies. It handles the account chooser (it picks the test account or "Use another account", never another tile), the email step, the password step, the authenticator code step if Google shows one (choosing "Google Authenticator" from "Try another way" if needed), simple interstitials such as "Not now" on a passkey offer, and the app's consent screen ("Continue" or "Allow"). It then opens myaccount.google.com in a short lived tab to confirm which Google account is signed in.

   It prints hosts and paths only, then a last line `RESULT {...}` with `ok`, `landing`, `title`, `totpChallenge`, `totpAttempts`, `consentClicked` and `identityConfirmed` (true, false or null if it could not tell). It leaves the browser open and signed in, so you can keep driving it over CDP.

4. Act on the exit code:

   | Code | Meaning                                                  | What to do                                                     |
   | ---- | -------------------------------------------------------- | -------------------------------------------------------------- |
   | 0    | Signed in, app page open                                 | Report the landing URL and carry on in the same browser        |
   | 2    | `CDP_URL` missing or bad `--url`                         | Fix and re-run                                                 |
   | 3    | `GOOGLE_UITEST_*` vars missing or malformed              | Rule 2: ask the user once, stop                                |
   | 4    | A challenge the script cannot do, or an OAuth error page | Stop and report the message. Do not retry in a loop            |
   | 5    | Wrong password, unknown account, or wrong account        | Stop and report. Delete the browser. Do not retry              |
   | 6    | Authenticator code rejected twice                        | Stop and report. Do not try again soon                         |
   | 7    | Anything else (timeout, no Google button found)          | Report the message; one re-run, or try `--click-selector`      |

5. When finished, delete the browser:

   ```bash
   curl -fsS -X DELETE "https://api.onkernel.com/browsers/$KERNEL_SID" -H "Authorization: Bearer $KERNEL_API_KEY"
   ```

## How it works

1. Connects to the Kernel browser over CDP (the same way salesforce-ui-login does) and opens `--url`.
2. If the page is not a Google sign in page, it clicks the app's Google button and waits for Google, in the same tab or a popup.
3. On Google it reads the page state every second and does one step at a time: account chooser, email, password, authenticator code, interstitial, consent.
4. Values are typed with CDP `Input.insertText`, so they never appear in shell history, arguments or output.
5. The TOTP code is made in the script (RFC 6238, HMAC-SHA1, 6 digits, 30 seconds) only when Google shows the authenticator step. 2-Step Verification may be off for the test account, in which case this step never happens.
6. Once the tab leaves Google and the URL has settled, it confirms the signed in account and reports the landing URL.

## Troubleshooting

1. Vars missing even though the credentials exist: QM only delivers org credentials to sessions where everyone present is internal (all-internal sessions). In a session with an external person, a guest or an external Slack channel member, the `GOOGLE_UITEST_*` vars are not set. Follow rule 2; do not try to fetch them another way.
2. "Google rejected this browser as not secure": make sure the Kernel browser was created with `"stealth":true` and `"headless":false`. If it still happens, stop and report.
3. "No Google sign in button found": pass the app's Google OAuth URL as `--url`, or use `--click-selector`.
4. OAuth error page (access blocked, `redirect_uri_mismatch`, `org_internal`): this is an app or OAuth client setup problem, not a login problem. Report it.
5. Exit 4 with a phone, passkey or "Verify it's you" step: Google wants extra proof for this sign in. An admin of the test account must sort this out; the script will not work around it.
6. `identityConfirmed` null: the landing app did not keep a Google session the script could check. The sign in still went through the test account, since the script only ever types the `GOOGLE_UITEST_*` login in a fresh browser.
