// Social backend tests: SIWS, sessions, profiles, follows, copy settings, notifications. Loopback only, no network.
// Run: npx tsc --outDir dist && node --test test/social.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createSocialServer } from "../dist/social/server.js";
import { SocialStore } from "../dist/social/store.js";
import { hmacSessionAuth, verifySessionToken } from "../dist/session.js";

const SECRET = "s".repeat(40);
const DOMAIN = "app.ringside.test";
const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) { s = ALPHA[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
  return s;
}
function newUser() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { wallet: b58(raw), signMsg: (m) => sign(null, Buffer.from(m), privateKey) };
}

async function setup(opts = {}) {
  let t = Date.now();
  const store = new SocialStore(":memory:", opts.maxFollows ?? 500);
  const server = createSocialServer({
    store, secret: SECRET, domain: DOMAIN, now: () => t,
    ipRateLimit: false, authRateLimit: false, userRateLimit: false,
    corsOrigins: ["https://app.ringside.test"], heartbeatMs: 50, ...opts.server,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { token, body, headers } = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, headers: r.headers };
  };
  const nonce = (wallet) => call("POST", "/auth/nonce", { body: { wallet } });
  const login = async (u = newUser()) => {
    const n = (await nonce(u.wallet)).json;
    const v = await call("POST", "/auth/verify", { body: { wallet: u.wallet, message: n.message, signature: b58(u.signMsg(n.message)) } });
    assert.equal(v.status, 200);
    return { ...u, token: v.json.token };
  };
  return { store, server, call, nonce, login, advance: (ms) => { t += ms; }, close: () => { server.closeAllConnections(); server.close(); store.close(); } };
}
const code = (r) => r.json?.error?.code;

test("SIWS happy path (base58 and base64 signatures), token accepted by hmacSessionAuth", async () => {
  const s = await setup();
  try {
    const u = newUser();
    const n = (await s.nonce(u.wallet)).json;
    assert.match(n.message, new RegExp(`^${DOMAIN} wants you to sign in`));
    assert.ok(n.message.includes(u.wallet) && n.message.includes(n.nonce) && n.message.includes("Issued At:") && n.message.includes("Expiration Time:"));
    const v = await s.call("POST", "/auth/verify", { body: { wallet: u.wallet, message: n.message, signature: u.signMsg(n.message).toString("base64") } });
    assert.equal(v.status, 200);
    assert.equal(verifySessionToken(SECRET, v.json.token).userId, u.wallet);
    const auth = await hmacSessionAuth(SECRET)({ headers: { authorization: `Bearer ${v.json.token}` } });
    assert.deepEqual(auth, { userId: u.wallet });
    const me = await s.call("GET", "/me", { token: v.json.token });
    assert.equal(me.status, 200);
    assert.equal(me.json.wallet, u.wallet);
    // base58 also works
    await s.login(u);
  } finally { s.close(); }
});

test("SIWS refusals: replay, expiry, domain, wallet, tampering, bad signature", async () => {
  const s = await setup();
  try {
    const u = newUser(), other = newUser();
    const verify = (wallet, message, signer = u) => s.call("POST", "/auth/verify", { body: { wallet, message, signature: b58(signer.signMsg(message)) } });

    let n = (await s.nonce(u.wallet)).json;
    assert.equal((await verify(u.wallet, n.message)).status, 200);
    const replay = await verify(u.wallet, n.message);
    assert.equal(replay.status, 401);
    assert.equal(code(replay), "invalid_signin");

    n = (await s.nonce(u.wallet)).json;
    s.advance(301_000);
    assert.equal((await verify(u.wallet, n.message)).status, 401, "expired");

    n = (await s.nonce(u.wallet)).json;
    const wrongDomain = n.message.replace(DOMAIN, "evil.example");
    assert.equal((await verify(u.wallet, wrongDomain)).status, 401, "domain");

    n = (await s.nonce(u.wallet)).json;
    assert.equal((await verify(other.wallet, n.message, other)).status, 401, "message issued to another wallet");

    n = (await s.nonce(u.wallet)).json;
    const tampered = n.message.replace("Sign in to Ringside.", "Sign in to Ringside and send me funds.");
    assert.equal((await verify(u.wallet, tampered)).status, 401, "tampered");

    n = (await s.nonce(u.wallet)).json;
    assert.equal((await verify(u.wallet, n.message, other)).status, 401, "signed by a different key");

    // Never issued
    const fake = n.message.replace(n.nonce, "0".repeat(32));
    assert.equal((await verify(u.wallet, fake)).status, 401);
    assert.equal((await s.call("POST", "/auth/verify", { body: { wallet: u.wallet } })).status, 401);
    assert.equal(code(await s.call("POST", "/auth/nonce", { body: { wallet: "nope" } })), "invalid_wallet");
  } finally { s.close(); }
});

