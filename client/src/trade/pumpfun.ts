/**
 * Pump.fun trade layer: quotes and instructions for buying and selling a
 * Pump coin, on its bonding curve or, once it has graduated, on its canonical
 * PumpSwap pool. A SOL fee to Ringside is appended to every trade.
 *
 * Venue: the curve account decides. A live curve (`complete == false`, with
 * reserves) trades on the curve with the legacy `buy` / `sell`. A complete or
 * migrated curve trades on the canonical PumpSwap pool. A coin that is
 * complete but has no pool yet is waiting for migration and cannot trade.
 *
 * Slippage follows the SDK's own convention: a buy asks for the tokens that
 * `solIn` buys now and lets the program charge up to `solIn` plus slippage; a
 * sell asks for at least the quoted SOL less slippage. Bounds are computed
 * here in bigint basis points, not through the SDK's float percentages.
 *
 * Our fee is `feeBps` of the trade's SOL value (the SOL spent on a buy, the
 * quoted SOL received on a sell), rounded up, so it is never more than 1
 * lamport above the exact figure. It is a System transfer from the user to
 * `feeWallet`, after the trade. The fee wallet must already hold at least the
 * rent-exempt minimum, or a small first transfer into it fails.
 *
 * Only SOL-quoted coins are supported (the curve's `quoteMint` is SOL, the
 * pool's is WSOL); token-quoted curves (USDC, `create_v2` quote mints) are
 * refused.
 *
 * TODO(launch): coin creation (`createV2AndBuyV2Instructions`) is not built
 * here. It needs token metadata hosted by us (see `metadata.ts`).
 *
 * Why `createRequire`: the ESM build of `@pump-fun/pump-sdk` 4.3.1 cannot be
 * imported by native Node ESM, because its dependency
 * `@pump-fun/agent-payments-sdk` does `import { BN } from "@coral-xyz/anchor"`,
 * a CommonJS module. We load the CJS builds, and take web3.js and spl-token
 * from the same CJS graph so every `PublicKey` is one class.
 */
