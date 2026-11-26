/**
 * Meteora Dynamic Bonding Curve (DBC) trade layer: quotes and instructions for
 * buying and selling a coin that is still on its DBC virtual curve (Bags,
 * Believe and Jupiter Studio launch here). A SOL fee to Ringside is appended to
 * every trade, exactly as in pumpfun.ts.
 *
 * Quotes run the SDK's own offline math (`swapQuote2`, ExactIn) on the decoded
 * virtual pool and its config, so fee schedule, dynamic fee, rate limiter and
 * Token-2022 transfer fee are the program's. Instructions come from the SDK's
 * `swap2` (ExactIn), which wraps and unwraps SOL.
 *
 * Slippage: a buy spends exactly `solIn` and asks for at least `tokensOut` less
 * slippage; a sell gives exactly `tokensIn` and asks for at least `solOut` less
 * slippage. Bounds are bigint basis points, not the SDK's.
 *
 * Our fee is `feeBps` of the trade's SOL value (SOL spent on a buy, the minimum
 * SOL received on a sell), rounded up, a System transfer from the user to
 * `feeWallet` after the trade.
 *
 * Refused: a graduated or migrating pool (`graduated`; Jupiter trades the DAMM
 * v2 pool after migration), a pool not quoted in plain SOL (`unsupported_quote`),
 * a transfer-hook base mint (`unsupported_token_program`).
 *
 * Token-2022: a base mint with a transfer fee is QUOTED, not refused. DBC fixes
 * the fee on the config (`transferFeeFlag` / `transferFeeBasisPoints`) and the
 * SDK takes it off the tokens a buyer receives and off the tokens a seller
 * sends, so `tokensOut` is what lands in the wallet and `tokensIn` is what
 * leaves it. A mint that carries a TransferFeeConfig the pool config does not
 * declare cannot be quoted reliably and is refused.
 *
 * Why `createRequire`: web3.js `PublicKey` must be one class across SDKs
 * (pumpfun.ts loads the CJS graph), and the SDK's ESM build would pull a second
 * copy.
 */
import { createRequire } from "node:module";
import { address, type Address, type Instruction } from "@solana/kit";
import type * as DbcModule from "@meteora-ag/dynamic-bonding-curve-sdk";
import type * as Web3Module from "@solana/web3.js";
import type * as SplTokenModule from "@solana/spl-token";
import type { AccountInfo, Commitment, PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { PoolConfig, VirtualPool } from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  feeLamports,
  withSlippageDown,
  toKitInstruction,
  MAX_SLIPPAGE_BPS,
  DEFAULT_FEE_BPS,
  DEFAULT_SLIPPAGE_BPS,
  type BuiltTrade,
} from "./pumpfun.js";
import { checkMeteoraSwap, JupiterError, type CheckIx } from "./jupiter.js";

const require = createRequire(import.meta.url);
const dbc = require("@meteora-ag/dynamic-bonding-curve-sdk") as typeof DbcModule;
const web3 = require("@solana/web3.js") as typeof Web3Module;
const spl = require("@solana/spl-token") as typeof SplTokenModule;
type BNType = { toString(): string };
type BNT = PoolConfig["migrationQuoteThreshold"];
const { BN } = require("@coral-xyz/anchor") as { BN: new (v: string) => BNType };

