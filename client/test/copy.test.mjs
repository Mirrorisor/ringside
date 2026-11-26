// Copy engine: intents, skips, caps, sell sizing, perps leverage, build, HTTP auth. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCopyEngine } from "../dist/copy/engine.js";
import { CopyStore } from "../dist/copy/store.js";
import { buildIntent, compileUnsigned, BuildError } from "../dist/copy/build.js";
import { createCopyServer, parseTrade } from "../dist/copy/server.js";
import { cappedLeverage, tierMaxLeverage, TIER_MAX_LEVERAGE } from "../dist/copy/perps.js";
import { createSessionToken, hmacSessionAuth } from "../dist/session.js";

const LEADER = "22S3bVxfkoJB5L5EhFo1Hp3T9EtX1qLG4dP9UDcRQN6B";
const ALICE = "99cnRnduE5KdqhuJmYN5YH3WcnSiPQ152bF3hbxSfvKU";
const BOB = "s7KMacZHd83q5bUtXhVkPPwRsxut1ipy93wfxmWpnn8";
const MINT = "AbYGhAcF86iLQpQQynmZPZAyMejskVFowy2P2LBktuaH";
const MINT2 = "8y5FVi7aTTSjwvLQkXFyRojbDrL8w9svysX8mZcEgmyK";
const SOL = 1_000_000_000;
const SESSION = "s".repeat(40);
const INGEST = "ingest-secret-not-real-0123456789";
const SIG = (n) => String(n).padStart(88, "1"); // base58-shaped, 88 chars
const T0 = 1_800_000_000_000; // ms

const settings = (o = {}) => ({
  follower: ALICE, leader: LEADER, enabled: true, mode: "fixed", fixedLamports: 0.1 * SOL, ratioBps: 5000,
  maxPerTradeLamports: 1 * SOL, dailyCapLamports: 1 * SOL, slippageBps: 100, copySells: true,
  copyPerps: true, maxLeverage: 5, skipFlags: [], minTokenAgeSec: 0, ...o,
});
const trade = (o = {}) => ({
  signature: SIG(1), wallet: LEADER, mint: MINT, side: "buy", tokenAmount: 1000, quote: "SOL", quoteAmount: 1,
  slot: 100, timestamp: Math.floor(T0 / 1000), source: "PUMP_FUN", ...o,
});

function rig({ list = [settings()], facts = {}, tiers, perpsEnabled = true, solPriceUsd } = {}) {
  const clock = { t: T0 };
  const notified = [];
  const social = { copySettingsForLeader: async () => list, notify: async (f, i) => { notified.push([f, i]); } };
  const flags = { tokenFacts: async (m) => facts[m] ?? { flags: [], ageSec: 3600 } };
  const store = new CopyStore(":memory:");
  const engine = createCopyEngine({ social, flags, store, tiers, perpsEnabled, solPriceUsd, now: () => clock.t });
  return { clock, notified, store, engine, setList: (l) => { list = l; } };
}
const one = async (r, t = trade()) => (await r.engine.onLeaderTrade(t))[0];

// ---- skip reasons -------------------------------------------------------------------------

test("a buy makes one pending intent and notifies the follower", async () => {
  const r = rig();
  const i = await one(r);
  assert.equal(i.status, "pending");
  assert.equal(i.lamports, 0.1 * SOL);
  assert.equal(i.venue, "pumpfun");
  assert.equal(i.expiresAt - i.createdAt, 60_000);
  assert.equal(r.notified.length, 1);
  assert.equal(r.notified[0][0], ALICE);
});

