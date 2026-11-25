/**
 * Wallet stats from a wallet's trade history (pure functions).
 *
 * Realised PnL uses average cost per (mint, quote): a buy adds tokens and
 * cost; a sell realises proceeds minus average cost of the tokens sold.
 * Tokens sold beyond the indexed position (bought before indexing began, or
 * received by transfer) have unknown cost and are left out of PnL.
 * PnL, volume and costs are reported per quote currency (SOL and USDC are
 * never mixed; there is no price oracle here).
 *
 * Win rate is per token: of the (mint, quote) positions with any realised
 * PnL in the window, the share whose realised PnL in the window is > 0.
 */
import type { Quote, Trade } from "./types.js";

export const WINDOWS = { "24h": 86_400, "7d": 604_800, "30d": 2_592_000 } as const;
export type Window = keyof typeof WINDOWS;
export const isWindow = (w: unknown): w is Window => typeof w === "string" && Object.hasOwn(WINDOWS, w);

export interface OpenPosition { mint: string; quote: Quote; tokenAmount: number; avgCost: number; costBasis: number }
export interface WindowStats { realisedPnl: Record<Quote, number>; volume: Record<Quote, number>; trades: number; buys: number; sells: number; winRate: number | null; tokensTraded: number }
export interface WalletStats { wallet: string; openPositions: OpenPosition[]; windows: Record<Window, WindowStats>; lastTradeAt: number | null }

/** Positions this small (UI units) count as closed. */
const EPS = 1e-9;
const zero = (): Record<Quote, number> => ({ SOL: 0, USDC: 0 });

interface Realisation { key: string; quote: Quote; pnl: number; timestamp: number }

/** Replays trades (any order) into open positions and per-sell realisations. */
export function replay(trades: Trade[]): { positions: Map<string, OpenPosition>; realisations: Realisation[] } {
  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp || a.slot - b.slot || a.signature.localeCompare(b.signature));
  const positions = new Map<string, OpenPosition>();
  const realisations: Realisation[] = [];
  for (const t of sorted) {
    if (!(t.tokenAmount > 0) || !(t.quoteAmount >= 0)) continue;
    const key = `${t.mint}:${t.quote}`;
    const p = positions.get(key) ?? { mint: t.mint, quote: t.quote, tokenAmount: 0, avgCost: 0, costBasis: 0 };
    if (t.side === "buy") {
      p.tokenAmount += t.tokenAmount;
      p.costBasis += t.quoteAmount;
    } else {
      const sold = Math.min(t.tokenAmount, p.tokenAmount);
      if (sold > 0) {
        const avg = p.costBasis / p.tokenAmount;
        const proceeds = t.quoteAmount * (sold / t.tokenAmount);
        realisations.push({ key, quote: t.quote, pnl: proceeds - avg * sold, timestamp: t.timestamp });
        p.tokenAmount -= sold;
        p.costBasis -= avg * sold;
        if (p.tokenAmount <= EPS) [p.tokenAmount, p.costBasis] = [0, 0];
      }
    }
    p.avgCost = p.tokenAmount > 0 ? p.costBasis / p.tokenAmount : 0;
    positions.set(key, p);
  }
  return { positions, realisations };
}

export function windowStats(trades: Trade[], realisations: Realisation[], since: number): WindowStats {
  const inWin = trades.filter((t) => t.timestamp >= since);
  const volume = zero();
  for (const t of inWin) volume[t.quote] += t.quoteAmount;
  const realisedPnl = zero();
  const perToken = new Map<string, number>();
  for (const r of realisations) {
    if (r.timestamp < since) continue;
    realisedPnl[r.quote] += r.pnl;
    perToken.set(r.key, (perToken.get(r.key) ?? 0) + r.pnl);
  }
  const wins = [...perToken.values()].filter((x) => x > 0).length;
  return {
    realisedPnl,
    volume,
    trades: inWin.length,
    buys: inWin.filter((t) => t.side === "buy").length,
    sells: inWin.filter((t) => t.side === "sell").length,
    winRate: perToken.size ? wins / perToken.size : null,
    tokensTraded: new Set(inWin.map((t) => t.mint)).size,
  };
}

export function walletStats(wallet: string, trades: Trade[], nowSec: number): WalletStats {
  const { positions, realisations } = replay(trades);
  const windows = {} as Record<Window, WindowStats>;
  for (const w of Object.keys(WINDOWS) as Window[]) windows[w] = windowStats(trades, realisations, nowSec - WINDOWS[w]);
  return {
    wallet,
    openPositions: [...positions.values()].filter((p) => p.tokenAmount > EPS),
    windows,
    lastTradeAt: trades.length ? Math.max(...trades.map((t) => t.timestamp)) : null,
  };
}

export const LEADERBOARD_METRICS = ["pnl", "volume", "winrate", "trades"] as const;
export type LeaderboardMetric = (typeof LEADERBOARD_METRICS)[number];
export const isMetric = (m: unknown): m is LeaderboardMetric => typeof m === "string" && (LEADERBOARD_METRICS as readonly string[]).includes(m);

/** Leaderboard rows rank on SOL-quoted PnL / volume. */
export function metricValue(s: WindowStats, by: LeaderboardMetric): number {
  switch (by) {
    case "pnl": return s.realisedPnl.SOL;
    case "volume": return s.volume.SOL;
    case "winrate": return s.winRate ?? -1;
    case "trades": return s.trades;
  }
}