test("startup refuses a short secret, a wildcard CORS origin and a bad domain", () => {
  const store = new SocialStore();
  assert.throws(() => createSocialServer({ store, secret: "short", domain: DOMAIN }), /32 bytes/);
  assert.throws(() => createSocialServer({ store, secret: SECRET, domain: DOMAIN, corsOrigins: ["*"] }), /never \*/);
  assert.throws(() => createSocialServer({ store, secret: SECRET, domain: "" }), /SOCIAL_DOMAIN/);
  store.close();
});

test("auth required, CORS, body limit, error shape", async () => {
  const s = await setup({ server: { maxBodyBytes: 200 } });
  try {
    const noAuth = await s.call("GET", "/me");
    assert.equal(noAuth.status, 401);
    assert.deepEqual(Object.keys(noAuth.json.error).sort(), ["code", "message"]);
    assert.equal((await s.call("GET", "/me", { token: "v1.bad.bad" })).status, 401);
    const ok = await s.call("OPTIONS", "/me", { headers: { origin: "https://app.ringside.test" } });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get("access-control-allow-origin"), "https://app.ringside.test");
    const evil = await s.call("GET", "/health", { headers: { origin: "https://evil.test" } });
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
    assert.equal(code(await s.call("POST", "/auth/nonce", { body: JSON.stringify({ wallet: "x".repeat(500) }) })), "body_too_large");
    assert.equal(code(await s.call("POST", "/auth/nonce", { body: "{not json" })), "invalid_json");
  } finally { s.close(); }
});

test("rate limits per IP and per user", async () => {
  const s = await setup({ server: { ipRateLimit: false, authRateLimit: { windowMs: 60_000, max: 2 }, userRateLimit: { windowMs: 60_000, max: 3 } } });
  try {
    const u = newUser();
    assert.equal((await s.nonce(u.wallet)).status, 200);
    assert.equal((await s.nonce(u.wallet)).status, 200);
    const r = await s.nonce(u.wallet);
    assert.equal(r.status, 429);
    assert.ok(r.headers.get("retry-after"));
  } finally { s.close(); }
  const s2 = await setup({ server: { userRateLimit: { windowMs: 60_000, max: 3 } } });
  try {
    const u = await s2.login();
    for (let i = 0; i < 3; i++) assert.equal((await s2.call("GET", "/me", { token: u.token })).status, 200);
    assert.equal((await s2.call("GET", "/me", { token: u.token })).status, 429);
  } finally { s2.close(); }
});

test("profiles: validation, sanitising, privacy, counts", async () => {
  const s = await setup();
  try {
    const a = await s.login(), b = await s.login();
    assert.deepEqual((await s.call("GET", "/me", { token: a.token })).json, { wallet: a.wallet, displayName: "", bio: "", avatarUrl: null, public: true });
    const put = await s.call("PUT", "/me", { token: a.token, body: { displayName: "  Al\u0000i‮ce\n ", bio: "line1\nli\u0007ne2", avatarUrl: "https://cdn.example.com/a.png" } });
    assert.equal(put.status, 200);
    assert.equal(put.json.displayName, "Alice");
    assert.equal(put.json.bio, "line1\nline2");
    for (const body of [
      { displayName: "x".repeat(51) }, { bio: "x".repeat(281) }, { displayName: 5 }, { public: "yes" }, { extra: 1 },
      { avatarUrl: "http://cdn.example.com/a.png" }, { avatarUrl: "javascript:alert(1)" }, { avatarUrl: "https://u:p@example.com/a.png" },
      { avatarUrl: "data:image/png;base64,AAAA" }, { avatarUrl: "https://example.com/" + "a".repeat(600) },
    ]) assert.equal((await s.call("PUT", "/me", { token: a.token, body })).status, 400, JSON.stringify(body).slice(0, 60));
    await s.call("POST", `/follows/${a.wallet}`, { token: b.token });
    const pub = await s.call("GET", `/users/${a.wallet}`, { token: b.token });
    assert.equal(pub.json.displayName, "Alice");
    assert.equal(pub.json.followers, 1);
    assert.equal(pub.json.following, 0);
    await s.call("PUT", "/me", { token: a.token, body: { public: false } });
    assert.equal((await s.call("GET", `/users/${a.wallet}`, { token: b.token })).status, 404);
    assert.equal((await s.call("GET", `/users/${a.wallet}`, { token: a.token })).status, 200);
    assert.equal((await s.call("GET", `/users/notawallet`, { token: a.token })).status, 400);
  } finally { s.close(); }
});

