// Copy engine: intents, skips, caps, sell sizing, perps leverage, build, HTTP auth. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCopyEngine } from "../dist/copy/engine.js";
import { CopyStore } from "../dist/copy/store.js";
import { confirmIntent, confirmPending } from "../dist/copy/confirm.js";
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
  r.store.confirmSent("seed", 100n);
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
  for (const [k, i] of [a, b].entries()) { r.store.markBuilt(i.id, { venue: "pumpfun" }); r.store.markSent(i.id, SIG(50 + k)); }
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
// trade() fills at 0.001 SOL per UI token, so 0.1 SOL buys 100 tokens = 100_000_000 raw (6 decimals)
const pumpFake = (venue = "curve", tokensOut = 100_000_000n) => ({
  calls: [],
  async buy(p) { this.calls.push(["buy", p]); return { instructions: [cuLimit], quote: { venue, solIn: p.solIn, tokensOut, slippageBps: 100, maxSolCost: p.solIn, feeLamports: p.solIn / 200n } }; },
  async sell(p) { this.calls.push(["sell", p]); return { instructions: [cuLimit], quote: { venue, tokensIn: p.tokensIn, solOut: p.tokensIn * 2n, minSolOut: p.tokensIn * 2n - 1n, slippageBps: 100, feeLamports: 7n } }; },
});
const jupFake = (follower) => ({
  calls: [],
  async order(req) {
    this.calls.push(req);
    return { inputMint: req.inputMint, outputMint: req.outputMint, inAmount: String(req.amount), outAmount: "100000000", feeBps: 50, slippageBps: 100, requestId: "r",
      transaction: compileUnsigned(req.payer ?? follower, [cuLimit], BLOCKHASH) };
  },
});
const chain = { latestBlockhash: async () => BLOCKHASH };

test("build: Pump curve while on the curve, unsigned transaction, fee and lamports reported", async () => {
  const r = rig();
  const i = await one(r);
  const pump = pumpFake("curve", 100_004_242n);
  const b = await buildIntent({ store: r.store, pump, jupiter: jupFake(ALICE), chain, now: () => r.clock.t }, i.id, ALICE);
  assert.equal(b.venue, "pumpfun");
  assert.equal(b.lamports, 0.1 * SOL);
  assert.equal(b.feeLamports, (0.1 * SOL) / 200);
  assert.ok(Buffer.from(b.transaction, "base64").length > 64);
  assert.equal(pump.calls[0][1].user, ALICE);
  const row = r.store.get(i.id);
  assert.equal(row.status, "built");
  assert.equal(row.tokens, "100004242");
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
    assert.equal(r.store.get(i.id).tokens, "100000000");
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
  assert.ok(r.store.confirmSent(i.id, BigInt(tokens)));
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
  r.store.confirmSent(sell.id, 300n);
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
  assert.equal(r.store.get(i.id).status, "sent_unconfirmed");
  assert.equal(r.store.markSent(i.id, SIG(9), ALICE), false); // not twice
  assert.equal(r.store.position(ALICE, MINT).tokens, 0n, "reported, not proven: no position yet");
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
  r.store.confirmSent(open.id, 0n);
  const [c] = await r.engine.onLeaderPerp(close(32));
  assert.equal(c.status, "pending");
  assert.equal(c.side, "close");
});

// ---- HTTP: isolation and ingest auth ------------------------------------------------------

const okTx = (owner, delta, o = {}) => ({
  err: null, signers: [owner], accounts: [MINT],
  preTokenBalances: [{ owner, mint: MINT, amount: "0" }], postTokenBalances: [{ owner, mint: MINT, amount: String(delta) }], ...o,
});

