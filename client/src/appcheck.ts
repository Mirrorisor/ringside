/**
 * Pure checks the web app runs before it asks a wallet for a signature. No DOM,
 * no network, so they run in the browser and under Node tests:
 *   - resolveBase       which backend base URL the app may talk to
 *   - checkSiwsMessage  the sign-in message names this site and this wallet
 *   - checkBuiltTransaction  the built copy transaction is safe and matches the intent
 *   - describeBuilt     what the review step shows, with "unknown" where the build response lacks it
 * The transaction rules are `checkTransaction` from trade/jupiter.ts, plus Pump programs,
 * a fee-wallet outflow cap and a mint match.
 */
import type { Address } from "@solana/kit";
import { associatedTokenAddress, checkTransaction, instructionsOf, TX_PROGRAMS, DEFAULT_TX_POLICY, type TxCheck } from "./trade/jupiter.js";

export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P" as Address;
export const PUMPSWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA" as Address;

export class AppCheckError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = "AppCheckError"; }
}

// ---- Backend base URLs ---------------------------------------------------------

const isLocalHost = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]";

/** Origins a dev build may be pointed at: this page's own, localhost, and the comma-separated `allowedCsv`. */
export function allowedOrigins(allowedCsv: string | undefined, pageOrigin: string): (o: URL) => boolean {
  const extra = new Set<string>();
  for (const s of (allowedCsv ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    try { extra.add(new URL(s).origin); } catch { /* ignore malformed entries */ }
  }
  return (u) => u.origin === pageOrigin || extra.has(u.origin) || ((u.protocol === "http:" || u.protocol === "https:") && isLocalHost(u.hostname));
}

/**
 * The base URL to use. Production always returns `defaultBase` (same-origin). A dev build accepts `override`
 * only when its origin passes the build-time allowlist; anything else falls back to `defaultBase`.
 */
export function resolveBase(override: string | null | undefined, defaultBase: string, o: { dev: boolean; allowedCsv?: string; pageOrigin: string }): string {
  if (!o.dev || !override) return defaultBase;
  try {
    const u = new URL(override);
    if (!/^https?:$/.test(u.protocol) || u.username || u.password) return defaultBase;
    if (!allowedOrigins(o.allowedCsv, o.pageOrigin)(u)) return defaultBase;
    return (u.origin + u.pathname).replace(/\/+$/, "");
  } catch {
    return defaultBase;
  }
}

// ---- Sign-in message -----------------------------------------------------------

const STATEMENT = "Sign in to Ringside. This request will not trigger a transaction or cost any fee.";
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Refuses a sign-in message unless it is the expected SIWS format for `host` and `wallet`. */
export function checkSiwsMessage(message: string, o: { host: string; wallet: string }): void {
  const bad = (why: string): never => { throw new AppCheckError("bad_signin_message", `Refusing to sign: the sign-in message ${why}.`); };
  if (typeof message !== "string" || message.length > 1024) bad("is malformed");
  const lines = message.split("\n");
  if (lines.length !== 8) bad("is not in the expected format");
  if (lines[0] !== `${o.host} wants you to sign in with your Solana account:`) bad(`is not for this site (${o.host})`);
  if (lines[1] !== o.wallet) bad("is not for your wallet");
  if (lines[2] !== "" || lines[4] !== "") bad("is not in the expected format");
  if (lines[3] !== STATEMENT) bad("has an unexpected statement");
  if (!/^Nonce: [0-9a-f]{32}$/.test(lines[5])) bad("has a bad nonce");
  const issued = /^Issued At: (.+)$/.exec(lines[6])?.[1], expires = /^Expiration Time: (.+)$/.exec(lines[7])?.[1];
  if (!issued || !expires || !ISO.test(issued) || !ISO.test(expires)) bad("has bad timestamps");
  const i = Date.parse(issued!), e = Date.parse(expires!);
  if (!Number.isFinite(i) || !Number.isFinite(e) || e <= i || e - i > 3_600_000) bad("has bad timestamps");
}

// ---- Built transaction ---------------------------------------------------------

export interface BuiltCheckOpts {
  user: string;
  /** Expected fee payer other than the user (the gas sponsor). */
  sponsor?: string | null;
  mint: string;
  venue: "jupiter" | "pumpfun" | "ringside-perps";
  /** Ringside fee wallet (VITE_FEE_WALLET); the only place a user SOL transfer may go. */
  feeWallet?: string | null;
  /** Displayed fee; the user's transfer to the fee wallet may not exceed it. */
  feeLamports: number | null;
}

export interface BuiltCheck {
  tx: TxCheck;
  feePayer: string;
  venues: ("jupiter" | "pumpfun")[];
  /** What the transaction itself sends from the user to the fee wallet. */
  feeLamportsInTx: bigint;
  rentLamports: bigint;
}

/** Decodes the built transaction and refuses it unless it is safe for `user` to sign and matches the intent. Throws AppCheckError or JupiterError. */
export async function checkBuiltTransaction(wire: string, o: BuiltCheckOpts): Promise<BuiltCheck> {
  if (o.venue !== "jupiter" && o.venue !== "pumpfun") throw new AppCheckError("venue_unsupported", "Refusing to sign: this venue cannot be checked in the app.");
  const user = o.user as Address;
  const feePayers = [user, ...(o.sponsor ? [o.sponsor as Address] : [])];
  const programs = [...DEFAULT_TX_POLICY.programs, PUMP_PROGRAM, PUMPSWAP_PROGRAM];
  const fee = o.feeLamports !== null && Number.isSafeInteger(o.feeLamports) && o.feeLamports >= 0 ? BigInt(o.feeLamports) : 0n;
  const tx = await checkTransaction(wire, {
    user, feePayers, policy: { programs },
    outflow: { recipients: o.feeWallet ? [o.feeWallet as Address] : [], maxAmount: o.feeWallet ? fee : 0n },
  });

  const { ixs } = instructionsOf(wire);
  const used = new Set(ixs.map((i) => i.program));
  const venues: BuiltCheck["venues"] = [];
  if (used.has(TX_PROGRAMS.jupiterSwap) || used.has(TX_PROGRAMS.jupiterOrderEngine)) venues.push("jupiter");
  if (used.has(PUMP_PROGRAM) || used.has(PUMPSWAP_PROGRAM)) venues.push("pumpfun");
  if (!venues.includes(o.venue)) throw new AppCheckError("venue_mismatch", `Refusing to sign: the transaction does not use ${o.venue === "jupiter" ? "Jupiter" : "Pump.fun"}, which this copy claims.`);
  if (venues.length > 1) throw new AppCheckError("venue_mismatch", "Refusing to sign: the transaction mixes venues.");

  // Mint: the intent's mint (or the user's token account for it) must be named by the transaction.
  const accounts = new Set<string>(ixs.flatMap((i) => i.accounts.filter((a): a is Address => a !== null)));
  const ata = [await associatedTokenAddress(user, o.mint as Address, TX_PROGRAMS.token), await associatedTokenAddress(user, o.mint as Address, TX_PROGRAMS.token2022)];
  if (!accounts.has(o.mint) && !ata.some((a) => accounts.has(a))) {
    throw new AppCheckError("mint_mismatch", "Refusing to sign: the transaction does not trade the token in this copy.");
  }
  return { tx, feePayer: tx.inspection.feePayer, venues, feeLamportsInTx: tx.outflow, rentLamports: tx.rentLamports };
}

// ---- What the review step shows --------------------------------------------------

export interface BuiltView {
  venue: string | null;
  /** Expected output: token base units for a buy, lamports for a sell. */
  expectedOut: bigint | null;
  /** Minimum output after slippage, same unit. */
  minOut: bigint | null;
  /** Ringside fee, lamports. */
  feeLamports: number | null;
  /** Sells only: SOL proceeds from the build response, never the leader's cost basis. */
  proceedsLamports: bigint | null;
  unknown: string[];
}

const big = (v: unknown): bigint | null => {
  if (typeof v === "bigint") return v >= 0n ? v : null;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^\d{1,30}$/.test(v)) return BigInt(v);
  return null;
};
const first = (d: Record<string, unknown>, keys: string[]) => { for (const k of keys) { const v = big(d[k]); if (v !== null) return v; } return null; };

