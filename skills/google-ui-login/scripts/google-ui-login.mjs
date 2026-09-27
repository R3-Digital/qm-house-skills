#!/usr/bin/env node
// Sign in with Google as the dedicated UI test account, in an existing Kernel browser.
// Opens the app URL, clicks "Sign in with Google" if needed, then handles the account chooser,
// email, password, an optional authenticator (TOTP) code and the app's consent screen.
// Reads only GOOGLE_UITEST_USERNAME, GOOGLE_UITEST_PASSWORD, GOOGLE_UITEST_TOTP_SECRET and CDP_URL.
// Never prints the password, the TOTP key or a TOTP code. Prints hosts and paths only, never query strings.
// Node 22+ (built in WebSocket, crypto). No dependencies.
//
// Usage: CDP_URL=... node google-ui-login.mjs --url https://app.example.com/login
//          [--click-selector CSS] [--expect REGEX] [--timeout SECONDS] [--screenshot FILE]
//        node google-ui-login.mjs --self-test
// Exit: 0 signed in, 2 usage, 3 vars missing, 4 challenge the script cannot satisfy,
//       5 wrong credentials, unknown account or wrong account, 6 TOTP rejected twice, 7 other.
import { createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";

const FIELDS = ["USERNAME", "PASSWORD", "TOTP_SECRET"];
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const has = (name) => args.includes(name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// TOTP, RFC 6238: 6 digits, 30 second step, HMAC-SHA1 (Google Authenticator defaults).
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
  console.log(bad.length ? `self-test FAILED for t=${bad.map((v) => v[0]).join(",")}` : `self-test ok (${vectors.length} RFC 6238 vectors)`);
  console.log("runtime", process.version, "WebSocket", typeof WebSocket);
  process.exit(bad.length ? 7 : 0);
}

// Secrets are masked in everything this script prints, as a second line of defence.
const env = Object.fromEntries(FIELDS.map((f) => [f, (process.env[`GOOGLE_UITEST_${f}`] || "").trim()]));
const secrets = [env.PASSWORD, env.TOTP_SECRET].filter((s) => s && s.length >= 4);
const mask = (s) => { let t = String(s); for (const x of secrets) t = t.split(x).join("[hidden]"); return t.replace(/\b\d{6}\b/g, "[code]"); };
const out = (...a) => console.log(mask(a.join(" ")));
const done = (code, result) => { out("RESULT " + JSON.stringify(result)); process.exit(code); };

const missing = FIELDS.filter((f) => !env[f]).map((f) => `GOOGLE_UITEST_${f}`);
if (missing.length) {
  out(`missing: ${missing.join(", ")}`);
  out("The Google test account credentials are not available in this session. Ask the user once to make the GOOGLE_UITEST_* org credentials available, then stop. Do not sign in with any other Google account.");
  done(3, { ok: false, reason: "vars-missing", missing });
}
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(env.USERNAME)) { out("GOOGLE_UITEST_USERNAME is not an email address"); done(3, { ok: false, reason: "bad-username" }); }
try { base32(env.TOTP_SECRET); } catch { out("GOOGLE_UITEST_TOTP_SECRET is not base32"); done(3, { ok: false, reason: "bad-totp-secret" }); }

const startUrl = opt("--url");
const CDP_URL = process.env.CDP_URL;
if (!startUrl || !/^https?:\/\//i.test(startUrl)) { out("--url is required and must start with http:// or https://"); done(2, { ok: false, reason: "bad-url" }); }
if (!CDP_URL) { out("CDP_URL is not set. Create the Kernel browser first (browse skill, kernel provider, no profile)."); done(2, { ok: false, reason: "no-cdp-url" }); }
if (typeof WebSocket !== "function") { out(`Node ${process.version} lacks built in WebSocket. Needs Node 22 or newer.`); done(7, { ok: false, reason: "old-node" }); }
const timeoutMs = Number(opt("--timeout") || 120) * 1000;
const expect = opt("--expect") ? new RegExp(opt("--expect")) : null;
const clickSelector = opt("--click-selector");
const where = (u) => { try { const x = new URL(u); return x.host + x.pathname; } catch { return "(unreadable url)"; } };
const isGoogleAuth = (u) => { try { const h = new URL(u).host; return /^accounts\.google\.[a-z.]+$/.test(h) || h === "accounts.youtube.com" || h === "gds.google.com"; } catch { return false; } };
const result = { ok: false, user: env.USERNAME, start: where(startUrl), totpChallenge: false, totpAttempts: 0, consentClicked: false };

// CDP plumbing (same pattern as salesforce-ui-login).
const ws = new WebSocket(CDP_URL);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("CDP connect failed")); }).catch(() => { out("Could not connect to CDP_URL"); done(7, { ...result, reason: "cdp-connect" }); });
let seq = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const id = ++seq; const t = setTimeout(() => { pending.delete(id); res({ error: { message: "cdp timeout" } }); }, 15000);
  pending.set(id, (m) => { clearTimeout(t); res(m); });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const finish = (code, extra = {}) => { try { ws.close(); } catch {} done(code, { ...result, ...extra }); };