async function http(extra = {}) {
  const r = rig({ list: [settings(), settings({ follower: BOB })] });
  const server = createCopyServer({
    store: r.store, engine: r.engine,
    build: { store: r.store, pump: pumpFake("curve"), jupiter: jupFake(ALICE), chain },
    tx: { getTransaction: async () => okTx(ALICE, 100_000_000n) },
    authenticate: hmacSessionAuth(SESSION, { aud: "copy" }), ingestSecret: INGEST, corsOrigin: "https://app.example", now: () => r.clock.t, ...extra,
  });
  server.listen(0);
  await new Promise((res) => server.once("listening", res));
  const base = `http://127.0.0.1:${server.address().port}`;
  const tok = (u) => ({ authorization: `Bearer ${createSessionToken(SESSION, u, 600, Date.now(), "copy")}` });
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
    assert.deepEqual(Object.keys(built.body).sort(), ["expectedOut", "feeLamports", "lamports", "minOut", "slippageBps", "transaction", "venue"]);

    const theft = await h.call("POST", `/intents/${aliceId}/sent`, { headers: h.tok(BOB), body: { signature: SIG(7) } });
    assert.equal(theft.status, 404);
    assert.equal(h.r.store.get(aliceId).status, "built");
    const sent = await h.call("POST", `/intents/${aliceId}/sent`, { headers: h.tok(ALICE), body: { signature: SIG(7) } });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.status, "sent"); // confirmed by the fake chain
    assert.equal(h.r.store.position(ALICE, MINT).tokens, 100_000_000n);
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

// ---- review fixes: bait trades, stuck intents, unproven sends, bind address ----------------

const deps = (r, o = {}) => ({ store: r.store, pump: pumpFake("curve"), jupiter: jupFake(ALICE), chain, now: () => r.clock.t, ...o });

test("H2: a 1-lamport leader buy does not trigger a follower buy; the floor scales with the copy size", async () => {
  const r = rig();
  const i = await one(r, trade({ quoteAmount: 1e-9 }));
  assert.equal(i.status, "skipped");
  assert.equal(i.skipReason, "leader_trade_too_small");
  assert.equal(r.notified.length, 0);
  // 0.04 SOL is under the 0.05 SOL floor; 0.05 passes
  assert.equal((await one(r, trade({ signature: SIG(2), quoteAmount: 0.04 }))).skipReason, "leader_trade_too_small");
  assert.equal((await one(r, trade({ signature: SIG(3), quoteAmount: 0.05 }))).status, "pending");
  // a follower copying 0.4 SOL needs a leader trade of at least 0.2 SOL (ratio 0.5)
  const big = rig({ list: [settings({ fixedLamports: 0.4 * SOL })] });
  assert.equal((await one(big, trade({ quoteAmount: 0.19 }))).skipReason, "leader_trade_too_small");
  assert.equal((await one(big, trade({ signature: SIG(2), quoteAmount: 0.2 }))).status, "pending");
  // exits are never blocked by the floor
  await copyBuy(big, 5, 0.1 * SOL, 100);
  assert.equal((await one(big, trade({ signature: SIG(6), side: "sell", quoteAmount: 0.0001 }))).status, "pending");
});

test("H2: a buy is refused when the price has moved more than 10% against the follower since the leader's fill", async () => {
  const r = rig();
  const i = await one(r);
  assert.equal(i.leaderPrice, 0.001);
  // 0.1 SOL at 0.001/token = 100_000_000 raw; 10% worse = 90_909_090 raw
  const worse = (tokensOut) => deps(r, { pump: pumpFake("curve", tokensOut) });
  await assert.rejects(buildIntent(worse(90_000_000n), i.id, ALICE), (e) => e instanceof BuildError && e.code === "price_moved");
  assert.equal(r.store.get(i.id).status, "pending", "a price refusal can be retried while the intent lives");
  await buildIntent(worse(91_000_000n), i.id, ALICE); // within 10%
  assert.equal(r.store.get(i.id).status, "built");
  // a better price always builds
  const r2 = rig();
  const j = await one(r2);
  await buildIntent(deps(r2, { pump: pumpFake("curve", 500_000_000n) }), j.id, ALICE);
  // the drift limit is configurable
  const r3 = rig();
  const k = await one(r3);
  await assert.rejects(buildIntent(deps(r3, { pump: pumpFake("curve", 95_000_000n), maxPriceDriftBps: 100 }), k.id, ALICE), (e) => e.code === "price_moved");
});

