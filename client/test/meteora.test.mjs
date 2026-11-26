// Meteora DBC trade layer against a fake RPC. Pool, config and mint accounts are
// encoded with the SDK's own IDL coder, so decoding goes through the real SDK
// paths; quote numbers are checked against an independent bigint calculation.
// Run: npx tsc --outDir dist && node --test test/meteora.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AccountRole } from "@solana/kit";
import {
  buildBuy, buildSell, quoteBuy, quoteSell, isMeteoraPool, MeteoraTradeError,
  METEORA_DBC_PROGRAM, VIRTUAL_POOL_BASE_MINT_OFFSET,
} from "../dist/trade/meteora.js";
import { feeLamports } from "../dist/trade/pumpfun.js";
import { SPONSOR_PROGRAMS, APP_PROGRAMS } from "../dist/sponsor.js";
import { METEORA_DBC_PROGRAM as APPCHECK_DBC } from "../dist/appcheck.js";

const require = createRequire(import.meta.url);
const dbc = require("@meteora-ag/dynamic-bonding-curve-sdk");
const { PublicKey, Keypair, SystemProgram } = require("@solana/web3.js");
const spl = require("@solana/spl-token");
const { BN } = require("@coral-xyz/anchor");

const PROGRAM = dbc.createDbcProgram({});
const SYSTEM = SystemProgram.programId.toBase58();
const rnd = () => Keypair.generate().publicKey;
const big = (n) => new BN(n.toString());
const u64 = (bn) => BigInt(bn.toString());

// ---- fixtures -------------------------------------------------------------

const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

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
  if (t.option) return null;
  if (t.defined) {
    const def = idl.types.find((d) => d.name === t.defined.name).type;
    if (def.kind === "struct") return Object.fromEntries(def.fields.map((f) => [camel(f.name), zeroOf(idl, f.type)]));
    if (def.kind === "enum") return { [def.variants[0].name]: {} };
  }
  throw new Error(`no zero for ${JSON.stringify(t)}`);
}

const merge = (zero, over) => {
  const out = { ...zero };
  for (const [k, v] of Object.entries(over)) {
    assert.ok(k in zero, `no field ${k}`);
    out[k] = v && typeof v === "object" && !BN.isBN(v) && !(v instanceof PublicKey) && !Array.isArray(v) && !Buffer.isBuffer(v) ? merge(zero[k], v) : v;
  }
  return out;
};

/** Anchor's coder.accounts.encode uses a 1000-byte buffer; PoolConfig is larger. */
function encode(account, fields) {
  const idl = PROGRAM.idl;
  const name = idl.accounts.find((a) => a.name.toLowerCase() === account.toLowerCase()).name;
  const coder = PROGRAM.coder.accounts;
  const buf = Buffer.alloc(16384);
  const len = coder.accountLayouts.get(name).layout.encode(merge(zeroOf(idl, { defined: { name } }), fields), buf);
  return Buffer.concat([coder.accountDiscriminator(name), buf.subarray(0, len)]);
}

const info = (data, owner) => ({ data, owner, lamports: 1_000_000_000, executable: false, rentEpoch: 0 });

function mintData(supply, extensions = []) {
  const base = Buffer.alloc(spl.MINT_SIZE);
  spl.MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, base);
  if (!extensions.length) return base;
  // Token-2022: pad to the account size, account-type byte (1 = Mint), then TLV entries.
  const tlv = Buffer.concat(extensions.map(([type, len]) => {
    const h = Buffer.alloc(4);
    h.writeUInt16LE(type, 0); h.writeUInt16LE(len, 2);
    return Buffer.concat([h, Buffer.alloc(len)]);
  }));
  return Buffer.concat([base, Buffer.alloc(spl.ACCOUNT_SIZE - spl.MINT_SIZE), Buffer.from([1]), tlv]);
}

function fakeRpc(accounts) {
  const calls = { gpa: 0 };
  return {
    calls, accounts,
    async getAccountInfo(k) { return accounts.get(k.toBase58()) ?? null; },
    async getMultipleAccountsInfo(keys) { return keys.map((k) => accounts.get(k.toBase58()) ?? null); },
    async getProgramAccounts(program, { filters }) {
      calls.gpa++;
      assert.equal(program.toBase58(), METEORA_DBC_PROGRAM);
      const m = filters[0].memcmp;
      assert.equal(m.offset, VIRTUAL_POOL_BASE_MINT_OFFSET);
      const want = new PublicKey(m.bytes).toBuffer();
      return [...accounts].filter(([, a]) => a.owner.equals(PROGRAM.programId) && a.data.length > m.offset + 32 && a.data.subarray(m.offset, m.offset + 32).equals(want))
        .map(([k, a]) => ({ pubkey: new PublicKey(k), account: a }));
    },
    async getSlot() { return 1000; },
    async getBlockTime() { return 1_700_000_000; },
  };
}

