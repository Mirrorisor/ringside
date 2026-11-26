export type RiskFlag = "sniper" | "bundle" | "insider" | "concentrated";
export interface CopySettings { follower: string; leader: string; enabled: boolean; mode: "fixed" | "ratio"; fixedLamports: number; ratioBps: number; maxPerTradeLamports: number; dailyCapLamports: number; slippageBps: number; copySells: boolean; copyPerps: boolean; maxLeverage: number; skipFlags: RiskFlag[]; minTokenAgeSec: number; }
export interface CopyIntent { id: string; follower: string; leader: string; sourceSignature: string; kind: "spot" | "perp"; mint: string; side: "buy" | "sell" | "long" | "short" | "close"; venue: "jupiter" | "pumpfun" | "ringside-perps"; lamports?: number; tokens?: string; leverage?: number; createdAt: number; expiresAt: number; status: "pending" | "skipped" | "built" | "sent" | "expired"; skipReason?: string; }

export type Quote = "SOL" | "USDC";
export type Window = "24h" | "7d" | "30d";
export interface Trade { signature: string; wallet: string; mint: string; side: "buy" | "sell"; tokenAmount: number; quote: Quote; quoteAmount: number; slot: number; timestamp: number; source: string }
export interface OpenPosition { mint: string; quote: Quote; tokenAmount: number; avgCost: number; costBasis: number }
export interface WindowStats { realisedPnl: Record<Quote, number>; volume: Record<Quote, number>; trades: number; buys: number; sells: number; winRate: number | null; tokensTraded: number }
export interface WalletStats { wallet: string; openPositions: OpenPosition[]; windows: Record<Window, WindowStats>; lastTradeAt: number | null }
export interface LeaderRow { rank: number; wallet: string; value: number; realisedPnl: Record<Quote, number>; volume: Record<Quote, number>; trades: number; winRate: number | null; tokensTraded: number }
export interface TokenFlags {
  mint: string; trades: number; creator: string | null;
  snipers: { wallet: string; slot: number; slotsAfterStart: number; tokenAmount: number }[];
  bundles: { slot: number; wallets: string[] }[];
  insiders: { wallet: string; fundedLamports: number }[] | null;
  concentration: { topShare: number; flagged: boolean; topHolders: { wallet: string; balance: number }[] };
}