test("every skip reason is recorded and nobody is notified", async () => {
  const cases = [
    ["disabled", settings({ enabled: false }), trade()],
    ["bad_settings", settings({ fixedLamports: -5 }), trade()],
    ["leader_trade_stale", settings(), trade({ timestamp: Math.floor(T0 / 1000) - 31 })],
    ["unsupported_quote", settings(), trade({ quote: "USDC" })],
    ["over_per_trade_cap", settings({ maxPerTradeLamports: 0.05 * SOL }), trade()],
    ["over_daily_cap", settings({ dailyCapLamports: 0.05 * SOL }), trade()],
    ["sells_disabled", settings({ copySells: false }), trade({ side: "sell" })],
    ["no_copy_position", settings(), trade({ side: "sell" })],
    ["flagged:sniper", settings({ skipFlags: ["sniper"] }), trade(), { [MINT]: { flags: ["sniper"], ageSec: 999 } }],
    ["token_too_young", settings({ minTokenAgeSec: 600 }), trade(), { [MINT]: { flags: [], ageSec: 30 } }],
    ["token_age_unknown", settings({ minTokenAgeSec: 600 }), trade(), { [MINT]: { flags: [], ageSec: null } }],
  ];
  for (const [reason, s, t, facts] of cases) {
    const r = rig({ list: [s], facts });
    const i = await one(r, t);
    assert.equal(i.status, "skipped", reason);
    assert.equal(i.skipReason, reason);
    assert.equal(r.notified.length, 0, reason);
  }
});

test("an unflagged token passes a skipFlags filter; the leader trade at exactly 30 s is fresh", async () => {
  const r = rig({ list: [settings({ skipFlags: ["sniper", "bundle"] })], facts: { [MINT]: { flags: ["concentrated"], ageSec: 1 } } });
  assert.equal((await one(r, trade({ timestamp: Math.floor(T0 / 1000) - 30 }))).status, "pending");
});

test("flags and age do not block an exit", async () => {
  const r = rig({ list: [settings({ skipFlags: ["sniper"], minTokenAgeSec: 600 })], facts: { [MINT]: { flags: ["sniper"], ageSec: 1 } } });
  r.store.insert({ id: "seed", follower: ALICE, leader: LEADER, sourceSignature: "x", kind: "spot", mint: MINT, side: "buy", venue: "pumpfun", lamports: 1, tokens: "100", createdAt: T0, expiresAt: T0, status: "built", slippageBps: 100 });
  r.store.markSent("seed", SIG(9));
  assert.equal((await one(r, trade({ side: "sell", quoteAmount: 5 }))).status, "pending");
});

test("one follower's skip does not stop another's intent", async () => {
  const r = rig({ list: [settings({ enabled: false }), settings({ follower: BOB })] });
  const out = await r.engine.onLeaderTrade(trade());
  assert.deepEqual(out.map((i) => [i.follower, i.status]), [[ALICE, "skipped"], [BOB, "pending"]]);
});

// ---- idempotency and expiry ---------------------------------------------------------------

test("the same (follower, signature) yields the same intent and one notification", async () => {
  const r = rig();
  const a = await one(r), b = await one(r);
  assert.equal(a.id, b.id);
  assert.equal(r.notified.length, 1);
  assert.equal(r.store.list(ALICE, undefined, T0).length, 1);
  assert.notEqual((await one(r, trade({ signature: SIG(2) }))).id, a.id);
});

test("a skip is idempotent too, even if settings change afterwards", async () => {
  const r = rig({ list: [settings({ enabled: false })] });
  const a = await one(r);
  r.setList([settings()]);
  const b = await one(r);
  assert.equal(b.id, a.id);
  assert.equal(b.status, "skipped");
});

test("pending intents expire after 60 s and cannot be built or listed as pending", async () => {
  const r = rig();
  const i = await one(r);
  r.clock.t = T0 + 59_999;
  assert.equal(r.store.list(ALICE, "pending", r.clock.t).length, 1);
  r.clock.t = T0 + 60_000;
  assert.equal(r.store.list(ALICE, "pending", r.clock.t).length, 0);
  assert.equal(r.store.get(i.id).status, "expired");
  await assert.rejects(buildIntent({ store: r.store, now: () => r.clock.t }, i.id, ALICE), (e) => e instanceof BuildError && e.code === "expired");
});

// ---- daily cap ----------------------------------------------------------------------------

