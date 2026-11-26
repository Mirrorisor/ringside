/**
 * Tier table and cap maths. Mirrors programs/ringside_perps/src/lib.rs
 * exactly, in integer (bigint) arithmetic; USD amounts are USDC base units
 * (6 dp) unless a name says otherwise. No DOM or browser globals.
 */
import type { BN } from "./anchor.js";

/** lib.rs:19 */
export const BPS = 10_000n;
/** lib.rs:29, one account may hold at most 20% of the OI cap. */
export const MAX_ACCOUNT_SHARE_BPS = 2_000n;
/** lib.rs:42, each side's OI may reach this multiple of the cap. */
export const GROSS_CAP_MULT = 2n;
/** lib.rs:30, the vault SOL/USD price must be at most this old. */
export const SOL_PRICE_MAX_AGE = 120;
/** lib.rs:34-36 */
export const DEFAULT_TIER0_CAP_BPS = 100;
export const DEFAULT_SKEW_CAP_BPS = 2_500;
/** lib.rs:673-676 */
export const SIDE_LONG = 0, SIDE_SHORT = 1, ORDER_INCREASE = 0, ORDER_CLOSE = 1;
/** lib.rs:21, FILL_DELAY_SLOTS lib.rs:22, ORDER_EXPIRY_SLOTS lib.rs:23 */
export const BAND_BPS = 1_500n, TWAP_WINDOW_SLOTS = 750n;

export interface TierParams { maxLeverage: bigint; maintenanceBps: bigint; feeBps: bigint; budgetBps: bigint }

/** `tier_params`, lib.rs:121-127. Any tier above 1 is tier 2, as in the program's `_` arm. */
export function tierParams(tier: number): TierParams {
  switch (tier) {
    case 0: return { maxLeverage: 2n, maintenanceBps: 2_000n, feeBps: 30n, budgetBps: 25n };
    case 1: return { maxLeverage: 5n, maintenanceBps: 800n, feeBps: 15n, budgetBps: 100n };
    default: return { maxLeverage: 10n, maintenanceBps: 400n, feeBps: 8n, budgetBps: 300n };
  }
}
/** Same clamp the browser app used: a bad or negative tier reads as tier 0, above 2 as tier 2. */
export const clampTier = (tier: number | null | undefined): number => (Number.isInteger(tier) ? Math.min(Math.max(tier as number, 0), 2) : 0);

/** `mul_bps`, lib.rs:921 (floor). */
export const mulBps = (amount: bigint, bps: bigint): bigint => (amount * bps) / BPS;

const big = (v: bigint | number | BN): bigint => (typeof v === "bigint" ? v : BigInt(v.toString()));

export interface VaultRisk { solUsdE6: bigint | number | BN; solUsdTs?: bigint | number | BN; tier0CapBps: number; skewCapBps: number }
export interface MarketOi { oiLong: bigint | number | BN; oiShort: bigint | number | BN; oiCapOverride?: bigint | number | BN }

/**
 * `oi_cap`, lib.rs:829-835: per-side OI cap in USDC base units. `solReserve` is the
 * SOL behind the price in lamports (virtual curve SOL at tier 0, the pool's SOL after
 * graduation). `oiCapOverride` (market.oi_cap_override) lowers it when above zero.
 * Pass `nowSec` to also apply the program's staleness check (returns null when stale).
 */
export function oiCap(v: VaultRisk, solReserve: bigint, oiCapOverride: bigint | number | BN = 0n, nowSec?: number): bigint | null {
  const usd = big(v.solUsdE6);
  if (nowSec !== undefined && !(usd > 0n && v.solUsdTs !== undefined && nowSec - Number(big(v.solUsdTs)) <= SOL_PRICE_MAX_AGE)) return null;
  const reserveUsd = (solReserve * usd) / 1_000_000_000n;
  const cap = (reserveUsd * BigInt(v.tier0CapBps)) / BPS;
  const ov = big(oiCapOverride);
  return ov > 0n ? (cap < ov ? cap : ov) : cap;
}

export interface Caps {
  /** Per-side OI cap. */
  cap: bigint;
  /** Gross cap per side: cap x GROSS_CAP_MULT (lib.rs:414). */
  side: bigint;
  /** One account's max size per market: 20% of cap (lib.rs:415). */
  account: bigint;
  /** Max |long OI - short OI| after a trade: skew_cap_bps of cap (lib.rs:418), rounded down. */
  skew: bigint;
}
export function caps(v: VaultRisk, solReserve: bigint, oiCapOverride: bigint | number | BN = 0n, nowSec?: number): Caps | null {
  const cap = oiCap(v, solReserve, oiCapOverride, nowSec);
  if (cap === null) return null;
  return { cap, side: cap * GROSS_CAP_MULT, account: (cap * MAX_ACCOUNT_SHARE_BPS) / BPS, skew: (cap * BigInt(v.skewCapBps)) / BPS };
}

