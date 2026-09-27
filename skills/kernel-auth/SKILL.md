---
name: kernel-auth
description: Use this when a browser task needs a signed-in website and you are managing that sign-in with Kernel managed auth, stored Kernel credentials or TOTP secrets through the Kernel REST API (KERNEL_API_KEY). Covers reusing, creating, checking, re-authenticating and cleaning up auth connections. For Salesforce sandboxes use salesforce-ui-login instead.
scope: org
---

# Kernel managed auth (REST API)

Adapted from the `kernel-auth` skill in https://github.com/kernel/skills (commit 47eab5f, MIT License, Copyright (c) 2025 Kernel). The original drives the Kernel CLI. Here every step is a direct call to `https://api.onkernel.com` with the org env `KERNEL_API_KEY`, in the same style as the browse skill. There is no Kernel CLI and no npm in the sandbox.

This skill sits next to the browse skill (`skills/browse/SKILL.md` and `skills/browse/providers/kernel.md`). The browse skill owns browser creation, profiles, the DM-only sign-in rule, the consent wording and the secret drop for getting a person's login. Follow those rules. This skill adds reuse, status checks, TOTP secrets, re-auth diagnosis, the timeline and cleanup.

## When not to use this

1. Salesforce sandboxes. Use the salesforce-ui-login skill. It signs in as the project's UI test user from the per-project `SF_SBX_UITEST_*` credential with a JWT, frontdoor and TOTP. Do not create a Kernel auth connection or Kernel credential for Salesforce, and never copy `SF_SBX_UITEST_JWT_KEY_B64` or `SF_SBX_UITEST_TOTP_SECRET` into Kernel. Those keys stay in the QM keychain.
2. When an API, MCP tool or connector can do the job. A URL in the request is not a reason to open a browser.
3. Public pages. Only start managed auth when the page you need really requires a signed-in session.

## Rules

1. Never print a password, TOTP key, TOTP code, `hosted_url`, `live_view_url` or `cdp_ws_url` in shared output. Pipe responses through the python filters below, which pick safe fields only. Never run with `set -x`.
2. Build request bodies with python from env vars into a temp file, send with `--data-binary @file`, then delete the file. Secrets never go in shell source or command arguments.
3. Storing a person's login or TOTP key at Kernel needs their explicit OK, given the way the browse skill describes. Sign-ins are DM-only.
4. Reuse before you create. One connection per domain and profile.
5. Do not call `/login` again while a flow is still running. A new call replaces the running flow and can throw away what the person was typing.
6. Delete temporary browsers when done. Do not delete a connection, credential or profile as routine cleanup or to "fix" a login.

## Setup

```bash
K=https://api.onkernel.com
kget()  { curl -sS "$K$1" -H "Authorization: Bearer $KERNEL_API_KEY"; }
kpost() { curl -sS -X "${3:-POST}" "$K$1" -H "Authorization: Bearer $KERNEL_API_KEY" -H 'content-type: application/json' --data-binary "@$2"; }
# Safe view of a connection: no URLs, no values.
kshow() { python3 -c 'import sys,json
j=json.load(sys.stdin); j=j if isinstance(j,list) else [j]
keep=["id","domain","profile_name","status","flow_status","flow_step","flow_type","flow_expires_at","can_reauth","can_reauth_reason","auto_reauth","health_checks","health_check_interval","save_credentials","credential","external_action_message","website_error","error_code","error_message"]
for c in j:
    out={k:c.get(k) for k in keep if c.get(k) is not None}
    if c.get("fields"): out["fields"]=[{k:f.get(k) for k in ("id","name","type","label") if k in f} for f in c["fields"]]
    if c.get("choices"): out["choices"]=[{k:x.get(k) for k in ("id","label","type") if k in x} for x in c["choices"]]
    print(json.dumps(out))'; }
```

## 1. Find an existing connection

```bash
kget "/auth/connections?domain=example.com&limit=50" | kshow
kget "/auth/connections?profile_name=$KERNEL_PROFILE&limit=50" | kshow
```

The list takes `domain`, `profile_name`, `query`, `limit` and `offset`. Sites can bounce between sibling domains (for example `app.` and `auth.`), so check the profile's connections before creating another.

## 2. Create a connection

