// The copy service as its own process: HTTP SocialPort, social internal routes, read-only indexer store, entry wiring. No network beyond loopback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSocialServer } from "../dist/social/server.js";
import { SocialStore } from "../dist/social/store.js";
import { SqliteStore } from "../dist/indexer/store.js";
import { httpSocialPort } from "../dist/copy/socialport.js";
import { copyPortsFromEnv, startCopyService } from "../dist/copy/main.js";

const LEADER = "22S3bVxfkoJB5L5EhFo1Hp3T9EtX1qLG4dP9UDcRQN6B";
const ALICE = "99cnRnduE5KdqhuJmYN5YH3WcnSiPQ152bF3hbxSfvKU";
const BOB = "s7KMacZHd83q5bUtXhVkPPwRsxut1ipy93wfxmWpnn8";
const MINT = "AbYGhAcF86iLQpQQynmZPZAyMejskVFowy2P2LBktuaH";
const SESSION = "s".repeat(40);
const INTERNAL = "i".repeat(40);
const INGEST = "ingest-secret-not-real-0123456789";
const SOL = 1_000_000_000;
const settings = (follower, o = {}) => ({
  follower, leader: LEADER, enabled: true, mode: "fixed", fixedLamports: 0.1 * SOL, ratioBps: 5000,
  maxPerTradeLamports: SOL, dailyCapLamports: SOL, slippageBps: 100, copySells: true,
  copyPerps: false, maxLeverage: 1, skipFlags: [], minTokenAgeSec: 0, ...o,
});
const intent = (o = {}) => ({
  id: "i1", follower: ALICE, leader: LEADER, sourceSignature: "x", kind: "spot", mint: MINT, side: "buy", venue: "pumpfun",
  lamports: 1, createdAt: 1, expiresAt: 2, status: "pending", ...o,
});