export type CapBreach = "oi_cap" | "account_cap" | "skew_cap";
/**
 * The three checks `execute_order` applies to an increase, in its order (lib.rs:412-418):
 * side OI + size <= cap x 2; account size after <= 20% of cap; |net OI after| x BPS <= cap x skew bps.
 * Returns the first breach or null. Exact integer comparison, same as the program.
 */
export function checkIncreaseCaps(
  v: VaultRisk, m: MarketOi, solReserve: bigint, side: 0 | 1, sizeUsd: bigint, existingSizeUsd: bigint, nowSec?: number,
): CapBreach | null {
  const cap = oiCap(v, solReserve, m.oiCapOverride ?? 0n, nowSec);
  if (cap === null) return "oi_cap";
  const long = big(m.oiLong), short = big(m.oiShort);
  const sideOi = side === SIDE_LONG ? long : short;
  if (sideOi + sizeUsd > cap * GROSS_CAP_MULT) return "oi_cap";
  if ((existingSizeUsd + sizeUsd) * BPS > cap * MAX_ACCOUNT_SHARE_BPS) return "account_cap";
  const net = long - short + (side === SIDE_LONG ? sizeUsd : -sizeUsd);
  if ((net < 0n ? -net : net) * BPS > cap * BigInt(v.skewCapBps)) return "skew_cap";
  return null;
}

/**
 * The leverage check in `execute_order` (lib.rs:407-408): (collateral after fee) x max leverage >= size after.
 * Returns the largest new order size (USDC base units) that passes for `collateral` added to a position
 * of `existingCollateral`/`existingSize`, or 0n.
 */
export function maxSizeForCollateral(tier: number, collateral: bigint, existingCollateral = 0n, existingSize = 0n, fundingOwed = 0n): bigint {
  const { maxLeverage, feeBps } = tierParams(tier);
  // The program realises funding into the existing collateral first (lib.rs:402-406); a negative result fails the fill.
  if (existingSize > 0n) {
    existingCollateral -= fundingOwed;
    if (existingCollateral < 0n) return 0n;
  }
  const ok = (s: bigint) => (existingCollateral + collateral - mulBps(s, feeBps)) * maxLeverage >= existingSize + s;
  // Closed form for the continuous case, then walk down; the floor() in mul_bps lets the true maximum sit up to maxLeverage above it.
  const num = (existingCollateral + collateral) * maxLeverage * BPS - existingSize * BPS;
  let s = num > 0n ? num / (BPS + maxLeverage * feeBps) + maxLeverage + 1n : 0n;
  while (s > 0n && !ok(s)) s--;
  return s;
}

/** lib.rs:24-26 */
export const FUNDING_SCALE = 1_000_000_000_000n, FUNDING_BASE_PER_HOUR = 500_000_000n, FUNDING_MAX_PER_HOUR = 5_000_000_000n;

/**
 * `accrue_funding` (lib.rs:812-823): the market's funding index as the program will have it when it fills an order at
 * `nowSec`. The stored index lags by the time since the last accrual. Integer maths with truncation toward zero, as in Rust.
 */
export function projectedFundingIndex(
  v: VaultRisk, m: MarketOi & { fundingIndex: bigint | number | BN; lastFundingTs: bigint | number | BN }, solReserve: bigint, nowSec: number,
): bigint {
  const index = big(m.fundingIndex);
  const dt = BigInt(nowSec) - big(m.lastFundingTs);
  if (dt <= 0n) return index;
  const long = big(m.oiLong), short = big(m.oiShort);
  let cap = oiCap(v, solReserve, m.oiCapOverride ?? 0n, nowSec) ?? 0n;
  const maxOi = long > short ? long : short;
  if (maxOi > cap) cap = maxOi;
  if (cap < 1n) cap = 1n;
  let rate = (FUNDING_BASE_PER_HOUR * (long - short)) / cap;
  if (rate > FUNDING_MAX_PER_HOUR) rate = FUNDING_MAX_PER_HOUR;
  if (rate < -FUNDING_MAX_PER_HOUR) rate = -FUNDING_MAX_PER_HOUR;
  return index + (rate * dt) / 3_600n;
}

/** `funding_owed`, lib.rs:807-810: what a position owes (positive) or is owed (negative), USDC base units. */
export function fundingOwed(side: number, sizeUsd: bigint, fundingSnapshot: bigint, index: bigint): bigint {
  const owed = (sizeUsd * (index - fundingSnapshot)) / FUNDING_SCALE;
  return side === SIDE_LONG ? owed : -owed;
}