// One flat segment: price from S0 to SM, liquidity L sized to raise THRESHOLD lamports.
const Q = 1n << 64n;
const S0 = Q >> 8n, SM = Q >> 4n; // sqrt prices, Q64.64
const THRESHOLD = 85_000_000_000n;
const L = (THRESHOLD << 128n) / (SM - S0);
const FEE_NUM = 10_000_000n; // 1% of 1e9
const FEE_DEN = 1_000_000_000n;
const P0 = S0 + (S0 >> 3n); // current sqrt price
const RESERVE0 = (L * (P0 - S0)) >> 128n;
const SOLD0 = (L * (P0 - S0)) / (P0 * S0); // base the curve has sold so far: the most a seller can return
const SELL = SOLD0 / 4n;

async function world({
  tokenProgram = spl.TOKEN_PROGRAM_ID, quoteMint = spl.NATIVE_MINT, quoteTokenFlag = 0,
  transferFeeBps = 0, mintExtensions = [], quoteReserve = RESERVE0, isMigrated = 0, migrationProgress = 0, withPoolMint = true,
} = {}) {
  const mint = rnd(), config = rnd(), pool = rnd();
  const accounts = new Map();
  accounts.set(config.toBase58(), info(encode("poolConfig", {
    quoteMint, quoteTokenFlag,
    tokenType: tokenProgram.equals(spl.TOKEN_2022_PROGRAM_ID) ? 1 : 0,
    transferFeeFlag: transferFeeBps ? 1 : 0, transferFeeBasisPoints: transferFeeBps,
    collectFeeMode: 0,
    activationType: 0,
    sqrtStartPrice: big(S0), migrationSqrtPrice: big(SM), migrationQuoteThreshold: big(THRESHOLD),
    poolFees: { baseFee: { cliffFeeNumerator: big(FEE_NUM), baseFeeMode: 0 } },
    curve: [{ sqrtPrice: big(SM), liquidity: big(L) }, ...Array.from({ length: 15 }, () => ({ sqrtPrice: big(0), liquidity: big(0) }))],
  }), PROGRAM.programId));
  accounts.set(pool.toBase58(), info(encode("virtualPool", {
    poolState: {
      config, baseMint: mint, baseVault: rnd(), quoteVault: rnd(), creator: rnd(),
      quoteReserve: big(quoteReserve), sqrtPrice: big(P0), isMigrated, migrationProgress,
    },
  }), PROGRAM.programId));
  if (withPoolMint) accounts.set(mint.toBase58(), info(mintData(1_000_000_000_000_000n, mintExtensions), tokenProgram));
  return { mint, pool, config, accounts, rpc: fakeRpc(accounts) };
}

// Independent reimplementation of the single-segment curve (Q64.64 sqrt prices).
const ceilDiv = (a, b) => (a + b - 1n) / b;
function expectedBuyTokens(solIn, transferBps = 0n) {
  const fee = ceilDiv(solIn * FEE_NUM, FEE_DEN);
  const next = P0 + ((solIn - fee) << 128n) / L;
  const out = (L * (next - P0)) / (next * P0);
  return out - ceilDiv(out * transferBps, 10_000n);
}
function expectedSellSol(tokensIn, transferBps = 0n) {
  const sent = tokensIn - ceilDiv(tokensIn * transferBps, 10_000n);
  const next = ceilDiv(L * P0, L + sent * P0);
  const gross = (L * (P0 - next)) >> 128n;
  return gross - ceilDiv(gross * FEE_NUM, FEE_DEN);
}

const feeWallet = rnd().toBase58();
const cfg = (rpc, extra = {}) => ({ rpc, feeWallet, ...extra });
const decodeIx = (ix) => PROGRAM.coder.instruction.decode(Buffer.from(ix.data));
const swapArgs = (ix) => { const d = decodeIx(ix); return d.data.params ?? d.data; };

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
const refusal = (code) => (e) => e instanceof MeteoraTradeError && e.code === code;