A connection needs `domain` and `profile_name`. Kernel creates the profile if it does not exist. Add only what the site needs: `login_url` (skips discovery), `allowed_domains` (extra redirect domains; common SSO domains are allowed already), `credential` (`{"name": "..."}` for a Kernel credential, or `{"provider": "...", "auto": true}` for an external provider, not both), `health_check_interval` in seconds, `save_credentials` (default true; turning it off usually stops unattended re-auth).

```bash
python3 -c 'import json,os
b={"domain":os.environ["SITE_DOMAIN"],"profile_name":os.environ["KERNEL_PROFILE"]}
if os.environ.get("LOGIN_URL"): b["login_url"]=os.environ["LOGIN_URL"]
if os.environ.get("CRED_NAME"): b["credential"]={"name":os.environ["CRED_NAME"]}
print(json.dumps(b))' > /tmp/conn-body.json
CONN=$(kpost /auth/connections /tmp/conn-body.json); rm -f /tmp/conn-body.json
CONN_ID=$(printf '%s' "$CONN" | python3 -c "import sys,json;j=json.load(sys.stdin);print(j.get('id') or j.get('existing_id',''))")
```

A 409 with `existing_id` means a connection for that domain and profile already exists. Use it. Domain and profile cannot be changed later; make a new connection if either must differ.

## 3. Update a connection

`PATCH /auth/connections/{id}` is partial. `allowed_domains` replaces the whole list, so send every domain you want to keep. Always check the result:

```bash
python3 -c 'import json;print(json.dumps({"health_check_interval":3600}))' > /tmp/patch.json
kpost "/auth/connections/$CONN_ID" /tmp/patch.json PATCH | kshow; rm -f /tmp/patch.json
```

The API accepts `credential` on PATCH, but the browse skill found linking reliable only at create. If `credential` is still empty afterwards, delete the unlinked connection and create it again with the credential.

## 4. Stored logins and TOTP secrets

Kernel credentials are write-only: reads return `has_values`, `value_keys` and `has_totp_secret`, never the values. Names must be new each time (a reused name gets a 409).

Store a login, with a TOTP key if the site uses an authenticator app. The values come from env (for example from a secret drop the person filled in):

```bash
export CRED_NAME="example-$(python3 -c 'import secrets;print(secrets.token_hex(4))')"
python3 -c 'import json,os
b={"name":os.environ["CRED_NAME"],"domain":os.environ["SITE_DOMAIN"],
   "values":{"email":os.environ["EMAIL"],"password":os.environ["PASSWORD"]}}
if os.environ.get("TOTP_SECRET"): b["totp_secret"]=os.environ["TOTP_SECRET"].replace(" ","")
print(json.dumps(b))' > /tmp/cred-body.json
kpost /credentials /tmp/cred-body.json | python3 -c "import sys,json;j=json.load(sys.stdin);print({k:j.get(k) for k in ('id','name','domain','has_values','has_totp_secret','value_keys')})"
rm -f /tmp/cred-body.json
```

The create and update responses include a live `totp_code` when a TOTP key was just set. The filter above drops it; keep it that way.

With `totp_secret` set, Kernel fills authenticator codes itself during login and re-auth, so the person is not needed for that step. SMS and email codes still need the person.

