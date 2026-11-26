/** Ringside perps pieces of the copy engine. */
import type { PerpEvent } from "./ports.js";

/** Mirrors `tier_params` in programs/ringside_perps (same table as client/app/main.ts TIER). Max leverage by tier. */
export const TIER_MAX_LEVERAGE = [2, 5, 10] as const;

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
 * TODO(perps-decode): decode Ringside perps open/close instructions from an
 * indexer transaction (Helius enhanced tx, program ringside_perps) into
 * PerpEvents. Needs the IDL's instruction discriminators and account order
 * (target/idl/ringside_perps.json). Not implemented: returns no events.
 */
export function decodePerpEvents(_tx: unknown): PerpEvent[] {
  return [];
}