const pageTargets = async () => ((await send("Target.getTargets")).result?.targetInfos || []).filter((t) => t.type === "page");
const attach = async (targetId) => { const s = (await send("Target.attachToTarget", { targetId, flatten: true })).result?.sessionId; if (s) await send("Page.enable", {}, s); return s; };
const initial = await pageTargets();
const mainTid = (initial.find((t) => !t.url.startsWith("chrome")) || initial[0])?.targetId || (await send("Target.createTarget", { url: "about:blank" })).result.targetId;
let cur = { tid: mainTid, sid: await attach(mainTid) };
const main = { ...cur };
const known = new Set(initial.map((t) => t.targetId));

async function ev(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true }, cur.sid);
  if (r.error) throw new Error(r.error.message || "evaluate failed");
  return r.result?.result?.value;
}
async function clickAt(x, y) { for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, cur.sid); }
// Click the first visible element matched by a JS expression that returns an element.
async function clickEl(js) {
  const r = await ev(`(()=>{const el=(${js});if(!el)return null;el.scrollIntoView({block:'center'});const b=el.getBoundingClientRect();return JSON.stringify({x:b.left+b.width/2,y:b.top+b.height/2});})()`);
  if (!r) return false; const p = JSON.parse(r); await clickAt(p.x, p.y); return true;
}
async function pressEnter() { for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, cur.sid); }
async function typeInto(selectorJs, text) {
  const ok = await ev(`(()=>{const el=(${selectorJs});if(!el)return false;el.focus();el.select&&el.select();return true;})()`);
  if (!ok) return false;
  await send("Input.insertText", { text }, cur.sid);
  return true;
}

// In-page helpers: visibility and button lookup by text.
const H = `const vis=e=>{if(!e)return false;const r=e.getBoundingClientRect();if(r.width<2||r.height<2)return false;const s=getComputedStyle(e);return s.visibility!=='hidden'&&s.display!=='none'&&!e.closest('[aria-hidden=true]');};
const q=s=>[...document.querySelectorAll(s)].filter(vis);
const txt=()=>((document.body&&document.body.innerText)||'');
const btn=re=>q('button,[role=button],input[type=submit],a').find(e=>re.test(((e.innerText||e.value||e.getAttribute('aria-label')||'')+'').trim()));`;