// ---- constants and wiring --------------------------------------------------

test("program ID matches the SDK and is allowlisted for sponsorship and the app check", () => {
  assert.equal(METEORA_DBC_PROGRAM, dbc.DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58());
  assert.equal(METEORA_DBC_PROGRAM, PROGRAM.programId.toBase58());
  assert.equal(SPONSOR_PROGRAMS.meteoraDbc, METEORA_DBC_PROGRAM);
  assert.ok(APP_PROGRAMS.includes(METEORA_DBC_PROGRAM));
  assert.equal(APPCHECK_DBC, METEORA_DBC_PROGRAM);
});

// ---- quotes ----------------------------------------------------------------

test("quoteBuy matches an independent curve calculation, with slippage and fee", async () => {
  const { mint, pool, rpc } = await world();
  const solIn = 2_000_000_000n;
  const q = await quoteBuy(cfg(rpc), { mint: mint.toBase58(), solIn, slippageBps: 150 });
  const expected = expectedBuyTokens(solIn);
  assert.ok(expected > 0n);
  assert.equal(q.venue, "meteora-dbc");
  assert.equal(q.pool, pool.toBase58());
  assert.equal(q.tokensOut, expected);
  assert.equal(q.minTokensOut, (expected * 9_850n) / 10_000n);
  assert.equal(q.feeLamports, 10_000_000n);
  assert.equal(q.maxTotalLamports, solIn + 10_000_000n);
  assert.equal(q.transferFeeBps, 0);
});

test("quoteSell matches an independent curve calculation", async () => {
  const { mint, rpc } = await world();
  const tokensIn = SELL;
  const q = await quoteSell(cfg(rpc, { feeBps: 100 }), { mint: mint.toBase58(), tokensIn, slippageBps: 200 });
  const sol = expectedSellSol(tokensIn);
  assert.ok(sol > 0n);
  assert.equal(q.solOut, sol);
  assert.equal(q.minSolOut, (sol * 9_800n) / 10_000n);
  assert.equal(q.feeLamports, ceilDiv(q.minSolOut * 100n, 10_000n));
});

test("a quote that overruns the curve is a quote_failed refusal", async () => {
  const { mint, rpc } = await world();
  await assert.rejects(quoteBuy(cfg(rpc), { mint: mint.toBase58(), solIn: 500_000_000_000n }), refusal("quote_failed"));
});

test("pool discovery: one getProgramAccounts, cached per mint; an explicit pool skips it", async () => {
  const w = await world();
  const m = w.mint.toBase58();
  await quoteBuy(cfg(w.rpc), { mint: m, solIn: 1_000_000_000n });
  await quoteBuy(cfg(w.rpc), { mint: m, solIn: 1_000_000_000n });
  assert.equal(w.rpc.calls.gpa, 1);
  const w2 = await world();
  await quoteBuy(cfg(w2.rpc), { mint: w2.mint.toBase58(), solIn: 1_000_000_000n, pool: w2.pool.toBase58() });
  assert.equal(w2.rpc.calls.gpa, 0);
});

// ---- instructions -----------------------------------------------------------

test("buildBuy: swap2 ExactIn with the slippage bound, our fee transfer last and exact", async () => {
  const { mint, pool, rpc } = await world();
  const user = rnd().toBase58();
  const solIn = 1_000_000_000n;
  const { quote, instructions } = await buildBuy(cfg(rpc), { mint: mint.toBase58(), user, solIn, slippageBps: 100 });
  const swap = instructions.filter((i) => i.programAddress === METEORA_DBC_PROGRAM);
  assert.equal(swap.length, 1);
  const d = decodeIx(swap[0]);
  assert.equal(d.name, "swap2");
  const a = swapArgs(swap[0]);
  assert.equal(u64(a.amount0), solIn);
  assert.equal(u64(a.amount1), quote.minTokensOut);
  assert.equal(quote.minTokensOut, (expectedBuyTokens(solIn) * 9_900n) / 10_000n);
  assert.ok(swap[0].accounts.some((x) => x.address === pool.toBase58()));
  assert.ok(swap[0].accounts.some((x) => x.address === user && (x.role === AccountRole.WRITABLE_SIGNER || x.role === AccountRole.READONLY_SIGNER)));
  const ata = spl.getAssociatedTokenAddressSync(mint, new PublicKey(user), true, spl.TOKEN_PROGRAM_ID).toBase58();
  assert.ok(swap[0].accounts.some((x) => x.address === ata), "user's token account");
  assert.ok(instructions.indexOf(swap[0]) < instructions.length - 1, "fee after the swap");
  assertFeeTransfer(instructions.at(-1), user, 5_000_000n);
});

