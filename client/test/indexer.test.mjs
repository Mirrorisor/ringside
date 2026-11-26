// Indexer: Helius webhook ingest, sqlite store, wallet stats, token flags, read API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSwap, parseTransaction, ringsideLaunchParser, RINGSIDE_LAUNCH_PROGRAM } from "../dist/indexer/helius.js";
import { SqliteStore, WASH_MIN_FUNDING_LAMPORTS } from "../dist/indexer/store.js";
import { walletStats } from "../dist/indexer/stats.js";
import { bundles, holderBalances, insiders, snipers, topHolderConcentration, SNIPER_MAX_SLOTS, BUNDLE_MIN_WALLETS, INSIDER_MIN_FUNDING_LAMPORTS, TOP_HOLDERS } from "../dist/indexer/flags.js";
import { createIndexerServer, secretMatches, MAX_FEED_LIMIT, LEADERBOARD_MIN_TRADES, LEADERBOARD_MIN_VOLUME_SOL, RateLimiter, clientKey } from "../dist/indexer/server.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/helius/${name}.json`, import.meta.url), "utf8"));
const CREATOR = "22S3bVxfkoJB5L5EhFo1Hp3T9EtX1qLG4dP9UDcRQN6B";
const ALICE = "99cnRnduE5KdqhuJmYN5YH3WcnSiPQ152bF3hbxSfvKU";
const BOB = "s7KMacZHd83q5bUtXhVkPPwRsxut1ipy93wfxmWpnn8";
const CAROL = "8y5FVi7aTTSjwvLQkXFyRojbDrL8w9svysX8mZcEgmyK";
const DAVE = "6fD1gQhJXSmhFniSDmtrxK3Mrfqtyg1ox7tESzyvcq1r";
const MINT = "AbYGhAcF86iLQpQQynmZPZAyMejskVFowy2P2LBktuaH";
const SECRET = "test-secret-not-real-0123456789";
const NOW = 1763990100;
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ""} expected ${b}, got ${a}`);

/** Test stand-in for the TODO Ringside decoder: reports the launch. */
const fakeRingside = {
  programId: RINGSIDE_LAUNCH_PROGRAM,
  parse: (tx) => ({ launches: [{ mint: tx.instructions[0].accounts[1], creator: tx.feePayer, slot: tx.slot, timestamp: tx.timestamp, signature: tx.signature }] }),
};

async function startServer(parsers, extra = {}) {
  const store = extra.store ?? new SqliteStore(":memory:");
  const server = createIndexerServer({ store, webhookSecret: SECRET, parsers, now: () => NOW, ...extra });
  server.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, auth = SECRET) =>
    fetch(`${base}/webhooks/helius`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const get = async (path, headers = {}) => { const r = await fetch(base + path, { headers }); return { status: r.status, body: await r.json(), headers: r.headers }; };
  return { store, server, post, get, stop: () => { server.close(); store.close(); } };
}

async function loadAll(post) {
  for (const f of ["launch", "funding", "swap-buy-jupiter", "batch", "swap-sell-pumpfun"]) assert.equal((await post(fixture(f))).status, 200, f);
}

test("parses an events.swap SOL buy", () => {
  const t = parseSwap(fixture("swap-buy-jupiter")[0]);
  assert.deepEqual(t, {
    signature: "5x9AVKHTZSDZ1oApPM3MqV3HkjpUu3diS7ePGVHCa3nKXgafKEmK85gFE7eXDP8HMFp8ZaDGKZUFeuG5QMuRc5M9",
    slot: 300000000, timestamp: 1763990001, source: "JUPITER", wallet: ALICE, mint: MINT, side: "buy", tokenAmount: 1_000_000, quote: "SOL", quoteAmount: 1.5,
  });
});

test("falls back to transfers when events.swap is empty; net SOL includes fees", () => {
  const t = parseSwap(fixture("swap-sell-pumpfun")[0]);
  assert.equal(t.side, "sell");
  assert.equal(t.wallet, ALICE);
  assert.equal(t.tokenAmount, 400_000);
  close(t.quoteAmount, 0.891);
  assert.equal(t.source, "PUMP_FUN");
});

test("USDC buys, ATA rent is not trade cost, failed transactions are skipped", () => {
  const [usdc, failed, rent] = fixture("batch");
  assert.deepEqual([parseSwap(usdc).quote, parseSwap(usdc).quoteAmount, parseSwap(usdc).tokenAmount, parseSwap(usdc).wallet], ["USDC", 50, 20_000, BOB]);
  assert.equal(parseTransaction(failed), null);
  const t = parseSwap(rent);
  assert.equal(t.wallet, CAROL);
  close(t.quoteAmount, 0.2, "rent excluded");
});

test("rejects malformed transactions and non-trades", () => {
  assert.equal(parseTransaction(null), null);
  assert.equal(parseTransaction({ signature: "x", slot: 1, timestamp: 1 }), null);
  assert.equal(parseTransaction({ ...fixture("swap-buy-jupiter")[0], slot: -1 }), null);
  // token-to-token: two non-quote mints move
  const tx = structuredClone(fixture("swap-buy-jupiter")[0]);
  tx.events.swap.nativeInput = null;
  tx.events.swap.tokenInputs = [{ userAccount: ALICE, mint: DAVE, rawTokenAmount: { tokenAmount: "5", decimals: 0 } }];
  tx.tokenTransfers = [];
  tx.nativeTransfers = [];
  assert.equal(parseTransaction(tx).trades.length, 0);
  // a plain transfer keeps its SOL transfers for insider detection
  const p = parseTransaction(fixture("funding")[0]);
  assert.deepEqual(p.transfers.map((t) => [t.from, t.to, t.lamports]), [[CREATOR, ALICE, 500_000_000]]);
});

test("Ringside hook: called only for transactions touching the program; stub decodes nothing", () => {
  const launch = fixture("launch")[0];
  assert.equal(ringsideLaunchParser.parse(launch), null);
  assert.equal(parseTransaction(launch).launches.length, 0);
  assert.deepEqual(parseTransaction(launch, [fakeRingside]).launches.map((l) => [l.mint, l.creator]), [[MINT, CREATOR]]);
  let calls = 0;
  parseTransaction(fixture("swap-buy-jupiter")[0], [{ programId: RINGSIDE_LAUNCH_PROGRAM, parse: () => (calls++, null) }]);
  assert.equal(calls, 0);
});

test("webhook auth: missing or wrong Authorization is 401, nothing stored", async () => {
  const s = await startServer();
  try {
    assert.equal((await s.post(fixture("swap-buy-jupiter"), null)).status, 401);
    assert.equal((await s.post(fixture("swap-buy-jupiter"), SECRET + "x")).status, 401);
    assert.equal((await s.post(fixture("swap-buy-jupiter"), `Bearer ${SECRET}`)).status, 401);
    assert.equal(s.store.walletTrades(ALICE).length, 0);
    assert.equal(secretMatches(SECRET, SECRET), true);
    assert.equal(secretMatches(undefined, SECRET), false);
    assert.equal(secretMatches("", ""), false);
    assert.throws(() => createIndexerServer({ store: s.store, webhookSecret: "" }));
  } finally { s.stop(); }
});

test("webhook ingest is idempotent on signature and validates the body", async () => {
  const s = await startServer();
  try {
    const r1 = await (await s.post(fixture("batch"))).json();
    assert.deepEqual(r1, { received: 3, ingested: 2, duplicates: 0, skipped: 1, trades: 2 });
    const r2 = await (await s.post(fixture("batch"))).json();
    assert.deepEqual(r2, { received: 3, ingested: 0, duplicates: 2, skipped: 1, trades: 0 });
    assert.equal(s.store.mintTrades(MINT).length, 2);
    assert.equal((await s.post("{not json")).status, 400);
    assert.equal((await s.post({ signature: "x" })).status, 400, "object, not array");
    assert.equal((await fetch(`http://127.0.0.1:${s.server.address().port}/webhooks/helius`)).status, 405);
  } finally { s.stop(); }
});

