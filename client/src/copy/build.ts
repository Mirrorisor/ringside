/**
 * Builds a follower's unsigned transaction for one intent, when they tap.
 * Nothing here signs. Ringside never signs for the follower; the returned
 * base64 transaction is for the follower's wallet to sign and then send to
 * the gas sponsor (sponsor.ts) or the network.
 *
 * Spot venue: the Pump.fun layer while the coin is still on its bonding
 * curve, otherwise Jupiter (graduated coins, non-Pump coins). Our fee is
 * whatever those layers include: Pump.fun's SOL transfer to the fee wallet,
 * Jupiter's referral fee.
 *
 * Perps: built with the shared client in ../perps (the same order builder the
 * app uses), behind RINGSIDE_COPY_PERPS=1 and on devnet only (an RPC URL
 * containing "mainnet" is refused). Collateral is USDC: the intent's SOL
 * amount is converted at an injected SOL/USD price, then the market's OI,
 * account and skew caps are re-checked against live accounts (`perp_cap`).
 * Perps are not sent to a venue: the transaction is one `request_order`
 * that a keeper fills a couple of slots later.
 */
import {
  appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, getBase64EncodedWireTransaction,
  pipe, setTransactionMessageFeePayer, AccountRole, setTransactionMessageLifetimeUsingBlockhash, address, type Address, type Instruction,
} from "@solana/kit";
import { checkTransaction, type OrderRequest, type SwapOrder, WSOL_MINT } from "../trade/jupiter.js";
import * as meteora from "../trade/meteora.js";
import { buildBuy, buildSell, PumpTradeError, type BuiltTrade, type BuyQuote, type PumpTradeConfig, type SellQuote } from "../trade/pumpfun.js";
import { PublicKey } from "@solana/web3.js";
import type { Idl } from "../perps/anchor.js";
import type { MarketAcc, PositionAcc, VaultAcc } from "../perps/accounts.js";
import { checkIncreaseCaps, clampTier, maxSizeForCollateral } from "../perps/math.js";
import { buildOrderInstruction } from "../perps/order.js";
import { cappedLeverage, perpsGateFromEnv } from "./perps.js";
import type { CopyIntent, LeaderExitPort } from "./ports.js";
import type { CopyStore } from "./store.js";

export type BuildErrorCode = "not_found" | "not_pending" | "expired" | "perps_build_unsupported" | "perp_cap" | "venue_unavailable" | "build_failed" | "price_moved" | "leader_exited";
export class BuildError extends Error {
  constructor(readonly code: BuildErrorCode, message: string) { super(message); this.name = "BuildError"; }
}

export interface BuiltIntent {
  /** Base64 wire transaction, unsigned. */
  transaction: string;
  feeLamports: number;
  venue: CopyIntent["venue"];
  lamports: number;
  /** What the quote expects to receive, as a decimal string: base-unit tokens for a buy, lamports for a sell. */
  expectedOut: string;
  /** The least the transaction accepts after slippage, same units as expectedOut. */
  minOut: string;
  slippageBps: number;
}

/** Pump.fun layer as a port. Resolves null when the coin has no Pump curve or pool. Fakeable in tests. */
export interface PumpPort {
  buy(p: { mint: string; user: string; solIn: bigint; slippageBps: number }): Promise<BuiltTrade<BuyQuote> | null>;
  sell(p: { mint: string; user: string; tokensIn: bigint; slippageBps: number }): Promise<BuiltTrade<SellQuote> | null>;
}
/** Meteora DBC curve as a port; null means no live curve for the mint (try Jupiter). */
export interface MeteoraPort {
  buy(p: { mint: string; user: string; solIn: bigint; slippageBps: number }): Promise<meteora.BuiltTrade<meteora.BuyQuote> | null>;
  sell(p: { mint: string; user: string; tokensIn: bigint; slippageBps: number }): Promise<meteora.BuiltTrade<meteora.SellQuote> | null>;
}
/** Jupiter as a port: an order with an unsigned transaction for the taker. */
export interface JupiterPort {
  order(req: OrderRequest): Promise<SwapOrder>;
}
export interface ChainPort {
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: bigint }>;
}

export const DEFAULT_BUILT_TTL_MS = 90_000;
export const DEFAULT_MAX_PRICE_DRIFT_BPS = 1000;
/** Pump.fun tokens always have 6 decimals; override for other mints. */
export const DEFAULT_TOKEN_DECIMALS = 6;