// Classify the Google page we are on. Returns a short state name.
const STATE = `(()=>{${H}
const u=location.href,t=txt();
if(document.readyState==='loading')return {s:'loading'};
if(/\\/signin\\/rejected/.test(u)||/browser or app may not be secure/i.test(t))return {s:'blocked',why:'Google rejected this browser as not secure'};
if(q('input[name=ca],#captchaimg,img[src*="Captcha"]').length||/type the text you (hear|see)/i.test(t)||q('iframe[src*="recaptcha"]').length)return {s:'blocked',why:'captcha'};
if(/couldn.t find your google account/i.test(t))return {s:'nouser'};
if(/wrong password|password was changed/i.test(t)&&q('input[type=password]').length)return {s:'wrongpw'};
if(/wrong code|code is incorrect|try again with a new code/i.test(t)&&/challenge\\/totp/.test(u))return {s:'badcode'};
if(/hasn.t verified this app/i.test(t))return {s:'blocked',why:'Google shows the unverified app warning for this app'};
if(/access blocked|authorization error|error 400|error 403|redirect_uri_mismatch|org_internal/i.test(t)&&/oauth|signin/.test(u))return {s:'oautherror'};
if(/challenge\\/totp/.test(u)||q('input[name=totpPin],#totpPin').length)return {s:'totp'};
if(/challenge\\/(selection|sk|pk|dp|ipp|iap|ootp|az|bc|kpe|kpp|ipe|rp|recaptcha)/.test(u)||/verify it.s you|choose how you want to sign in|check your phone|use your passkey|confirm your recovery|get a verification code/i.test(t))return {s:'challenge',path:location.pathname};
if(q('input[type=password]').length)return {s:'password'};
if(q('#identifierId,input[type=email]').length)return {s:'email'};
if(q('[data-identifier],[data-email]').length&&/choose an account|use another account/i.test(t))return {s:'chooser'};
if(/speedbump|gaplustos|signinoptions|interstitial/.test(u))return {s:'speedbump'};
if(/oauth|consent|approval/.test(u)||btn(/^(continue|allow)$/i))return {s:'consent'};
if(btn(/^(not now|skip|i understand|remind me later)$/i))return {s:'speedbump'};
return {s:'google-other',title:document.title};
})()`;

// Switch to a Google sign in popup if the app opened one; switch back when it closes.
async function followTargets() {
  const ts = await pageTargets();
  const alive = ts.some((t) => t.targetId === cur.tid);
  const pop = ts.find((t) => !known.has(t.targetId) && isGoogleAuth(t.url));
  ts.forEach((t) => known.add(t.targetId));
  if (pop && pop.targetId !== cur.tid) { cur = { tid: pop.targetId, sid: await attach(pop.targetId) }; out("following Google popup"); return; }
  if (!alive) { cur = { ...main }; out("popup closed, back to the app tab"); }
}

// 1. Open the app URL.
out("opening", where(startUrl));
await send("Page.navigate", { url: startUrl }, cur.sid);
await sleep(3000);

// 2. If we are still on the app, click its Google button (or the given selector).
async function clickGoogleButton() {
  if (clickSelector) return clickEl(`document.querySelector(${JSON.stringify(clickSelector)})`);
  return clickEl(`(()=>{${H}
    const re=/(sign|log) ?in with google|continue with google|google (sign|log) ?in|^google$/i;
    const b=q('button,[role=button],a,input[type=submit],input[type=button]').find(e=>re.test(((e.innerText||e.value||e.getAttribute('aria-label')||e.title||'')+'').trim()));
    if(b)return b;
    const f=q('iframe').find(e=>/accounts\\.google\\.com\\/gsi\\/button/.test(e.src));
    return f||null;})()`);
}