test("H2: a buy is refused once the leader has sold the mint after the source trade", async () => {
  const r = rig();
  const i = await one(r, trade({ slot: 100 }));
  await r.engine.onLeaderTrade(trade({ signature: SIG(2), side: "sell", slot: 101 })); // leader dumps
  await assert.rejects(buildIntent(deps(r), i.id, ALICE), (e) => e instanceof BuildError && e.code === "leader_exited");
  assert.equal(r.store.get(i.id).status, "skipped");
  assert.equal(r.store.get(i.id).skipReason, "leader_exited");
  // a sell of another mint, or before the buy, does not count
  const r2 = rig();
  await r2.engine.onLeaderTrade(trade({ signature: SIG(8), side: "sell", slot: 99 }));
  await r2.engine.onLeaderTrade(trade({ signature: SIG(9), side: "sell", slot: 150, mint: MINT2 }));
  const j = await one(r2, trade({ slot: 100 }));
  await buildIntent(deps(r2), j.id, ALICE);
  // the port is injectable
  const r3 = rig();
  const k = await one(r3);
  await assert.rejects(buildIntent(deps(r3, { exits: { leaderSoldSince: async () => true } }), k.id, ALICE), (e) => e.code === "leader_exited");
});

test("M1: built expiry (90 s) -> pending if the intent lives on, else expired; cap and reservations are released", async () => {
  // an engine with a long intent ttl, so the intent outlives the built window
  const store = new CopyStore(":memory:");
  const clock = { t: T0 };
  const social = { copySettingsForLeader: async () => [settings({ fixedLamports: 0.5 * SOL, dailyCapLamports: 1 * SOL })], notify: async () => {} };
  const engine = createCopyEngine({ social, flags: { tokenFacts: async () => ({ flags: [], ageSec: 1 }) }, store, perpsEnabled: false, now: () => clock.t, ttlMs: 600_000 });
  const [i] = await engine.onLeaderTrade(trade());
  await buildIntent({ store, pump: pumpFake("curve", 500_000_000n), jupiter: jupFake(ALICE), chain, now: () => clock.t }, i.id, ALICE);
  assert.equal(store.get(i.id).builtExpiresAt, T0 + 90_000);
  assert.equal(store.committedSince(ALICE, 0, clock.t), 0.5 * SOL);
  clock.t = T0 + 89_999;
  store.expireDue(clock.t);
  assert.equal(store.get(i.id).status, "built");
  clock.t = T0 + 90_000;
  store.expireDue(clock.t);
  assert.equal(store.get(i.id).status, "pending");
  await buildIntent({ store, pump: pumpFake("curve", 500_000_000n), jupiter: jupFake(ALICE), chain, now: () => clock.t }, i.id, ALICE); // rebuild
  assert.equal(store.get(i.id).status, "built");
  // past the intent's own expiry the built intent expires, and the cap is free again
  clock.t = T0 + 600_001;
  store.expireDue(clock.t);
  assert.equal(store.get(i.id).status, "expired");
  assert.equal(store.committedSince(ALICE, 0, clock.t), 0);
});

test("M1 (reviewer PoC): a built-but-never-sent sell no longer locks the position", async () => {
  const r = rig();
  const [b] = await r.engine.onLeaderTrade(trade());
  await buildIntent(deps(r), b.id, ALICE);
  r.store.markSent(b.id, SIG(9), ALICE);
  r.store.confirmSent(b.id, 100_000_000n);
  const [s] = await r.engine.onLeaderTrade(trade({ signature: SIG(2), side: "sell" }));
  await buildIntent(deps(r), s.id, ALICE);
  r.clock.t += 7 * 86_400_000;
  r.store.expireDue(r.clock.t);
  assert.equal(r.store.get(s.id).status, "expired");
  assert.equal(r.store.reservedSellTokens(ALICE, MINT), 0n);
  const [s2] = await r.engine.onLeaderTrade(trade({ signature: SIG(3), side: "sell", timestamp: Math.floor(r.clock.t / 1000) }));
  assert.equal(s2.status, "pending");
});

test("L2: a signature is unique across intents (reviewer PoC)", async () => {
  const r = rig();
  const ids = [];
  for (const n of [1, 2]) {
    const i = await one(r, trade({ signature: SIG(n) }));
    r.store.markBuilt(i.id, { venue: "pumpfun", tokens: "10" });
    ids.push(i.id);
  }
  assert.equal(r.store.markSent(ids[0], "1".repeat(88), ALICE), true);
  assert.equal(r.store.markSent(ids[1], "1".repeat(88), ALICE), false);
  assert.equal(r.store.get(ids[1]).status, "built");
});

async function sentIntent(r, sig = SIG(9), tokensOut = 100_000_000n) {
  const i = await one(r);
  await buildIntent(deps(r, { pump: pumpFake("curve", tokensOut) }), i.id, ALICE);
  assert.ok(r.store.markSent(i.id, sig, ALICE, r.clock.t));
  return i;
}