export const METEORA_DBC_PROGRAM = address("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
export { feeLamports, MAX_SLIPPAGE_BPS, DEFAULT_FEE_BPS, DEFAULT_SLIPPAGE_BPS };
export type { BuiltTrade };

/** Byte offset of `base_mint` in a VirtualPool account: discriminator, volatility tracker, config, creator. */
export const VIRTUAL_POOL_BASE_MINT_OFFSET = 8 + 64 + 32 + 32;

/**
 * The RPC calls this module makes. A web3.js `Connection` satisfies it; tests
 * pass a fake. `getAccountInfo` is for the SDK's `swap2`.
 */
export interface MeteoraRpc {
  getAccountInfo(key: PublicKey, commitment?: Commitment): Promise<AccountInfo<Buffer> | null>;
  getMultipleAccountsInfo(keys: PublicKey[], commitment?: Commitment): Promise<(AccountInfo<Buffer> | null)[]>;
  getProgramAccounts(
    program: PublicKey,
    config: { commitment?: Commitment; filters?: unknown[]; dataSlice?: { offset: number; length: number } },
  ): Promise<{ pubkey: PublicKey; account: AccountInfo<Buffer> }[]>;
  getSlot(commitment?: Commitment): Promise<number>;
  getBlockTime(slot: number): Promise<number | null>;
}

export interface MeteoraTradeConfig {
  rpc: MeteoraRpc;
  /** Receives our fee, in SOL. */
  feeWallet: Address | string;
  /** Our fee in basis points of the trade's SOL value. Default 50 (0.5%). */
  feeBps?: number | bigint;
}

export interface BuyQuote {
  venue: "meteora-dbc";
  mint: string;
  pool: string;
  /** Lamports the user spends (Meteora fees included, ours not). */
  solIn: bigint;
  /** Base units that reach the wallet now, after Meteora fees and any Token-2022 transfer fee. */
  tokensOut: bigint;
  /** The least the program may deliver: `tokensOut` less slippage. */
  minTokensOut: bigint;
  /** Token-2022 transfer fee already taken out of `tokensOut`, in bps (0 for plain SPL). */
  transferFeeBps: number;
  slippageBps: number;
  /** Our fee, on `solIn`. */
  feeLamports: bigint;
  /** `solIn + feeLamports`, before network fee and rent. */
  maxTotalLamports: bigint;
}

export interface SellQuote {
  venue: "meteora-dbc";
  mint: string;
  pool: string;
  /** Base units leaving the wallet (a Token-2022 transfer fee is taken from these). */
  tokensIn: bigint;
  /** Lamports the sale returns now, after Meteora fees. */
  solOut: bigint;
  /** The least the program may return: `solOut` less slippage. */
  minSolOut: bigint;
  transferFeeBps: number;
  slippageBps: number;
  /** Our fee, on `minSolOut`. */
  feeLamports: bigint;
}

export type MeteoraTradeErrorCode =
  | "bad_slippage"
  | "not_found" // no pool for the mint, or its config/mint is missing
  | "graduated" // curve complete or migrating or migrated; trade the DAMM v2 pool elsewhere
  | "unsupported_quote" // quote mint is not plain SOL
  | "unsupported_token_program" // transfer hook, or an undeclared transfer fee
  | "bad_amount"
  | "swap_unverified" // the SDK's swap instruction failed our self-check (also swap_destination, swap_mint, swap_referral)
  | "swap_destination"
  | "swap_mint"
  | "swap_referral"
  | "too_small"
  | "quote_failed"; // the SDK's math rejected the trade (e.g. it overruns the curve)

export class MeteoraTradeError extends Error {
  constructor(readonly code: MeteoraTradeErrorCode, message: string) {
    super(message);
    this.name = "MeteoraTradeError";
  }
}

function checkBps(bps: number | bigint, what: string): bigint {
  if (typeof bps === "number" && !Number.isInteger(bps)) throw new RangeError(`${what} must be an integer number of basis points`);
  const b = BigInt(bps);
  if (b < 0n || b > 10_000n) throw new RangeError(`${what} must be between 0 and 10000 basis points`);
  return b;
}

function checkSlippage(bps: number): number {
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_SLIPPAGE_BPS)
    throw new MeteoraTradeError("bad_slippage", `Slippage must be a whole number of bps from 0 to ${MAX_SLIPPAGE_BPS}.`);
  return bps;
}

const toBN = (v: bigint) => new BN(v.toString()) as unknown as BNT;
const toBig = (v: { toString(): string }): bigint => BigInt(v.toString());

// ---------------------------------------------------------------------------
// Market state
// ---------------------------------------------------------------------------

export interface PoolState {
  poolKey: PublicKey;
  pool: VirtualPool;
  config: PoolConfig;
  currentPoint: BNT;
}

const poolForMint = new Map<string, string>(); // mint -> pool address; a pool never changes its mint
const POOL_CACHE_MAX = 5_000;

const hasDisc = (program: ReturnType<typeof dbc.createDbcProgram>, name: string, data: Buffer): boolean => {
  const d = program.idl.accounts?.find((a) => a.name === name)?.discriminator;
  return d !== undefined && Buffer.from(d).equals(data.subarray(0, d.length));
};

/** Whether a decoded pool has left its curve: migrated, migrating, or the curve is full. */
export function isGraduatedPool(pool: VirtualPool, config: Pick<PoolConfig, "migrationQuoteThreshold">): boolean {
  const s = pool.poolState;
  return s.isMigrated !== 0 || s.migrationProgress !== 0 || !s.quoteReserve.lt(config.migrationQuoteThreshold);
}