test("daily cap: counts pending intents, rolls over after 24 h, ignores skips and expired intents", async () => {
  const r = rig({ list: [settings({ fixedLamports: 0.4 * SOL, dailyCapLamports: 1 * SOL })] });
  assert.equal((await one(r, trade({ signature: SIG(1) }))).status, "pending"); // 0.4
  assert.equal((await one(r, trade({ signature: SIG(2) }))).status, "pending"); // 0.8
  const third = await one(r, trade({ signature: SIG(3) })); // 1.2 > 1
  assert.equal(third.skipReason, "over_daily_cap");
  r.clock.t = T0 + 61_000; // the two pending expired: they never executed, so they free the cap
  const fresh = (n) => trade({ signature: SIG(n), timestamp: Math.floor(r.clock.t / 1000) });
  assert.equal((await one(r, fresh(4))).status, "pending");
  assert.equal((await one(r, fresh(5))).status, "pending");
  assert.equal((await one(r, fresh(6))).skipReason, "over_daily_cap");
});

test("daily cap: exactly reaching the cap is allowed; the window is 24 h", async () => {
  const r = rig({ list: [settings({ fixedLamports: 0.5 * SOL, dailyCapLamports: 1 * SOL })] });
  const mk = async (n) => { const i = await one(r, trade({ signature: SIG(n), timestamp: Math.floor(r.clock.t / 1000) })); return i; };
  const a = await mk(1), b = await mk(2);
  assert.deepEqual([a.status, b.status], ["pending", "pending"]);
  for (const i of [a, b]) { r.store.markBuilt(i.id, { venue: "pumpfun" }); r.store.markSent(i.id, SIG(50)); }
  assert.equal((await mk(3)).skipReason, "over_daily_cap");
  r.clock.t = T0 + 24 * 3600 * 1000 + 1;
  assert.equal((await mk(4)).status, "pending");
});

test("ratio mode sizes from the leader's trade and is checked against the per-trade cap", async () => {
  const r = rig({ list: [settings({ mode: "ratio", ratioBps: 2500, maxPerTradeLamports: 0.3 * SOL })] });
  const i = await one(r, trade({ quoteAmount: 1 })); // 25% of 1 SOL
  assert.equal(i.lamports, 0.25 * SOL);
  assert.equal((await one(r, trade({ signature: SIG(2), quoteAmount: 2 }))).skipReason, "over_per_trade_cap"); // 0.5 > 0.3
});

// ---- builder fakes ------------------------------------------------------------------------