test("L2: sent_unconfirmed is not a position; confirmation records the actual token delta, not the quote", async () => {
  const r = rig();
  const i = await sentIntent(r);
  assert.equal(r.store.get(i.id).status, "sent_unconfirmed");
  assert.equal(r.store.position(ALICE, MINT).tokens, 0n);
  // a sell cannot be copied yet either
  assert.equal((await one(r, trade({ signature: SIG(2), side: "sell" }))).skipReason, "no_copy_position");
  // the quote said 100_000_000; the chain says 93_000_000 (slippage)
  const tx = { getTransaction: async () => okTx(ALICE, 93_000_000n) };
  assert.equal(await confirmIntent({ store: r.store, tx, now: () => r.clock.t }, i.id), "confirmed");
  assert.equal(r.store.get(i.id).status, "sent");
  assert.equal(r.store.position(ALICE, MINT).tokens, 93_000_000n);
});

test("L2: unconfirmed buys still count toward the daily cap", async () => {
  const r = rig({ list: [settings({ fixedLamports: 0.5 * SOL, dailyCapLamports: 0.5 * SOL })] });
  await sentIntent(r, SIG(9), 500_000_000n);
  assert.equal((await one(r, trade({ signature: SIG(2) }))).skipReason, "over_daily_cap");
});

test("L2: a missing, failed, foreign-signed or wrong-mint transaction never becomes a position", async () => {
  const bad = {
    "not signed by the follower": okTx(ALICE, 5n, { signers: [BOB] }),
    "failed on chain": okTx(ALICE, 5n, { err: { InstructionError: [0, "Custom"] } }),
    "other mint": { ...okTx(ALICE, 5n), accounts: [MINT2], preTokenBalances: [{ owner: ALICE, mint: MINT2, amount: "0" }], postTokenBalances: [{ owner: ALICE, mint: MINT2, amount: "5" }] },
    "no token received": okTx(ALICE, 0n),
    "tokens went to someone else": okTx(BOB, 5n, { signers: [ALICE] }),
  };
  for (const [why, chainTx] of Object.entries(bad)) {
    const r = rig();
    const i = await sentIntent(r);
    assert.equal(await confirmIntent({ store: r.store, tx: { getTransaction: async () => chainTx }, now: () => r.clock.t }, i.id), "failed", why);
    assert.equal(r.store.get(i.id).status, "failed", why);
    assert.equal(r.store.position(ALICE, MINT).tokens, 0n, why);
  }
});

test("L2: a transaction not found stays unconfirmed until its blockhash is dead, then fails and frees the cap", async () => {
  const r = rig({ list: [settings({ fixedLamports: 0.5 * SOL, dailyCapLamports: 0.5 * SOL })] });
  const i = await sentIntent(r, SIG(9), 500_000_000n);
  const missing = { getTransaction: async () => null };
  const d = () => ({ store: r.store, tx: missing, now: () => r.clock.t });
  r.clock.t += 60_000;
  assert.equal(await confirmIntent(d(), i.id), "unconfirmed");
  const flaky = { getTransaction: async () => { throw new Error("rpc down"); } };
  assert.equal(await confirmIntent({ ...d(), tx: flaky }, i.id), "unconfirmed");
  r.clock.t += 130_000;
  assert.equal(await confirmPending(d()), 0);
  assert.equal(r.store.get(i.id).status, "failed");
  assert.equal(r.store.committedSince(ALICE, 0, r.clock.t), 0);
  // later confirmation by the sweep
  const r2 = rig();
  const j = await sentIntent(r2);
  assert.equal(await confirmPending({ store: r2.store, tx: { getTransaction: async () => okTx(ALICE, 7n) }, now: () => r2.clock.t }), 1);
  assert.equal(r2.store.position(ALICE, MINT).tokens, 7n);
  void j;
});

test("L2: a confirmed sell reduces the position by the tokens actually sold", async () => {
  const r = rig();
  await copyBuy(r, 1, 0.1 * SOL, 1000);
  const s = await one(r, trade({ signature: SIG(2), side: "sell", quoteAmount: 1 }));
  r.store.markBuilt(s.id, { venue: "pumpfun" });
  r.store.markSent(s.id, SIG(60), ALICE);
  const tx = { getTransaction: async () => ({ ...okTx(ALICE, 0n), preTokenBalances: [{ owner: ALICE, mint: MINT, amount: "1000" }], postTokenBalances: [{ owner: ALICE, mint: MINT, amount: "600" }] }) };
  assert.equal(await confirmIntent({ store: r.store, tx }, s.id), "confirmed");
  assert.equal(r.store.position(ALICE, MINT).tokens, 600n);
});