test("wallet stats: average-cost realised PnL, open positions, win rate, windows", () => {
  const T = (side, tokenAmount, quoteAmount, timestamp, extra = {}) => ({ signature: `s${timestamp}`, wallet: ALICE, mint: MINT, side, tokenAmount, quote: "SOL", quoteAmount, slot: timestamp, timestamp, source: "X", ...extra });
  const day = 86_400;
  const trades = [
    T("buy", 100, 1, NOW - 10 * day),
    T("buy", 100, 3, NOW - 9 * day), // avg cost 0.02
    T("sell", 50, 2, NOW - 2 * day), // +1.0
    T("sell", 100, 1, NOW - 3600), // 1.0 - 2.0 = -1.0
    T("sell", 100, 5, NOW - 60, { mint: DAVE }), // no indexed cost basis: ignored
    T("buy", 10, 1, NOW - 30, { mint: DAVE }),
    T("sell", 10, 2, NOW - 20, { mint: DAVE }), // +1.0
  ];
  const s = walletStats(ALICE, trades, NOW);
  close(s.windows["30d"].realisedPnl.SOL, 1.0);
  close(s.windows["7d"].realisedPnl.SOL, 1.0);
  close(s.windows["24h"].realisedPnl.SOL, 0.0);
  assert.equal(s.windows["30d"].winRate, 0.5, "MINT net 0 is not a win, DAVE is");
  assert.equal(s.windows["24h"].winRate, 0.5);
  assert.equal(s.windows["30d"].trades, 7);
  assert.equal(s.windows["7d"].trades, 5);
  assert.equal(s.windows["24h"].trades, 4);
  close(s.windows["7d"].volume.SOL, 2 + 1 + 5 + 1 + 2);
  assert.equal(s.openPositions.length, 1);
  assert.equal(s.openPositions[0].tokenAmount, 50);
  close(s.openPositions[0].avgCost, 0.02);
  close(s.openPositions[0].costBasis, 1);
  assert.equal(walletStats(ALICE, [], NOW).windows["7d"].winRate, null);
});