const cuLimit = { programAddress: "ComputeBudget111111111111111111111111111111", data: Uint8Array.from([2, 0x40, 0x0d, 0x03, 0x00]) };
const BLOCKHASH = { blockhash: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi", lastValidBlockHeight: 100n };
const pumpFake = (venue = "curve", tokensOut = 1000n) => ({
  calls: [],
  async buy(p) { this.calls.push(["buy", p]); return { instructions: [cuLimit], quote: { venue, solIn: p.solIn, tokensOut, feeLamports: p.solIn / 200n } }; },
  async sell(p) { this.calls.push(["sell", p]); return { instructions: [cuLimit], quote: { venue, tokensIn: p.tokensIn, solOut: p.tokensIn * 2n, feeLamports: 7n } }; },
});
const jupFake = (follower) => ({
  calls: [],
  async order(req) {
    this.calls.push(req);
    return { inputMint: req.inputMint, outputMint: req.outputMint, inAmount: String(req.amount), outAmount: "5000", feeBps: 50, slippageBps: 100, requestId: "r",
      transaction: compileUnsigned(req.payer ?? follower, [cuLimit], BLOCKHASH) };
  },
});
const chain = { latestBlockhash: async () => BLOCKHASH };

test("build: Pump curve while on the curve, unsigned transaction, fee and lamports reported", async () => {
  const r = rig();
  const i = await one(r);
  const pump = pumpFake("curve", 4242n);
  const b = await buildIntent({ store: r.store, pump, jupiter: jupFake(ALICE), chain, now: () => r.clock.t }, i.id, ALICE);
  assert.equal(b.venue, "pumpfun");
  assert.equal(b.lamports, 0.1 * SOL);
  assert.equal(b.feeLamports, (0.1 * SOL) / 200);
  assert.ok(Buffer.from(b.transaction, "base64").length > 64);
  assert.equal(pump.calls[0][1].user, ALICE);
  const row = r.store.get(i.id);
  assert.equal(row.status, "built");
  assert.equal(row.tokens, "4242");
  await assert.rejects(buildIntent({ store: r.store, pump, jupiter: jupFake(ALICE), chain }, i.id, ALICE), (e) => e.code === "not_pending");
});

test("build: graduated coins (AMM) and non-Pump coins go through Jupiter, with the sponsor as fee payer", async () => {
  for (const pump of [pumpFake("amm"), { buy: async () => null, sell: async () => null }]) {
    const r = rig();
    const i = await one(r);
    const jup = jupFake(ALICE);
    const b = await buildIntent({ store: r.store, pump, jupiter: jup, chain, now: () => r.clock.t }, i.id, ALICE);
    assert.equal(b.venue, "jupiter");
    assert.equal(jup.calls[0].taker, ALICE);
    assert.equal(jup.calls[0].inputMint, "So11111111111111111111111111111111111111112");
    assert.equal(b.feeLamports, Math.floor((0.1 * SOL * 50) / 10_000));
    assert.equal(r.store.get(i.id).tokens, "5000");
  }
  const r = rig();
  const i = await one(r);
  const SPONSOR = "6fD1gQhJXSmhFniSDmtrxK3Mrfqtyg1ox7tESzyvcq1r";
  // the fake gives the sponsor as fee payer, but the follower is not a signer: checkTransaction must refuse
  await assert.rejects(buildIntent({ store: r.store, pump: pumpFake("amm"), jupiter: jupFake(ALICE), chain, sponsor: SPONSOR }, i.id, ALICE), (e) => e instanceof BuildError && e.code === "build_failed");
  assert.equal(r.store.get(i.id).status, "pending", "a refused build leaves the intent pending");
});

test("build: a perp intent is not built (TODO) and says so with a code", async () => {
  const r = rig({ tiers: { tierOf: async () => 0 } });
  const [i] = await r.engine.onLeaderPerp(perp());
  await assert.rejects(buildIntent({ store: r.store, pump: pumpFake(), jupiter: jupFake(ALICE), chain }, i.id, ALICE), (e) => e.code === "perps_build_unsupported");
});

// ---- sell sizing from copy positions ------------------------------------------------------

async function copyBuy(r, n, lamports, tokens) {
  const i = await one(r, trade({ signature: SIG(n), quoteAmount: 1 }));
  r.store.markBuilt(i.id, { venue: "pumpfun", lamports, tokens: String(tokens) });
  assert.ok(r.store.markSent(i.id, SIG(100 + n)));
  return i;
}

test("sells only up to the position acquired through copies, sized at cost basis", async () => {
  const r = rig({ list: [settings({ fixedLamports: 0.1 * SOL })] });
  await copyBuy(r, 1, 0.1 * SOL, 1000);
  await copyBuy(r, 2, 0.1 * SOL, 500);
  assert.deepEqual(r.store.position(ALICE, MINT), { tokens: 1500n, costLamports: BigInt(0.2 * SOL) });
  // fixed 0.1 SOL out of 0.2 SOL cost basis -> half the tokens
  const s1 = await one(r, trade({ signature: SIG(3), side: "sell" }));
  assert.equal(s1.status, "pending");
  assert.equal(s1.tokens, "750");
  // the pending sell reserves its tokens: the next sell can only take the remaining 750
  const s2 = await one(r, trade({ signature: SIG(4), side: "sell", quoteAmount: 50 }));
  assert.equal(s2.tokens, "750");
  const s3 = await one(r, trade({ signature: SIG(5), side: "sell" }));
  assert.equal(s3.skipReason, "no_copy_position");
  // a different mint has no position
  assert.equal((await one(r, trade({ signature: SIG(6), side: "sell", mint: MINT2 }))).skipReason, "no_copy_position");
});

test("ratio sells larger than the position are clamped; sending a sell reduces position and cost proportionally", async () => {
  const r = rig({ list: [settings({ mode: "ratio", ratioBps: 10_000 })] });
  await copyBuy(r, 1, 0.3 * SOL, 900);
  const sell = await one(r, trade({ signature: SIG(2), side: "sell", quoteAmount: 0.1 }));
  assert.equal(sell.tokens, "300"); // 0.1 of 0.3 SOL cost
  r.store.markBuilt(sell.id, { venue: "jupiter", lamports: 0.12 * SOL });
  r.store.markSent(sell.id, SIG(77));
  assert.deepEqual(r.store.position(ALICE, MINT), { tokens: 600n, costLamports: BigInt(0.2 * SOL) });
  const big = await one(r, trade({ signature: SIG(3), side: "sell", quoteAmount: 99 }));
  assert.equal(big.tokens, "600");
});

test("markSent needs the built state and the owner", async () => {
  const r = rig();
  const i = await one(r);
  assert.equal(r.store.markSent(i.id, SIG(9)), false); // still pending
  r.store.markBuilt(i.id, { venue: "pumpfun", tokens: "10" });
  assert.equal(r.store.markSent(i.id, SIG(9), BOB), false);
  assert.equal(r.store.markSent(i.id, SIG(9), ALICE), true);
  assert.equal(r.store.markSent(i.id, SIG(9), ALICE), false); // not twice: the position is counted once
  assert.equal(r.store.position(ALICE, MINT).tokens, 10n);
});

// ---- perps --------------------------------------------------------------------------------

const perp = (o = {}) => ({ leader: LEADER, market: "mkt", mint: MINT, side: "long", sizeUsd: 500, leverage: 8, signature: SIG(20), slot: 5, timestamp: Math.floor(T0 / 1000), action: "open", ...o });

test("leverage is capped at min(maxLeverage, tier max); tier table mirrors the program", () => {
  assert.deepEqual([...TIER_MAX_LEVERAGE], [2, 5, 10]);
  assert.equal(tierMaxLeverage(7), 10);
  assert.equal(tierMaxLeverage(null), 2);
  assert.equal(cappedLeverage(8, 5, 2), 5); // follower cap binds
  assert.equal(cappedLeverage(8, 20, 1), 5); // tier binds
  assert.equal(cappedLeverage(8, 20, 0), 2);
  assert.equal(cappedLeverage(3, 20, 2), 3); // leader's own lower leverage kept
});

test("perp copy intents carry the capped leverage", async () => {
  for (const [tier, maxLev, want] of [[0, 20, 2], [1, 20, 5], [2, 20, 10], [2, 4, 4], [1, 3, 3]]) {
    const r = rig({ list: [settings({ maxLeverage: maxLev })], tiers: { tierOf: async () => tier } });
    const [i] = await r.engine.onLeaderPerp(perp({ leverage: 50 }));
    assert.equal(i.status, "pending", `tier ${tier}`);
    assert.equal(i.leverage, want, `tier ${tier} max ${maxLev}`);
    assert.equal(i.venue, "ringside-perps");
    assert.equal(i.kind, "perp");
    assert.equal(i.side, "long");
  }
});

test("perps are refused when copyPerps is false, the env gate is off, or there is no market", async () => {
  let r = rig({ list: [settings({ copyPerps: false })], tiers: { tierOf: async () => 2 } });
  assert.equal((await r.engine.onLeaderPerp(perp()))[0].skipReason, "perps_disabled");
  r = rig({ tiers: { tierOf: async () => 2 }, perpsEnabled: false });
  assert.equal((await r.engine.onLeaderPerp(perp()))[0].skipReason, "perps_gate_off");
  r = rig({ tiers: { tierOf: async () => null } });
  assert.equal((await r.engine.onLeaderPerp(perp()))[0].skipReason, "no_perp_market");
  r = rig({ list: [settings({ mode: "ratio" })], tiers: { tierOf: async () => 2 } });
  assert.equal((await r.engine.onLeaderPerp(perp()))[0].skipReason, "no_price");
});

test("the env gate defaults off", async () => {
  const prev = process.env.RINGSIDE_COPY_PERPS;
  delete process.env.RINGSIDE_COPY_PERPS;
  try {
    const store = new CopyStore(":memory:");
    const engine = createCopyEngine({ social: { copySettingsForLeader: async () => [settings()], notify: async () => {} }, flags: { tokenFacts: async () => ({ flags: [], ageSec: 1 }) }, store, now: () => T0 });
    assert.equal((await engine.onLeaderPerp(perp()))[0].skipReason, "perps_gate_off");
    process.env.RINGSIDE_COPY_PERPS = "1";
    const on = createCopyEngine({ social: { copySettingsForLeader: async () => [settings()], notify: async () => {} }, flags: { tokenFacts: async () => ({ flags: [], ageSec: 1 }) }, store, now: () => T0 });
    assert.equal((await on.onLeaderPerp(perp({ signature: SIG(21) })))[0].status, "pending");
  } finally {
    if (prev === undefined) delete process.env.RINGSIDE_COPY_PERPS; else process.env.RINGSIDE_COPY_PERPS = prev;
  }
});

test("perp close is copied only when the follower has a sent open", async () => {
  const r = rig({ tiers: { tierOf: async () => 1 } });
  const close = (n) => perp({ action: "close", signature: SIG(n) });
  assert.equal((await r.engine.onLeaderPerp(close(30)))[0].skipReason, "no_copy_position");
  const [open] = await r.engine.onLeaderPerp(perp({ signature: SIG(31) }));
  r.store.markBuilt(open.id, { venue: "ringside-perps" });
  r.store.markSent(open.id, SIG(90));
  const [c] = await r.engine.onLeaderPerp(close(32));
  assert.equal(c.status, "pending");
  assert.equal(c.side, "close");
});

// ---- HTTP: isolation and ingest auth ------------------------------------------------------

async function http(extra = {}) {
  const r = rig({ list: [settings(), settings({ follower: BOB })] });
  const server = createCopyServer({
    store: r.store, engine: r.engine,
    build: { store: r.store, pump: pumpFake("curve"), jupiter: jupFake(ALICE), chain },
    authenticate: hmacSessionAuth(SESSION), ingestSecret: INGEST, corsOrigin: "https://app.example", now: () => r.clock.t, ...extra,
  });
  server.listen(0);
  await new Promise((res) => server.once("listening", res));
  const base = `http://127.0.0.1:${server.address().port}`;
  const tok = (u) => ({ authorization: `Bearer ${createSessionToken(SESSION, u, 600)}` });
  const call = async (method, path, { headers = {}, body } = {}) => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null, text };
  };
  return { r, call, tok, stop: () => { server.close(); server.closeAllConnections?.(); } };
}
const ingest = (h, t = trade(), auth = `Bearer ${INGEST}`) => h.call("POST", "/ingest/trade", { headers: auth ? { authorization: auth } : {}, body: { trade: t } });

