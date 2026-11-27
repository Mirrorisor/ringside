/** Pure helpers for the mainnet seed deposit (see scripts/init-mainnet.ts and docs/security-fixes.md F9). */

export const USDC_DECIMALS = 6;
export const DEFAULT_SEED_DEPOSIT_USDC = "1000";

/**
 * Parses SEED_DEPOSIT_USDC (a plain decimal number of USDC, at most 6 decimals) into base units.
 * Unset or blank means the default. Anything else (0, negative, exponent, thousands separators,
 * more than 6 decimals) throws rather than guessing.
 */
export function parseSeedAmount(raw: string | undefined): bigint {
  const s = (raw ?? "").trim() === "" ? DEFAULT_SEED_DEPOSIT_USDC : raw!.trim();
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) throw new Error(`SEED_DEPOSIT_USDC=${JSON.stringify(s)} is not a plain USDC amount with at most ${USDC_DECIMALS} decimals (e.g. 1000 or 250.5)`);
  const units = BigInt(m[1]) * 10n ** BigInt(USDC_DECIMALS) + BigInt((m[2] ?? "").padEnd(USDC_DECIMALS, "0"));
  if (units <= 0n) throw new Error("SEED_DEPOSIT_USDC must be greater than 0");
  if (units > 0xffff_ffff_ffff_ffffn) throw new Error("SEED_DEPOSIT_USDC does not fit in a u64");
  return units;
}

export type SeedDecision =
  | { action: "skip"; reason: string }
  | { action: "deposit" }
  | { action: "insufficient"; have: bigint; need: bigint };

/**
 * `totalShares`: the vault's total_shares, or null when the vault does not exist yet.
 * `balance`: the wallet's USDC balance in base units (0n when it has no USDC account).
 * A vault that already has shares is never topped up here; otherwise the wallet must hold the full amount.
 */
export function decideSeed(totalShares: bigint | null, balance: bigint, required: bigint): SeedDecision {
  if (totalShares !== null && totalShares > 0n) return { action: "skip", reason: `vault already has ${totalShares} shares` };
  if (balance < required) return { action: "insufficient", have: balance, need: required };
  return { action: "deposit" };
}

export const formatUsdc = (units: bigint): string => {
  const base = 10n ** BigInt(USDC_DECIMALS);
  const frac = (units % base).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return `${units / base}${frac ? "." + frac : ""}`;
};