const buy = (wallet, slot, tokenAmount = 100) => ({ signature: `sig-${wallet}-${slot}`, wallet, mint: MINT, side: "buy", tokenAmount, quote: "SOL", quoteAmount: 1, slot, timestamp: slot, source: "X" });

test("flag: snipers within SNIPER_MAX_SLOTS of the first trade or launch", () => {
  assert.equal(SNIPER_MAX_SLOTS, 2);
  const trades = [buy(CREATOR, 100), buy(ALICE, 101), buy(BOB, 102), buy(BOB, 102, 50), buy(CAROL, 103)];
  assert.deepEqual(snipers(trades).map((s) => [s.wallet, s.slotsAfterStart, s.tokenAmount]), [[CREATOR, 0, 100], [ALICE, 1, 100], [BOB, 2, 150]]);
  assert.deepEqual(snipers(trades, 100, CREATOR).map((s) => s.wallet), [ALICE, BOB], "creator excluded");
  assert.deepEqual(snipers(trades, 101).map((s) => s.wallet), [ALICE, BOB, CAROL]);
  assert.deepEqual(snipers([]), []);
});

test("flag: bundles need BUNDLE_MIN_WALLETS distinct buyers in one slot", () => {
  assert.equal(BUNDLE_MIN_WALLETS, 3);
  const sells = { ...buy(DAVE, 200), side: "sell" };
  assert.deepEqual(bundles([buy(ALICE, 200), buy(BOB, 200), buy(BOB, 200), sells]), [], "duplicates and sells do not count");
  assert.deepEqual(bundles([buy(ALICE, 200), buy(BOB, 200), buy(CAROL, 200), buy(DAVE, 201)]), [{ slot: 200, wallets: [ALICE, CAROL, BOB].sort() }]);
});

test("flag: insiders funded by the creator before their first buy", () => {
  const tr = (to, slot, lamports = INSIDER_MIN_FUNDING_LAMPORTS) => ({ signature: `t${to}${slot}`, from: CREATOR, to, lamports, slot, timestamp: slot });
  const trades = [buy(ALICE, 100), buy(BOB, 100), buy(CAROL, 100), buy(CREATOR, 99)];
  const transfers = [tr(ALICE, 90), tr(BOB, 150), tr(CAROL, 95, INSIDER_MIN_FUNDING_LAMPORTS - 1), { ...tr(DAVE, 10), from: DAVE, to: ALICE }];
  assert.deepEqual(insiders(CREATOR, trades, transfers).map((i) => [i.wallet, i.fundingSlot, i.firstBuySlot]), [[ALICE, 90, 100]]);
});

test("flag: top-10 holder concentration", () => {
  assert.equal(TOP_HOLDERS, 10);
  const balances = new Map(Array.from({ length: 20 }, (_, i) => [`w${String(i).padStart(2, "0")}`, i < 10 ? 5 : 1]));
  const c = topHolderConcentration(balances);
  assert.equal(c.topHolders.length, 10);
  close(c.topShare, 50 / 60);
  assert.equal(c.flagged, true);
  const low = topHolderConcentration(balances, 1_000);
  close(low.topShare, 0.05);
  assert.equal(low.flagged, false);
  const hb = holderBalances([buy(ALICE, 1, 100), { ...buy(ALICE, 2, 100), side: "sell" }, buy(BOB, 3, 7)]);
  assert.deepEqual([...hb], [[BOB, 7]], "closed positions drop out");
});

