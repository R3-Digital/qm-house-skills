#!/usr/bin/env node
// Salesforce UI login as this project's UI test user, into an existing Kernel browser.
// JWT bearer -> frontdoor -> TOTP challenge only if Salesforce shows one.
// Reads only SF_SBX_UITEST_* and CDP_URL. Never reads the admin SF_SBX_* vars.
// Never prints the TOTP key, the access token or the frontdoor URL. Node 22+ (built in fetch, WebSocket, crypto).
//
// Usage: CDP_URL=... node sf-ui-login.mjs [--path /lightning/...] [--report] [--screenshot FILE] [--timeout SECONDS]
//        node sf-ui-login.mjs --self-test
// Exit: 0 signed in, 2 usage, 3 vars missing, 4 MFA registration needed, 5 JWT or login page, 6 TOTP rejected, 7 other.
import { createSign, createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";

const FIELDS = ["NAME", "CLIENT_ID", "USERNAME", "INSTANCE_URL", "JWT_KEY_B64", "TOTP_SECRET"];
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const has = (name) => args.includes(name);
const out = (...a) => console.log(...a);
const done = (code, result) => { out("RESULT " + JSON.stringify(result)); process.exit(code); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// TOTP, RFC 6238: 6 digits, 30 second step, HMAC-SHA1. Same output as otplib's authenticator defaults.
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32(s) {
  let bits = "";
  for (const ch of s.replace(/[\s=-]/g, "").toUpperCase()) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error("TOTP secret is not base32");
    bits += v.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function totp(secret, ms = Date.now()) {
  const step = Math.floor(ms / 30000);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", base32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = (h.readUInt32BE(o) & 0x7fffffff) % 1000000;
  return { code: String(n).padStart(6, "0"), step, remaining: 30 - Math.floor((ms / 1000) % 30) };
}

if (has("--self-test")) {
  const k = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // RFC 6238 test secret "12345678901234567890"
  const vectors = [[59, "287082"], [1111111109, "081804"], [1111111111, "050471"], [1234567890, "005924"], [2000000000, "279037"], [20000000000, "353130"]];
  const bad = vectors.filter(([t, want]) => totp(k, t * 1000).code !== want);
  out(bad.length ? `self-test FAILED for t=${bad.map((v) => v[0]).join(",")}` : `self-test ok (${vectors.length} RFC 6238 vectors)`);
  out("runtime", process.version, "WebSocket", typeof WebSocket, "fetch", typeof fetch);
  process.exit(bad.length ? 7 : 0);
}

const env = Object.fromEntries(FIELDS.map((f) => [f, (process.env[`SF_SBX_UITEST_${f}`] || "").trim()]));
const missing = FIELDS.filter((f) => !env[f]).map((f) => `SF_SBX_UITEST_${f}`);
if (missing.length) {
  out(`missing: ${missing.join(", ")}`);
  out("This project has no UI test user credential. Ask Robert once in the main chat and stop. Do not use SF_SBX_* or sf-auth-ensure for UI login.");
  done(3, { ok: false, reason: "vars-missing", missing });
}
const CDP_URL = process.env.CDP_URL;
if (!CDP_URL) { out("CDP_URL is not set. Create the Kernel browser first (browse skill, kernel provider)."); done(2, { ok: false, reason: "no-cdp-url" }); }
if (typeof WebSocket !== "function" || typeof fetch !== "function") { out(`Node ${process.version} lacks built in WebSocket or fetch. Needs Node 22 or newer.`); done(7, { ok: false, reason: "old-node" }); }
const target = opt("--path") || "/lightning/page/home";
if (!target.startsWith("/")) { out("--path must start with /"); done(2, { ok: false, reason: "bad-path" }); }
const timeoutMs = Number(opt("--timeout") || 60) * 1000;
const where = (u) => { try { const x = new URL(u); return x.host + x.pathname; } catch { return "(unreadable url)"; } };
const result = { ok: false, sandbox: env.NAME, user: env.USERNAME, totpChallenge: false, totpAttempts: 0 };

// 1. JWT bearer login as the test user.
const inst = env.INSTANCE_URL.replace(/\/$/, "");
const aud = process.env.SF_SBX_UITEST_AUDIENCE_URL || (/\.sandbox\.my\.salesforce\.com$/i.test(new URL(inst).host) ? "https://test.salesforce.com" : "https://login.salesforce.com");
const b64u = (x) => Buffer.from(x).toString("base64url");
const claims = { iss: env.CLIENT_ID, sub: env.USERNAME, aud, exp: Math.floor(Date.now() / 1000) + 180 };
const unsigned = `${b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64u(JSON.stringify(claims))}`;
let assertion;
try {
  const signer = createSign("RSA-SHA256"); signer.update(unsigned);
  assertion = `${unsigned}.${signer.sign(Buffer.from(env.JWT_KEY_B64, "base64").toString("utf8")).toString("base64url")}`;
} catch (e) { out("could not sign the JWT (bad SF_SBX_UITEST_JWT_KEY_B64?)"); done(5, { ...result, reason: "jwt-sign" }); }
const tr = await fetch(`${inst}/services/oauth2/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }) });
const tj = await tr.json().catch(() => ({}));
if (!tr.ok || !tj.access_token) { out(`JWT login failed: http ${tr.status} ${tj.error || ""} ${tj.error_description || ""}`.trim()); done(5, { ...result, reason: "jwt-failed", error: tj.error }); }
const ui = await (await fetch(`${tj.instance_url}/services/oauth2/userinfo`, { headers: { Authorization: `Bearer ${tj.access_token}` } })).json().catch(() => ({}));
if (String(ui.preferred_username || "").toLowerCase() !== env.USERNAME.toLowerCase()) { out("JWT session is not the test user. Stopping."); done(5, { ...result, reason: "wrong-user" }); }
out("JWT ok as", env.USERNAME);

// 2. Frontdoor in the Kernel browser. The URL only travels inside the CDP socket.
const ws = new WebSocket(CDP_URL);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("CDP connect failed")); });
let seq = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}, sessionId) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
const pages = (await send("Target.getTargets")).result.targetInfos.filter((t) => t.type === "page");
const tid = (pages.find((t) => !t.url.startsWith("chrome")) || pages[0])?.targetId || (await send("Target.createTarget", { url: "about:blank" })).result.targetId;
const sid = (await send("Target.attachToTarget", { targetId: tid, flatten: true })).result.sessionId;
await send("Page.enable", {}, sid);
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true }, sid)).result?.result?.value;
const finish = (code, extra = {}) => { try { ws.close(); } catch {} done(code, { ...result, ...extra }); };
const fd = `${tj.instance_url}/secur/frontdoor.jsp?sid=${encodeURIComponent(tj.access_token)}&retURL=${encodeURIComponent(target)}`;
await send("Page.navigate", { url: fd }, sid);

const CODE_INPUTS = `[...document.querySelectorAll('input')].filter(e=>['text','tel','number'].includes(e.type)&&e.getBoundingClientRect().width>0)`;
async function phase() {
  const u = (await ev("location.href")) || "";
  const title = (await ev("document.title")) || "";
  if (/lightning\.force\.com\/(lightning|one)\//.test(u)) return "lightning";
  if (/webauthn|AddPasskeyUi/i.test(u) || /Create a Passkey|Choose a Verification Method|Connect an Authenticator App/i.test(title)) return "registration";
  const totpPage = await ev(`(()=>{const b=(document.body&&document.body.innerText)||'';return document.readyState==='complete'&&${CODE_INPUTS}.length===1&&/verif|authenticator|code/i.test(b);})()`);
  if (totpPage) return "totp";
  if (await ev("!!document.querySelector('input#username, input[type=password]')")) return "login";
  return "";
}
async function waitPhase(ms) {
  const t0 = Date.now(); let last = "";
  while (Date.now() - t0 < ms) {
    await sleep(1500);
    const u = (await ev("location.href")) || "";
    if (u !== last) { out("at", where(u)); last = u; }
    const p = await phase();
    if (p) return p;
  }
  return "timeout";
}

let p = await waitPhase(timeoutMs);
if (p === "registration") { out("Salesforce wants MFA registration (passkey page). Registration is an operator task. Stop and tell Robert. Do not click through or screenshot this page."); finish(4, { reason: "registration-needed" }); }
if (p === "login") { out("Landed on a login page. Stop. Do not type a password."); finish(5, { reason: "login-page" }); }

// 3. TOTP challenge: one fresh code, at most one retry in the next window, then stop.
if (p === "totp") {
  result.totpChallenge = true;
  out("TOTP challenge shown");
  let lastStep = -1;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let t = totp(env.TOTP_SECRET);
    while (t.step <= lastStep || t.remaining < 12) { await sleep(1000); t = totp(env.TOTP_SECRET); }
    lastStep = t.step; result.totpAttempts = attempt;
    const ready = await ev(`(()=>{const i=${CODE_INPUTS};if(i.length!==1)return false;i[0].focus();i[0].value='';return true;})()`);
    if (!ready) { out("code field not found"); finish(7, { reason: "no-code-field" }); }
    await send("Input.insertText", { text: t.code }, sid);
    const btn = await ev(`(()=>{const b=[...document.querySelectorAll('input[type=submit],button')].find(e=>/verify|connect|continue|submit/i.test(e.value||e.innerText||''));if(!b)return null;b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2});})()`);
    if (!btn) { out("submit button not found"); finish(7, { reason: "no-submit" }); }
    const { x, y } = JSON.parse(btn);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, sid);
    out(`code submitted (attempt ${attempt})`);
    p = await waitPhase(20000);
    if (p === "lightning") break;
    if (attempt === 2) { out("TOTP rejected twice. Stop. Wait before any new attempt and tell Robert (10 bad codes lock the user for 1 hour)."); finish(6, { reason: "totp-rejected" }); }
  }
}
if (p !== "lightning") { out("Did not reach Lightning:", p); finish(7, { reason: p || "unknown" }); }

// 4. Make sure the target page is open (retURL can be dropped after an MFA step).
if (!((await ev("location.pathname")) || "").startsWith(target.split("?")[0])) {
  await send("Page.navigate", { url: `${new URL((await ev("location.href"))).origin}${target}` }, sid);
  await sleep(4000);
}
result.ok = true;
result.page = where(await ev("location.href"));
if (has("--report") || has("--screenshot")) {
  // Lightning list tables live in shadow DOM: search inside shadow roots and read the "N items" text.
  const DEEP = `(sel)=>{const o=[];const w=r=>{r.querySelectorAll(sel).forEach(e=>o.push(e));r.querySelectorAll('*').forEach(e=>{if(e.shadowRoot)w(e.shadowRoot);});};w(document);return o;}`;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    await sleep(2000);
    result.items = ((await ev(`(((document.body&&document.body.innerText)||'').match(/\\d+\\+? items?\\b[^\\n]*/)||[''])[0]`)) || "").trim();
    result.rows = (await ev(`(${DEEP})('table tbody tr').length`)) || 0;
    if (result.rows > 0 || /^0 items/.test(result.items || "")) break;
  }
  result.title = await ev("document.title");
}
const shot = opt("--screenshot");
if (shot) { const s = await send("Page.captureScreenshot", { format: "png" }, sid); if (s.result?.data) { writeFileSync(shot, Buffer.from(s.result.data, "base64")); out("screenshot", shot); } }
out("signed in at", result.page);
finish(0);