let sawGoogle = false, clicked = false, lastPrinted = "", challengeTries = 0, speedbumps = 0, emailTries = 0, pwTries = 0;
const t0 = Date.now();
while (Date.now() - t0 < timeoutMs) {
  await sleep(1500);
  await followTargets();
  let url, st;
  try { url = (await ev("location.href")) || ""; } catch { cur = { ...main }; continue; }
  const w = where(url);
  if (w !== lastPrinted) { out("at", w); lastPrinted = w; }

  if (!isGoogleAuth(url)) {
    if (cur.tid !== main.tid) continue; // popup still loading
    const ready = await ev("document.readyState").catch(() => "");
    if (ready !== "complete") continue;
    if (sawGoogle || (expect && expect.test(url))) { if (!expect || expect.test(url)) break; continue; }
    if (!clicked) {
      if (url === "about:blank") continue;
      clicked = await clickGoogleButton();
      out(clicked ? "clicked the Google sign in button" : "no Google sign in button found yet");
      if (!clicked && Date.now() - t0 > 20000) { out("No 'Sign in with Google' button found on the app page. Pass the Google OAuth URL or --click-selector."); finish(7, { reason: "no-google-button", page: w }); }
      continue;
    }
    // Clicked but nothing Google happened yet; if the app already let us in (existing session), accept after a grace period.
    if (Date.now() - t0 > 30000 && !sawGoogle) { out("The app never showed Google sign in. It may already be signed in, or the button did nothing."); finish(7, { reason: "no-google-page", page: w }); }
    continue;
  }

  sawGoogle = true;
  try { st = await ev(STATE); } catch { continue; }
  if (!st || st.s === "loading") continue;

  if (st.s === "blocked") { out(`Stopped: ${st.why}. The script cannot get past this. Report it; do not retry in a loop.`); finish(4, { reason: "blocked", detail: st.why, page: w }); }
  if (st.s === "nouser") { out("Google cannot find the test account. Check GOOGLE_UITEST_USERNAME."); finish(5, { reason: "account-not-found" }); }
  if (st.s === "wrongpw") { out("Google says the password is wrong. Stop. Do not retry; tell the user the stored test password needs updating."); finish(5, { reason: "wrong-password" }); }
  if (st.s === "oautherror") { out("Google shows an OAuth error for this app (for example access blocked or redirect mismatch). Report it."); finish(4, { reason: "oauth-error", page: w, title: await ev("document.title").catch(() => "") }); }

  if (st.s === "chooser") {
    // Pick the test account tile if present, otherwise "Use another account". Never pick any other tile.
    const u = JSON.stringify(env.USERNAME.toLowerCase());
    const picked = await clickEl(`(()=>{${H}return q('[data-identifier],[data-email]').find(e=>((e.getAttribute('data-identifier')||e.getAttribute('data-email')||'')+'').toLowerCase()===${u});})()`);
    if (picked) { out("picked the test account in the account chooser"); continue; }
    const other = await clickEl(`(()=>{${H}return btn(/use another account/i)||q('li,div[role=link]').find(e=>/use another account/i.test(e.innerText||''));})()`);
    out(other ? "clicked Use another account" : "account chooser without a Use another account option");
    if (!other) finish(4, { reason: "chooser-no-other" });
    continue;
  }

  if (st.s === "email") {
    if (++emailTries > 3) { out("Email step keeps coming back. Stop."); finish(7, { reason: "email-loop" }); }
    await typeInto(`(()=>{${H}return q('#identifierId,input[type=email]')[0];})()`, env.USERNAME);
    if (!(await clickEl(`(()=>{${H}return document.querySelector('#identifierNext button')||btn(/^next$/i);})()`))) await pressEnter();
    out("email entered");
    await sleep(2500);
    continue;
  }

  if (st.s === "password") {
    if (++pwTries > 2) { out("Password step keeps coming back. Stop. Do not retry."); finish(5, { reason: "password-loop" }); }
    await typeInto(`(()=>{${H}return q('input[type=password]')[0];})()`, env.PASSWORD);
    if (!(await clickEl(`(()=>{${H}return document.querySelector('#passwordNext button')||btn(/^next$/i);})()`))) await pressEnter();
    out("password entered");
    await sleep(3000);
    continue;
  }

  if (st.s === "totp" || st.s === "badcode") {
    // One fresh code, at most one retry in the next window, then stop.
    result.totpChallenge = true;
    if (st.s === "badcode" && result.totpAttempts === 0) result.totpAttempts = 1;
    if (result.totpAttempts >= 2) { out("Authenticator code rejected twice. Stop. Tell the user; the TOTP secret may be wrong."); finish(6, { reason: "totp-rejected" }); }
    let t = totp(env.TOTP_SECRET);
    const last = result.lastStep ?? -1;
    while (t.step <= last || t.remaining < 8) { await sleep(1000); t = totp(env.TOTP_SECRET); }
    result.lastStep = t.step; result.totpAttempts++;
    const okField = await typeInto(`(()=>{${H}return q('input[name=totpPin],#totpPin,input[type=tel]')[0];})()`, t.code);
    if (!okField) { out("authenticator code field not found"); finish(7, { reason: "no-code-field" }); }
    if (!(await clickEl(`(()=>{${H}return document.querySelector('#totpNext button')||btn(/^(next|verify)$/i);})()`))) await pressEnter();
    out(`authenticator code submitted (attempt ${result.totpAttempts})`);
    await sleep(4000);
    continue;
  }

  if (st.s === "challenge") {
    // Prefer the authenticator app. Try "Try another way" once to reach the method list.
    const pickedTotp = await clickEl(`(()=>{${H}const re=/google authenticator|authenticator app/i;return q('[data-challengetype="6"]')[0]||q('li,div[role=link],button').filter(e=>re.test(e.innerText||'')).sort((a,b)=>a.innerText.length-b.innerText.length)[0];})()`);
    if (pickedTotp) { out("chose the authenticator app option"); await sleep(2500); continue; }
    if (challengeTries++ < 1) {
      const other = await clickEl(`(()=>{${H}return btn(/try another way|more ways to verify/i);})()`);
      if (other) { out("clicked Try another way"); await sleep(2500); continue; }
    }
    out(`Stopped: Google wants a verification the script cannot do (${st.path || "verify it's you"}), such as a phone prompt, SMS, passkey or security key. Report it; do not retry in a loop.`);
    finish(4, { reason: "unsupported-challenge", page: w });
  }

  if (st.s === "speedbump") {
    if (++speedbumps > 4) { out("Too many interstitial pages. Stop."); finish(7, { reason: "speedbump-loop", page: w }); }
    const c = await clickEl(`(()=>{${H}return btn(/^(not now|skip|remind me later|i understand)$/i);})()`);
    out(c ? "dismissed a Google interstitial page" : "interstitial page without a known button");
    if (!c) finish(4, { reason: "unknown-interstitial", page: w, title: await ev("document.title").catch(() => "") });
    await sleep(2500);
    continue;
  }

  if (st.s === "consent") {
    const c = await clickEl(`(()=>{${H}return btn(/^(continue|allow)$/i);})()`);
    if (c) { result.consentClicked = true; out("clicked Continue on the app consent screen"); await sleep(3000); }
    continue;
  }
  // google-other: keep waiting for the page to settle.
}