/** Reads the build response. Anything it lacks is reported in `unknown` rather than guessed. */
export function describeBuilt(side: string, built: Record<string, unknown>, slippageBps?: number): BuiltView {
  const sell = side === "sell";
  const venue = typeof built.venue === "string" ? built.venue : null;
  const feeRaw = first(built, ["feeLamports", "ringsideFeeLamports", "fee"]);
  const proceeds = sell ? first(built, ["proceedsLamports", "solOut", "lamports"]) : null;
  const expectedOut = sell ? proceeds : first(built, ["expectedOut", "tokensOut", "outAmount", "tokens"]);
  let minOut = first(built, ["minOut", "minOutAmount", "otherAmountThreshold", "minTokensOut", "minLamportsOut"]);
  if (minOut === null && expectedOut !== null && Number.isInteger(slippageBps) && slippageBps! >= 0 && slippageBps! <= 10_000) {
    minOut = (expectedOut * BigInt(10_000 - slippageBps!)) / 10_000n;
  }
  const unknown: string[] = [];
  if (!venue) unknown.push("venue");
  if (feeRaw === null) unknown.push("Ringside fee");
  if (expectedOut === null) unknown.push(sell ? "sale proceeds" : "expected output");
  if (minOut === null) unknown.push("minimum after slippage");
  return { venue, expectedOut, minOut, feeLamports: feeRaw === null ? null : Number(feeRaw), proceedsLamports: proceeds, unknown };
}
