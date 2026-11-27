/** Account decoding through the IDL coder. */
import { PublicKey } from "@solana/web3.js";
import { anchor, type BN, type Idl } from "./anchor.js";

export interface VaultAcc {
  authority: PublicKey; priceAuthority: PublicKey; usdcMint: PublicKey; totalShares: BN; traderCollateral: BN; reserved: BN; protocolFees: BN;
  solUsdE6: BN; solUsdTs: BN; tier0CapBps: number; skewCapBps: number; paused: boolean; bump: number;
}
export interface MarketAcc {
  mint: PublicKey; curve: PublicKey; creator: PublicKey; tier: number; createdSlot: BN; oiLong: BN; oiShort: BN; oiCapOverride: BN;
  fundingIndex: BN; lastFundingTs: BN; bandAnchorQ64: BN; bandAnchorSlot: BN; traderNetPnl: BN; insurance: BN; creatorFees: BN;
  reduceOnly: boolean; adlMode: boolean; bump: number;
  /** Locked 80% of creator fees (docs/creator-fee-lock.md). Absent until the IDL is regenerated from the upgraded program. */
  creatorFeesLocked?: BN;
  /** Appended fields; absent until the IDL is regenerated from the upgraded program. `pool` is all zeros before graduation. */
  pool?: PublicKey;
  /** The curve's final price (Q64.64) a graduated market is priced at until its pool has TWAP history (0 on older markets). */
  gradPriceQ64?: BN;
  /** Start of the retirement volume window: slot, and the curve's creator_fees_locked then. */
  volSnapSlot?: BN; volSnapFees?: BN;
}
export interface PositionAcc {
  owner: PublicKey; market: PublicKey; side: number; collateral: BN; sizeUsd: BN; entryPriceQ64: BN; fundingSnapshot: BN; openedSlot: BN; bump: number;
}
export type AccountName = "vault" | "market" | "position" | "orderRequest" | "lpAccount" | "curve";

export const perpsCoders = (idl: Idl) => ({
  accounts: new anchor.BorshAccountsCoder(idl),
  instructions: new anchor.BorshInstructionCoder(idl),
  events: new anchor.BorshEventCoder(idl),
});
export type PerpsCoders = ReturnType<typeof perpsCoders>;

/**
 * Decodes one account by name ("vault", "market", "position", "orderRequest"). The raw coder is keyed by the
 * IDL's PascalCase names, while `program.coder.accounts` (what the app used) took camelCase: accept both.
 * Field names come back camelCase, as before.
 */
export function decodeAccount(c: PerpsCoders, name: string, data: Buffer | Uint8Array): any {
  const raw = c.accounts.decode(name[0].toUpperCase() + name.slice(1), Buffer.from(data)) as Record<string, unknown>;
  // The raw coder returns the IDL's snake_case fields; `program.coder.accounts` returned camelCase.
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.replace(/_([a-z0-9])/g, (_, ch: string) => ch.toUpperCase()), v]));
}
export const decodeVault = (c: PerpsCoders, data: Buffer | Uint8Array): VaultAcc => decodeAccount(c, "vault", data);
export const decodeMarket = (c: PerpsCoders, data: Buffer | Uint8Array): MarketAcc => decodeAccount(c, "market", data);
export const decodePosition = (c: PerpsCoders, data: Buffer | Uint8Array): PositionAcc => decodeAccount(c, "position", data);
