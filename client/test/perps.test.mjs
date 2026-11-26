// Shared perps client + copy perps build: PDAs, tier/cap maths, order instruction, event decoding, build refusals. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import anchorPkg from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  BPS, GROSS_CAP_MULT, acceptablePrice, buildOrderInstruction, caps, checkIncreaseCaps, curvePda, decodeMarket, decodePerpEvents, decodePosition,
  decodeVault, fundingOwed, marketPda, projectedFundingIndex, maxSizeForCollateral, oiCap, orderPda, perpsCoders, positionPda, tierParams, vaultPda, vaultUsdcPda,
} from "../dist/perps/index.js";
import { buildIntent, BuildError, cachedGenesisHash, cachedMintDecimals } from "../dist/copy/build.js";
import { describeBuilt } from "../dist/appcheck.js";
import { createCopyEngine } from "../dist/copy/engine.js";
import { CopyStore } from "../dist/copy/store.js";
import { decodePerpEvents as copyDecode } from "../dist/copy/perps.js";

const IDL_PATH = join(import.meta.dirname, "../../target/idl/ringside_perps.json");
const HAVE_IDL = existsSync(IDL_PATH);
const idl = HAVE_IDL ? JSON.parse(readFileSync(IDL_PATH, "utf8")) : null;
const opts = { skip: HAVE_IDL ? false : "target/idl/ringside_perps.json is not present (gitignored; build or copy it in)" };

const PERPS = new PublicKey("DsZ69w3q25nRmAzJCRBMLbwZWN6NyVbYipTWsCAUsg1F");
const k = (n) => new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : 7)));
const MINT = k(1), TRADER = k(2), USDC_MINT = k(3), RELAYER = k(4);
const seedsPda = (seeds, p = PERPS) => PublicKey.findProgramAddressSync(seeds, p)[0];

// ---- PDAs ------------------------------------------------------------------------------------

test("PDAs use the program's seeds (lib.rs SEED_* and the Accounts structs)", () => {
  assert.equal(vaultPda(PERPS).toBase58(), seedsPda([Buffer.from("vault")]).toBase58());
  assert.equal(vaultUsdcPda(PERPS).toBase58(), seedsPda([Buffer.from("vault_usdc")]).toBase58());
  const market = marketPda(PERPS, MINT);
  assert.equal(market.toBase58(), seedsPda([Buffer.from("market"), MINT.toBuffer()]).toBase58());
  for (const side of [0, 1]) {
    assert.equal(positionPda(PERPS, TRADER, market, side).toBase58(), seedsPda([Buffer.from("position"), TRADER.toBuffer(), market.toBuffer(), Buffer.from([side])]).toBase58());
    assert.equal(orderPda(PERPS, TRADER, market, side).toBase58(), seedsPda([Buffer.from("order"), TRADER.toBuffer(), market.toBuffer(), Buffer.from([side])]).toBase58());
  }
  assert.notEqual(positionPda(PERPS, TRADER, market, 0).toBase58(), positionPda(PERPS, TRADER, market, 1).toBase58());
  const LAUNCH = k(9);
  assert.equal(curvePda(LAUNCH, MINT).toBase58(), seedsPda([Buffer.from("curve"), MINT.toBuffer()], LAUNCH).toBase58());
});

// ---- tiers and caps --------------------------------------------------------------------------

test("tier table: max leverage / maintenance / fee / budget, tiers above 1 read as 2", () => {
  const t = (n) => { const p = tierParams(n); return [p.maxLeverage, p.maintenanceBps, p.feeBps, p.budgetBps]; };
  assert.deepEqual(t(0), [2n, 2000n, 30n, 25n]);
  assert.deepEqual(t(1), [5n, 800n, 15n, 100n]);
  assert.deepEqual(t(2), [10n, 400n, 8n, 300n]);
  assert.deepEqual(t(200), t(2));
  assert.equal(GROSS_CAP_MULT, 2n);
});

// 30 SOL behind the price at $150, tier0 cap 100 bps: 30e9 * 150e6 / 1e9 = 4_500e6 ($4,500); x 1% = 45e6 ($45).
const vault = { solUsdE6: 150_000_000n, solUsdTs: 1_000n, tier0CapBps: 100, skewCapBps: 2500 };
const SOL30 = 30_000_000_000n;

test("oi_cap and derived caps (hand computed)", () => {
  assert.equal(oiCap(vault, SOL30), 45_000_000n);
  assert.equal(oiCap(vault, SOL30, 10_000_000n), 10_000_000n, "override lowers it");
  assert.equal(oiCap(vault, SOL30, 99_000_000n), 45_000_000n, "override never raises it");
  assert.equal(oiCap(vault, SOL30, 0n), 45_000_000n, "zero override means none");
  assert.equal(oiCap(vault, SOL30, 0n, 1_120), 45_000_000n, "120 s old is fresh");
  assert.equal(oiCap(vault, SOL30, 0n, 1_121), null, "121 s old is stale");
  assert.deepEqual(caps(vault, SOL30), { cap: 45_000_000n, side: 90_000_000n, account: 9_000_000n, skew: 11_250_000n });
  assert.equal(oiCap({ ...vault, tier0CapBps: 60_000 }, 500_000_000n), 450_000_000n, "devnet: 0.5 SOL x $150 = $75, x 600% = $450");
});