test("buildSell: swap2 base-for-quote with min out, then our fee on the minimum SOL out", async () => {
  const { mint, rpc } = await world();
  const user = rnd().toBase58();
  const tokensIn = SELL;
  const { quote, instructions } = await buildSell(cfg(rpc), { mint: mint.toBase58(), user, tokensIn, slippageBps: 50 });
  const swap = instructions.find((i) => i.programAddress === METEORA_DBC_PROGRAM);
  const a = swapArgs(swap);
  assert.equal(u64(a.amount0), tokensIn);
  assert.equal(u64(a.amount1), quote.minSolOut);
  assert.equal(quote.minSolOut, (expectedSellSol(tokensIn) * 9_950n) / 10_000n);
  // SOL is unwrapped (CloseAccount) before our transfer, which is last.
  const closeAt = instructions.findIndex((i) => i.programAddress === spl.TOKEN_PROGRAM_ID.toBase58() && Buffer.from(i.data)[0] === 9);
  assert.ok(closeAt > instructions.indexOf(swap) && closeAt < instructions.length - 1);
  assertFeeTransfer(instructions.at(-1), user, feeLamports(quote.minSolOut, 50));
});

test("feeBps 0 appends no transfer; bad fee bps throws", async () => {
  const { mint, rpc } = await world();
  const { quote, instructions } = await buildBuy(cfg(rpc, { feeBps: 0 }), { mint: mint.toBase58(), user: rnd().toBase58(), solIn: 1_000_000_000n });
  assert.equal(quote.feeLamports, 0n);
  assert.ok(!instructions.some((i) => i.programAddress === SYSTEM && i.accounts.some((a) => a.address === feeWallet)));
  await assert.rejects(buildBuy(cfg(rpc, { feeBps: 20_000 }), { mint: mint.toBase58(), user: rnd().toBase58(), solIn: 1_000_000_000n }), RangeError);
});

// ---- slippage ---------------------------------------------------------------

test("slippage above the cap is refused, so a sell fee can't round to zero", async () => {
  const { mint, rpc } = await world();
  const m = mint.toBase58();
  const tokensIn = SELL;
  await assert.rejects(quoteSell(cfg(rpc), { mint: m, tokensIn, slippageBps: 10_000 }), refusal("bad_slippage"));
  await assert.rejects(quoteBuy(cfg(rpc), { mint: m, solIn: 1_000_000_000n, slippageBps: 3001 }), refusal("bad_slippage"));
  await assert.rejects(quoteBuy(cfg(rpc), { mint: m, solIn: 1_000_000_000n, slippageBps: 1.5 }), refusal("bad_slippage"));
  await assert.rejects(buildBuy(cfg(rpc), { mint: m, user: rnd().toBase58(), solIn: 1_000_000_000n, slippageBps: -1 }), refusal("bad_slippage"));
  const q = await quoteSell(cfg(rpc), { mint: m, tokensIn, slippageBps: 3000 });
  assert.ok(q.feeLamports > 0n);
});

test("refuses bad amounts and unknown mints", async () => {
  const { mint, rpc } = await world();
  const m = mint.toBase58();
  await assert.rejects(quoteBuy(cfg(rpc), { mint: m, solIn: 0n }), refusal("bad_amount"));
  await assert.rejects(quoteSell(cfg(rpc), { mint: m, tokensIn: -5n }), refusal("bad_amount"));
  await assert.rejects(quoteBuy(cfg(rpc), { mint: rnd().toBase58(), solIn: 1_000n }), refusal("not_found"));
});

// ---- graduation -------------------------------------------------------------