/** Live perps accounts for one follower and market. Backed by RPC in production (perpsport.ts); fakeable in tests. */
export interface PerpsState {
  vault: VaultAcc; market: MarketAcc;
  positions: { 0: PositionAcc | null; 1: PositionAcc | null };
  /** An order request already waiting for a keeper on that side (a second one cannot be created). */
  orders: { 0: boolean; 1: boolean };
  /** SOL behind the price, lamports: virtual curve SOL, or the pool's SOL once graduated. */
  solReserve: bigint;
  /** True once the market prices from the Raydium pool; copy builds do not support that yet. */
  graduated: boolean;
  /** Q64 price for the slippage bound, if known. Without it the order carries no price bound. */
  referencePriceQ64?: bigint;
  nowSec: number;
}
export interface PerpsPort {
  /** null when the mint has no perp market. */
  state(mint: string, owner: string): Promise<PerpsState | null>;
}
export interface PerpsBuildDeps {
  /** ringside_perps IDL (target/idl/ringside_perps.json), injected so this module has no file or JSON-import dependency. */
  idl: Idl;
  port: PerpsPort;
  /** The RPC URL in use; one containing "mainnet" is refused. */
  rpcUrl: string;
  /** Defaults to RINGSIDE_COPY_PERPS=1, read at build time. */
  enabled?: boolean;
  /** SOL price in USD. Defaults to the vault's own on-chain price. */
  solPriceUsd?: () => Promise<number | undefined>;
}

export interface BuildDeps {
  store: CopyStore;
  perps?: PerpsBuildDeps;
  pump: PumpPort;
  /** Optional: coins on a Meteora launch curve (Bags, Believe, Jupiter Studio). */
  meteora?: MeteoraPort;
  jupiter: JupiterPort;
  chain: ChainPort;
  /** Gas sponsor address: fee payer when set; the follower is still a required signer. */
  sponsor?: string;
  now?: () => number;
  /** How long a built intent stays built, about a blockhash lifetime. Default 90 s. */
  builtTtlMs?: number;
  /** Refuse a buy when the quote is more than this many bps worse than the leader's fill. Default COPY_MAX_PRICE_DRIFT_BPS or 1000. */
  maxPriceDriftBps?: number;
  /** Reports leader sells after the source trade. Defaults to the store's record of leader sells. */
  exits?: LeaderExitPort;
  /** Decimals of a mint, to compare the quote with the leader's UI-unit price. Default 6. */
  tokenDecimals?: (mint: string) => Promise<number> | number;
}

/** Wraps the real Meteora layer; "not_found" and "graduated" mean: try Jupiter. */
export function meteoraPort(cfg: meteora.MeteoraTradeConfig): MeteoraPort {
  const soft = async <T>(f: () => Promise<T>): Promise<T | null> => {
    try { return await f(); } catch (e) {
      if (e instanceof meteora.MeteoraTradeError && (e.code === "not_found" || e.code === "graduated")) return null;
      throw e;
    }
  };
  return {
    buy: (p) => soft(() => meteora.buildBuy(cfg, p)),
    sell: (p) => soft(() => meteora.buildSell(cfg, p)),
  };
}

/** Wraps the real Pump layer; "not_found" (no curve, no pool) means: try Jupiter. */
export function pumpPort(cfg: PumpTradeConfig): PumpPort {
  const soft = async <T>(f: () => Promise<T>): Promise<T | null> => {
    try { return await f(); } catch (e) { if (e instanceof PumpTradeError && e.code === "not_found") return null; throw e; }
  };
  return {
    buy: (p) => soft(() => buildBuy(cfg, p)),
    sell: (p) => soft(() => buildSell(cfg, p)),
  };
}

export function compileUnsigned(feePayer: string, instructions: Instruction[], lifetime: { blockhash: string; lastValidBlockHeight: bigint }): string {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(feePayer), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: lifetime.blockhash as never, lastValidBlockHeight: lifetime.lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return getBase64EncodedWireTransaction(compileTransaction(msg));
}

const num = (b: bigint) => Number(b);
const envBps = (k: string, d: number) => { const v = Number(process.env[k]); return process.env[k] ? (Number.isFinite(v) && v >= 0 ? v : d) : d; };

/**
 * Validates that `intentId` belongs to `follower`, is pending and unexpired,
 * then builds it. A missing intent and another follower's intent are
 * indistinguishable (`not_found`).
 */
