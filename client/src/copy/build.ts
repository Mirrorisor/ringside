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
 * Perps: TODO(perps-build). Not built. The Ringside perps Anchor client
 * lives in client/app/main.ts, a browser module (DOM, polyfills, a Vite JSON
 * import of target/idl) that cannot be imported from Node without a refactor,
 * and its collateral is USDC so sizing needs a quote. Perp intents are
 * created, but build fails with `perps_build_unsupported`.
 */
import {
  appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, getBase64EncodedWireTransaction,
  pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, address, type Address, type Instruction,
} from "@solana/kit";
import { checkTransaction, type OrderRequest, type SwapOrder, WSOL_MINT } from "../trade/jupiter.js";
import { buildBuy, buildSell, PumpTradeError, type BuiltTrade, type BuyQuote, type PumpTradeConfig, type SellQuote } from "../trade/pumpfun.js";
import type { CopyIntent, LeaderExitPort } from "./ports.js";
import type { CopyStore } from "./store.js";

export type BuildErrorCode = "not_found" | "not_pending" | "expired" | "perps_build_unsupported" | "venue_unavailable" | "build_failed" | "price_moved" | "leader_exited";
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

export interface BuildDeps {
  store: CopyStore;
  pump: PumpPort;
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
  if (i.kind === "perp") throw new BuildError("perps_build_unsupported", "Perp copy transactions are not built yet.");

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
      } else built = await viaJupiter(deps, i, follower, payer, WSOL_MINT, i.mint, solIn);
    } else if (i.side === "sell") {
      const tokensIn = BigInt(i.tokens ?? "0");
      const pump = await deps.pump.sell({ mint: i.mint, user: follower, tokensIn, slippageBps: i.slippageBps });
      if (pump && pump.quote.venue === "curve") {
        built = {
          transaction: compileUnsigned(payer, pump.instructions, await deps.chain.latestBlockhash()),
          feeLamports: num(pump.quote.feeLamports), venue: "pumpfun", lamports: num(pump.quote.solOut), tokens: tokensIn.toString(),
          expectedOut: pump.quote.solOut.toString(), minOut: pump.quote.minSolOut.toString(), slippageBps: pump.quote.slippageBps,
        };
      } else built = await viaJupiter(deps, i, follower, payer, i.mint, WSOL_MINT, tokensIn);
    } else throw new BuildError("build_failed", "Unsupported side.");
  } catch (e) {
    if (e instanceof BuildError) throw e;
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