test("read API: /token/:mint/flags end to end from fixtures", async () => {
  const s = await startServer([fakeRingside]);
  try {
    await loadAll(s.post);
    const { status, body } = await s.get(`/token/${MINT}/flags`);
    assert.equal(status, 200);
    assert.equal(body.creator, CREATOR);
    assert.equal(body.trades, 4);
    assert.deepEqual(body.snipers.map((x) => x.wallet).sort(), [ALICE, BOB, CAROL].sort());
    assert.deepEqual(body.insiders.map((i) => i.wallet), [ALICE]);
    assert.deepEqual(body.bundles, []);
    assert.equal(body.concentration.topHolders[0].wallet, ALICE);
    assert.equal((await s.get("/token/not-a-mint/flags")).status, 400);
  } finally { s.stop(); }
});

test("read API: /wallet and /feed with input validation and capped limits", async () => {
  const s = await startServer();
  try {
    await loadAll(s.post);
    const w = await s.get(`/wallet/${ALICE}`);
    assert.equal(w.status, 200);
    close(w.body.windows["7d"].realisedPnl.SOL, 0.891 - 0.6);
    assert.equal(w.body.openPositions[0].tokenAmount, 600_000);
    assert.equal((await s.get("/wallet/0OIl")).status, 400);

    const f = await s.get(`/feed?wallets=${ALICE},${BOB}&limit=10`);
    assert.equal(f.status, 200);
    assert.deepEqual(f.body.trades.map((t) => [t.wallet, t.side]), [[ALICE, "sell"], [BOB, "buy"], [ALICE, "buy"]]);
    const one = await s.get(`/feed?wallets=${ALICE},${BOB}&limit=1`);
    assert.equal(one.body.trades.length, 1);
    const page2 = await s.get(`/feed?wallets=${ALICE},${BOB}&limit=10&before=${one.body.next}`);
    assert.equal(page2.body.trades.length, 2);
    assert.equal((await s.get(`/feed?wallets=${ALICE}&limit=999999`)).status, 200, "limit is capped, not rejected");
    assert.ok(MAX_FEED_LIMIT <= 200);
    assert.equal((await s.get("/feed")).status, 400);
    assert.equal((await s.get(`/feed?wallets=${ALICE},bad`)).status, 400);
    assert.equal((await s.get(`/feed?wallets=${ALICE}&limit=-1`)).status, 400);
    assert.equal((await s.get(`/feed?wallets=${ALICE}&limit=1e3`)).status, 400);
    const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const many = Array.from({ length: 101 }, (_, i) => ALICE.slice(0, -2) + B58[Math.floor(i / 58)] + B58[i % 58]).join(",");
    assert.equal((await s.get(`/feed?wallets=${many}`)).status, 400);
    assert.equal((await s.get("/nope")).status, 404);
  } finally { s.stop(); }
});

test("read API: /leaderboard ranks by window and metric", async () => {
  const d = await startServer();
  try {
    await loadAll(d.post);
    const lb = await d.get("/leaderboard?window=7d&by=pnl");
    assert.deepEqual(lb.body.entries, [], "fixture wallets are below the default minimum volume / trades");
    assert.equal(lb.body.minTrades, LEADERBOARD_MIN_TRADES);
    assert.equal(lb.body.minVolumeSol, LEADERBOARD_MIN_VOLUME_SOL);
  } finally { d.stop(); }
  const s = await startServer(undefined, { leaderboardMinVolumeSol: 0, leaderboardMinTrades: 1 });
  try {
    await loadAll(s.post);
    const lb = await s.get("/leaderboard?window=7d&by=pnl");
    assert.equal(lb.status, 200);
    assert.equal(lb.body.entries[0].wallet, ALICE);
    assert.equal(lb.body.entries[0].rank, 1);
    close(lb.body.entries[0].value, 0.291);
    assert.equal(lb.body.entries.length, 3);
    const byTrades = await s.get("/leaderboard?window=30d&by=trades&limit=1");
    assert.deepEqual(byTrades.body.entries.map((e) => [e.wallet, e.value]), [[ALICE, 2]]);
    assert.equal((await s.get("/leaderboard?window=1y")).status, 400);
    assert.equal((await s.get("/leaderboard?by=__proto__")).status, 400);
    assert.equal((await s.get("/leaderboard?window=toString")).status, 400);
  } finally { s.stop(); }
});

// ---------------------------------------------------------------------------
// Security review regressions (M4 denial of service, M5 leaderboard
// manipulation, L2 sponsored-trade attribution).