test("follows: idempotent, self refused, cap, listing", async () => {
  const s = await setup({ maxFollows: 2 });
  try {
    const a = await s.login(), b = await s.login(), c = await s.login(), d = await s.login();
    const self = await s.call("POST", `/follows/${a.wallet}`, { token: a.token });
    assert.equal(self.status, 400);
    assert.equal(code(self), "self_follow");
    assert.equal((await s.call("POST", `/follows/${b.wallet}`, { token: a.token })).status, 200);
    assert.equal((await s.call("POST", `/follows/${b.wallet}`, { token: a.token })).status, 200); // idempotent
    assert.deepEqual((await s.call("GET", "/follows", { token: a.token })).json, { following: [b.wallet] });
    assert.equal((await s.call("POST", `/follows/${c.wallet}`, { token: a.token })).status, 200);
    const over = await s.call("POST", `/follows/${d.wallet}`, { token: a.token });
    assert.equal(over.status, 409);
    assert.equal(code(over), "follow_limit");
    assert.equal((await s.call("POST", `/follows/${b.wallet}`, { token: a.token })).status, 200, "repeat at the cap is fine");
    assert.deepEqual((await s.call("GET", `/users/${b.wallet}/followers`, { token: c.token })).json, { followers: [a.wallet], next: null });
    assert.equal((await s.call("DELETE", `/follows/${b.wallet}`, { token: a.token })).status, 200);
    assert.equal((await s.call("DELETE", `/follows/${b.wallet}`, { token: a.token })).status, 200); // idempotent
    assert.deepEqual((await s.call("GET", "/follows", { token: a.token })).json, { following: [c.wallet] });
    assert.equal((await s.call("POST", "/follows/bad", { token: a.token })).status, 400);
  } finally { s.close(); }
});

