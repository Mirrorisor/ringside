/** Shared contract between the social backend and the copy engine. Keep identical in both trees. */
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
  venue: "jupiter" | "pumpfun" | "meteora" | "ringside-perps";
  lamports?: number; tokens?: string; leverage?: number;
  createdAt: number; expiresAt: number;
  status: "pending" | "skipped" | "built" | "sent" | "expired"; skipReason?: string;
}
export interface SocialPort {
  copySettingsForLeader(leader: string): Promise<CopySettings[]>;
  notify(follower: string, intent: CopyIntent): Promise<void>;
}