const SPONSOR = "9WEcBMSRNFyDsyZ964sGRQU7AR8VBchbUmxEHve8ejv5";
const TRADER = "EiTEoEJFpxofrtH36vJmqEPEjdJg4wu1BwvALBCaz8T9";
const CURVE = "6epuRPtABtf9xZYDJVzDBc7iuCSGdoWG7xfCG9isxddS";
const SPONSORS = new Set([SPONSOR]);
const timed = (label, fn, maxMs) => {
  const t0 = performance.now();
  const r = fn();
  const ms = performance.now() - t0;
  assert.ok(ms < maxMs, `${label} took ${ms.toFixed(0)} ms (limit ${maxMs})`);
  return r;
};
/** Distinct valid base58 addresses. */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const addr = (i, prefix = "W") => { let s = ""; for (let n = i, k = 0; k < 6; k++, n = Math.floor(n / 58)) s = B58[n % 58] + s; return (prefix + "1111111111111111111111111111111111111").slice(0, 38) + s; };
const sigOf = (i) => addr(i, "S").padEnd(88, "z");
/** A ParsedTx with one trade. */
const ptx = (i, t) => ({ signature: t.signature, slot: t.slot, timestamp: t.timestamp, trades: [t], transfers: [], launches: [] });
const mk = (i, wallet, mint, side, tokenAmount, quoteAmount, timestamp) => ({ signature: sigOf(i), wallet, mint, side, tokenAmount, quote: "SOL", quoteAmount, slot: timestamp, timestamp, source: "X" });
const fundTx = (i, from, to, lamports, timestamp = NOW - 100) => ({ signature: sigOf(i), slot: timestamp, timestamp, trades: [], transfers: [{ signature: sigOf(i), from, to, lamports, slot: timestamp, timestamp }], launches: [] });

test("M4: snipers and walletStats handle 300k trades (no spread into Math.min/max)", () => {
  const trades = Array.from({ length: 300_000 }, (_, i) => ({ signature: "s" + i, wallet: "w" + (i % 7), mint: "m", side: "buy", tokenAmount: 1, quote: "SOL", quoteAmount: 1, slot: i + 5, timestamp: 1 + i, source: "X" }));
  const sn = timed("snipers", () => snipers(trades), 2_000);
  assert.deepEqual(sn.map((x) => x.slot), [5, 6, 7]);
  const ws = timed("walletStats", () => walletStats("w", trades, 10), 3_000);
  assert.equal(ws.lastTradeAt, 300_000);
});

test("M4: transfersFrom accepts 40k recipients; flags use a subquery for buyers", () => {
  const st = new SqliteStore(":memory:");
  try {
    const to = Array.from({ length: 40_000 }, (_, i) => addr(i));
    st.ingest(fundTx(1, CREATOR, to[39_999], 1_000_000_000));
    st.ingest(fundTx(2, CREATOR, ALICE, 1_000_000_000));
    const got = timed("transfersFrom", () => st.transfersFrom(CREATOR, to), 1_000);
    assert.deepEqual(got.map((t) => t.to), [to[39_999]]);
    // 40k buyers of one mint, the last one creator-funded.
    st.ingestMany(to.map((w, i) => ptx(i, mk(100 + i, w, MINT, "buy", 1, 0.01, NOW - 50))));
    assert.deepEqual(timed("transfersToBuyers", () => st.transfersToBuyers(CREATOR, MINT), 1_000).map((t) => t.to), [to[39_999]]);
  } finally { st.close(); }
});

/** Expected leaderboard from the reference replay (walletStats) over all wallets. */
function referenceBoard(byWallet, window, by, minVolumeSol, minTrades) {
  const rows = [];
  for (const [w, trades] of byWallet) {
    const s = walletStats(w, trades, NOW).windows[window];
    if (s.volume.SOL < minVolumeSol || s.trades < minTrades) continue;
    const value = by === "pnl" ? s.realisedPnl.SOL : by === "volume" ? s.volume.SOL : by === "trades" ? s.trades : s.winRate ?? -1;
    rows.push({ wallet: w, value });
  }
  return rows.sort((a, b) => b.value - a.value || (a.wallet < b.wallet ? -1 : 1));
}