test("a graduated or migrating pool is refused with `graduated`, for quotes and builds", async () => {
  const cases = {
    migrated: { isMigrated: 1 },
    "migration progress": { migrationProgress: 1 },
    "created DAMM pool": { migrationProgress: 3, isMigrated: 1 },
    "curve full, not yet flagged": { quoteReserve: THRESHOLD },
  };
  for (const [name, opts] of Object.entries(cases)) {
    const { mint, rpc } = await world(opts);
    const m = mint.toBase58();
    await assert.rejects(quoteBuy(cfg(rpc), { mint: m, solIn: 1_000_000_000n }), refusal("graduated"), name);
    await assert.rejects(quoteSell(cfg(rpc), { mint: m, tokensIn: 1_000_000n }), refusal("graduated"), name);
    await assert.rejects(buildBuy(cfg(rpc), { mint: m, user: rnd().toBase58(), solIn: 1_000_000_000n }), refusal("graduated"), name);
    await assert.rejects(buildSell(cfg(rpc), { mint: m, user: rnd().toBase58(), tokensIn: 1_000_000n }), refusal("graduated"), name);
    assert.equal(await isMeteoraPool(rpc, m), false, name);
  }
});

// ---- quote mint --------------------------------------------------------------

test("a non-SOL quote mint is refused with `unsupported_quote`", async () => {
  const usdc = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const { mint, rpc } = await world({ quoteMint: usdc });
  const m = mint.toBase58();
  await assert.rejects(quoteBuy(cfg(rpc), { mint: m, solIn: 1_000_000_000n }), refusal("unsupported_quote"));
  await assert.rejects(buildSell(cfg(rpc), { mint: m, user: rnd().toBase58(), tokensIn: 1_000_000n }), refusal("unsupported_quote"));
  // Even a SOL-looking mint on a Token-2022 quote flag is not plain SOL.
  const t22 = await world({ quoteTokenFlag: 1 });
  await assert.rejects(quoteBuy(cfg(t22.rpc), { mint: t22.mint.toBase58(), solIn: 1_000_000_000n }), refusal("unsupported_quote"));
  assert.equal(await isMeteoraPool(rpc, m), false);
});

// ---- Token-2022 ---------------------------------------------------------------

test("Token-2022 base mint with a declared transfer fee: the fee is included in quotes", async () => {
  const { mint, rpc } = await world({ tokenProgram: spl.TOKEN_2022_PROGRAM_ID, transferFeeBps: 500, mintExtensions: [[1, 108]] });
  const m = mint.toBase58();
  const solIn = 1_000_000_000n;
  const buy = await quoteBuy(cfg(rpc), { mint: m, solIn });
  assert.equal(buy.transferFeeBps, 500);
  assert.equal(buy.tokensOut, expectedBuyTokens(solIn, 500n));
  assert.ok(buy.tokensOut < expectedBuyTokens(solIn));
  const tokensIn = SELL;
  const sell = await quoteSell(cfg(rpc), { mint: m, tokensIn });
  assert.equal(sell.solOut, expectedSellSol(tokensIn, 500n));
  // Instructions use the Token-2022 program for the user's token account.
  const user = rnd();
  const { instructions } = await buildBuy(cfg(rpc), { mint: m, user: user.toBase58(), solIn });
  const ata = spl.getAssociatedTokenAddressSync(mint, user, true, spl.TOKEN_2022_PROGRAM_ID).toBase58();
  assert.ok(instructions.find((i) => i.programAddress === METEORA_DBC_PROGRAM).accounts.some((a) => a.address === ata));
});

test("Token-2022 mint with a transfer fee the pool config does not declare, or a hook, is refused", async () => {
  const undeclared = await world({ tokenProgram: spl.TOKEN_2022_PROGRAM_ID, mintExtensions: [[1, 108]] });
  await assert.rejects(quoteBuy(cfg(undeclared.rpc), { mint: undeclared.mint.toBase58(), solIn: 1_000_000_000n }), refusal("unsupported_token_program"));
  const hook = await world({ tokenProgram: spl.TOKEN_2022_PROGRAM_ID, mintExtensions: [[14, 64]] });
  await assert.rejects(quoteBuy(cfg(hook.rpc), { mint: hook.mint.toBase58(), solIn: 1_000_000_000n }), refusal("unsupported_token_program"));
  assert.equal(await isMeteoraPool(hook.rpc, hook.mint.toBase58()), false);
});

// ---- isMeteoraPool ---------------------------------------------------------------

test("isMeteoraPool: true for a live curve, false for other mints; RPC errors propagate", async () => {
  const { mint, rpc } = await world();
  assert.equal(await isMeteoraPool(rpc, mint.toBase58()), true);
  assert.equal(await isMeteoraPool(rpc, rnd().toBase58()), false);
  const broken = { ...rpc, async getProgramAccounts() { throw new Error("rpc down"); } };
  await assert.rejects(isMeteoraPool(broken, rnd().toBase58()), /rpc down/);
});
