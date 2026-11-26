/**
 * Creator reputation: each creator's launch history, from the stored launches and the per-mint
 * `token_stats` aggregate (see store.ts). Thresholds are exported constants.
 *
 * A coin "died within 24h" when, measured from its first indexed trade (its launch time if it never
 * traded), either:
 *  - its last SOL-quoted price inside the 24h window is at least DEAD_PRICE_DROP below the peak
 *    price inside that window, or
 *  - it has no trade after DEAD_QUIET_AFTER_SECONDS (the first hour), ever.
 * A coin is only judged once its 24h window has fully passed ("matured"); younger coins count as
 * launched but are neither dead nor alive yet. Prices are quote per token (SOL trades only).
 *
 * Graduation is derived, not decoded: a coin graduated if any trade of it came from the PUMP_AMM
 * source (Pump.fun's AMM, where coins migrate). Graduation to other venues is not detected.
 */
export const DEAD_WINDOW_SECONDS = 86_400;
export const DEAD_QUIET_AFTER_SECONDS = 3_600;
/** Fraction below the peak (0.9 = the last price is at most 10% of the peak) that counts as dead. */
export const DEAD_PRICE_DROP = 0.9;
/** A creator with at least this many matured launches can be a serial rugger. */
export const SERIAL_RUGGER_MIN_LAUNCHES = 3;
/** ...if at least this share of its matured launches died within 24h. */
export const SERIAL_RUGGER_MIN_DEAD_RATE = 0.7;
/** Trades from this `source` mark a graduated Pump.fun coin. */
export const GRADUATED_SOURCE = "PUMP_AMM";
export const DEFAULT_CREATOR_COINS = 20;
export const MAX_CREATOR_COINS = 50;

export type CoinStatus = "dead" | "alive" | "pending";

export interface CreatorStats {
  creator: string;
  /** Coins launched (all, including those still inside their 24h window). */
  launched: number;
  /** Coins whose 24h window has passed: the ones judged. */
  matured: number;
  /** Matured coins that died within 24h. */
  dead: number;
  graduated: number;
  /** dead / matured, or null with no matured coin. */
  deadRate: number | null;
  serialRugger: boolean;
}

export interface CreatorCoin {
  mint: string;
  launchedAt: number;
  firstTradeAt: number | null;
  peakPrice: number | null;
  lastPrice: number | null;
  graduated: boolean;
  status: CoinStatus;
}

export function isSerialRugger(matured: number, dead: number): boolean {
  return matured >= SERIAL_RUGGER_MIN_LAUNCHES && dead / matured >= SERIAL_RUGGER_MIN_DEAD_RATE;
}