export async function buildIntent(deps: BuildDeps, intentId: string, follower: string): Promise<BuiltIntent> {
  const now = (deps.now ?? Date.now)();
  deps.store.expireDue(now);
  const i = deps.store.get(intentId);
  if (!i || i.follower !== follower) throw new BuildError("not_found", "No such intent.");
  if (i.status === "expired" || (i.status === "pending" && i.expiresAt <= now)) throw new BuildError("expired", "Intent expired.");
  // A pending intent can be rebuilt (also after its built window lapsed): the old transaction's blockhash is dead by then.
  if (i.status !== "pending") throw new BuildError("not_pending", "Intent is not pending.");
  if (i.kind === "perp") return buildPerp(deps, i, follower);

  // A buy is refused once the leader has sold out of the token: this is the exit that bait trades rely on.
  if (i.side === "buy" && i.sourceSlot !== undefined) {
    const exited = await (deps.exits ?? deps.store).leaderSoldSince(i.leader, i.mint, { signature: i.sourceSignature, slot: i.sourceSlot });
    if (exited) {
      deps.store.markRefused(i.id, "leader_exited");
      throw new BuildError("leader_exited", "The leader has already sold this token.");
    }
  }

  const payer = deps.sponsor ?? follower;
  let built: BuiltIntent & { tokens: string };
  try {
    if (i.side === "buy") {
      const solIn = BigInt(i.lamports ?? 0);
      const pump = await deps.pump.buy({ mint: i.mint, user: follower, solIn, slippageBps: i.slippageBps });
      if (pump && pump.quote.venue === "curve") {
        built = {
          transaction: compileUnsigned(payer, pump.instructions, await deps.chain.latestBlockhash()),
          feeLamports: num(pump.quote.feeLamports), venue: "pumpfun", lamports: num(pump.quote.solIn), tokens: pump.quote.tokensOut.toString(),
          // The curve buy asks for exactly tokensOut; slippage bounds the SOL cost (maxSolCost), not the tokens.
          expectedOut: pump.quote.tokensOut.toString(), minOut: pump.quote.tokensOut.toString(), slippageBps: pump.quote.slippageBps,
        };
      } else {
        const met = deps.meteora ? await deps.meteora.buy({ mint: i.mint, user: follower, solIn, slippageBps: i.slippageBps }) : null;
        if (met) {
          built = {
            transaction: compileUnsigned(payer, met.instructions, await deps.chain.latestBlockhash()),
            feeLamports: num(met.quote.feeLamports), venue: "meteora", lamports: num(met.quote.solIn), tokens: met.quote.tokensOut.toString(),
            expectedOut: met.quote.tokensOut.toString(), minOut: met.quote.minTokensOut.toString(), slippageBps: met.quote.slippageBps,
          };
        } else built = await viaJupiter(deps, i, follower, payer, WSOL_MINT, i.mint, solIn);
      }
    } else if (i.side === "sell") {
      const tokensIn = BigInt(i.tokens ?? "0");
      const pump = await deps.pump.sell({ mint: i.mint, user: follower, tokensIn, slippageBps: i.slippageBps });
      if (pump && pump.quote.venue === "curve") {
        built = {
          transaction: compileUnsigned(payer, pump.instructions, await deps.chain.latestBlockhash()),
          feeLamports: num(pump.quote.feeLamports), venue: "pumpfun", lamports: num(pump.quote.solOut), tokens: tokensIn.toString(),
          expectedOut: pump.quote.solOut.toString(), minOut: pump.quote.minSolOut.toString(), slippageBps: pump.quote.slippageBps,
        };
      } else {
        const met = deps.meteora ? await deps.meteora.sell({ mint: i.mint, user: follower, tokensIn, slippageBps: i.slippageBps }) : null;
        if (met) {
          built = {
            transaction: compileUnsigned(payer, met.instructions, await deps.chain.latestBlockhash()),
            feeLamports: num(met.quote.feeLamports), venue: "meteora", lamports: num(met.quote.solOut), tokens: tokensIn.toString(),
            expectedOut: met.quote.solOut.toString(), minOut: met.quote.minSolOut.toString(), slippageBps: met.quote.slippageBps,
          };
        } else built = await viaJupiter(deps, i, follower, payer, i.mint, WSOL_MINT, tokensIn);
      }
    } else throw new BuildError("build_failed", "Unsupported side.");
  } catch (e) {
    if (e instanceof BuildError) throw e;
    if (e instanceof meteora.MeteoraTradeError && (e.code === "unsupported_quote" || e.code === "unsupported_token_program")) throw new BuildError("venue_unavailable", "This token cannot be traded right now.");
    if (e instanceof PumpTradeError && (e.code === "awaiting_migration" || e.code === "unsupported_quote")) throw new BuildError("venue_unavailable", "This token cannot be traded right now.");
    throw new BuildError("build_failed", "Could not build the transaction.");
  }
  if (i.side === "buy" && i.leaderPrice && i.leaderPrice > 0) {
    const dec = Number((await deps.tokenDecimals?.(i.mint)) ?? DEFAULT_TOKEN_DECIMALS);
    const quoted = built.lamports / 1e9 / (Number(built.tokens) / 10 ** dec);
    const maxDrift = deps.maxPriceDriftBps ?? envBps("COPY_MAX_PRICE_DRIFT_BPS", DEFAULT_MAX_PRICE_DRIFT_BPS);
    // Worse for a buy means a higher price (fewer tokens for the same SOL). A zero or unreadable quote is refused too.
    if (!Number.isFinite(quoted) || quoted <= 0 || (quoted / i.leaderPrice - 1) * 10_000 > maxDrift) {
      throw new BuildError("price_moved", "The price has moved too far from the leader's fill.");
    }
  }
  // Re-read the clock: a slow build must not mark an intent that expired meanwhile.
  const builtAt = (deps.now ?? Date.now)();
  if (!deps.store.markBuilt(i.id, { venue: built.venue, lamports: built.lamports, tokens: built.tokens }, builtAt + (deps.builtTtlMs ?? DEFAULT_BUILT_TTL_MS))) throw new BuildError("not_pending", "Intent is not pending.");
  return {
    transaction: built.transaction, feeLamports: built.feeLamports, venue: built.venue, lamports: built.lamports,
    expectedOut: built.expectedOut, minOut: built.minOut, slippageBps: built.slippageBps,
  };
}