- Add or replace a TOTP key later: `PATCH /credentials/{id_or_name}` with `{"totp_secret": ...}` built the same way. Remove value keys with `remove_value_keys`.
- Get a current code (only to finish a site's authenticator setup the person asked for): `GET /credentials/{id_or_name}/totp-code`. Treat the code as a secret. Feed it straight into the page; do not print it.
- The TOTP key is the base32 text a site shows under "can't scan the QR code". Never screenshot a QR code or key page. Get the key from the person through a secret drop, not from chat.
- Check what is stored: `kget "/credentials?domain=example.com" | python3 -c "import sys,json;[print({k:c.get(k) for k in ('name','domain','has_values','has_totp_secret','value_keys')}) for c in json.load(sys.stdin)]"`

## 5. Log in

Start one flow on the existing connection:

```bash
python3 -c 'import json;print(json.dumps({"record_session":True}))' > /tmp/login.json
LOGIN=$(kpost "/auth/connections/$CONN_ID/login" /tmp/login.json); rm -f /tmp/login.json
printf '%s' "$LOGIN" | python3 -c "import sys,json;j=json.load(sys.stdin);print({k:j.get(k) for k in ('id','flow_type','flow_expires_at')})"
```

`flow_type` is `LOGIN` or `REAUTH`. The response also has `hosted_url` (single use, about 30 minutes) and `live_view_url` (the managed auth browser, not your task browser). When the person must act, send them `hosted_url` in the DM, as the browse skill says, and keep waiting in the same turn. Never open the hosted URL yourself.

Wait for the end of the flow with a bounded poll:

```bash
for i in $(seq 1 120); do
  S=$(kget "/auth/connections/$CONN_ID" | python3 -c "import sys,json;j=json.load(sys.stdin);print(j.get('status'),j.get('flow_status'),j.get('flow_step'))")
  echo "$S"; case "$S" in *" SUCCESS "*|*FAILED*|*EXPIRED*|*CANCELED*) break;; esac; sleep 5
done
```

`GET /auth/connections/{id}/events` is a server-sent events stream of the same states that ends when the flow does. If you use it, filter it the same way, since events can carry URLs.

Done means `flow_status` is `SUCCESS` and `status` is `AUTHENTICATED`. If it `EXPIRED`, start one new flow, send the new link, and keep waiting.

### Submitting fields yourself

When `flow_step` is `AWAITING_INPUT`, `kshow` lists `fields` and `choices`. Prefer the hosted link. Submit yourself only when you already hold the value legitimately (for example picking the authenticator option). Send exactly one mode per call: `field_values` (keyed by field id) or `selected_choice_id`, plus the `interaction_id` from the same GET:

```bash
kget "/auth/connections/$CONN_ID" > /tmp/conn.json
python3 -c 'import json,os
c=json.load(open("/tmp/conn.json"))
print(json.dumps({"interaction_id":c.get("interaction_id"),"selected_choice_id":os.environ["CHOICE_ID"]}))' > /tmp/submit.json
kpost "/auth/connections/$CONN_ID/submit" /tmp/submit.json > /dev/null; rm -f /tmp/conn.json /tmp/submit.json
```

A 200 only means the input was accepted. Keep polling. If the same fields come back three times, stop and fall back to the hosted link.

## 6. Use the signed-in profile

The login ran in its own browser. It does not sign in your task browser. Delete the old task browser, create a new one with `"profile":{"name":"<profile_name>"}` as in the browse skill, add `"telemetry":{"enabled":true}` if you may need to debug, load the target page and check you are signed in before doing anything that matters. If it lands on a login page, re-auth the same connection; do not make a new profile.

## 7. Re-auth problems

`status` alone does not tell you if Kernel can re-auth by itself. Check `can_reauth`, `can_reauth_reason`, `auto_reauth`, `health_checks` and `credential` with `kshow`. Unattended re-auth needs health checks on, auto re-auth on and a usable credential (with `totp_secret` if the site asks for an authenticator code). `can_reauth=false` means a person must act.

For a connection in `NEEDS_AUTH`: link or fix its credential, start one login, finish any fields or external action, then confirm `AUTHENTICATED` and `can_reauth=true`.

The timeline shows what happened, newest first. Filter by `type` (`login`, `reauth`, `health_check`) and page with `limit` and `offset` (the `X-Next-Offset` header is 0 on the last page):

```bash
kget "/auth/connections/$CONN_ID/timeline?type=reauth&limit=20" | python3 -c "import sys,json
j=json.load(sys.stdin); ev=j if isinstance(j,list) else j.get('events',[])
[print({k:e.get(k) for k in ('timestamp','type','status','step','error_code','error_message','website_error')}) for e in ev]"
```

## 8. Clean up

```bash
curl -fsS -X DELETE "$K/browsers/$KERNEL_SID" -H "Authorization: Bearer $KERNEL_API_KEY"
```

Deleting a connection (`DELETE /auth/connections/{id}`) cancels any running login and stops health checks. Deleting a credential (`DELETE /credentials/{id_or_name}`) removes the stored login and TOTP key. Do either only when the person asks, after checking the exact id or name. Never delete a shared profile to recover from a failed login.

## API reference

Check these instead of guessing when a call surprises you:

- Managed auth: https://www.kernel.sh/docs/api-reference/managed-auth/list-auth-connections (and the create, get, update, delete, start-login-flow, submit-field-values and get-auth-connection-event-timeline pages next to it)
- Credentials and TOTP: https://www.kernel.sh/docs/auth/credentials
- Programmatic flows: https://www.kernel.sh/docs/auth/programmatic
- Full OpenAPI spec: https://api.onkernel.com/spec.json
