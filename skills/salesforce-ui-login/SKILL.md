---
name: salesforce-ui-login
description: Use this when you need the Salesforce web UI in a sandbox (Lightning pages, list views, Setup screens, anything the API cannot show) in a Kernel browser. Signs in as the project's non-admin UI test user from the SF_SBX_UITEST_* credential using a JWT, frontdoor and, if asked, a TOTP code. Never uses the admin login.
scope: org
---

# Salesforce UI login (UI test user, JWT + frontdoor + TOTP)

Each project that needs the Salesforce UI gets its own UI test user credential. When it is granted to the project, these env vars are set in your sandbox:

| Var                          | What it is                                |
| ---------------------------- | ----------------------------------------- |
| `SF_SBX_UITEST_NAME`         | Sandbox label, for messages only          |
| `SF_SBX_UITEST_CLIENT_ID`    | Connected app consumer key                |
| `SF_SBX_UITEST_USERNAME`     | The UI test user's username               |
| `SF_SBX_UITEST_INSTANCE_URL` | The sandbox My Domain URL                 |
| `SF_SBX_UITEST_JWT_KEY_B64`  | Base64 of the JWT private key (secret)    |
| `SF_SBX_UITEST_TOTP_SECRET`  | The user's authenticator app key (secret) |

Optional: `SF_SBX_UITEST_AUDIENCE_URL` overrides the JWT audience. The script picks `https://test.salesforce.com` for `*.sandbox.my.salesforce.com` hosts and `https://login.salesforce.com` otherwise.

## Rules

1. Use only the `SF_SBX_UITEST_*` vars for UI work. Never use the admin `SF_SBX_*` vars, `sf-auth-ensure` or `sf org open` to get into the UI. The admin login is for the API.
2. If any `SF_SBX_UITEST_*` var is missing, ask Robert once in the main chat that this project needs a UI test user credential, then stop. Do not look for another login.
3. Production UI is out of scope. If asked, say it needs a separate decision.
4. Never print, log, store or post the JWT key, the TOTP key, a TOTP code, an access token or the frontdoor URL. The script keeps them out of its output. Do not add debug prints that show them.
5. Never screenshot a login, verification, passkey or authenticator setup page. Screenshots are fine once Lightning has loaded.
6. TOTP: one fresh code, and at most one retry in the next 30 second window. If both fail, stop and tell Robert. Ten bad codes lock the user out for an hour.
7. Never type a password. If Salesforce shows a login page, stop.

## Steps

1. Check the vars without printing values:

   ```bash
   for v in NAME CLIENT_ID USERNAME INSTANCE_URL JWT_KEY_B64 TOTP_SECRET; do
     [ -n "$(printenv SF_SBX_UITEST_$v)" ] && echo "SF_SBX_UITEST_$v set" || echo "SF_SBX_UITEST_$v MISSING"
   done
   ```

   If anything is missing, follow rule 2.

2. Create a Kernel browser as the browse skill describes (`skills/browse/providers/kernel.md`). In a channel or group, leave out the profile. You need `CDP_URL` and `KERNEL_SID`. Do not post `LIVE_VIEW` in a channel.

3. Sign in and open the page you need:

   ```bash
   CDP_URL="$CDP_URL" node skills/salesforce-ui-login/scripts/sf-ui-login.mjs \
     --path "/lightning/o/Project__c/list?filterName=All" --report
   ```

   Options:
   - `--path` is where to land after sign in. Default `/lightning/page/home`. It must start with `/`.
   - `--report` reads the "N items" text and counts table rows on list views.
   - `--screenshot /tmp/page.png` saves a screenshot after Lightning loads.
   - `--timeout 90` sets the wait in seconds (default 60).
   - `--self-test` checks the built in TOTP code against RFC 6238 vectors, with no network use.

   The script needs Node 22 or newer. It has no dependencies, so there is nothing to install. It prints hosts and paths only, then a last line `RESULT {...}` with `ok`, `page`, `totpChallenge`, `totpAttempts` and, with `--report`, `items` and `rows`. It leaves the browser open and signed in, so you can keep driving it over CDP.

4. Act on the exit code:

   | Code | Meaning                                 | What to do                                             |
   | ---- | --------------------------------------- | ------------------------------------------------------ |
   | 0    | Signed in, target page open             | Carry on in the same browser                           |
   | 2    | `CDP_URL` missing or bad `--path`       | Fix and re-run                                         |
   | 3    | `SF_SBX_UITEST_*` vars missing          | Rule 2: ask Robert once, stop                          |
   | 4    | Salesforce wants MFA registration       | Stop and tell Robert. Registration is an operator task |
   | 5    | JWT failed, wrong user, or a login page | Stop and report the message. Do not retry in a loop    |
   | 6    | TOTP code rejected twice                | Stop. Tell Robert. Do not try again soon               |
   | 7    | Anything else (timeout, page not found) | Report the message; one re-run is fine                 |

5. Sessions last a while, but if a later page bounces you to a login page, re-run step 3 in the same browser. Do not try to log in by hand.

6. When finished, delete the browser:

   ```bash
   curl -fsS -X DELETE "https://api.onkernel.com/browsers/$KERNEL_SID" -H "Authorization: Bearer $KERNEL_API_KEY"
   ```

## How it works

1. Signs an RS256 JWT for the test user and swaps it for an access token at `<instance>/services/oauth2/token`.
2. Checks with `/services/oauth2/userinfo` that the token really belongs to `SF_SBX_UITEST_USERNAME`.
3. Opens `/secur/frontdoor.jsp` in the Kernel browser over CDP, so the token never appears in shell history or output.
4. Watches the page. If Salesforce asks for a verification code, it types a TOTP code generated from `SF_SBX_UITEST_TOTP_SECRET`, waiting for a fresh window if fewer than 12 seconds remain.
5. Makes sure the `--path` page is open, then reports.

## How the MFA pages look

Registered test users usually go straight through frontdoor with no MFA page. For reference, this is what Salesforce shows a user who has not registered yet. The script stops at it with exit 4.

1. "Create a Passkey" (`AddPasskeyUi`). It is shown once. The way out is the small "Choose another verification method" link (element `chRegL`).
2. "Choose a Verification Method" with three buttons: Salesforce Authenticator, One-Time Password App, and Security Key.
3. After picking One-Time Password App: "Connect an Authenticator App" with a QR code, an "I Can't Scan the QR Code" link that shows the key in place, a code field `input#t` and a Connect button.

Never screenshot these pages; the QR code and key are secrets. A user with privileged permissions (for example Modify All Data) may not be offered the One-Time Password App option at all, so UI test users should stay non-admin.

## Lightning gotchas

1. List view tables live inside shadow DOM. `document.querySelectorAll('table')` finds nothing. Walk shadow roots (the script does this for `--report`) or read the "N items" text.
2. Open list views with `filterName=All`. "Recently Viewed" is empty for a new test user.
3. "All" can still have filters (for example on Status), so 0 items may be a filter, not a permission problem. Check the filter panel or compare with an API count before reporting a problem.
4. You do not need npm, Playwright or the sf CLI for this. Node's built in `fetch` and `WebSocket` are enough.

## Operator note: adding a UI test user for a new sandbox

This needs Robert's approval and is done by an operator, not by the agent in a project. In short: create a non-admin user with the needed permissions, allow it on the JWT connected app, register a One-Time Password App for it once, then store the six `SF_SBX_UITEST_*` fields as a keychain credential and grant it to the project. Do not automate this from a project conversation.