test("L2: HTTP /sent with a signature that another intent used is a conflict", async () => {
  const h = await http();
  try {
    await ingest(h);
    await ingest(h, trade({ signature: SIG(2) }));
    const [a, b] = (await h.call("GET", "/intents?status=pending", { headers: h.tok(ALICE) })).body.intents;
    for (const i of [a, b]) await h.call("POST", `/intents/${i.id}/build`, { headers: h.tok(ALICE) });
    assert.equal((await h.call("POST", `/intents/${a.id}/sent`, { headers: h.tok(ALICE), body: { signature: SIG(7) } })).status, 200);
    assert.equal((await h.call("POST", `/intents/${b.id}/sent`, { headers: h.tok(ALICE), body: { signature: SIG(7) } })).status, 409);
    assert.equal(h.r.store.position(ALICE, MINT).tokens, 100_000_000n, "counted once");
  } finally { h.stop(); }
});

test("L6: the service binds to COPY_HOST, default 127.0.0.1", async () => {
  const { startCopyService } = await import("../dist/copy/main.js");
  const mk = (env) => {
    const social = { copySettingsForLeader: async () => [], notify: async () => {} };
    const base = { SESSION_SECRET: SESSION, COPY_INGEST_SECRET: INGEST, COPY_RPC_URL: "http://127.0.0.1:1", COPY_FEE_WALLET: ALICE, COPY_PORT: "0", COPY_DB: ":memory:" };
    return startCopyService(social, {}, { ...base, ...env });
  };
  for (const [env, want] of [[{}, "127.0.0.1"], [{ COPY_HOST: "127.0.0.2" }, "127.0.0.2"]]) {
    const svc = mk(env);
    await new Promise((res) => svc.server.once("listening", res));
    assert.equal(svc.server.address().address, want);
    svc.server.close();
  }
});

test("build response carries expectedOut, minOut and slippageBps, consistent for both venues", async () => {
  const isDec = (v) => typeof v === "string" && /^\d+$/.test(v);
  const check = (b) => { assert.ok(isDec(b.expectedOut) && isDec(b.minOut)); assert.ok(BigInt(b.minOut) <= BigInt(b.expectedOut)); assert.equal(b.slippageBps, 100); };
  // Pump buy: tokens out
  let r = rig(); let i = await one(r);
  let b = await buildIntent(deps(r, { pump: pumpFake("curve", 100_000_123n) }), i.id, ALICE);
  check(b); assert.equal(b.expectedOut, "100000123"); assert.equal(b.expectedOut, r.store.get(i.id).tokens);
  // Jupiter buy: outAmount and otherAmountThreshold
  r = rig(); i = await one(r);
  const jb = jupFake(ALICE); const orig = jb.order.bind(jb);
  jb.order = async (q) => ({ ...(await orig(q)), otherAmountThreshold: "99000000" });
  b = await buildIntent(deps(r, { pump: pumpFake("amm"), jupiter: jb }), i.id, ALICE);
  check(b); assert.equal(b.venue, "jupiter"); assert.equal(b.expectedOut, "100000000"); assert.equal(b.minOut, "99000000");
  // sells: lamports out
  for (const venue of ["pumpfun", "jupiter"]) {
    r = rig(); await copyBuy(r, 1, 0.1 * SOL, 1000);
    const s = await one(r, trade({ signature: SIG(2), side: "sell", quoteAmount: 1 }));
    const j = jupFake(ALICE); const o2 = j.order.bind(j);
    j.order = async (q) => ({ ...(await o2(q)), otherAmountThreshold: "4900" });
    const sb = await buildIntent(deps(r, venue === "pumpfun" ? { jupiter: j } : { pump: pumpFake("amm"), jupiter: j }), s.id, ALICE);
    check(sb); assert.equal(sb.venue, venue);
    if (venue === "pumpfun") assert.equal(sb.expectedOut, String(sb.lamports)); else assert.equal(sb.minOut, "4900");
  }
});