// Let the app finish its own redirects: wait until the URL is stable for about 3 seconds.
let finalUrl = "";
for (let i = 0, same = 0; i < 20 && same < 2; i++) {
  await sleep(1500);
  let u = ""; try { u = (await ev("location.href")) || ""; } catch { cur = { ...main }; }
  same = u === finalUrl ? same + 1 : 0; finalUrl = u;
}
if (!finalUrl || isGoogleAuth(finalUrl) || (expect && !expect.test(finalUrl))) { out("Timed out before leaving Google sign in, at", where(finalUrl)); finish(7, { reason: "timeout", page: where(finalUrl) }); }

// 3. Confirm which Google account the browser is signed in as, in a short lived tab on myaccount.google.com.
//    true: the page shows the test account. false: a different account is signed in. null: could not tell.
async function identity() {
  const tid = (await send("Target.createTarget", { url: "https://myaccount.google.com/" })).result?.targetId;
  if (!tid) return null;
  const saved = cur; cur = { tid, sid: await attach(tid) };
  let verdict = null;
  const u = JSON.stringify(env.USERNAME.toLowerCase());
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const r = await ev(`(()=>{if(document.readyState!=='complete')return null;const t=((document.body&&document.body.innerText)||'').toLowerCase();return {host:location.host,has:t.includes(${u})};})()`).catch(() => null);
    if (!r) continue;
    if (r.host !== "myaccount.google.com") break; // bounced to sign in: no Google session to check
    if (r.has) { verdict = true; break; }
    if (i >= 8) { verdict = false; break; }
  }
  await send("Target.closeTarget", { targetId: tid });
  cur = saved;
  return verdict;
}
result.identityConfirmed = await identity().catch(() => null);
if (result.identityConfirmed === false) { out("The browser is signed in to a Google account other than the test account. Stop and delete this browser."); finish(5, { reason: "wrong-account", landing: where(finalUrl) }); }
if (result.identityConfirmed === null) out("could not confirm the Google account from myaccount.google.com (the app may not keep a Google session)");

result.ok = true;
result.landing = where(finalUrl);
result.title = await ev("document.title").catch(() => "");
delete result.lastStep;
const shot = opt("--screenshot");
if (shot) { const s = await send("Page.captureScreenshot", { format: "png" }, cur.sid); if (s.result?.data) { writeFileSync(shot, Buffer.from(s.result.data, "base64")); out("screenshot", shot); } }
out("signed in, landed at", result.landing);
finish(0);