async function findPoolKey(rpc: MeteoraRpc, mintStr: string, hint?: string): Promise<PublicKey | null> {
  if (hint) return new web3.PublicKey(hint);
  const cached = poolForMint.get(mintStr);
  if (cached) return new web3.PublicKey(cached);
  const found = await rpc.getProgramAccounts(new web3.PublicKey(METEORA_DBC_PROGRAM), {
    filters: [{ memcmp: { offset: VIRTUAL_POOL_BASE_MINT_OFFSET, bytes: mintStr, encoding: "base58" } }],
    dataSlice: { offset: 0, length: 0 },
  });
  const key = found[0]?.pubkey ?? null;
  if (key) {
    if (poolForMint.size >= POOL_CACHE_MAX) poolForMint.clear();
    poolForMint.set(mintStr, key.toBase58());
  }
  return key;
}

async function loadPool(rpc: MeteoraRpc, mintStr: string, poolHint?: string): Promise<PoolState> {
  const program = dbc.createDbcProgram(rpc as unknown as Web3Module.Connection);
  const poolKey = await findPoolKey(rpc, mintStr, poolHint);
  if (!poolKey) throw new MeteoraTradeError("not_found", `${mintStr} has no Meteora DBC pool.`);
  const mintKey = new web3.PublicKey(mintStr);
  const [poolInfo, mintInfo] = await rpc.getMultipleAccountsInfo([poolKey, mintKey]);
  if (!poolInfo || !poolInfo.owner.equals(new web3.PublicKey(METEORA_DBC_PROGRAM))) throw new MeteoraTradeError("not_found", `Meteora pool for ${mintStr} not found.`);
  if (!mintInfo) throw new MeteoraTradeError("not_found", `Mint ${mintStr} not found.`);
  if (hasDisc(program, "transferHookPool", poolInfo.data)) {
    throw new MeteoraTradeError("unsupported_token_program", `${mintStr} uses a transfer hook, which is not supported.`);
  }
  if (!hasDisc(program, "virtualPool", poolInfo.data)) throw new MeteoraTradeError("not_found", `${poolKey.toBase58()} is not a Meteora virtual pool.`);
  const pool = program.coder.accounts.decode("virtualPool", poolInfo.data) as VirtualPool;
  if (!pool.poolState.baseMint.equals(mintKey)) throw new MeteoraTradeError("not_found", `Pool ${poolKey.toBase58()} does not trade ${mintStr}.`);

  const configKey = pool.poolState.config;
  const configInfo = (await rpc.getMultipleAccountsInfo([configKey]))[0];
  if (!configInfo) throw new MeteoraTradeError("not_found", `Pool config ${configKey.toBase58()} not found.`);
  let config: PoolConfig;
  if (hasDisc(program, "poolConfig", configInfo.data)) {
    config = program.coder.accounts.decode("poolConfig", configInfo.data) as PoolConfig;
  } else if (hasDisc(program, "configWithTransferHook", configInfo.data)) {
    throw new MeteoraTradeError("unsupported_token_program", `${mintStr} uses a transfer hook, which is not supported.`);
  } else {
    throw new MeteoraTradeError("not_found", `${configKey.toBase58()} is not a Meteora pool config.`);
  }

  // Graduation first: a finished curve is Jupiter's, whatever else is true of it.
  if (isGraduatedPool(pool, config)) {
    throw new MeteoraTradeError("graduated", `${mintStr} has graduated or is migrating; trade its DAMM v2 pool instead.`);
  }
  if (!config.quoteMint.equals(spl.NATIVE_MINT) || config.quoteTokenFlag !== 0) {
    throw new MeteoraTradeError("unsupported_quote", `Pool for ${mintStr} is quoted in ${config.quoteMint.toBase58()}, not SOL.`);
  }
  const baseProgram = mintInfo.owner;
  if (!baseProgram.equals(spl.TOKEN_PROGRAM_ID) && !baseProgram.equals(spl.TOKEN_2022_PROGRAM_ID)) {
    throw new MeteoraTradeError("unsupported_token_program", `Mint ${mintStr} is owned by ${baseProgram.toBase58()}.`);
  }
  if (baseProgram.equals(spl.TOKEN_2022_PROGRAM_ID)) {
    const mint = spl.unpackMint(mintKey, mintInfo, baseProgram);
    const exts = spl.getExtensionTypes(mint.tlvData);
    if (exts.includes(spl.ExtensionType.TransferHook)) {
      throw new MeteoraTradeError("unsupported_token_program", `${mintStr} has a transfer hook, which is not supported.`);
    }
    if (exts.includes(spl.ExtensionType.TransferFeeConfig) && config.transferFeeFlag !== 1) {
      throw new MeteoraTradeError("unsupported_token_program", `${mintStr} has a Token-2022 transfer fee the pool config does not declare; it cannot be quoted.`);
    }
  }

  // Quote clock: the activation type picks slot or unix time.
  const slot = await rpc.getSlot();
  let point = slot;
  if (config.activationType === 1) {
    const t = await rpc.getBlockTime(slot);
    if (t === null) throw new MeteoraTradeError("quote_failed", `Block time unavailable for slot ${slot}.`);
    point = t;
  }
  return { poolKey, pool, config, currentPoint: toBN(BigInt(point)) };
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

export interface BuyParams {
  mint: string;
  /** Lamports to spend on the coin. */
  solIn: bigint;
  slippageBps?: number;
  /** The virtual pool address, if the caller knows it (skips a getProgramAccounts). */
  pool?: string;
}
export interface SellParams {
  mint: string;
  /** Base units to sell. */
  tokensIn: bigint;
  slippageBps?: number;
  pool?: string;
}

function swapQuote(state: PoolState, swapBaseForQuote: boolean, amountIn: bigint): { out: bigint; feeBps: number } {
  const client = new dbc.DynamicBondingCurveClient({} as Web3Module.Connection);
  try {
    const q = client.pool.swapQuote2({
      virtualPool: state.pool,
      config: state.config,
      swapBaseForQuote,
      swapMode: dbc.SwapMode.ExactIn,
      amountIn: toBN(amountIn),
      slippageBps: 0,
      hasReferral: false,
      currentPoint: state.currentPoint,
    });
    return { out: toBig(q.excludedTransferFeeAmountOut), feeBps: state.config.transferFeeFlag === 1 ? Number(state.config.transferFeeBasisPoints) : 0 };
  } catch (e) {
    throw new MeteoraTradeError("quote_failed", `Meteora quote failed: ${(e as Error).message}`);
  }
}

function quoteBuyFrom(state: PoolState, cfg: MeteoraTradeConfig, p: BuyParams): BuyQuote {
  if (typeof p.solIn !== "bigint" || p.solIn <= 0n) throw new MeteoraTradeError("bad_amount", "solIn must be a positive bigint.");
  const slippageBps = checkSlippage(p.slippageBps ?? DEFAULT_SLIPPAGE_BPS);
  const { out: tokensOut, feeBps } = swapQuote(state, false, p.solIn);
  if (tokensOut <= 0n) throw new MeteoraTradeError("too_small", "That amount buys no tokens.");
  const fee = feeLamports(p.solIn, cfg.feeBps ?? DEFAULT_FEE_BPS);
  return {
    venue: "meteora-dbc", mint: p.mint, pool: state.poolKey.toBase58(),
    solIn: p.solIn, tokensOut, minTokensOut: withSlippageDown(tokensOut, slippageBps), transferFeeBps: feeBps,
    slippageBps, feeLamports: fee, maxTotalLamports: p.solIn + fee,
  };
}

function quoteSellFrom(state: PoolState, cfg: MeteoraTradeConfig, p: SellParams): SellQuote {
  if (typeof p.tokensIn !== "bigint" || p.tokensIn <= 0n) throw new MeteoraTradeError("bad_amount", "tokensIn must be a positive bigint.");
  const slippageBps = checkSlippage(p.slippageBps ?? DEFAULT_SLIPPAGE_BPS);
  const { out: solOut, feeBps } = swapQuote(state, true, p.tokensIn);
  if (solOut <= 0n) throw new MeteoraTradeError("too_small", "That amount returns no SOL.");
  const minSolOut = withSlippageDown(solOut, slippageBps);
  return {
    venue: "meteora-dbc", mint: p.mint, pool: state.poolKey.toBase58(),
    tokensIn: p.tokensIn, solOut, minSolOut, transferFeeBps: feeBps, slippageBps,
    feeLamports: feeLamports(minSolOut, cfg.feeBps ?? DEFAULT_FEE_BPS),
  };
}

/** Quote a buy of `solIn` lamports on the DBC curve. */
export async function quoteBuy(cfg: MeteoraTradeConfig, p: BuyParams): Promise<BuyQuote> {
  return quoteBuyFrom(await loadPool(cfg.rpc, p.mint, p.pool), cfg, p);
}

/** Quote a sale of `tokensIn` base units on the DBC curve. */
export async function quoteSell(cfg: MeteoraTradeConfig, p: SellParams): Promise<SellQuote> {
  return quoteSellFrom(await loadPool(cfg.rpc, p.mint, p.pool), cfg, p);
}

/**
 * Whether `mint` trades on a live Meteora DBC curve: a pool exists and has not
 * graduated. False for any other mint, for a graduated pool (use Jupiter) and
 * for a pool this module cannot trade (non-SOL quote, transfer hook). The copy
 * engine and the app use it to choose the venue.
 */
export async function isMeteoraPool(rpc: MeteoraRpc, mint: string, pool?: string): Promise<boolean> {
  try {
    await loadPool(rpc, mint, pool);
    return true;
  } catch (e) {
    if (e instanceof MeteoraTradeError) return false;
    throw e; // an RPC failure is not "not a Meteora pool"
  }
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

function feeTransfer(cfg: MeteoraTradeConfig, user: PublicKey, lamports: bigint): TransactionInstruction[] {
  if (lamports === 0n) return [];
  return [web3.SystemProgram.transfer({ fromPubkey: user, toPubkey: new web3.PublicKey(cfg.feeWallet), lamports })];
}

async function swap2(cfg: MeteoraTradeConfig, state: PoolState, user: PublicKey, swapBaseForQuote: boolean, amountIn: bigint, minimumAmountOut: bigint) {
  const client = new dbc.DynamicBondingCurveClient(cfg.rpc as unknown as Web3Module.Connection);
  const tx = await client.pool.swap2({
    owner: user,
    pool: state.poolKey,
    swapBaseForQuote,
    referralTokenAccount: null,
    swapMode: dbc.SwapMode.ExactIn,
    amountIn: toBN(amountIn),
    minimumAmountOut: toBN(minimumAmountOut),
  });
  // Self-check: the SDK's output must pay the user's own token account and no one else's referral slot.
  const kit = tx.instructions.map(toKitInstruction);
  const ixs: CheckIx[] = kit.map((k) => ({ program: k.programAddress, accounts: (k.accounts ?? []).map((a) => a.address), data: Uint8Array.from(k.data ?? []) }));
  try { await checkMeteoraSwap(ixs, { user: address(user.toBase58()), mint: address(state.pool.poolState.baseMint.toBase58()) }); }
  catch (e) { if (e instanceof JupiterError) throw new MeteoraTradeError(e.code as MeteoraTradeErrorCode, `Refusing to build: ${e.message}`); throw e; }
  return tx.instructions;
}

/**
 * Instructions for `user` to buy `solIn` lamports of `mint` on its curve, then
 * pay our fee. Wraps SOL, creates the token account if needed, unwraps after.
 */
export async function buildBuy(cfg: MeteoraTradeConfig, p: BuyParams & { user: Address | string }): Promise<BuiltTrade<BuyQuote>> {
  checkBps(cfg.feeBps ?? DEFAULT_FEE_BPS, "feeBps");
  const user = new web3.PublicKey(p.user);
  const state = await loadPool(cfg.rpc, p.mint, p.pool);
  const quote = quoteBuyFrom(state, cfg, p);
  const trade = await swap2(cfg, state, user, false, quote.solIn, quote.minTokensOut);
  return { quote, instructions: [...trade, ...feeTransfer(cfg, user, quote.feeLamports)].map(toKitInstruction) };
}

/** Instructions for `user` to sell `tokensIn` of `mint` on its curve, then pay our fee from the proceeds. */
export async function buildSell(cfg: MeteoraTradeConfig, p: SellParams & { user: Address | string }): Promise<BuiltTrade<SellQuote>> {
  checkBps(cfg.feeBps ?? DEFAULT_FEE_BPS, "feeBps");
  const user = new web3.PublicKey(p.user);
  const state = await loadPool(cfg.rpc, p.mint, p.pool);
  const quote = quoteSellFrom(state, cfg, p);
  const trade = await swap2(cfg, state, user, true, quote.tokensIn, quote.minSolOut);
  return { quote, instructions: [...trade, ...feeTransfer(cfg, user, quote.feeLamports)].map(toKitInstruction) };
}

export type { Instruction };
