// Pump.fun trade layer against a fake RPC. Accounts are encoded with the SDK's
// own Anchor coders, so decoding goes through the real SDK paths.
// Run: npx tsc --outDir dist && node --test test/pumpfun.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AccountRole } from "@solana/kit";
import {
  buildBuy, buildSell, quoteBuy, quoteSell, feeLamports, withSlippageUp, withSlippageDown,
  PumpTradeError, PUMP_PROGRAM, PUMPSWAP_PROGRAM, PUMP_FEE_PROGRAM, DEFAULT_FEE_BPS,
} from "../dist/trade/pumpfun.js";

// Same CJS graph as the module, so PublicKey is one class.
const require = createRequire(import.meta.url);
const pump = require("@pump-fun/pump-sdk");
const swap = require("@pump-fun/pump-sdk/swap");
const { PublicKey, Keypair, SystemProgram } = require("@solana/web3.js");
const spl = require("@solana/spl-token");
const { BN } = require("@coral-xyz/anchor");

const PUMP = pump.getPumpProgram(null);
const AMM = swap.OFFLINE_PUMP_AMM_PROGRAM;
const SYSTEM = SystemProgram.programId.toBase58();
const rnd = () => Keypair.generate().publicKey;

// ---- fixtures -------------------------------------------------------------

/** A zero value of an IDL type, so fixtures only spell out what matters. */
function zeroOf(idl, t) {
  if (typeof t === "string") {
    if (t === "bool") return false;
    if (t === "pubkey") return PublicKey.default;
    if (t === "string") return "";
    if (t === "bytes") return Buffer.alloc(0);
    if (/^[ui](8|16|32)$/.test(t)) return 0;
    return new BN(0);
  }
  if (t.array) return Array.from({ length: t.array[1] }, () => zeroOf(idl, t.array[0]));
  if (t.vec) return [];
  if (t.option || t.coption) return null;
  if (t.defined) {
    const def = idl.types.find((d) => d.name === t.defined.name).type;
    if (def.kind === "struct") return Object.fromEntries(def.fields.map((f) => [f.name, zeroOf(idl, f.type)]));
    if (def.kind === "enum") return { [def.variants[0].name]: {} };
  }
  throw new Error(`no zero for ${JSON.stringify(t)}`);
}

async function encode(program, account, fields, size) {
  const idl = program.idl;
  const name = idl.accounts.find((a) => a.name.toLowerCase() === account.toLowerCase()).name;
  const zero = zeroOf(idl, { defined: { name } });
  for (const k of Object.keys(fields)) assert.ok(k in zero, `${account} has no field ${k}`);
  // Anchor's coder.accounts.encode uses a fixed 1000-byte buffer; Pump's Global is larger.
  const coder = program.coder.accounts;
  const buf = Buffer.alloc(8192);
  const len = coder.accountLayouts.get(account).layout.encode({ ...zero, ...fields }, buf);
  const data = Buffer.concat([coder.accountDiscriminator(account), buf.subarray(0, len)]);
  return size && data.length < size ? Buffer.concat([data, Buffer.alloc(size - data.length)]) : data;
}

const info = (data, owner) => ({ data, owner, lamports: 1_000_000_000, executable: false, rentEpoch: 0 });

