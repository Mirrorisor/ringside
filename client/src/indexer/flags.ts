/**
 * Token risk flags. Each is a pure function of indexed trades (and SOL
 * transfers), with its thresholds as exported constants.
 */
import type { SolTransfer, Trade } from "./types.js";

/** A buy at most this many slots after the token's first trade (or launch) is a snipe. ~0.8 s at 400 ms slots. */
export const SNIPER_MAX_SLOTS = 2;
/** At least this many distinct wallets buying one mint in one slot is a bundle. */
export const BUNDLE_MIN_WALLETS = 3;
/** A creator transfer below this is ignored as dust (0.01 SOL). */
export const INSIDER_MIN_FUNDING_LAMPORTS = 10_000_000;
/** Number of largest holders summed for concentration. */
export const TOP_HOLDERS = 10;
/** Top-holder share at or above this is flagged. */
export const TOP_HOLDERS_MAX_SHARE = 0.3;

export interface Sniper { wallet: string; slot: number; slotsAfterStart: number; tokenAmount: number }
export interface Bundle { slot: number; wallets: string[] }
export interface Insider { wallet: string; fundedLamports: number; fundingSlot: number; firstBuySlot: number }
export interface Concentration { topHolders: { wallet: string; balance: number }[]; topShare: number; denominator: number; flagged: boolean }

const buys = (trades: Trade[]) => trades.filter((t) => t.side === "buy");

/**
 * Wallets that bought within SNIPER_MAX_SLOTS of the start slot: the launch
 * slot if known, else the mint's first indexed trade. The creator is excluded.
 */
export function snipers(trades: Trade[], startSlot?: number, creator?: string, maxSlots = SNIPER_MAX_SLOTS): Sniper[] {
  if (trades.length === 0) return [];
  const start = startSlot ?? Math.min(...trades.map((t) => t.slot));
  const out = new Map<string, Sniper>();
  for (const t of buys(trades)) {
    const d = t.slot - start;
    if (d < 0 || d > maxSlots || t.wallet === creator) continue;
    const prev = out.get(t.wallet);
    if (prev) prev.tokenAmount += t.tokenAmount;
    else out.set(t.wallet, { wallet: t.wallet, slot: t.slot, slotsAfterStart: d, tokenAmount: t.tokenAmount });
  }
  return [...out.values()].sort((a, b) => a.slot - b.slot || a.wallet.localeCompare(b.wallet));
}

/** Slots where at least BUNDLE_MIN_WALLETS distinct wallets bought the mint. */
export function bundles(trades: Trade[], minWallets = BUNDLE_MIN_WALLETS): Bundle[] {
  const bySlot = new Map<number, Set<string>>();
  for (const t of buys(trades)) {
    let s = bySlot.get(t.slot);
    if (!s) bySlot.set(t.slot, (s = new Set()));
    s.add(t.wallet);
  }
  return [...bySlot]
    .filter(([, w]) => w.size >= minWallets)
    .map(([slot, w]) => ({ slot, wallets: [...w].sort() }))
    .sort((a, b) => a.slot - b.slot);
}

/**
 * Wallets that received at least INSIDER_MIN_FUNDING_LAMPORTS directly from
 * the creator at or before the slot of their first buy (one hop only).
 */
export function insiders(creator: string, trades: Trade[], transfers: SolTransfer[], minLamports = INSIDER_MIN_FUNDING_LAMPORTS): Insider[] {
  const firstBuy = new Map<string, number>();
  for (const t of buys(trades)) if (t.wallet !== creator) firstBuy.set(t.wallet, Math.min(firstBuy.get(t.wallet) ?? Infinity, t.slot));
  const out = new Map<string, Insider>();
  for (const tr of transfers) {
    if (tr.from !== creator) continue;
    const buySlot = firstBuy.get(tr.to);
    if (buySlot === undefined || tr.slot > buySlot) continue;
    const prev = out.get(tr.to);
    if (prev) prev.fundedLamports += tr.lamports;
    else out.set(tr.to, { wallet: tr.to, fundedLamports: tr.lamports, fundingSlot: tr.slot, firstBuySlot: buySlot });
  }
  return [...out.values()].filter((i) => i.fundedLamports >= minLamports).sort((a, b) => a.wallet.localeCompare(b.wallet));
}

/** Net token balance per wallet from indexed trades (positive balances only). */
export function holderBalances(trades: Trade[]): Map<string, number> {
  const b = new Map<string, number>();
  for (const t of trades) b.set(t.wallet, (b.get(t.wallet) ?? 0) + (t.side === "buy" ? t.tokenAmount : -t.tokenAmount));
  for (const [w, x] of b) if (!(x > 1e-9)) b.delete(w);
  return b;
}

/**
 * Share of `supply` (or, if unknown, of all positive indexed balances) held
 * by the TOP_HOLDERS largest holders.
 */
export function topHolderConcentration(balances: Map<string, number>, supply?: number, n = TOP_HOLDERS, maxShare = TOP_HOLDERS_MAX_SHARE): Concentration {
  const sorted = [...balances].map(([wallet, balance]) => ({ wallet, balance })).sort((a, b) => b.balance - a.balance || a.wallet.localeCompare(b.wallet));
  const top = sorted.slice(0, n);
  const denominator = supply && supply > 0 ? supply : sorted.reduce((s, h) => s + h.balance, 0);
  const topShare = denominator > 0 ? top.reduce((s, h) => s + h.balance, 0) / denominator : 0;
  return { topHolders: top, topShare, denominator, flagged: topShare >= maxShare };
}