import { createRequire } from "node:module";
import { address, AccountRole, type Address, type Instruction } from "@solana/kit";
import type * as PumpSdkModule from "@pump-fun/pump-sdk";
import type * as PumpSwapModule from "@pump-fun/pump-sdk/swap";
import type * as Web3Module from "@solana/web3.js";
import type * as SplTokenModule from "@solana/spl-token";
import type { AccountInfo, Commitment, PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { BondingCurve, FeeConfig, Global } from "@pump-fun/pump-sdk";
import type { SwapSolanaState } from "@pump-fun/pump-sdk/swap";

const require = createRequire(import.meta.url);
const pump = require("@pump-fun/pump-sdk") as typeof PumpSdkModule;
const swap = require("@pump-fun/pump-sdk/swap") as typeof PumpSwapModule;
const web3 = require("@solana/web3.js") as typeof Web3Module;
const spl = require("@solana/spl-token") as typeof SplTokenModule;
// bn.js ships no types here; this is all we use of it.
type BNType = { toString(): string; add(b: BNType): BNType };
const { BN } = require("@coral-xyz/anchor") as { BN: new (v: string) => BNType };

export const PUMP_PROGRAM = address("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const PUMPSWAP_PROGRAM = address("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
export const PUMP_FEE_PROGRAM = address("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");

export const DEFAULT_FEE_BPS = 50;
export const DEFAULT_SLIPPAGE_BPS = 100;
const BPS = 10_000n;

/**
 * The RPC calls this module makes. A web3.js `Connection` satisfies it; tests
 * pass a fake. `getEpochInfo` is only called for a Token-2022 quote with a
 * transfer fee, which a SOL pool never has.
 */
export interface PumpRpc {
  getMultipleAccountsInfo(keys: PublicKey[], commitment?: Commitment): Promise<(AccountInfo<Buffer> | null)[]>;
  getEpochInfo?(): Promise<{ epoch: number }>;
}

export interface PumpTradeConfig {
  rpc: PumpRpc;
  /** Receives our fee, in SOL. */
  feeWallet: Address | string;
  /** Our fee in basis points of the trade's SOL value. Default 50 (0.5%). */
  feeBps?: number | bigint;
}

export type Venue = "curve" | "amm";

export interface BuyQuote {
  venue: Venue;
  mint: string;
  /** Lamports the user wants to spend on the coin (Pump fees included, ours not). */
  solIn: bigint;
  /** Base units the program is asked for. */
  tokensOut: bigint;
  /** The most the program may charge: `solIn` plus slippage. */
  maxSolCost: bigint;
  slippageBps: number;
  /** Our fee, on `solIn`. */
  feeLamports: bigint;
  /** `maxSolCost + feeLamports`: the worst case, before network fee and rent. */
  maxTotalLamports: bigint;
}

export interface SellQuote {
  venue: Venue;
  mint: string;
  tokensIn: bigint;
  /** Lamports the sale returns now, after Pump fees. */
  solOut: bigint;
  /** The least the program may return: `solOut` less slippage. */
  minSolOut: bigint;
  slippageBps: number;
  /** Our fee, on `minSolOut`: never on SOL the seller might not get. */
  feeLamports: bigint;
}

export interface BuiltTrade<Q> {
  quote: Q;
  /** Trade instructions, then our fee transfer. The user signs and pays. */
  instructions: Instruction[];
}

export type PumpTradeErrorCode =
  | "not_found" // no mint, curve or pool
  | "awaiting_migration" // curve complete, pool not created yet
  | "unsupported_quote" // curve or pool not quoted in SOL
  | "unsupported_token_program"
  | "bad_amount"
  | "too_small"; // the amount buys or returns nothing

export class PumpTradeError extends Error {
  constructor(readonly code: PumpTradeErrorCode, message: string) {
    super(message);
    this.name = "PumpTradeError";
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function checkBps(bps: number | bigint, what: string): bigint {
  const b = BigInt(bps);
  if (typeof bps === "number" && !Number.isInteger(bps)) throw new RangeError(`${what} must be an integer number of basis points`);
  if (b < 0n || b > BPS) throw new RangeError(`${what} must be between 0 and 10000 basis points`);
  return b;
}

/**
 * Our fee on `solAmount` lamports: ceil(solAmount * bps / 10000). Never below
 * the exact fee and never more than 1 lamport above it.
 */
export function feeLamports(solAmount: bigint, bps: number | bigint = DEFAULT_FEE_BPS): bigint {
  if (typeof solAmount !== "bigint" || solAmount < 0n) throw new RangeError("solAmount must be a non-negative bigint");
  const b = checkBps(bps, "feeBps");
  return (solAmount * b + BPS - 1n) / BPS;
}

/** `amount` plus `bps` of it, rounded down. */
export function withSlippageUp(amount: bigint, bps: number | bigint): bigint {
  return amount + (amount * checkBps(bps, "slippageBps")) / BPS;
}

/** `amount` less `bps` of it, rounded down. */
export function withSlippageDown(amount: bigint, bps: number | bigint): bigint {
  return (amount * (BPS - checkBps(bps, "slippageBps"))) / BPS;
}

const toBN = (v: bigint): BNType => new BN(v.toString());
const toBig = (v: BNType): bigint => BigInt(v.toString());

/** A web3.js v1 instruction as a @solana/kit instruction. */
export function toKitInstruction(ix: TransactionInstruction): Instruction {
  return {
    programAddress: address(ix.programId.toBase58()),
    accounts: ix.keys.map((k) => ({
      address: address(k.pubkey.toBase58()),
      role: k.isSigner
        ? k.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER
        : k.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY,
    })),
    data: new Uint8Array(ix.data),
  };
}

// ---------------------------------------------------------------------------
// Market state
// ---------------------------------------------------------------------------

type CurveMarket = {
  venue: "curve";
  global: Global;
  feeConfig: FeeConfig | null;
  bondingCurve: BondingCurve;
  bondingCurveAccountInfo: AccountInfo<Buffer>;
  tokenProgram: PublicKey;
};
type AmmMarket = { venue: "amm"; state: SwapSolanaState };
type Market = CurveMarket | AmmMarket;

/** Whether a decoded curve has graduated: complete, or its reserves zeroed by migration. */
export function isGraduated(curve: BondingCurve): boolean {
  return curve.complete || pump.isBondingCurveMigrated(curve);
}

async function loadMarket(rpc: PumpRpc, mintStr: string, userStr?: string): Promise<Market> {
  const mint = new web3.PublicKey(mintStr);
  const user = userStr ? new web3.PublicKey(userStr) : web3.PublicKey.default;
  const poolKey = pump.canonicalPumpPoolPda(mint);
  const [globalInfo, feeConfigInfo, curveInfo, mintInfo, poolInfo] = await rpc.getMultipleAccountsInfo([
    pump.GLOBAL_PDA,
    pump.PUMP_FEE_CONFIG_PDA,
    pump.bondingCurvePda(mint),
    mint,
    poolKey,
  ]);
  if (!mintInfo) throw new PumpTradeError("not_found", `Mint ${mintStr} not found.`);

  const bondingCurve = curveInfo ? pump.PUMP_SDK.decodeBondingCurve(curveInfo) : null;
  if (bondingCurve && curveInfo && !isGraduated(bondingCurve)) {
    if (!pump.isLegacyQuoteMint(bondingCurve.quoteMint)) {
      throw new PumpTradeError("unsupported_quote", `Curve for ${mintStr} is quoted in ${bondingCurve.quoteMint.toBase58()}, not SOL.`);
    }
    if (!globalInfo) throw new PumpTradeError("not_found", "Pump Global account not found.");
    const tokenProgram = mintInfo.owner;
    if (!tokenProgram.equals(spl.TOKEN_PROGRAM_ID) && !tokenProgram.equals(spl.TOKEN_2022_PROGRAM_ID)) {
      throw new PumpTradeError("unsupported_token_program", `Mint ${mintStr} is owned by ${tokenProgram.toBase58()}.`);
    }
    return {
      venue: "curve",
      global: pump.PUMP_SDK.decodeGlobal(globalInfo),
      feeConfig: feeConfigInfo ? pump.PUMP_SDK.decodeFeeConfig(feeConfigInfo) : null,
      bondingCurve,
      bondingCurveAccountInfo: curveInfo,
      tokenProgram,
    };
  }

  if (!poolInfo) {
    if (bondingCurve) throw new PumpTradeError("awaiting_migration", `${mintStr} has completed its curve; its PumpSwap pool does not exist yet.`);
    throw new PumpTradeError("not_found", `${mintStr} has no Pump curve and no canonical PumpSwap pool.`);
  }
  const amm = new swap.OnlinePumpAmmSdk(rpc as unknown as Web3Module.Connection);
  const state = await amm.swapSolanaState(poolKey, user);
  if (!state.pool.quoteMint.equals(spl.NATIVE_MINT)) {
    throw new PumpTradeError("unsupported_quote", `Pool for ${mintStr} is quoted in ${state.pool.quoteMint.toBase58()}, not WSOL.`);
  }
  return { venue: "amm", state };
}

/** The fee-schedule inputs the SDK's AMM quote functions take, from a swap state. */
function ammQuoteArgs(s: SwapSolanaState) {
  return {
    baseReserve: s.poolBaseAmount,
    quoteReserve: s.poolQuoteAmount,
    virtualQuoteReserves: s.pool.virtualQuoteReserves,
    globalConfig: s.globalConfig,
    baseMintAccount: s.baseMintAccount,
    baseMint: s.baseMint,
    coinCreator: s.pool.coinCreator,
    creator: s.pool.creator,
    feeConfig: s.feeConfig,
    quoteMint: s.pool.quoteMint,
    isMayhemMode: s.pool.isMayhemMode,
    creatorFeeBps: s.pool.creatorFeeBps,
    quoteTransferFee: s.quoteTransferFee,
  };
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

export interface BuyParams {
  mint: string;
  /** Lamports to spend on the coin. */
  solIn: bigint;
  slippageBps?: number;
}
export interface SellParams {
  mint: string;
  /** Base units to sell. */
  tokensIn: bigint;
  slippageBps?: number;
}

function quoteBuyFrom(market: Market, cfg: PumpTradeConfig, p: BuyParams): BuyQuote {
  if (typeof p.solIn !== "bigint" || p.solIn <= 0n) throw new PumpTradeError("bad_amount", "solIn must be a positive bigint.");
  const slippageBps = p.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  let tokensOut: bigint;
  if (market.venue === "curve") {
    const { global, feeConfig, bondingCurve } = market;
    tokensOut = toBig(
      pump.getBuyTokenAmountFromSolAmount({
        global,
        feeConfig,
        mintSupply: bondingCurve.tokenTotalSupply,
        bondingCurve,
        amount: toBN(p.solIn),
        quoteMint: bondingCurve.quoteMint,
      }),
    );
  } else {
    try {
      tokensOut = toBig(swap.buyQuoteInput({ quote: toBN(p.solIn), slippage: 0, ...ammQuoteArgs(market.state) }).base);
    } catch (e) {
      throw new PumpTradeError("too_small", `PumpSwap quote failed: ${(e as Error).message}`);
    }
  }
  if (tokensOut <= 0n) throw new PumpTradeError("too_small", "That amount buys no tokens.");
  const maxSolCost = withSlippageUp(p.solIn, slippageBps);
  const fee = feeLamports(p.solIn, cfg.feeBps ?? DEFAULT_FEE_BPS);
  return { venue: market.venue, mint: p.mint, solIn: p.solIn, tokensOut, maxSolCost, slippageBps, feeLamports: fee, maxTotalLamports: maxSolCost + fee };
}

function quoteSellFrom(market: Market, cfg: PumpTradeConfig, p: SellParams): SellQuote {
  if (typeof p.tokensIn !== "bigint" || p.tokensIn <= 0n) throw new PumpTradeError("bad_amount", "tokensIn must be a positive bigint.");
  const slippageBps = p.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  let solOut: bigint;
  if (market.venue === "curve") {
    const { global, feeConfig, bondingCurve } = market;
    solOut = toBig(
      pump.getSellSolAmountFromTokenAmount({
        global,
        feeConfig,
        mintSupply: bondingCurve.tokenTotalSupply,
        bondingCurve,
        amount: toBN(p.tokensIn),
      }),
    );
  } else {
    const s = market.state;
    try {
      solOut = toBig(
        swap.sellBaseInput({
          base: toBN(p.tokensIn),
          slippage: 0,
          feeBucketsTotal: s.pool.protocolFees.add(s.pool.creatorFees),
          ...ammQuoteArgs(s),
        }).uiQuote,
      );
    } catch (e) {
      throw new PumpTradeError("too_small", `PumpSwap quote failed: ${(e as Error).message}`);
    }
  }
  if (solOut <= 0n) throw new PumpTradeError("too_small", "That amount returns no SOL.");
  const minSolOut = withSlippageDown(solOut, slippageBps);
  return { venue: market.venue, mint: p.mint, tokensIn: p.tokensIn, solOut, minSolOut, slippageBps, feeLamports: feeLamports(minSolOut, cfg.feeBps ?? DEFAULT_FEE_BPS) };
}

/** Quote a buy of `solIn` lamports, on the curve or (graduated) on PumpSwap. */
export async function quoteBuy(cfg: PumpTradeConfig, p: BuyParams): Promise<BuyQuote> {
  return quoteBuyFrom(await loadMarket(cfg.rpc, p.mint), cfg, p);
}

/** Quote a sale of `tokensIn` base units, on the curve or (graduated) on PumpSwap. */
export async function quoteSell(cfg: PumpTradeConfig, p: SellParams): Promise<SellQuote> {
  return quoteSellFrom(await loadMarket(cfg.rpc, p.mint), cfg, p);
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

function feeTransfer(cfg: PumpTradeConfig, user: PublicKey, lamports: bigint): TransactionInstruction[] {
  if (lamports === 0n) return [];
  return [web3.SystemProgram.transfer({ fromPubkey: user, toPubkey: new web3.PublicKey(cfg.feeWallet), lamports })];
}

/**
 * Instructions for `user` to buy `solIn` lamports of `mint`, then pay our fee.
 * Creates the user's token account if needed. The user must hold
 * `quote.maxTotalLamports` plus rent and the network fee.
 */
export async function buildBuy(cfg: PumpTradeConfig, p: BuyParams & { user: Address | string }): Promise<BuiltTrade<BuyQuote>> {
  checkBps(cfg.feeBps ?? DEFAULT_FEE_BPS, "feeBps");
  const user = new web3.PublicKey(p.user);
  const market = await loadMarket(cfg.rpc, p.mint, p.user);
  const quote = quoteBuyFrom(market, cfg, p);
  let trade: TransactionInstruction[];
  if (market.venue === "curve") {
    // slippage 0: `solAmount` is already our bigint bound.
    trade = await pump.PUMP_SDK.buyInstructions({
      global: market.global,
      bondingCurveAccountInfo: market.bondingCurveAccountInfo,
      bondingCurve: market.bondingCurve,
      associatedUserAccountInfo: null, // always CreateIdempotent: saves an RPC round trip
      mint: new web3.PublicKey(p.mint),
      user,
      amount: toBN(quote.tokensOut),
      solAmount: toBN(quote.maxSolCost),
      slippage: 0,
      tokenProgram: market.tokenProgram,
    });
  } else {
    trade = await swap.PUMP_AMM_SDK.buyInstructions(market.state, toBN(quote.tokensOut), toBN(quote.maxSolCost));
  }
  return { quote, instructions: [...trade, ...feeTransfer(cfg, user, quote.feeLamports)].map(toKitInstruction) };
}

/** Instructions for `user` to sell `tokensIn` of `mint`, then pay our fee from the proceeds. */
export async function buildSell(cfg: PumpTradeConfig, p: SellParams & { user: Address | string }): Promise<BuiltTrade<SellQuote>> {
  checkBps(cfg.feeBps ?? DEFAULT_FEE_BPS, "feeBps");
  const user = new web3.PublicKey(p.user);
  const market = await loadMarket(cfg.rpc, p.mint, p.user);
  const quote = quoteSellFrom(market, cfg, p);
  let trade: TransactionInstruction[];
  if (market.venue === "curve") {
    trade = await pump.PUMP_SDK.sellInstructions({
      global: market.global,
      bondingCurveAccountInfo: market.bondingCurveAccountInfo,
      bondingCurve: market.bondingCurve,
      mint: new web3.PublicKey(p.mint),
      user,
      amount: toBN(quote.tokensIn),
      solAmount: toBN(quote.minSolOut),
      slippage: 0,
      tokenProgram: market.tokenProgram,
      mayhemMode: market.bondingCurve.isMayhemMode,
      cashback: market.bondingCurve.isCashbackCoin,
    });
  } else {
    trade = await swap.PUMP_AMM_SDK.sellInstructions(market.state, toBN(quote.tokensIn), toBN(quote.minSolOut));
  }
  return { quote, instructions: [...trade, ...feeTransfer(cfg, user, quote.feeLamports)].map(toKitInstruction) };
}
