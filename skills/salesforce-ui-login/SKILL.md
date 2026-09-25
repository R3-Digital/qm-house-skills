---
name: salesforce-ui-login
description: Use this when you need the Salesforce web UI (Setup, Lightning pages, App Builder, anything the API or sf CLI cannot do) in the Kernel browser, or when a Salesforce login page, passkey or MFA prompt blocks you. Opens Salesforce already signed in with a URL from the sf CLI.
scope: org
---

# Salesforce UI login (sf CLI URL, no login page)

## Rules

1. Never log in through the Salesforce login page. Never try to satisfy a passkey, MFA or "register a passkey" prompt, and never click "skip" on one.
2. Production: the prod login (`qm-agent@r3.digital`, alias `r3-prod`) is API-only, so Salesforce blocks it from the UI. Do not try prod UI. Tell the user it needs a separate decision.
3. The URL from `sf org open` carries a live session. Treat it like a password: never in chat, tool output, logs, files, argv, or the browse task text (that text goes to the model and is echoed in the runner log).

## Steps

1. Check the CLI login: `sf-auth-ensure --status`. Not connected: `sf-auth-ensure --force`. Use this project's sandbox alias (e.g. `r3-partial`, `r3-proposal`, `r3-kernel`).
2. Create the Kernel browser as in the browse skill (`skill://browse/providers/kernel.md`). Profile-less in a shared room. That gives `CDP_URL`.
3. Open Salesforce signed in. The URL goes from sf straight into the browser through a pipe, so it is never printed or stored. Change the alias and `--path` (any page path; omit for home). If `sf` is not on PATH, use `$HOME/.local/bin/sf`:

```bash
sf org open -o r3-kernel --path lightning/setup/SetupOneHome/home --url-only --json 2>/dev/null \
| CDP_URL="$CDP_URL" /opt/browser-engine/venv/bin/python -c '
import asyncio, json, logging, os, sys
from urllib.parse import urlsplit
try:
    url = json.load(sys.stdin)["result"]["url"]
except Exception:
    print("no URL from sf. Run sf-auth-ensure --force and retry."); sys.exit(1)
from browser_use import BrowserSession
logging.disable(logging.CRITICAL)
async def main():
    s = BrowserSession(cdp_url=os.environ["CDP_URL"])
    await s.start()
    await s.navigate_to(url)
    await asyncio.sleep(8)
    u = urlsplit(await s.get_current_page_url())
    print("landed on", u.netloc + u.path)
    await s.stop()  # detaches, the browser stays open
try:
    asyncio.run(main())
except Exception as e:
    print("browser step failed:", type(e).__name__); sys.exit(1)
' 2>/dev/null
```

4. Check where it landed (only host and path are printed):
   - `/lightning/...` or `/setup/...`: signed in. Now run the browse runner as usual. The task says the browser is already signed in and names plain page URLs (no session in them).
   - Login page, or a path with `webauthn`, `identity` or `verification`: stop. Tell the user what you saw. Do not click through.
5. If a page bounces to login later, the session expired. Run step 3 again for a fresh URL. Never reuse an old one.
6. Delete the Kernel browser when done (browse skill, Clean up). Never post `LIVE_VIEW` of a signed-in browser in a shared room.

## Gotchas (seen 25 Sep 2026)

- Do not build `frontdoor.jsp?sid=...` by hand. `sf org display --json` redacts the token (you get a placeholder), and a hand-built frontdoor from `sf org auth show-access-token` landed on Salesforce's passkey page (`/_ui/identity/webauthn/AddPasskeyUi`).
- A browse agent given a sign-in URL inside a long task skipped it and went straight to the target page, landing on the login page. Signing in first (step 3) avoids that.
- A raw token in a URL can contain characters curl rejects. Another reason to let `sf org open` build it.
