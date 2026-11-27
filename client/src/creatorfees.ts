/**
 * Creator-fee display logic for the web app (docs/creator-fee-lock.md). Pure: no chain access, no DOM, no imports,
 * so the Vite app and the node tests share it. Amounts are bigint base units (lamports for SOL, 1e-6 for USDC).
 *
 * Each creator fee is split as it accrues: 20% into an early bucket (`creator_fees_owed` on the launch Curve,
 * `creator_fees` on the perps Market), claimable any time, and 80% into a locked bucket (`creator_fees_locked`),
 * claimable only once the curve is complete. A curve that has not graduated 30 days after `created_ts` lets anyone
 * (the keeper does it) forfeit the locked bucket to the protocol.
 */

/** Mirrors CREATOR_FEE_FORFEIT_SECONDS in programs/ringside_launch/src/lib.rs (30 days). */
export const CREATOR_FEE_FORFEIT_SECONDS = 30n * 24n * 3600n;

/** One short line for traders, shown with the panel. */
export const TRADER_NOTE = "Creators can take only 20% of their fees before the coin graduates.";

export interface Stream {
  /** Early (20%) bucket: claimable any time. */
  early: bigint;
  /** Locked (80%) bucket: claimable once the curve is complete. */
  locked: bigint;
}
export interface FeeInput {
  complete: boolean;
  /** Unix seconds (Curve.created_ts). */
  createdTs: bigint;
  sol: Stream;
  /** The perp market's USDC stream, or null when the token has no market. */
  usdc: Stream | null;
}
/**
 * locked: not graduated, before the deadline. overdue: not graduated, past the deadline, locked fees still there
 * (the keeper forfeits them on its next run). graduated: everything claimable. forfeited: past the deadline, not
 * graduated and nothing locked.
 */
export type FeeStatus = "locked" | "overdue" | "graduated" | "forfeited";

/** Unix seconds after which an ungraduated curve's locked fees can be forfeited. */
export const forfeitTs = (createdTs: bigint): bigint => createdTs + CREATOR_FEE_FORFEIT_SECONDS;

export function feeStatus(i: FeeInput, now: bigint): FeeStatus {
  if (i.complete) return "graduated";
  if (now < forfeitTs(i.createdTs)) return "locked";
  return i.sol.locked + (i.usdc?.locked ?? 0n) > 0n ? "overdue" : "forfeited";
}

/** What `claim_creator_fees` pays now: the early bucket, plus the locked bucket once the curve is complete. */
export const claimPays = (s: Stream, complete: boolean): bigint => s.early + (complete ? s.locked : 0n);

/** Locked amount that cannot be claimed yet (0 once graduated: it is claimable then). */
export const stillLocked = (s: Stream, complete: boolean): bigint => (complete ? 0n : s.locked);

/** Floors to `dp` decimals (never shows more than is claimable), trims trailing zeros down to `minDp`. */
export function formatUnits(v: bigint, decimals: number, dp: number, minDp: number): string {
  const unit = 10n ** BigInt(decimals);
  const cut = 10n ** BigInt(decimals - dp);
  const f = (v / cut) * cut;
  if (v > 0n && f === 0n) return `<${(1 / 10 ** dp).toFixed(dp)}`;
  const whole = (f / unit).toString();
  let frac = (f % unit).toString().padStart(decimals, "0").slice(0, dp);
  while (frac.length > minDp && frac.endsWith("0")) frac = frac.slice(0, -1);
  return frac ? `${whole}.${frac}` : whole;
}
export const formatSol = (lamports: bigint): string => `${formatUnits(lamports, 9, 6, 3)} SOL`;
export const formatUsdc = (e6: bigint): string => `$${formatUnits(e6, 6, 4, 2)}`;

/** "29d 4h", "3h 12m", "5m", "under a minute". Negative or zero: "now". */
export function formatCountdown(seconds: bigint): string {
  if (seconds <= 0n) return "now";
  const d = seconds / 86400n, h = (seconds % 86400n) / 3600n, m = (seconds % 3600n) / 60n;
  if (d > 0n) return `${d}d ${h}h`;
  if (h > 0n) return `${h}h ${m}m`;
  return m > 0n ? `${m}m` : "under a minute";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Unix seconds -> "27 Dec 2026" in UTC (the same text in every time zone). */
export function formatDate(ts: bigint): string {
  const d = new Date(Number(ts) * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** The status sentence for the panel. */
export function statusLine(i: FeeInput, now: bigint): string {
  const s = feeStatus(i, now);
  if (s === "graduated") return "Graduated: all fees claimable";
  if (s === "forfeited") return "Forfeited: the locked 80% went to the protocol";
  const when = formatDate(forfeitTs(i.createdTs));
  if (s === "overdue") return `Not graduated by ${when}: the locked fees are forfeited to the protocol on the keeper's next run`;
  return `Unlocks when the coin graduates. Forfeited to the protocol on ${when} (in ${formatCountdown(forfeitTs(i.createdTs) - now)}) if it hasn't graduated`;
}

export interface StreamView {
  key: "sol" | "usdc";
  label: string;
  claimable: string;
  locked: string;
  /** Raw amount a claim would pay now. */
  pays: bigint;
  /** Button text, e.g. "Claim 0.0123 SOL". */
  button: string;
  /** What the claim pays, in words. */
  payNote: string;
  canClaim: boolean;
}

/** Everything the panel and the "My launches" rows show, as plain strings. */
export function feeView(i: FeeInput, now: bigint) {
  const mk = (key: "sol" | "usdc", s: Stream): StreamView => {
    const fmt = key === "sol" ? formatSol : formatUsdc;
    const pays = claimPays(s, i.complete);
    return {
      key, label: key === "sol" ? "SOL (launch curve)" : "USDC (perp market)",
      claimable: fmt(pays), locked: fmt(stillLocked(s, i.complete)), pays,
      button: pays > 0n ? `Claim ${fmt(pays)}` : `Nothing to claim (${key === "sol" ? "SOL" : "USDC"})`,
      payNote: i.complete ? "pays everything" : "pays the 20% bucket",
      canClaim: pays > 0n,
    };
  };
  return {
    status: feeStatus(i, now),
    line: statusLine(i, now),
    note: TRADER_NOTE,
    streams: [mk("sol", i.sol), ...(i.usdc ? [mk("usdc", i.usdc)] : [])],
  };
}