async function viaJupiter(deps: BuildDeps, i: { side: string; slippageBps: number }, follower: string, payer: string, inputMint: string, outputMint: string, amount: bigint) {
  const order = await deps.jupiter.order({
    inputMint, outputMint, amount, taker: follower, slippageBps: i.slippageBps,
    payer: payer !== follower ? payer : undefined,
  });
  if (!order.transaction) throw new BuildError("venue_unavailable", "No route.");
  if (order.inputMint !== inputMint || order.outputMint !== outputMint || order.inAmount !== amount.toString()) throw new BuildError("build_failed", "Order mismatch.");
  // Refuse anything that is not a plain swap for this follower before they are asked to sign.
  await checkTransaction(order.transaction, { user: follower as Address, feePayers: [payer as Address] });
  const buy = i.side === "buy";
  const out = BigInt(order.outAmount);
  const sol = buy ? amount : out;
  const feeLamports = order.feeBps && (buy || outputMint === WSOL_MINT) ? Number((sol * BigInt(order.feeBps)) / 10_000n) : 0;
  return {
    transaction: order.transaction, feeLamports, venue: "jupiter" as const,
    lamports: Number(sol), tokens: (buy ? out : amount).toString(),
    expectedOut: order.outAmount, minOut: order.otherAmountThreshold, slippageBps: order.slippageBps,
  };
}

// ---- perps ----------------------------------------------------------------------------------

type PerpIntent = Pick<CopyIntent, "id" | "mint" | "side" | "lamports" | "leverage"> & { slippageBps: number };