test("increase cap checks: oi, account and skew, with exact boundaries", () => {
  const m = (oiLong, oiShort, oiCapOverride = 0n) => ({ oiLong, oiShort, oiCapOverride });
  const chk = (mk, side, size, existing = 0n) => checkIncreaseCaps(vault, mk, SOL30, side, size, existing);
  assert.equal(chk(m(0n, 0n), 0, 9_000_000n), null, "exactly 20% of cap");
  assert.equal(chk(m(0n, 0n), 0, 9_000_001n), "account_cap");
  assert.equal(chk(m(0n, 0n), 0, 5_000_000n, 4_000_000n), null, "existing size counts toward the account cap");
  assert.equal(chk(m(0n, 0n), 0, 5_000_001n, 4_000_000n), "account_cap");
  assert.equal(chk(m(85_000_000n, 85_000_000n), 0, 5_000_000n), null, "90e6 side limit, balanced book");
  assert.equal(chk(m(85_000_000n, 85_000_000n), 0, 5_000_001n), "oi_cap");
  assert.equal(chk(m(10_000_000n, 0n), 0, 1_250_000n), null, "net 11.25e6 = 25% of cap");
  assert.equal(chk(m(10_000_000n, 0n), 0, 1_250_001n), "skew_cap");
  assert.equal(chk(m(10_000_000n, 0n), 1, 9_000_000n), null, "the other side reduces the skew");
  assert.equal(chk(m(0n, 10_000_000n), 1, 2_000_000n), "skew_cap");
  assert.equal(chk(m(0n, 0n, 4_000_000n), 0, 1_000_000n), "account_cap", "an override of $4 makes the account cap $0.8");
  assert.equal(checkIncreaseCaps(vault, m(0n, 0n), SOL30, 0, 1n, 0n, 5_000), "oi_cap", "stale price refuses");
});

test("leverage after fee: largest size that passes the program's check", () => {
  for (const [tier, col] of [[0, 10_000_000n], [1, 10_000_000n], [2, 100_000_000n], [2, 123_456_789n]]) {
    const { maxLeverage, feeBps } = tierParams(tier);
    const ok = (s) => (col - (s * feeBps) / BPS) * maxLeverage >= s;
    const s = maxSizeForCollateral(tier, col);
    assert.ok(ok(s) && !ok(s + 1n), `tier ${tier} col ${col}`);
  }
  // tier 2, $100: size <= 1000e6 / 1.008 = 992_063_492.06
  assert.ok(Math.abs(Number(maxSizeForCollateral(2, 100_000_000n)) - 992_063_492) < 20);
  // adding to a position: collateral 50 + 100 existing, size 400 existing at tier 1 (5x): (150 - fee) x 5 >= 400 + s
  const s = maxSizeForCollateral(1, 50_000_000n, 100_000_000n, 400_000_000n);
  assert.ok(Math.abs(Number(s) - 347_394_540) < 20, "350e6 / 1.0075");
  assert.equal(maxSizeForCollateral(0, 1_000_000n, 0n, 100_000_000n), 0n, "over-levered already");
});

// ---- order instruction -----------------------------------------------------------------------

const DISC = Buffer.from([96, 52, 79, 225, 124, 205, 66, 123]);
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u128 = (n) => Buffer.concat([u64(BigInt(n) & ((1n << 64n) - 1n)), u64(BigInt(n) >> 64n)]);

test("request_order: accounts and data match the IDL", opts, async () => {
  const def = idl.instructions.find((i) => i.name === "request_order");
  assert.deepEqual([...DISC], def.discriminator);
  const ix = buildOrderInstruction({ idl, action: "open", trader: TRADER, payer: RELAYER, mint: MINT, side: 1, usdcMint: USDC_MINT, collateral: 5_000_000n, sizeUsd: 20_000_000n, acceptablePriceQ64: 123n << 70n });
  assert.equal(ix.programId.toBase58(), PERPS.toBase58());
  const market = marketPda(PERPS, MINT);
  const want = {
    owner: TRADER, payer: RELAYER, vault: vaultPda(PERPS), vault_usdc: vaultUsdcPda(PERPS), market,
    position: positionPda(PERPS, TRADER, market, 1), order: orderPda(PERPS, TRADER, market, 1),
    owner_usdc: getAssociatedTokenAddressSync(USDC_MINT, TRADER), token_program: TOKEN_PROGRAM_ID, system_program: SystemProgram.programId,
  };
  assert.deepEqual(ix.keys.map((x) => x.pubkey.toBase58()), def.accounts.map((a) => want[a.name].toBase58()), "IDL account order");
  assert.deepEqual(ix.keys.map((x) => [x.isSigner, x.isWritable]), def.accounts.map((a) => [!!a.signer, !!a.writable]));
  assert.equal(ix.keys.filter((x) => x.isSigner).length, 2, "owner and payer sign");
  assert.deepEqual(ix.data, Buffer.concat([DISC, Buffer.from([1, 0]), u64(5_000_000), u64(20_000_000), u128(123n << 70n)]));
});

