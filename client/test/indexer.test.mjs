// Indexer: Helius webhook ingest, sqlite store, wallet stats, token flags, read API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSwap, parseTransaction, ringsideLaunchParser, RINGSIDE_LAUNCH_PROGRAM } from "../dist/indexer/helius.js";
import { SqliteStore } from "../dist/indexer/store.js";
import { walletStats } from "../dist/indexer/stats.js";
import { bundles, holderBalances, insiders, snipers, topHolderConcentration, SNIPER_MAX_SLOTS, BUNDLE_MIN_WALLETS, INSIDER_MIN_FUNDING_LAMPORTS, TOP_HOLDERS } from "../dist/indexer/flags.js";
import { createIndexerServer, secretMatches, MAX_FEED_LIMIT } from "../dist/indexer/server.js";

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

async function startServer(parsers) {
  const store = new SqliteStore(":memory:");
  const server = createIndexerServer({ store, webhookSecret: SECRET, parsers, now: () => NOW });
  server.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, auth = SECRET) =>
    fetch(`${base}/webhooks/helius`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const get = async (path) => { const r = await fetch(base + path); return { status: r.status, body: await r.json() }; };
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
  const s = await startServer();
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