async function social(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "copy-wiring-"));
  const store = new SocialStore(join(dir, "social.db"));
  const server = createSocialServer({ store, secret: SESSION, domain: "app.test", ipRateLimit: false, internalSecret: INTERNAL, ...opts });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { dir, store, server, url, stop: () => { server.closeAllConnections(); server.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("SocialPort adapter reads enabled settings of current followers and notifies through the social store", async () => {
  const s = await social();
  try {
    s.store.follow(ALICE, LEADER); s.store.putCopySettings(settings(ALICE));
    s.store.follow(BOB, LEADER); s.store.putCopySettings(settings(BOB, { enabled: false }));
    s.store.putCopySettings(settings("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1")); // not following: ignored
    const port = httpSocialPort({ baseUrl: s.url, secret: INTERNAL });
    const got = await port.copySettingsForLeader(LEADER);
    assert.deepEqual(got.map((x) => x.follower), [ALICE]);
    assert.deepEqual(got[0], settings(ALICE));
    assert.deepEqual(await port.copySettingsForLeader(BOB), []);

    const live = []; s.store.onNotify((f, n) => live.push([f, n.intent.id]));
    await port.notify(ALICE, intent());
    await port.notify(ALICE, intent({ status: "built" })); // same id: a status update
    assert.deepEqual(live, [[ALICE, "i1"], [ALICE, "i1"]], "the social process's own listeners (SSE) fire on every notify");
    const n = s.store.notifications(ALICE, 10, null).items;
    assert.equal(n.length, 1); assert.equal(n[0].intent.status, "built");
    await assert.rejects(port.notify(BOB, intent()), /HTTP 400/, "intent.follower must match");
  } finally { s.stop(); }
});

test("internal routes: wrong or missing secret, browser origin, proxy header; off without a secret; no CORS", async () => {
  const s = await social({ corsOrigins: ["https://app.test"] });
  try {
    const get = (headers = {}, path = `/internal/copy/settings?leader=${LEADER}`) => fetch(s.url + path, { headers });
    const ok = { authorization: `Bearer ${INTERNAL}` };
    assert.equal((await get(ok)).status, 200);
    assert.equal((await get()).status, 401);
    assert.equal((await get({ authorization: `Bearer ${"x".repeat(40)}` })).status, 401);
    assert.equal((await get({ authorization: `Bearer ${SESSION}` })).status, 401, "the session secret is not the internal secret");
    const withOrigin = await get({ ...ok, origin: "https://app.test" });
    assert.equal(withOrigin.status, 403);
    assert.equal(withOrigin.headers.get("access-control-allow-origin"), null);
    assert.equal((await get({ ...ok, "x-forwarded-for": "1.2.3.4" })).status, 403);
    assert.equal((await get(ok, "/internal/copy/settings?leader=nope")).status, 400);
    assert.equal((await get(ok, "/internal/other")).status, 404);
    assert.equal((await fetch(s.url + "/internal/copy/settings", { method: "OPTIONS", headers: { origin: "https://app.test" } })).headers.get("access-control-allow-origin"), null);
  } finally { s.stop(); }
  const off = await social({ internalSecret: undefined });
  try { assert.equal((await fetch(`${off.url}/internal/copy/settings?leader=${LEADER}`, { headers: { authorization: `Bearer ${INTERNAL}` } })).status, 404); } finally { off.stop(); }
});

test("internal secret must be 32+ bytes and differ from SESSION_SECRET; the adapter refuses non-loopback URLs", () => {
  const store = new SocialStore();
  const mk = (internalSecret) => createSocialServer({ store, secret: SESSION, domain: "app.test", internalSecret });
  assert.throws(() => mk("short"), /at least 32/);
  assert.throws(() => mk(SESSION), /differ/);
  assert.throws(() => httpSocialPort({ baseUrl: "http://127.0.0.1:1", secret: "short" }), /at least 32/);
  for (const u of ["https://127.0.0.1:1", "http://example.com", "http://10.0.0.5:8791"]) assert.throws(() => httpSocialPort({ baseUrl: u, secret: INTERNAL }), /loopback|127\.0\.0\.1/, u);
  assert.doesNotThrow(() => httpSocialPort({ baseUrl: "http://[::1]:8791", secret: INTERNAL }));
  store.close();
});

test("adapter errors carry the status, never the secret", async () => {
  const port = httpSocialPort({ baseUrl: "http://127.0.0.1:1", secret: INTERNAL, fetch: async () => new Response("no", { status: 503 }) });
  await assert.rejects(port.copySettingsForLeader(LEADER), (e) => /HTTP 503/.test(e.message) && !e.message.includes(INTERNAL));
  const bad = httpSocialPort({ baseUrl: "http://127.0.0.1:1", secret: INTERNAL, fetch: async () => Response.json({ nope: 1 }) });
  await assert.rejects(bad.copySettingsForLeader(LEADER), /unexpected response/);
});

test("indexer store opens read-only next to a live writer: sees new rows, cannot write", () => {
  const dir = mkdtempSync(join(tmpdir(), "copy-wiring-"));
  const path = join(dir, "indexer.db");
  const w = new SqliteStore(path);
  try {
    const r = new SqliteStore(path, { readOnly: true });
    assert.deepEqual(r.mintTrades(MINT), []);
    w.ingest({ signature: "S1", slot: 1, timestamp: 1_700_000_000, trades: [{ signature: "S1", wallet: LEADER, mint: MINT, side: "buy", tokenAmount: 10, quote: "SOL", quoteAmount: 1, slot: 1, timestamp: 1_700_000_000, source: "t" }], transfers: [], launches: [] });
    assert.equal(r.mintTrades(MINT).length, 1, "a write by the indexer after the reader opened is visible");
    assert.throws(() => r.ingest({ signature: "S2", slot: 2, timestamp: 1_700_000_001, trades: [], transfers: [], launches: [] }), /readonly|read-only|attempt to write/i);
    assert.throws(() => new SqliteStore(join(dir, "missing.db"), { readOnly: true }));
    r.close();
  } finally { w.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("entry wiring: ports from env, service answers /health on loopback and shuts down; bad env refuses early", async () => {
  const s = await social();
  const ipath = join(s.dir, "indexer.db");
  new SqliteStore(ipath).close();
  const env = {
    SESSION_SECRET: SESSION, COPY_INGEST_SECRET: INGEST, SOCIAL_INTERNAL_SECRET: INTERNAL, SOCIAL_INTERNAL_URL: s.url,
    INDEXER_DB: ipath, COPY_RPC_URL: "http://127.0.0.1:1", COPY_FEE_WALLET: ALICE, COPY_PORT: "0", COPY_DB: join(s.dir, "copy.sqlite"),
  };
  assert.throws(() => copyPortsFromEnv({ ...env, SOCIAL_INTERNAL_SECRET: "short" }), /at least 32/);
  assert.throws(() => copyPortsFromEnv({ ...env, INDEXER_DB: join(s.dir, "nope.db") }));
  const { social: sp, indexer } = copyPortsFromEnv(env);
  const svc = startCopyService(sp, indexer, env);
  try {
    await new Promise((r) => svc.server.once("listening", r));
    const addr = svc.server.address();
    assert.equal(addr.address, "127.0.0.1");
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${addr.port}/health`)).json(), { ok: true });
    // The engine's port is the real one: settings written through the social store reach it.
    s.store.follow(ALICE, LEADER); s.store.putCopySettings(settings(ALICE));
    assert.equal((await sp.copySettingsForLeader(LEADER)).length, 1);
  } finally {
    await new Promise((r) => { svc.server.closeAllConnections(); svc.server.close(r); });
    svc.store.close(); indexer.close(); s.stop();
  }
});