test("request_order: identical to what Anchor's Program builds (what the app sent before)", opts, async () => {
  const { Program, BN } = anchorPkg;
  const program = new Program(idl, { connection: new Connection("http://127.0.0.1:1") });
  const market = marketPda(PERPS, MINT);
  for (const [kind, side] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
    const col = kind ? 0 : 7_500_000, size = kind ? 0 : 15_000_000;
    const old = await program.methods.requestOrder({ side, kind, collateral: new BN(col), sizeUsd: new BN(size), acceptablePriceQ64: new BN(0) })
      .accountsPartial({
        owner: TRADER, payer: RELAYER, vault: vaultPda(PERPS), vaultUsdc: vaultUsdcPda(PERPS), market,
        position: positionPda(PERPS, TRADER, market, side), order: orderPda(PERPS, TRADER, market, side),
        ownerUsdc: getAssociatedTokenAddressSync(USDC_MINT, TRADER), tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).instruction();
    const now = buildOrderInstruction({ idl, action: kind ? "close" : "open", trader: TRADER, payer: RELAYER, mint: MINT, side, usdcMint: USDC_MINT, collateral: BigInt(col), sizeUsd: BigInt(size) });
    assert.deepEqual(now.data, old.data, `data kind ${kind} side ${side}`);
    assert.deepEqual(now.keys.map((x) => [x.pubkey.toBase58(), x.isSigner, x.isWritable]), old.keys.map((x) => [x.pubkey.toBase58(), x.isSigner, x.isWritable]));
  }
});

test("request_order: close ignores amounts, increase equals open, bad input refused, slippage direction follows the program", opts, () => {
  const base = { idl, trader: TRADER, mint: MINT, side: 0, usdcMint: USDC_MINT };
  const close = buildOrderInstruction({ ...base, action: "close", collateral: 9n, sizeUsd: 9n });
  assert.deepEqual(close.data, Buffer.concat([DISC, Buffer.from([0, 1]), u64(0), u64(0), u128(0)]));
  assert.equal(close.keys[1].pubkey.toBase58(), TRADER.toBase58(), "payer defaults to the trader");
  const a = buildOrderInstruction({ ...base, action: "open", collateral: 1n, sizeUsd: 2n }), b = buildOrderInstruction({ ...base, action: "increase", collateral: 1n, sizeUsd: 2n });
  assert.deepEqual(a.data, b.data);
  assert.throws(() => buildOrderInstruction({ ...base, action: "open", collateral: 0n, sizeUsd: 2n }));
  assert.throws(() => buildOrderInstruction({ ...base, action: "open", collateral: 1n, sizeUsd: 1n << 64n }));
  assert.throws(() => buildOrderInstruction({ ...base, side: 2, action: "close" }));
  const R = 1_000_000n;
  assert.equal(acceptablePrice(0, "open", R, 100), 1_010_000n, "open long: price must not exceed");
  assert.equal(acceptablePrice(1, "open", R, 100), 990_000n, "open short: price must not fall below");
  assert.equal(acceptablePrice(0, "close", R, 100), 990_000n, "close long: floor");
  assert.equal(acceptablePrice(1, "close", R, 100), 1_010_000n, "close short: cap");
  const bounded = buildOrderInstruction({ ...base, action: "open", collateral: 1n, sizeUsd: 2n, referencePriceQ64: R, slippageBps: 100 });
  assert.deepEqual(bounded.data.subarray(-16), u128(1_010_000n));
  assert.throws(() => acceptablePrice(0, "open", R, 10_001));
});

// ---- account decoding ------------------------------------------------------------------------

test("accounts decode through the IDL coder", opts, () => {
  const c = perpsCoders(idl);
  const disc = (n) => createHash("sha256").update(`account:${n}`).digest().subarray(0, 8);
  const pos = Buffer.concat([disc("Position"), TRADER.toBuffer(), MINT.toBuffer(), Buffer.from([1]), u64(6), u64(7), u128((8n << 64n) + 3n), u128(0), u64(99), Buffer.from([254])]);
  const p = decodePosition(c, pos);
  assert.equal(p.side, 1); assert.equal(p.collateral.toString(), "6"); assert.equal(p.sizeUsd.toString(), "7");
  assert.equal(p.entryPriceQ64.toString(), ((8n << 64n) + 3n).toString()); assert.equal(p.owner.toBase58(), TRADER.toBase58());
  assert.equal(typeof decodeVault, "function"); assert.equal(typeof decodeMarket, "function");
});

// ---- event decoding --------------------------------------------------------------------------

const evDisc = (n) => createHash("sha256").update(`event:${n}`).digest().subarray(0, 8);
const changed = (side, size, col) => Buffer.concat([evDisc("PositionChanged"), TRADER.toBuffer(), marketPda(PERPS, MINT).toBuffer(), Buffer.from([side]), u64(size), u64(col), u128(5)]);
const closed = (side, reason) => Buffer.concat([evDisc("PositionClosed"), TRADER.toBuffer(), marketPda(PERPS, MINT).toBuffer(), Buffer.from([side]), u64(0), u64(1_000_000), u128(5), Buffer.from([reason])]);
const data = (b) => `Program data: ${b.toString("base64")}`;
const P = PERPS.toBase58();
const tx = (logs, extra = {}) => ({ signature: "sig1", slot: 321, blockTime: 1_800_000_000, meta: { err: null, logMessages: logs }, ...extra });
const mintOf = (m) => (m === marketPda(PERPS, MINT).toBase58() ? MINT.toBase58() : undefined);

test("perp events: PositionChanged is an open, PositionClosed reason 0 is a close", opts, () => {
  assert.deepEqual([...evDisc("PositionChanged")], idl.events.find((e) => e.name === "PositionChanged").discriminator);
  assert.deepEqual([...evDisc("PositionClosed")], idl.events.find((e) => e.name === "PositionClosed").discriminator);
  const logs = [
    "Program KeeperProg1111111111111111111111111111111111 invoke [1]", `Program ${P} invoke [2]`, "Program log: Instruction: ExecuteOrder",
    data(changed(1, 20_000_000, 5_000_000)), `Program ${P} success`, "Program KeeperProg1111111111111111111111111111111111 success",
  ];
  const [ev] = decodePerpEvents(idl, tx(logs), { mintOf });
  assert.deepEqual(ev, {
    leader: TRADER.toBase58(), market: marketPda(PERPS, MINT).toBase58(), mint: MINT.toBase58(), side: "short", sizeUsd: 20, leverage: 4,
    signature: "sig1", slot: 321, timestamp: 1_800_000_000, action: "open",
  });
  const [cl] = decodePerpEvents(idl, tx([`Program ${P} invoke [1]`, data(closed(0, 0)), `Program ${P} success`]), { mintOf });
  assert.equal(cl.action, "close"); assert.equal(cl.side, "long"); assert.equal(cl.leader, TRADER.toBase58());
  assert.equal(copyDecode, decodePerpEvents, "the copy module exposes the same decoder");
});

test("perp events: liquidations, failed or spoofed or unknown-market events yield nothing", opts, () => {
  const run = (logs, t = {}, m = mintOf) => decodePerpEvents(idl, tx(logs, t), { mintOf: m });
  assert.deepEqual(run([`Program ${P} invoke [1]`, data(closed(0, 1)), `Program ${P} success`]), [], "liquidation");
  assert.deepEqual(run([`Program ${P} invoke [1]`, data(closed(0, 2)), `Program ${P} success`]), [], "ADL");
  assert.deepEqual(run([`Program ${P} invoke [1]`, data(changed(0, 2, 1)), `Program ${P} success`], { meta: { err: { InstructionError: [0, 1] }, logMessages: [] } }), [], "failed tx");
  const spoof = ["Program Evil1111111111111111111111111111111111111 invoke [1]", data(changed(0, 2_000_000, 1_000_000)), "Program Evil1111111111111111111111111111111111111 success"];
  assert.deepEqual(run(spoof), [], "another program logging the same bytes");
  assert.deepEqual(run([`Program ${P} invoke [1]`, data(changed(0, 2_000_000, 1_000_000)), `Program ${P} success`], {}, () => undefined), [], "no mint for the market");
  assert.deepEqual(run([`Program ${P} invoke [1]`, "Program data: !!notbase64!!", data(Buffer.from("garbage")), `Program ${P} success`]), []);
  const afterExit = [`Program ${P} invoke [1]`, `Program ${P} success`, data(changed(0, 2_000_000, 1_000_000))];
  assert.deepEqual(run(afterExit), [], "data logged after the program returned");
});

// ---- copy perps build ------------------------------------------------------------------------

const LEADER = "22S3bVxfkoJB5L5EhFo1Hp3T9EtX1qLG4dP9UDcRQN6B";
const SOL = 1_000_000_000;
const SIG = (n) => String(n).padStart(88, "1");
const T0 = 1_800_000_000_000;
const FOLLOWER = TRADER.toBase58();
const chain = { latestBlockhash: async () => ({ blockhash: "4Nd1mY8bWc8kdwhzC3YvCkAVEZYT5yAv8M6sXdVQ2JbV", lastValidBlockHeight: 100n }) };
const bn = (n) => ({ toString: () => String(n) });

function rig({ maxLeverage = 5, tier = 2, solReserve = 300_000_000_000n, market = {}, positions = {}, orders = {}, graduated = false, vaultOv = {} } = {}) {
  const store = new CopyStore(":memory:");
  const settings = { follower: FOLLOWER, leader: LEADER, enabled: true, mode: "fixed", fixedLamports: 0.1 * SOL, ratioBps: 5000, maxPerTradeLamports: SOL, dailyCapLamports: SOL, slippageBps: 100, copySells: true, copyPerps: true, maxLeverage, skipFlags: [], minTokenAgeSec: 0 };
  const engine = createCopyEngine({
    social: { copySettingsForLeader: async () => [settings], notify: async () => {} }, flags: { tokenFacts: async () => ({ flags: [], ageSec: 99 }) },
    store, tiers: { tierOf: async () => tier }, perpsEnabled: true, now: () => T0,
  });
  const state = {
    vault: { usdcMint: USDC_MINT, paused: false, solUsdE6: bn(150_000_000), solUsdTs: bn(1_000), tier0CapBps: 100, skewCapBps: 2500, ...vaultOv },
    market: { tier, reduceOnly: false, oiLong: bn(0), oiShort: bn(0), oiCapOverride: bn(0), ...market },
    positions: { 0: null, 1: null, ...positions }, orders: { 0: false, 1: false, ...orders }, solReserve, graduated, nowSec: 1_050,
  };
  const calls = [];
  const deps = (o = {}) => ({
    store, pump: {}, jupiter: {}, chain, now: () => T0,
    perps: { idl, port: { state: async (...a) => { calls.push(a); return state; } }, rpcUrl: "https://api.devnet.solana.com", genesisHash: async () => DEVNET_GENESIS, enabled: true, solPriceUsd: async () => 100, ...o },
  });
  const open = async (ev = {}) => (await engine.onLeaderPerp({ leader: LEADER, market: "m", mint: MINT.toBase58(), side: "long", sizeUsd: 500, leverage: 50, signature: SIG(1), slot: 5, timestamp: Math.floor(T0 / 1000), action: "open", ...ev }))[0];
  return { store, engine, deps, open, state, calls };
}
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const refused = (code) => (e) => e instanceof BuildError && e.code === code;
const orderArgs = (built) => {
  const t = VersionedTransaction.deserialize(Buffer.from(built.transaction, "base64"));
  const keys = t.message.staticAccountKeys;
  const ix = t.message.compiledInstructions.find((c) => keys[c.programIdIndex].equals(PERPS));
  const d = Buffer.from(ix.data);
  return { tx: t, ix, side: d[8], kind: d[9], collateral: d.readBigUInt64LE(10), size: d.readBigUInt64LE(18), price: d.readBigUInt64LE(26) + (d.readBigUInt64LE(34) << 64n) };
};

test("copy perps build: gate off by default, devnet only, no config", opts, async () => {
  const r = rig();
  const i = await r.open();
  assert.equal(i.status, "pending");
  delete process.env.RINGSIDE_COPY_PERPS;
  await assert.rejects(buildIntent(r.deps({ enabled: undefined }), i.id, FOLLOWER), refused("perps_build_unsupported"), "env gate unset");
  await assert.rejects(buildIntent(r.deps({ enabled: false }), i.id, FOLLOWER), refused("perps_build_unsupported"), "gate off");
  for (const url of ["https://api.mainnet-beta.solana.com", "https://MAINNET.helius-rpc.com/?k=1"]) {
    await assert.rejects(buildIntent(r.deps({ rpcUrl: url }), i.id, FOLLOWER), refused("perps_build_unsupported"), url);
  }
  await assert.rejects(buildIntent({ ...r.deps(), perps: undefined }, i.id, FOLLOWER), refused("perps_build_unsupported"), "no perps deps");
  assert.equal(r.calls.length, 0, "refused before any chain read");
  assert.equal(r.store.get(i.id).status, "pending");
  process.env.RINGSIDE_COPY_PERPS = "1";
  try { assert.equal((await buildIntent(r.deps({ enabled: undefined }), i.id, FOLLOWER)).venue, "ringside-perps", "env gate on"); }
  finally { delete process.env.RINGSIDE_COPY_PERPS; }
});

test("copy perps build: leverage is capped at min(settings, tier) and the tier max is kept after the fee", opts, async () => {
  // 0.1 SOL at $100 = $10 collateral.
  for (const [tier, maxLev, wantApprox] of [[0, 20, 20_000_000], [1, 20, 50_000_000], [2, 20, 100_000_000], [2, 3, 30_000_000], [2, 1, 10_000_000]]) {
    const r = rig({ tier, maxLeverage: maxLev, solReserve: 600_000_000_000n }); // cap $900, account cap $180
    const i = await r.open();
    assert.ok(i.leverage <= Math.min(maxLev, [2, 5, 10][tier]), "intent already capped");
    const built = await buildIntent(r.deps(), i.id, FOLLOWER);
    const a = orderArgs(built);
    assert.equal(a.kind, 0); assert.equal(a.side, 0); assert.equal(a.collateral, 10_000_000n);
    assert.ok(a.size <= BigInt(wantApprox) && a.size >= BigInt(wantApprox) - BigInt(wantApprox) / 100n, `tier ${tier} max ${maxLev}: size ${a.size}`);
    const { maxLeverage, feeBps } = tierParams(tier);
    assert.ok((a.collateral - (a.size * feeBps) / BPS) * maxLeverage >= a.size, "passes the program's leverage check");
    assert.equal(r.store.get(i.id).status, "built");
    assert.equal(built.expectedOut, a.size.toString());
  }
  // The market's tier at build time caps again: the intent was made at tier 2 (5x) but the market is tier 0 now.
  const r = rig({ tier: 2, maxLeverage: 5 });
  const i = await r.open();
  assert.equal(i.leverage, 5);
  r.state.market.tier = 0;
  const a = orderArgs(await buildIntent(r.deps(), i.id, FOLLOWER));
  assert.ok(a.size < 20_000_000n && a.size > 19_000_000n);
});

test("copy perps build: unsigned, sponsor pays, short side, slippage bound, close", opts, async () => {
  const r = rig({ tier: 1 });
  const s = await r.open({ side: "short" });
  r.state.referencePriceQ64 = 1_000_000n;
  const built = await buildIntent({ ...r.deps(), sponsor: RELAYER.toBase58() }, s.id, FOLLOWER);
  const a = orderArgs(built);
  assert.equal(a.side, 1);
  assert.equal(a.price, 990_000n, "short open: floor at reference - slippage (100 bps)");
  assert.equal(a.tx.message.staticAccountKeys[0].toBase58(), RELAYER.toBase58(), "sponsor is the fee payer");
  assert.ok(a.tx.signatures.every((x) => x.every((b) => b === 0)), "nothing is signed");
  assert.equal(built.feeLamports, 0);

  // Close: needs an open position on exactly one side on chain.
  const r2 = rig({ tier: 1 });
  assert.equal((await r2.open({ action: "close", signature: SIG(2) })).status, "skipped", "engine skips a close without a copy position");
  const r3 = rig({ tier: 1 });
  const open = await r3.open({ side: "short" });
  r3.store.markBuilt(open.id, { venue: "ringside-perps" });
  r3.store.markSent(open.id, SIG(70));
  r3.store.confirmSent(open.id, 0n);
  const cl = await r3.open({ action: "close", side: "short", signature: SIG(3) });
  assert.equal(cl.status, "pending");
  await assert.rejects(buildIntent(r3.deps(), cl.id, FOLLOWER), refused("build_failed"), "no position on chain");
  r3.state.positions[1] = { sizeUsd: bn(30_000_000), collateral: bn(10_000_000) };
  r3.state.referencePriceQ64 = 1_000_000n;
  const a2 = orderArgs(await buildIntent(r3.deps(), cl.id, FOLLOWER));
  assert.equal(a2.kind, 1); assert.equal(a2.side, 1); assert.equal(a2.size, 0n);
  assert.equal(a2.price, 1_010_000n, "close short: capped at reference + slippage");
  // M1: with both sides open on chain, only the leader's side is closed (it used to refuse as ambiguous or close the wrong one).
  r3.state.positions[0] = { sizeUsd: bn(50_000_000), collateral: bn(10_000_000) };
  r3.state.referencePriceQ64 = undefined;
  const cl2 = await r3.open({ action: "close", side: "short", signature: SIG(4) });
  assert.equal(orderArgs(await buildIntent(r3.deps(), cl2.id, FOLLOWER)).side, 1, "closes the short, leaves the long");
  // The leader closing the long, which the follower never copied, is skipped by the engine ...
  assert.equal((await r3.open({ action: "close", side: "long", signature: SIG(5) })).skipReason, "no_copy_position");
  // ... and a close intent for an uncopied side is refused at build even if one exists (store row forged / stale).
  const forged = { ...r3.store.get(cl2.id), id: "forged-1", sourceSignature: SIG(6), perpSide: "long", status: "pending", expiresAt: T0 + 60_000 };
  r3.store.insert(forged);
  await assert.rejects(buildIntent(r3.deps(), "forged-1", FOLLOWER), refused("perp_not_copied"));
  assert.equal(r3.store.get("forged-1").status, "pending");
  // Another leader's copied position on that side does not count either.
  r3.store.insert({ ...forged, id: "forged-2", sourceSignature: SIG(7), perpSide: "short", leader: k(9).toBase58() });
  await assert.rejects(buildIntent(r3.deps(), "forged-2", FOLLOWER), refused("perp_not_copied"));
  // Confirming the close clears the record.
  r3.store.markBuilt(cl2.id, { venue: "ringside-perps" }); r3.store.markSent(cl2.id, SIG(71)); r3.store.confirmSent(cl2.id, 0n);
  assert.equal(r3.store.copiedPerp(FOLLOWER, LEADER, MINT.toBase58(), "short"), false);
});

test("M1 sponsor L1: the follower is the instruction payer, the sponsor only the fee payer", opts, async () => {
  const r = rig({ tier: 1 });
  const i = await r.open();
  const built = await buildIntent({ ...r.deps(), sponsor: RELAYER.toBase58() }, i.id, FOLLOWER);
  const a = orderArgs(built);
  const keys = a.tx.message.staticAccountKeys;
  assert.equal(keys[0].toBase58(), RELAYER.toBase58());
  const ixKeys = a.ix.accountKeyIndexes.map((x) => keys[x].toBase58());
  assert.ok(!ixKeys.includes(RELAYER.toBase58()), "the fee payer is in no instruction account (sponsor.ts refuses it)");
  const def = idl.instructions.find((x) => x.name === "request_order");
  const pi = def.accounts.findIndex((x) => x.name === "payer");
  assert.equal(ixKeys[pi], FOLLOWER, "payer is the owner");
  assert.equal(a.tx.message.header.numRequiredSignatures, 2, "sponsor + follower");
});

test("M2: ratio mode sizes from the leader's change, not the total", opts, async () => {
  const mk = () => { const r = rig({ tier: 2 }); return r; };
  const ratioRig = () => {
    const store = new CopyStore(":memory:");
    const settings = { follower: FOLLOWER, leader: LEADER, enabled: true, mode: "ratio", fixedLamports: 0, ratioBps: 10_000, maxPerTradeLamports: 100 * SOL, dailyCapLamports: 100 * SOL, slippageBps: 100, copySells: true, copyPerps: true, maxLeverage: 5, skipFlags: [], minTokenAgeSec: 0 };
    const engine = createCopyEngine({ social: { copySettingsForLeader: async () => [settings], notify: async () => {} }, flags: { tokenFacts: async () => ({ flags: [], ageSec: 99 }) }, store, tiers: { tierOf: async () => 2 }, perpsEnabled: true, now: () => T0, solPriceUsd: async () => 100 });
    const ev = (o) => engine.onLeaderPerp({ leader: LEADER, market: "m", mint: MINT.toBase58(), side: "long", sizeUsd: 100, leverage: 2, signature: SIG(1), slot: 5, timestamp: Math.floor(T0 / 1000), action: "open", ...o }).then((x) => x[0]);
    return { store, ev };
  };
  void mk;
  const { store, ev } = ratioRig();
  // First event ever seen: the previous size is unknown, so skip rather than copy the whole position.
  assert.equal((await ev({ signature: SIG(10), sizeUsd: 100 })).skipReason, "perp_size_unknown");
  // Leader goes 100 -> 150: copy 50 USD = 0.5 SOL, not 150 USD.
  const inc = await ev({ signature: SIG(11), sizeUsd: 150 });
  assert.equal(inc.status, "pending");
  assert.equal(inc.lamports, 0.5 * SOL);
  // Replay of the same event gives the same intent (idempotent), no double count.
  assert.equal((await ev({ signature: SIG(11), sizeUsd: 150 })).id, inc.id);
  assert.equal((await ev({ signature: SIG(12), sizeUsd: 400 })).lamports, 2.5 * SOL);
  // After a close the next open starts from zero.
  await ev({ signature: SIG(13), action: "close", sizeUsd: 0 });
  assert.equal((await ev({ signature: SIG(14), sizeUsd: 200 })).lamports, 2 * SOL);
  // A size that did not grow means our record is stale: skip.
  assert.equal((await ev({ signature: SIG(15), sizeUsd: 150 })).skipReason, "perp_size_unknown");
  // The event's own previous size wins when the source has it.
  const { ev: ev2 } = ratioRig();
  assert.equal((await ev2({ signature: SIG(20), sizeUsd: 300, prevSizeUsd: 100 })).lamports, 2 * SOL);
  void store;
});

test("M3: the mainnet check uses the genesis hash, cached, failing closed", opts, async () => {
  const r = rig({ tier: 2 });
  const i = await r.open();
  const MAINNET = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
  await assert.rejects(buildIntent(r.deps({ genesisHash: async () => MAINNET }), i.id, FOLLOWER), refused("perps_build_unsupported"), "mainnet behind an innocent URL");
  await assert.rejects(buildIntent(r.deps({ genesisHash: async () => { throw new Error("rpc down"); } }), i.id, FOLLOWER), refused("perps_build_unsupported"), "error fails closed");
  await assert.rejects(buildIntent(r.deps({ genesisHash: undefined }), i.id, FOLLOWER), refused("perps_build_unsupported"), "missing check fails closed");
  assert.equal(r.calls.length, 0, "no chain reads before the cluster is verified");
  let n = 0;
  const g = cachedGenesisHash(async () => { n++; if (n === 1) throw new Error("once"); return DEVNET_GENESIS; });
  await assert.rejects(g());
  assert.equal(await g(), DEVNET_GENESIS); assert.equal(await g(), DEVNET_GENESIS);
  assert.equal(n, 2, "success cached, failure not");
  assert.ok(await buildIntent(r.deps(), i.id, FOLLOWER));
});

test("L2: orders the program would reject at fill are refused with a code", opts, async () => {
  // Tier 0 curve sold out.
  let r = rig({ tier: 0 }); r.state.curveComplete = true;
  let i = await r.open({ leverage: 2 });
  await assert.rejects(buildIntent(r.deps(), i.id, FOLLOWER), refused("perp_curve_complete"));
  r.state.market.tier = 1; // tier >= 1 trades on after completion
  assert.ok(await buildIntent(r.deps(), i.id, FOLLOWER));
  // Clamped mark.
  r = rig({ tier: 2 }); r.state.markClamped = true;
  i = await r.open();
  await assert.rejects(buildIntent(r.deps(), i.id, FOLLOWER), refused("perp_mark_clamped"));
  // Funding owed on the existing position: existing 100 size long, collateral 5, funding index moved so it owes.
  const pos = (col, size, side, snap) => ({ side, sizeUsd: bn(size), collateral: bn(col), fundingSnapshot: bn(snap) });
  r = rig({ tier: 2, market: { fundingIndex: bn(60_000_000_000), lastFundingTs: bn(1_050) }, positions: { 0: pos(1_000_000, 100_000_000, 0, 0) } });
  r.state.market.oiLong = bn(100_000_000);
  i = await r.open();
  // owed = 100e6 * 6e10 / 1e12 = 6e6 > 1e6 collateral
  await assert.rejects(buildIntent(r.deps(), i.id, FOLLOWER), refused("perp_funding"));
  // Funding that is owed but affordable shrinks the size the leverage check allows.
  const big = { solReserve: 3_000_000_000_000n };
  const base = rig({ tier: 2, ...big, positions: { 0: pos(20_000_000, 250_000_000, 0, 0) } });
  const sizeNoFunding = orderArgs(await buildIntent(base.deps(), (await base.open()).id, FOLLOWER)).size;
  const owing = rig({ tier: 2, ...big, market: { fundingIndex: bn(4_000_000_000), lastFundingTs: bn(1_050) }, positions: { 0: pos(20_000_000, 250_000_000, 0, 0) } });
  const sizeFunding = orderArgs(await buildIntent(owing.deps(), (await owing.open()).id, FOLLOWER)).size;
  assert.ok(sizeFunding < sizeNoFunding, `${sizeFunding} < ${sizeNoFunding}`);
  const { maxLeverage, feeBps } = tierParams(2);
  const col = 20_000_000n - 1_000_000n + 10_000_000n; // existing minus funding owed (250e6*4e9/1e12) plus new
  assert.ok((col - (sizeFunding * feeBps) / BPS) * maxLeverage >= 250_000_000n + sizeFunding, "passes the program's check after funding");
  // Accrual since the last funding timestamp is projected like accrue_funding: cap $450, skew 100/450, 1100 s.
  const vr = { solUsdE6: 150_000_000n, solUsdTs: 1_000n, tier0CapBps: 100, skewCapBps: 2500 };
  assert.equal(projectedFundingIndex(vr, { oiLong: 100_000_000n, oiShort: 0n, oiCapOverride: 0n, fundingIndex: 7n, lastFundingTs: 0n }, 300_000_000_000n, 1_100), 7n + (111_111_111n * 1_100n) / 3_600n);
  assert.equal(fundingOwed(0, 100_000_000n, 0n, 60_000_000_000n), 6_000_000n);
  assert.equal(fundingOwed(1, 100_000_000n, 0n, 60_000_000_000n), -6_000_000n);
});

test("L6: perps report the trade fee and collateral in their own fields, not minOut", opts, async () => {
  for (const [tier, bps] of [[0, 30n], [1, 15n], [2, 8n]]) {
    const r = rig({ tier });
    const i = await r.open();
    const b = await buildIntent(r.deps(), i.id, FOLLOWER);
    const a = orderArgs(b);
    assert.equal(b.minOut, undefined, "no minOut for perps");
    assert.equal(b.collateralUsdc, a.collateral.toString());
    assert.equal(b.feeUsdc, ((a.size * bps) / 10_000n).toString());
    const v = describeBuilt(i.side, JSON.parse(JSON.stringify(b)));
    assert.equal(v.perp, true); assert.equal(v.minOut, null);
    assert.equal(v.feeUsdc, BigInt(b.feeUsdc)); assert.equal(v.collateralUsdc, a.collateral);
    assert.ok(!v.unknown.includes("minimum after slippage"));
  }
});

test("copy perps build: cap breach is perp_cap and leaves the intent pending", opts, async () => {
  const mk = (extra) => rig({ tier: 2, ...extra });
  // 0.1 SOL x $100 = $10, 5x = ~$50. Reserve 300 SOL at $150 -> cap $450 (account $90, skew $112.5, side $900).
  let r = mk({});
  let i = await r.open();
  assert.ok(await buildIntent(r.deps(), i.id, FOLLOWER), "fits");

  r = mk({ solReserve: 10_000_000_000n }); // cap $15, account cap $3
  i = await r.open();
  await assert.rejects(buildIntent(r.deps(), i.id, FOLLOWER), refused("perp_cap"));
  assert.equal(r.store.get(i.id).status, "pending", "can be retried when the market has room");

  r = mk({ market: { oiLong: bn(880_000_000) } }); // side limit $900: $50 more breaches it
  i = await r.open();
  await assert.rejects(buildIntent(r.deps(), i.id, FOLLOWER), refused("perp_cap"), "oi cap");

  r = mk({ market: { oiLong: bn(100_000_000), oiShort: bn(0) } }); // net $100 + $50 > $112.5 skew limit
  i = await r.open();
  await assert.rejects(buildIntent(r.deps(), i.id, FOLLOWER), refused("perp_cap"), "skew cap");
  const short = await r.open({ side: "short", signature: SIG(5) });
  assert.ok(await buildIntent(r.deps(), short.id, FOLLOWER), "the other side reduces the skew");

  r = mk({ market: { oiCapOverride: bn(10_000_000) } }); // cap $10 -> account cap $2
  i = await r.open();
  await assert.rejects(buildIntent(r.deps(), i.id, FOLLOWER), refused("perp_cap"), "market override");

  r = mk({ positions: { 0: { sizeUsd: bn(85_000_000), collateral: bn(40_000_000) } } }); // existing $85 + $50 > $90 account cap
  i = await r.open();
  await assert.rejects(buildIntent(r.deps(), i.id, FOLLOWER), refused("perp_cap"), "existing position counts");
});

test("copy perps build: other refusals (no market, graduated, reduce-only, paused, pending order, no price)", opts, async () => {
  const cases = [
    ["venue_unavailable", { market: { reduceOnly: true } }],
    ["venue_unavailable", { graduated: true }],
    ["venue_unavailable", { vaultOv: { paused: true } }],
    ["build_failed", { orders: { 0: true } }],
  ];
  for (const [code, o] of cases) {
    const r = rig(o); const i = await r.open();
    await assert.rejects(buildIntent(r.deps(), i.id, FOLLOWER), refused(code), JSON.stringify(o));
  }
  let r = rig(); let i = await r.open();
  await assert.rejects(buildIntent(r.deps({ port: { state: async () => null } }), i.id, FOLLOWER), refused("venue_unavailable"), "no market");
  await assert.rejects(buildIntent(r.deps({ solPriceUsd: async () => undefined }), i.id, FOLLOWER), refused("build_failed"), "no price");
  assert.ok(await buildIntent(r.deps({ solPriceUsd: undefined }), i.id, FOLLOWER), "falls back to the vault's own price");
});
