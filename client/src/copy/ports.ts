/**
 * Copy engine ports. `RiskFlag`, `CopySettings`, `CopyIntent` and `SocialPort`
 * are a shared contract with the social backend: do not change their shape
 * without agreeing it with that side.
 */
export type RiskFlag = "sniper" | "bundle" | "insider" | "concentrated";

export interface CopySettings {
  follower: string; leader: string; enabled: boolean;
  mode: "fixed" | "ratio"; fixedLamports: number; ratioBps: number;
  maxPerTradeLamports: number; dailyCapLamports: number;
  slippageBps: number; copySells: boolean;
  copyPerps: boolean; maxLeverage: number;
  skipFlags: RiskFlag[]; minTokenAgeSec: number;
}

export interface CopyIntent {
  id: string; follower: string; leader: string; sourceSignature: string;
  kind: "spot" | "perp"; mint: string; side: "buy" | "sell" | "long" | "short" | "close";
  venue: "jupiter" | "pumpfun" | "ringside-perps";
  lamports?: number; tokens?: string; leverage?: number;
  createdAt: number; expiresAt: number;
  status: "pending" | "skipped" | "built" | "sent" | "expired"; skipReason?: string;
}

export interface SocialPort {
  copySettingsForLeader(leader: string): Promise<CopySettings[]>;
  notify(follower: string, intent: CopyIntent): Promise<void>;
}

/** What the engine needs to know about a token. Backed by the indexer's flag functions. */
export interface TokenFacts {
  flags: RiskFlag[];
  /** Seconds since the token's launch or first indexed trade; null if unknown. */
  ageSec: number | null;
}
export interface FlagsPort {
  tokenFacts(mint: string, nowSec: number): Promise<TokenFacts>;
}

/** Tier of a Ringside perp market (0, 1 or 2), or null if the mint has no market. */
export interface PerpTierPort {
  tierOf(mint: string): Promise<number | null>;
}

/** A decoded Ringside perp open or close by a leader. Decoding is a TODO (see perps.ts). */
export interface PerpEvent {
  leader: string; market: string; mint: string;
  side: "long" | "short";
  sizeUsd: number; leverage: number;
  signature: string; slot: number; timestamp: number; // unix seconds
  action: "open" | "close";
}