test("M4/M5: leaderboard over 60k trades / 12k wallets is ranked in SQL from incremental aggregates", async () => {
  const store = new SqliteStore(":memory:");
  const byWallet = new Map();
  const txs = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  // 60k rather than 300k trades: SQLite ingest runs ~35k trades/s here, and
  // the read path, not ingest, is what this guards. 12k wallets is well past
  // the old 5,000-wallet scan cap.
  const WALLETS = 12_000, PER = 5;
  for (let k = 0; k < PER; k++) {
    for (let w = 0; w < WALLETS; w++) {
      const i = k * WALLETS + w;
      const wallet = addr(w);
      const side = k % 3 === 2 ? "sell" : "buy";
      const t = mk(i, wallet, addr(w % 50, "M"), side, 100, side === "buy" ? 1 + rnd() : 1.2 + rnd() * 2, NOW - 3 * 86_400 + k * 600);
      txs.push(ptx(i, t));
      if (!byWallet.has(wallet)) byWallet.set(wallet, []);
      byWallet.get(wallet).push(t);
    }
  }
  // The best trader is the last wallet, far past the old 5,000-wallet scan cap.
  const star = addr(WALLETS - 1);
  const starSell = mk(9_999_999, star, addr(49, "M"), "sell", 100, 1_000, NOW - 60);
  txs.push(ptx(0, starSell));
  byWallet.get(star).push(starSell);
  assert.equal(txs.length, WALLETS * PER + 1);

  const t0 = performance.now();
  for (let i = 0; i < txs.length; i += 1_000) store.ingestMany(txs.slice(i, i + 1_000));
  const ingestMs = performance.now() - t0;

  const s = await startServer(undefined, { store, rateLimit: false });
  try {
    for (const by of ["pnl", "volume", "winrate", "trades"]) {
      const t1 = performance.now();
      const lb = await s.get(`/leaderboard?window=7d&by=${by}&limit=100`);
      const ms = performance.now() - t1;
      assert.equal(lb.status, 200);
      assert.ok(ms < 2_000, `leaderboard ${by} took ${ms.toFixed(0)} ms`);
      const ref = referenceBoard(byWallet, "7d", by, LEADERBOARD_MIN_VOLUME_SOL, LEADERBOARD_MIN_TRADES).slice(0, 100);
      assert.equal(lb.body.entries.length, 100);
      lb.body.entries.forEach((e, i) => close(e.value, ref[i].value, `${by} rank ${i + 1}`));
      if (by === "pnl") assert.equal(lb.body.entries[0].wallet, star);
    }
    const t2 = performance.now();
    await s.get("/leaderboard?window=7d&by=pnl&limit=100");
    assert.ok(performance.now() - t2 < 50, "second request is served from the response cache");
    console.log(`# ${txs.length} trades: ingest ${ingestMs.toFixed(0)} ms`);
    assert.ok(ingestMs < 8_000, `ingest took ${ingestMs.toFixed(0)} ms`);
  } finally { s.stop(); }
});