function mintData(supply) {
  const b = Buffer.alloc(spl.MINT_SIZE);
  spl.MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, b);
  return b;
}
function tokenAccountData(mint, owner, amount) {
  const b = Buffer.alloc(spl.ACCOUNT_SIZE);
  spl.AccountLayout.encode({ mint, owner, amount, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, b);
  return b;
}

function fakeRpc(accounts) {
  const calls = { batches: 0 };
  return {
    calls,
    accounts,
    async getMultipleAccountsInfo(keys) {
      calls.batches++;
      return keys.map((k) => accounts.get(k.toBase58()) ?? null);
    },
    async getEpochInfo() { throw new Error("offline"); },
  };
}

// Standard launch reserves.
const VT = 1_073_000_000_000_000n, VS = 30_000_000_000n, RT = 793_100_000_000_000n, SUPPLY = 1_000_000_000_000_000n;
const PROTOCOL_BPS = 95n, CREATOR_BPS = 30n;

async function curveWorld({ tokenProgram = spl.TOKEN_PROGRAM_ID, quoteMint = PublicKey.default, complete = false, withPool = false } = {}) {
  const mint = rnd();
  const accounts = new Map();
  accounts.set(pump.GLOBAL_PDA.toBase58(), info(await encode(PUMP, "global", {
    initialized: true,
    feeRecipient: rnd(),
    feeRecipients: Array.from({ length: 7 }, rnd),
    feeBasisPoints: new BN(PROTOCOL_BPS.toString()),
    creatorFeeBasisPoints: new BN(CREATOR_BPS.toString()),
    tokenTotalSupply: new BN(SUPPLY.toString()),
  }), PUMP.programId));
  const reserves = complete
    ? { virtualTokenReserves: new BN(0), virtualQuoteReserves: new BN(0), realTokenReserves: new BN(0), realQuoteReserves: new BN(0) }
    : { virtualTokenReserves: new BN(VT.toString()), virtualQuoteReserves: new BN(VS.toString()), realTokenReserves: new BN(RT.toString()), realQuoteReserves: new BN(0) };
  accounts.set(pump.bondingCurvePda(mint).toBase58(), info(await encode(PUMP, "bondingCurve", {
    ...reserves,
    tokenTotalSupply: new BN(SUPPLY.toString()),
    complete,
    creator: rnd(),
    quoteMint,
  }), PUMP.programId));
  accounts.set(mint.toBase58(), info(mintData(SUPPLY), tokenProgram));
  if (withPool) await addPool(accounts, mint);
  return { mint, accounts, rpc: fakeRpc(accounts) };
}

const POOL_BASE = 206_900_000_000_000n, POOL_QUOTE = 85_000_000_000n;
const LP_BPS = 20n, AMM_PROTOCOL_BPS = 5n, AMM_CREATOR_BPS = 5n;

async function addPool(accounts, mint, { quoteMint = spl.NATIVE_MINT } = {}) {
  const poolKey = pump.canonicalPumpPoolPda(mint);
  const [baseVault, quoteVault] = [rnd(), rnd()];
  accounts.set(swap.GLOBAL_CONFIG_PDA.toBase58(), info(await encode(AMM, "globalConfig", {
    lpFeeBasisPoints: new BN(LP_BPS.toString()),
    protocolFeeBasisPoints: new BN(AMM_PROTOCOL_BPS.toString()),
    coinCreatorFeeBasisPoints: new BN(AMM_CREATOR_BPS.toString()),
    protocolFeeRecipients: Array.from({ length: 8 }, rnd),
    buybackFeeRecipients: Array.from({ length: 8 }, rnd),
  }), AMM.programId));
  accounts.set(poolKey.toBase58(), info(await encode(AMM, "pool", {
    creator: pump.pumpPoolAuthorityPda(mint),
    baseMint: mint,
    quoteMint,
    lpMint: rnd(),
    poolBaseTokenAccount: baseVault,
    poolQuoteTokenAccount: quoteVault,
    lpSupply: new BN(1_000_000),
    coinCreator: rnd(),
  }, swap.POOL_ACCOUNT_NEW_SIZE), AMM.programId));
  accounts.set(quoteMint.toBase58(), info(mintData(0n), spl.TOKEN_PROGRAM_ID));
  accounts.set(baseVault.toBase58(), info(tokenAccountData(mint, poolKey, POOL_BASE), spl.TOKEN_PROGRAM_ID));
  accounts.set(quoteVault.toBase58(), info(tokenAccountData(quoteMint, poolKey, POOL_QUOTE), spl.TOKEN_PROGRAM_ID));
  return poolKey;
}

// Independent reimplementation of the legacy curve math (feeConfig absent).
const ceilDiv = (a, b) => (a + b - 1n) / b;
function expectedCurveBuyTokens(solIn) {
  const input = ((solIn - 1n) * 10_000n) / (10_000n + PROTOCOL_BPS + CREATOR_BPS);
  const out = (input * VT) / (VS + input);
  return out < RT ? out : RT;
}
function expectedCurveSellSol(tokens) {
  const gross = (tokens * VS) / (VT + tokens);
  return gross - ceilDiv(gross * PROTOCOL_BPS, 10_000n) - ceilDiv(gross * CREATOR_BPS, 10_000n);
}

const feeWallet = rnd().toBase58();
const cfg = (rpc, extra = {}) => ({ rpc, feeWallet, ...extra });
const decodeIx = (program, ix) => program.coder.instruction.decode(Buffer.from(ix.data));
const u64 = (bn) => BigInt(bn.toString());

function assertFeeTransfer(ix, user, lamports) {
  assert.equal(ix.programAddress, SYSTEM);
  assert.equal(ix.accounts[0].address, user);
  assert.equal(ix.accounts[0].role, AccountRole.WRITABLE_SIGNER);
  assert.equal(ix.accounts[1].address, feeWallet);
  assert.equal(ix.accounts[1].role, AccountRole.WRITABLE);
  const d = Buffer.from(ix.data);
  assert.equal(d.readUInt32LE(0), 2, "System Transfer");
  assert.equal(d.readBigUInt64LE(4), lamports);
}

// ---- feeLamports ----------------------------------------------------------

test("program IDs match the SDK", () => {
  assert.equal(PUMP_PROGRAM, pump.PUMP_PROGRAM_ID.toBase58());
  assert.equal(PUMPSWAP_PROGRAM, pump.PUMP_AMM_PROGRAM_ID.toBase58());
  assert.equal(PUMP_FEE_PROGRAM, pump.PUMP_FEE_PROGRAM_ID.toBase58());
});

test("feeLamports is exact when it divides and rounds up by at most 1 lamport", () => {
  assert.equal(DEFAULT_FEE_BPS, 50);
  assert.equal(feeLamports(1_000_000_000n), 5_000_000n);
  assert.equal(feeLamports(1_000_000_000n, 50), 5_000_000n);
  assert.equal(feeLamports(199n, 50), 1n); // 0.995 -> 1
  assert.equal(feeLamports(201n, 50), 2n); // 1.005 -> 2
  assert.equal(feeLamports(1n, 1), 1n);
  assert.equal(feeLamports(0n, 50), 0n);
  assert.equal(feeLamports(123_456_789n, 0), 0n);
  assert.equal(feeLamports(10n, 10_000), 10n);
  for (const sol of [1n, 7n, 999n, 12_345_678_901n, 18_446_744_073_709_551_615n]) {
    for (const bps of [1, 33, 50, 99, 250]) {
      const f = feeLamports(sol, bps);
      const exactTimesBps = sol * BigInt(bps); // fee * 10000 vs exact * 10000
      assert.ok(f * 10_000n >= exactTimesBps, "never below the exact fee");
      assert.ok(f * 10_000n - exactTimesBps < 10_000n, "at most 1 lamport above");
    }
  }
});

test("feeLamports rejects bad input", () => {
  assert.throws(() => feeLamports(-1n, 50), RangeError);
  assert.throws(() => feeLamports(100, 50), RangeError);
  assert.throws(() => feeLamports(100n, 10_001), RangeError);
  assert.throws(() => feeLamports(100n, -1), RangeError);
  assert.throws(() => feeLamports(100n, 1.5), RangeError);
});

test("slippage bounds in bigint basis points", () => {
  assert.equal(withSlippageUp(1_000_000n, 100), 1_010_000n);
  assert.equal(withSlippageUp(999n, 125), 1011n);
  assert.equal(withSlippageDown(1_000_000n, 100), 990_000n);
  assert.equal(withSlippageDown(999n, 125), 986n);
  assert.equal(withSlippageDown(5n, 10_000), 0n);
});

// ---- bonding curve --------------------------------------------------------

test("quoteBuy on the curve matches the curve math, with slippage and fee", async () => {
  const { mint, rpc } = await curveWorld();
  const solIn = 1_000_000_000n;
  const q = await quoteBuy(cfg(rpc), { mint: mint.toBase58(), solIn, slippageBps: 150 });
  assert.equal(q.venue, "curve");
  assert.equal(q.tokensOut, expectedCurveBuyTokens(solIn));
  assert.equal(q.maxSolCost, 1_015_000_000n);
  assert.equal(q.feeLamports, 5_000_000n);
  assert.equal(q.maxTotalLamports, 1_020_000_000n);
  assert.equal(rpc.calls.batches, 1, "one RPC round trip");
});

test("quoteSell on the curve matches the curve math", async () => {
  const { mint, rpc } = await curveWorld();
  const tokensIn = 10_000_000_000_000n;
  const q = await quoteSell(cfg(rpc, { feeBps: 100 }), { mint: mint.toBase58(), tokensIn, slippageBps: 200 });
  const sol = expectedCurveSellSol(tokensIn);
  assert.equal(q.venue, "curve");
  assert.equal(q.solOut, sol);
  assert.equal(q.minSolOut, (sol * 9_800n) / 10_000n);
  assert.equal(q.feeLamports, ceilDiv(sol * 100n, 10_000n));
});

test("buildBuy on the curve: ATA, buy with exact bounds, then our fee last", async () => {
  const { mint, rpc } = await curveWorld();
  const user = rnd().toBase58();
  const { quote, instructions } = await buildBuy(cfg(rpc), { mint: mint.toBase58(), user, solIn: 250_000_000n, slippageBps: 100 });
  assert.equal(instructions.length, 3);
  const [ata, buy, fee] = instructions;
  assert.equal(ata.programAddress, spl.ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
  assert.equal(Buffer.from(ata.data)[0], 1, "CreateIdempotent");
  assert.equal(buy.programAddress, PUMP_PROGRAM);
  const d = decodeIx(PUMP, buy);
  assert.equal(d.name, "buy");
  assert.equal(u64(d.data.amount), quote.tokensOut);
  assert.equal(u64(d.data.maxSolCost), 252_500_000n);
  assert.ok(buy.accounts.some((a) => a.address === user && a.role === AccountRole.WRITABLE_SIGNER));
  const expectedAta = spl.getAssociatedTokenAddressSync(mint, new PublicKey(user), true, spl.TOKEN_PROGRAM_ID).toBase58();
  assert.ok(buy.accounts.some((a) => a.address === expectedAta));
  assertFeeTransfer(fee, user, 1_250_000n);
});

test("buildBuy uses the mint's token program (Token-2022 coins)", async () => {
  const { mint, rpc } = await curveWorld({ tokenProgram: spl.TOKEN_2022_PROGRAM_ID });
  const user = rnd();
  const { instructions } = await buildBuy(cfg(rpc), { mint: mint.toBase58(), user: user.toBase58(), solIn: 10_000_000n });
  const ata2022 = spl.getAssociatedTokenAddressSync(mint, user, true, spl.TOKEN_2022_PROGRAM_ID).toBase58();
  const buy = instructions.find((i) => i.programAddress === PUMP_PROGRAM);
  assert.ok(buy.accounts.some((a) => a.address === ata2022));
  assert.ok(buy.accounts.some((a) => a.address === spl.TOKEN_2022_PROGRAM_ID.toBase58()));
});

test("buildSell on the curve: sell with min out, then our fee on the quoted SOL", async () => {
  const { mint, rpc } = await curveWorld();
  const user = rnd().toBase58();
  const tokensIn = 3_000_000_000_000n;
  const { quote, instructions } = await buildSell(cfg(rpc), { mint: mint.toBase58(), user, tokensIn, slippageBps: 50 });
  assert.equal(instructions.length, 2);
  const [sell, fee] = instructions;
  const d = decodeIx(PUMP, sell);
  assert.equal(d.name, "sell");
  assert.equal(u64(d.data.amount), tokensIn);
  assert.equal(u64(d.data.minSolOutput), quote.minSolOut);
  assert.equal(quote.minSolOut, (expectedCurveSellSol(tokensIn) * 9_950n) / 10_000n);
  assertFeeTransfer(fee, user, feeLamports(quote.solOut, 50));
});

test("feeBps 0 appends no transfer", async () => {
  const { mint, rpc } = await curveWorld();
  const { quote, instructions } = await buildBuy(cfg(rpc, { feeBps: 0 }), { mint: mint.toBase58(), user: rnd().toBase58(), solIn: 10_000_000n });
  assert.equal(quote.feeLamports, 0n);
  assert.ok(!instructions.some((i) => i.programAddress === SYSTEM && i.accounts.some((a) => a.address === feeWallet)));
});

test("refuses bad amounts, bad fee bps and dust", async () => {
  const { mint, rpc } = await curveWorld();
  const m = mint.toBase58();
  await assert.rejects(quoteBuy(cfg(rpc), { mint: m, solIn: 0n }), (e) => e instanceof PumpTradeError && e.code === "bad_amount");
  await assert.rejects(quoteSell(cfg(rpc), { mint: m, tokensIn: -5n }), (e) => e.code === "bad_amount");
  await assert.rejects(quoteBuy(cfg(rpc), { mint: m, solIn: 1n }), (e) => e.code === "too_small");
  await assert.rejects(buildBuy(cfg(rpc, { feeBps: 20_000 }), { mint: m, user: rnd().toBase58(), solIn: 1_000_000n }), RangeError);
});

test("refuses unknown mints and token-quoted curves", async () => {
  const { rpc } = await curveWorld();
  await assert.rejects(quoteBuy(cfg(rpc), { mint: rnd().toBase58(), solIn: 1_000n }), (e) => e.code === "not_found");
  const usdc = await curveWorld({ quoteMint: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") });
  await assert.rejects(quoteBuy(cfg(usdc.rpc), { mint: usdc.mint.toBase58(), solIn: 1_000_000n }), (e) => e.code === "unsupported_quote");
  // A mint with no curve and no pool.
  const lone = rnd();
  rpc.accounts.set(lone.toBase58(), info(mintData(1n), spl.TOKEN_PROGRAM_ID));
  await assert.rejects(quoteBuy(cfg(rpc), { mint: lone.toBase58(), solIn: 1_000n }), (e) => e.code === "not_found");
});

// ---- graduation -----------------------------------------------------------

test("a complete curve with no pool yet is awaiting migration", async () => {
  const { mint, rpc } = await curveWorld({ complete: true });
  await assert.rejects(quoteBuy(cfg(rpc), { mint: mint.toBase58(), solIn: 1_000_000n }), (e) => e.code === "awaiting_migration");
});

test("a curve flagged complete routes to PumpSwap even before its reserves are zeroed", async () => {
  const { mint, accounts, rpc } = await curveWorld({ withPool: true });
  const key = pump.bondingCurvePda(mint).toBase58();
  const curve = pump.PUMP_SDK.decodeBondingCurve(accounts.get(key));
  accounts.set(key, info(await encode(PUMP, "bondingCurve", { ...curve, complete: true }), PUMP.programId));
  assert.equal((await quoteBuy(cfg(rpc), { mint: mint.toBase58(), solIn: 1_000_000n })).venue, "amm");
});

test("graduated: quoteBuy and buildBuy use PumpSwap and still append our fee", async () => {
  const { mint, rpc } = await curveWorld({ complete: true, withPool: true });
  const user = rnd().toBase58();
  const solIn = 500_000_000n;
  const q = await quoteBuy(cfg(rpc), { mint: mint.toBase58(), solIn, slippageBps: 100 });
  assert.equal(q.venue, "amm");
  // Constant product with LP + protocol + creator fees taken from the input.
  const eff = (solIn * 10_000n) / (10_000n + LP_BPS + AMM_PROTOCOL_BPS + AMM_CREATOR_BPS);
  const approx = (POOL_BASE * eff) / (POOL_QUOTE + eff);
  assert.ok(q.tokensOut <= approx && q.tokensOut > (approx * 9_999n) / 10_000n, `${q.tokensOut} ~ ${approx}`);
  assert.equal(q.maxSolCost, 505_000_000n);

  const { quote, instructions } = await buildBuy(cfg(rpc), { mint: mint.toBase58(), user, solIn, slippageBps: 100 });
  assert.equal(quote.tokensOut, q.tokensOut);
  assert.ok(!instructions.some((i) => i.programAddress === PUMP_PROGRAM), "no curve instruction");
  const ammIx = instructions.filter((i) => i.programAddress === PUMPSWAP_PROGRAM).map((i) => decodeIx(AMM, i));
  const buy = ammIx.find((d) => d.name === "buy");
  assert.ok(buy, `AMM buy in ${ammIx.map((d) => d.name)}`);
  assert.equal(u64(buy.data.baseAmountOut), quote.tokensOut);
  assert.equal(u64(buy.data.maxQuoteAmountIn), 505_000_000n);
  assertFeeTransfer(instructions.at(-1), user, 2_500_000n);
});

test("graduated: buildSell uses PumpSwap, unwraps, then our fee", async () => {
  const { mint, rpc } = await curveWorld({ complete: true, withPool: true });
  const user = rnd().toBase58();
  const tokensIn = 1_000_000_000_000n;
  const { quote, instructions } = await buildSell(cfg(rpc), { mint: mint.toBase58(), user, tokensIn, slippageBps: 300 });
  assert.equal(quote.venue, "amm");
  const gross = (POOL_QUOTE * tokensIn) / (POOL_BASE + tokensIn);
  assert.ok(quote.solOut < gross && quote.solOut > (gross * 99n) / 100n);
  assert.equal(quote.minSolOut, (quote.solOut * 9_700n) / 10_000n);
  const sell = instructions.filter((i) => i.programAddress === PUMPSWAP_PROGRAM).map((i) => decodeIx(AMM, i)).find((d) => d.name === "sell");
  assert.equal(u64(sell.data.baseAmountIn), tokensIn);
  assert.equal(u64(sell.data.minQuoteAmountOut), quote.minSolOut);
  // The WSOL account is closed (SOL unwrapped) before our transfer.
  const closeAt = instructions.findIndex((i) => i.programAddress === spl.TOKEN_PROGRAM_ID.toBase58() && Buffer.from(i.data)[0] === 9);
  assert.ok(closeAt >= 0 && closeAt < instructions.length - 1);
  assertFeeTransfer(instructions.at(-1), user, feeLamports(quote.solOut, 50));
});

test("graduated to a non-WSOL pool is refused", async () => {
  const { mint, accounts, rpc } = await curveWorld({ complete: true });
  await addPool(accounts, mint, { quoteMint: rnd() });
  await assert.rejects(quoteBuy(cfg(rpc), { mint: mint.toBase58(), solIn: 1_000_000n }), (e) => e.code === "unsupported_quote");
});
