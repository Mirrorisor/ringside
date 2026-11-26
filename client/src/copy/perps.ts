/** Ringside perps pieces of the copy engine. */
import { tierParams } from "../perps/math.js";

/** Max leverage by tier, from the shared tier table (mirrors `tier_params`, lib.rs:121). */
export const TIER_MAX_LEVERAGE: readonly number[] = [0, 1, 2].map((t) => Number(tierParams(t).maxLeverage));

export function tierMaxLeverage(tier: number | null | undefined): number {
  const t = Number.isInteger(tier) ? Math.min(Math.max(tier as number, 0), 2) : 0;
  return TIER_MAX_LEVERAGE[t];
}

/** The copier's leverage: the leader's, capped by the follower's setting and the market's tier. */
export function cappedLeverage(leaderLeverage: number, maxLeverage: number, tier: number | null | undefined): number {
  const cap = Math.min(maxLeverage, tierMaxLeverage(tier));
  return Math.floor(Math.min(leaderLeverage, cap) * 100) / 100;
}

/** Whether perps copying is switched on by the environment. Off unless RINGSIDE_COPY_PERPS=1. */
export const perpsGateFromEnv = (env: NodeJS.ProcessEnv = process.env) => env.RINGSIDE_COPY_PERPS === "1";

/**
 * Decodes Ringside perps events (PositionChanged = open or increase, PositionClosed reason 0 = close)
 * from a transaction's logs into PerpEvents. See ../perps/events.ts.
 */
export { decodePerpEvents, decodeRawEvents } from "../perps/events.js";