test("copy settings: need follow first, defaults, bounds, only enabled returned", async () => {
  const s = await setup();
  try {
    const f = await s.login(), f2 = await s.login(), l = await s.login();
    const url = `/copy-settings/${l.wallet}`;
    const SOL = 1_000_000_000;
    assert.equal(code(await s.call("GET", url, { token: f.token })), "not_following");
    assert.equal(code(await s.call("PUT", url, { token: f.token, body: { enabled: true } })), "not_following");
    await s.call("POST", `/follows/${l.wallet}`, { token: f.token });
    await s.call("POST", `/follows/${l.wallet}`, { token: f2.token });

    const d = (await s.call("GET", url, { token: f.token })).json;
    assert.equal(d.enabled, false);
    assert.equal(d.copyPerps, false);
    assert.deepEqual(d.skipFlags, ["sniper", "bundle", "insider", "concentrated"]);
    assert.equal(d.follower, f.wallet);
    assert.equal(d.leader, l.wallet);
    assert.deepEqual(await s.store.copySettingsForLeader(l.wallet), []);

    const badBodies = [
      { slippageBps: 3001 }, { slippageBps: -1 }, { slippageBps: 1.5 },
      { maxLeverage: 0 }, { maxLeverage: 11 },
      { maxPerTradeLamports: 0 }, { dailyCapLamports: 0 }, { dailyCapLamports: -5 },
      { maxPerTradeLamports: 2 * SOL, dailyCapLamports: SOL },
      { maxPerTradeLamports: 5 * SOL + 1, dailyCapLamports: 100 * SOL },
      { fixedLamports: 0 }, { ratioBps: 10_001 }, { mode: "other" },
      { skipFlags: ["sniper", "nope"] }, { skipFlags: "sniper" }, { enabled: "true" },
      { unknown: 1 }, { leader: f.wallet },
    ];
    for (const body of badBodies) {
      const r = await s.call("PUT", url, { token: f.token, body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(code(r), "invalid_copy_settings");
    }
    const ok = await s.call("PUT", url, { token: f.token, body: {
      enabled: true, mode: "ratio", ratioBps: 500, maxPerTradeLamports: 2 * SOL, dailyCapLamports: 4 * SOL,
      slippageBps: 3000, maxLeverage: 10, copyPerps: true, skipFlags: ["sniper"], minTokenAgeSec: 60,
    } });
    assert.equal(ok.status, 200);
    assert.deepEqual((await s.call("GET", url, { token: f.token })).json, ok.json);
    const list = await s.store.copySettingsForLeader(l.wallet);
    assert.equal(list.length, 1, "f2 never enabled");
    assert.equal(list[0].follower, f.wallet);
    assert.deepEqual(list[0].skipFlags, ["sniper"]);
    // disabling removes it; unfollowing removes settings
    await s.call("PUT", url, { token: f.token, body: { enabled: false } });
    assert.deepEqual(await s.store.copySettingsForLeader(l.wallet), []);
    await s.call("PUT", url, { token: f.token, body: { enabled: true } });
    assert.equal((await s.store.copySettingsForLeader(l.wallet)).length, 1);
    await s.call("DELETE", `/follows/${l.wallet}`, { token: f.token });
    assert.deepEqual(await s.store.copySettingsForLeader(l.wallet), []);
  } finally { s.close(); }
});

const T0 = Math.floor(Date.now() / 1000);
const intent = (follower, leader, id, over = {}) => ({
  id, follower, leader, sourceSignature: "sig" + id, kind: "spot", mint: leader, side: "buy", venue: "jupiter",
  lamports: 1000, createdAt: T0, expiresAt: T0 + 60, status: "pending", ...over,
});

test("notifications: stored per user, paginated, isolated, expired view", async () => {
  const s = await setup();
  try {
    const a = await s.login(), b = await s.login(), l = await s.login();
    for (let i = 1; i <= 5; i++) await s.store.notify(a.wallet, intent(a.wallet, l.wallet, `a${i}`));
    await s.store.notify(b.wallet, intent(b.wallet, l.wallet, "b1"));
    await assert.rejects(() => s.store.notify(a.wallet, intent(b.wallet, l.wallet, "x")));
    const p1 = (await s.call("GET", "/notifications?limit=3", { token: a.token })).json;
    assert.deepEqual(p1.notifications.map((n) => n.id), ["a5", "a4", "a3"]);
    const p2 = (await s.call("GET", `/notifications?limit=3&before=${p1.next}`, { token: a.token })).json;
    assert.deepEqual(p2.notifications.map((n) => n.id), ["a2", "a1"]);
    assert.equal(p2.next, null);
    const mine = (await s.call("GET", "/notifications", { token: b.token })).json;
    assert.deepEqual(mine.notifications.map((n) => n.id), ["b1"]);
    assert.equal(mine.notifications[0].follower, b.wallet);
    // same id again updates, does not duplicate
    await s.store.notify(b.wallet, intent(b.wallet, l.wallet, "b1", { status: "sent" }));
    const again = (await s.call("GET", "/notifications", { token: b.token })).json.notifications;
    assert.equal(again.length, 1);
    assert.equal(again[0].status, "sent");
    assert.equal((await s.call("GET", "/notifications", { token: l.token })).json.notifications.length, 0);
    assert.equal((await s.call("GET", "/notifications")).status, 401);
    assert.equal(code(await s.call("GET", "/notifications?limit=0", { token: a.token })), "invalid_limit");
    // a pending intent past expiresAt reads as expired (push the clock forward)
    s.advance(120_000);
    assert.equal((await s.call("GET", "/notifications", { token: a.token })).json.notifications[0].status, "expired");
  } finally { s.close(); }
});

test("notification stream: SSE delivers only the user's intents and needs a bearer token", async () => {
  const s = await setup();
  try {
    const a = await s.login(), b = await s.login(), l = await s.login();
    assert.equal((await s.call("GET", "/notifications/stream")).status, 401);
    const ac = new AbortController();
    const base = `http://127.0.0.1:${s.server.address().port}`;
    const res = await fetch(base + "/notifications/stream", { headers: { authorization: `Bearer ${a.token}` }, signal: ac.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    const reader = res.body.getReader();
    await s.store.notify(b.wallet, intent(b.wallet, l.wallet, "for-b"));
    await s.store.notify(a.wallet, intent(a.wallet, l.wallet, "for-a"));
    let text = "";
    const dec = new TextDecoder();
    while (!text.includes("for-a")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value);
    }
    assert.ok(text.includes('"id":"for-a"'));
    assert.ok(!text.includes("for-b"));
    ac.abort();
  } finally { s.close(); }
});