test("ingest refuses a missing or wrong secret and creates nothing", async () => {
  const h = await http();
  try {
    for (const auth of [null, "Bearer nope", `Bearer ${INGEST}x`, INGEST, "Bearer ", `Basic ${INGEST}`]) {
      const res = await ingest(h, trade(), auth);
      assert.equal(res.status, 401, String(auth));
      assert.deepEqual(res.body, { error: { code: "unauthorized" } });
    }
    assert.equal(h.r.store.list(ALICE, undefined, T0).length, 0);
    const ok = await ingest(h);
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { trades: 1, pending: 2 });
    assert.equal((await ingest(h, { ...trade(), wallet: "bad" })).status, 400);
  } finally { h.stop(); }
});

test("one follower cannot see, build or mark sent another's intent", async () => {
  const h = await http();
  try {
    await ingest(h);
    const a = await h.call("GET", "/intents?status=pending", { headers: h.tok(ALICE) });
    const b = await h.call("GET", "/intents?status=pending", { headers: h.tok(BOB) });
    assert.equal(a.body.intents.length, 1);
    assert.equal(b.body.intents.length, 1);
    assert.equal(a.body.intents[0].follower, ALICE);
    assert.equal(b.body.intents[0].follower, BOB);
    assert.notEqual(a.body.intents[0].id, b.body.intents[0].id);
    assert.equal("slippageBps" in a.body.intents[0], false);
    const aliceId = a.body.intents[0].id;

    const steal = await h.call("POST", `/intents/${aliceId}/build`, { headers: h.tok(BOB) });
    const missing = await h.call("POST", `/intents/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}/build`, { headers: h.tok(BOB) });
    assert.equal(steal.status, 404);
    assert.deepEqual(steal.body, missing.body, "no existence oracle");
    assert.equal(h.r.store.get(aliceId).status, "pending");

    const built = await h.call("POST", `/intents/${aliceId}/build`, { headers: h.tok(ALICE) });
    assert.equal(built.status, 200);
    assert.deepEqual(Object.keys(built.body).sort(), ["feeLamports", "lamports", "transaction", "venue"]);

    const theft = await h.call("POST", `/intents/${aliceId}/sent`, { headers: h.tok(BOB), body: { signature: SIG(7) } });
    assert.equal(theft.status, 404);
    assert.equal(h.r.store.get(aliceId).status, "built");
    const sent = await h.call("POST", `/intents/${aliceId}/sent`, { headers: h.tok(ALICE), body: { signature: SIG(7) } });
    assert.equal(sent.status, 200);
    assert.equal(h.r.store.position(ALICE, MINT).tokens, 1000n);
    assert.equal(h.r.store.position(BOB, MINT).tokens, 0n);
    assert.equal((await h.call("POST", `/intents/${aliceId}/sent`, { headers: h.tok(ALICE), body: { signature: SIG(7) } })).status, 409);
  } finally { h.stop(); }
});