async function buildPerp(deps: BuildDeps, i: PerpIntent, follower: string): Promise<BuiltIntent> {
  const pd = deps.perps;
  if (!pd) throw new BuildError("perps_build_unsupported", "Perp copy transactions are not configured.");
  if (!(pd.enabled ?? perpsGateFromEnv())) throw new BuildError("perps_build_unsupported", "Perp copying is switched off (RINGSIDE_COPY_PERPS).");
  if (/mainnet/i.test(pd.rpcUrl)) throw new BuildError("perps_build_unsupported", "Perp copying is devnet-only.");

  let state: PerpsState | null;
  try { state = await pd.port.state(i.mint, follower); } catch { throw new BuildError("build_failed", "Could not read the perp market."); }
  if (!state) throw new BuildError("venue_unavailable", "This token has no perp market.");
  const { vault, market } = state;
  if (state.graduated) throw new BuildError("venue_unavailable", "Graduated perp markets are not copyable yet.");
  if (vault.paused) throw new BuildError("venue_unavailable", "Perps are paused.");

  const owner = new PublicKey(follower), mint = new PublicKey(i.mint);
  const payer = deps.sponsor ? new PublicKey(deps.sponsor) : owner;
  const base = { idl: pd.idl, trader: owner, payer, mint, usdcMint: vault.usdcMint };
  const bound = state.referencePriceQ64 !== undefined ? { referencePriceQ64: state.referencePriceQ64, slippageBps: i.slippageBps } : {};
  const finish = async (ixs: ReturnType<typeof buildOrderInstruction>[], sizeUsd: bigint, collateral: bigint, lamports: number): Promise<BuiltIntent> => {
    let transaction: string;
    try { transaction = compileUnsigned(payer.toBase58(), ixs.map(toKitInstruction), await deps.chain.latestBlockhash()); }
    catch { throw new BuildError("build_failed", "Could not build the transaction."); }
    const builtAt = (deps.now ?? Date.now)();
    if (!deps.store.markBuilt(i.id, { venue: "ringside-perps", lamports }, builtAt + (deps.builtTtlMs ?? DEFAULT_BUILT_TTL_MS))) throw new BuildError("not_pending", "Intent is not pending.");
    // expectedOut is the notional in USDC base units; there is no price floor to report, the bound is inside the order.
    return { transaction, feeLamports: 0, venue: "ringside-perps", lamports, expectedOut: sizeUsd.toString(), minOut: collateral.toString(), slippageBps: i.slippageBps };
  };

  if (i.side === "close") {
    const open = ([0, 1] as const).filter((s) => state!.positions[s] && BigInt(state!.positions[s]!.sizeUsd.toString()) > 0n);
    if (open.length === 0) throw new BuildError("build_failed", "No open position to close.");
    if (open.length > 1) throw new BuildError("build_failed", "Both sides are open; close them from the app.");
    if (state.orders[open[0]]) throw new BuildError("build_failed", "An order on this side is already waiting for a keeper.");
    const pos = state.positions[open[0]]!;
    return finish([buildOrderInstruction({ ...base, ...bound, action: "close", side: open[0] })], BigInt(pos.sizeUsd.toString()), 0n, i.lamports ?? 0);
  }
  if (i.side !== "long" && i.side !== "short") throw new BuildError("build_failed", "Unsupported side.");
  const side = i.side === "long" ? 0 : 1;
  if (market.reduceOnly) throw new BuildError("venue_unavailable", "The market is reduce-only.");
  if (state.orders[side]) throw new BuildError("build_failed", "An order on this side is already waiting for a keeper.");

  // Collateral: the intent's SOL amount in USD (6 dp).
  let px: number | undefined;
  try { px = pd.solPriceUsd ? await pd.solPriceUsd() : Number(vault.solUsdE6.toString()) / 1e6; } catch { px = undefined; }
  if (!px || !Number.isFinite(px) || px <= 0) throw new BuildError("build_failed", "No SOL price.");
  const lamports = i.lamports ?? 0;
  const collateral = BigInt(Math.floor((lamports * px) / 1000));
  if (collateral <= 0n) throw new BuildError("build_failed", "Copy size is too small.");

  // Leverage: the intent's (already min(leader, settings.maxLeverage, tier)), capped again by the market's tier now.
  const tier = clampTier(market.tier);
  const lev = cappedLeverage(i.leverage ?? 1, i.leverage ?? 1, tier);
  if (!(lev >= 1)) throw new BuildError("build_failed", "Leverage is below the minimum.");
  const existing = state.positions[side];
  const exSize = existing ? BigInt(existing.sizeUsd.toString()) : 0n, exCol = existing ? BigInt(existing.collateral.toString()) : 0n;
  let size = (collateral * BigInt(Math.floor(lev * 100))) / 100n;
  // The program checks leverage after the fee, so at the tier maximum the size must shrink a little.
  const fit = maxSizeForCollateral(tier, collateral, exCol, exSize);
  if (size > fit) size = fit;
  if (size <= 0n) throw new BuildError("build_failed", "Copy size is too small.");

  const breach = checkIncreaseCaps(vault, market, state.solReserve, side, size, exSize, state.nowSec);
  if (breach) throw new BuildError("perp_cap", `The market cannot take this copy (${breach}).`);

  return finish([buildOrderInstruction({ ...base, ...bound, action: exSize > 0n ? "increase" : "open", side, collateral, sizeUsd: size })], size, collateral, lamports);
}

function toKitInstruction(ix: ReturnType<typeof buildOrderInstruction>): Instruction {
  return {
    programAddress: address(ix.programId.toBase58()),
    accounts: ix.keys.map((k) => ({
      address: address(k.pubkey.toBase58()),
      role: k.isSigner ? (k.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : (k.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY),
    })),
    data: Uint8Array.from(ix.data),
  };
}