test("M5: aggregates are exact when trades arrive out of order, and rebuild on upgrade", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { DatabaseSync } = await import("node:sqlite");
  const dir = mkdtempSync(join(tmpdir(), "idx-"));
  const path = join(dir, "i.db");
  try {
    const trades = [
      mk(1, ALICE, MINT, "buy", 100, 1, NOW - 5000),
      mk(2, ALICE, MINT, "buy", 100, 3, NOW - 4000),
      mk(3, ALICE, MINT, "sell", 50, 2, NOW - 3000),
      mk(4, ALICE, MINT, "sell", 150, 4, NOW - 2000),
      mk(5, ALICE, DAVE, "buy", 10, 1, NOW - 1000),
      mk(6, ALICE, DAVE, "sell", 10, 0.5, NOW - 500),
    ];
    const ref = walletStats(ALICE, trades, NOW).windows["7d"];
    const q = { sinceTimestamp: NOW - 604_800, by: "pnl", limit: 10, minVolumeSol: 0, minTrades: 0 };
    let st = new SqliteStore(path);
    for (const t of [...trades].reverse()) st.ingest(ptx(0, t)); // newest first
    let [row] = st.leaderboard(q);
    close(row.realisedPnl.SOL, ref.realisedPnl.SOL, "out-of-order pnl");
    assert.equal(row.winRate, ref.winRate);
    assert.equal(row.trades, 6);
    st.close();
    // An older database without aggregates is rebuilt on open.
    const raw = new DatabaseSync(path);
    raw.exec("DELETE FROM meta; DELETE FROM agg_hourly; DELETE FROM positions;");
    raw.close();
    st = new SqliteStore(path);
    [row] = st.leaderboard(q);
    close(row.realisedPnl.SOL, ref.realisedPnl.SOL, "rebuilt pnl");
    st.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("M5: leaderboard minimum volume and trade count are enforced", () => {
  const st = new SqliteStore(":memory:");
  try {
    assert.ok(LEADERBOARD_MIN_TRADES >= 2 && LEADERBOARD_MIN_VOLUME_SOL > 0);
    // One lucky round trip: huge PnL, too few trades.
    st.ingest(ptx(0, mk(1, BOB, MINT, "buy", 1, 1, NOW - 100)));
    st.ingest(ptx(0, mk(2, BOB, MINT, "sell", 1, 100, NOW - 90)));
    // Many dust trades: enough trades, too little volume.
    for (let i = 0; i < 10; i++) st.ingest(ptx(0, mk(10 + i, CAROL, MINT, i % 2 ? "sell" : "buy", 1, i % 2 ? 0.02 : 0.01, NOW - 80 + i)));
    // Qualifies.
    for (let i = 0; i < LEADERBOARD_MIN_TRADES; i++) st.ingest(ptx(0, mk(30 + i, ALICE, MINT, i % 2 ? "sell" : "buy", 1, i % 2 ? 1.5 : 1, NOW - 70 + i)));
    const rows = st.leaderboard({ sinceTimestamp: NOW - 86_400, by: "pnl", limit: 10, minVolumeSol: LEADERBOARD_MIN_VOLUME_SOL, minTrades: LEADERBOARD_MIN_TRADES });
    assert.deepEqual(rows.map((r) => r.wallet), [ALICE]);
  } finally { st.close(); }
});

test("M5: wash dampener drops PnL of mints traded by wallets that funded each other", () => {
  const st = new SqliteStore(":memory:");
  try {
    const q = { sinceTimestamp: NOW - 86_400, by: "pnl", limit: 10, minVolumeSol: 0, minTrades: 0 };
    // ALICE funds BOB, then they pass MINT back and forth: BOB books big "PnL".
    st.ingest(fundTx(1, ALICE, BOB, WASH_MIN_FUNDING_LAMPORTS));
    st.ingest(ptx(0, mk(2, BOB, MINT, "buy", 100, 1, NOW - 90)));
    st.ingest(ptx(0, mk(3, ALICE, MINT, "buy", 100, 50, NOW - 80)));
    st.ingest(ptx(0, mk(4, BOB, MINT, "sell", 100, 50, NOW - 70)));
    // BOB's honest trade on another mint still counts.
    st.ingest(ptx(0, mk(5, BOB, DAVE, "buy", 10, 1, NOW - 60)));
    st.ingest(ptx(0, mk(6, BOB, DAVE, "sell", 10, 2, NOW - 50)));
    // CAROL is unlinked: dust below the threshold does not link her to ALICE.
    st.ingest(fundTx(7, ALICE, CAROL, WASH_MIN_FUNDING_LAMPORTS - 1));
    st.ingest(ptx(0, mk(8, CAROL, MINT, "buy", 100, 1, NOW - 40)));
    st.ingest(ptx(0, mk(9, CAROL, MINT, "sell", 100, 3, NOW - 30)));
    const rows = st.leaderboard(q);
    assert.deepEqual(rows.map((r) => [r.wallet, Math.round(r.value * 1e6) / 1e6]), [[CAROL, 2], [BOB, 1]]);
    const bob = rows.find((r) => r.wallet === BOB);
    assert.deepEqual([bob.washExcluded.positions, bob.washExcluded.trades], [1, 2]);
    close(bob.washExcluded.pnlSol, 49);
    assert.deepEqual(st.washPositions(BOB), [MINT]);
    assert.deepEqual(st.washPositions(ALICE), [MINT]);
    assert.deepEqual(st.washPositions(CAROL), []);
    // A link that appears after both traded marks retroactively.
    st.ingest(fundTx(10, CAROL, BOB, WASH_MIN_FUNDING_LAMPORTS));
    assert.deepEqual(st.washPositions(CAROL), [MINT]);
    assert.deepEqual(st.leaderboard(q).map((r) => r.wallet), [BOB]);
  } finally { st.close(); }
});

test("L2: sponsored trades are attributed to the signing trader, not the fee payer", () => {
  const [buyTx, sellTx, topup] = fixture("sponsored");
  assert.equal(buyTx.feePayer, SPONSOR);
  // Unconfigured, the sponsor (fee payer, paid ATA rent, took a token fee) looks like a buyer.
  assert.equal(parseSwap(buyTx).wallet, SPONSOR);
  const b = parseSwap(buyTx, { sponsors: SPONSORS });
  assert.deepEqual([b.wallet, b.side, b.tokenAmount, b.quote], [TRADER, "buy", 1_990_000, "SOL"]);
  close(b.quoteAmount, 1.0101, "curve + protocol fee + sponsor fee recovery; sponsor-paid rent excluded");
  for (const opts of [{}, { sponsors: SPONSORS }]) {
    const s = parseSwap(sellTx, opts);
    assert.deepEqual([s.wallet, s.side, s.tokenAmount], [TRADER, "sell", 1_990_000], "signer ordering picks the trader over the curve");
    close(s.quoteAmount, 1.1879);
  }
  // Without account order the trader and the curve are indistinguishable: no trade rather than a wrong one.
  assert.equal(parseSwap({ ...sellTx, accountData: [] }, { sponsors: SPONSORS }), null);
  // An events.swap naming the sponsor is ignored.
  const ev = { ...buyTx, events: { swap: { nativeInput: { account: SPONSOR, amount: "1000" }, tokenOutputs: [{ userAccount: SPONSOR, mint: MINT, rawTokenAmount: { tokenAmount: "5", decimals: 0 } }] } } };
  assert.equal(parseSwap(ev, { sponsors: SPONSORS }).wallet, TRADER);
  // Sponsor gas top-ups are not stored as funding.
  assert.equal(parseTransaction(topup).transfers.length, 1);
  assert.equal(parseTransaction(topup, undefined, { sponsors: SPONSORS }).transfers.length, 0);
  assert.notEqual(CURVE, TRADER);
});

test("L2: webhook uses INDEXER_SPONSOR_ADDRESSES end to end", async () => {
  const s = await startServer(undefined, { sponsorAddresses: [SPONSOR] });
  try {
    assert.equal((await s.post(fixture("sponsored"))).status, 200);
    assert.equal(s.store.walletTrades(SPONSOR).length, 0);
    const w = await s.get(`/wallet/${TRADER}`);
    close(w.body.windows["7d"].realisedPnl.SOL, 1.1879 - 1.0101);
  } finally { s.stop(); }
});

test("M4: per-IP rate limit on the read API (webhook and /health exempt)", async () => {
  const s = await startServer(undefined, { rateLimit: { windowMs: 60_000, max: 3 } });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await s.get(`/wallet/${ALICE}`)).status, 200);
    const r = await s.get("/leaderboard");
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get("retry-after")) > 0);
    assert.equal((await s.get("/health")).status, 200);
    assert.equal((await s.post(fixture("funding"))).status, 200);
  } finally { s.stop(); }
  let t = 0;
  const rl = new RateLimiter(1_000, 2, 100, () => t);
  assert.deepEqual([rl.take("a"), rl.take("a"), rl.take("a") > 0], [0, 0, true]);
  t = 1_000;
  assert.equal(rl.take("a"), 0, "window resets");
  for (let i = 0; i < 1_000; i++) rl.take("k" + i);
  assert.ok(rl.size <= 100, "memory is bounded");
  assert.equal(clientKey("2001:db8:1:2:aaaa::1"), clientKey("2001:db8:1:2:ffff:1:2:3"), "IPv6 keyed by /64");
  assert.notEqual(clientKey("2001:db8:1:2::1"), clientKey("2001:db8:1:3::1"));
  assert.equal(clientKey("::ffff:10.0.0.1"), "10.0.0.1");
});

test("M4: stalled requests are cut off by the request timeout", async () => {
  const { connect } = await import("node:net");
  const s = await startServer(undefined, { requestTimeoutMs: 300 });
  try {
    const sock = connect(s.server.address().port, "127.0.0.1");
    sock.write("GET /health HTTP/1.1\r\nHost: x\r\n"); // never finishes the headers
    const t0 = performance.now();
    await new Promise((resolve) => { sock.on("close", resolve); sock.on("error", resolve); sock.resume(); });
    assert.ok(performance.now() - t0 < 2_000);
  } finally { s.stop(); }
});

test("M4: leaderboard responses are cached briefly", async () => {
  const s = await startServer(undefined, { leaderboardMinVolumeSol: 0, leaderboardMinTrades: 1, cacheTtlMs: 60_000 });
  try {
    const a = await s.get("/leaderboard?window=7d&by=trades");
    await loadAll(s.post);
    assert.deepEqual((await s.get("/leaderboard?window=7d&by=trades")).body, a.body, "served from cache");
    assert.ok((await s.get("/leaderboard?window=7d&by=trades&limit=10")).body.entries.length > 0, "other keys are fresh");
  } finally { s.stop(); }
});