test("session auth is required; errors carry codes only; CORS is one exact origin", async () => {
  const h = await http();
  try {
    assert.equal((await h.call("GET", "/intents")).status, 401);
    assert.equal((await h.call("GET", "/intents", { headers: { authorization: "Bearer v1.x.y" } })).status, 401);
    assert.equal((await h.call("GET", "/intents?status=bogus", { headers: h.tok(ALICE) })).status, 400);
    const bad = await h.call("POST", "/intents/not-an-id/build", { headers: h.tok(ALICE) });
    assert.equal(bad.status, 404);
    assert.match(bad.text, /^\{"error":\{"code":"not_found"\}\}$/);
    const allowed = await h.call("GET", "/health", { headers: { origin: "https://app.example" } });
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://app.example");
    const other = await h.call("GET", "/health", { headers: { origin: "https://evil.example" } });
    assert.equal(other.headers.get("access-control-allow-origin"), null);
    const pre = await h.call("OPTIONS", "/intents", { headers: { origin: "https://app.example" } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "https://app.example");
  } finally { h.stop(); }
  assert.throws(() => createCopyServer({ store: new CopyStore(), engine: {}, build: {}, authenticate: async () => null, ingestSecret: INGEST, corsOrigin: "*" }));
  assert.throws(() => createCopyServer({ store: new CopyStore(), engine: {}, build: {}, authenticate: async () => null, ingestSecret: "" }));
});

test("body size limit and rate limits", async () => {
  const h = await http({ rateLimit: { windowMs: 60_000, max: 3 } });
  try {
    const big = await h.call("POST", "/ingest/trade", { headers: { authorization: `Bearer ${INGEST}` }, body: JSON.stringify({ trade: trade(), pad: "x".repeat(70_000) }) });
    assert.equal(big.status, 413);
    const codes = [];
    for (let n = 0; n < 5; n++) codes.push((await h.call("GET", "/intents", { headers: h.tok(ALICE) })).status);
    assert.ok(codes.includes(429), codes.join());
  } finally { h.stop(); }
});

test("parseTrade rejects malformed input", () => {
  assert.ok(parseTrade(trade()));
  for (const bad of [null, [], { ...trade(), side: "hold" }, { ...trade(), quoteAmount: -1 }, { ...trade(), signature: "short" }, { ...trade(), timestamp: 1.5 }, { ...trade(), mint: "x" }]) assert.equal(parseTrade(bad), null);
});
