/**
 * Forfeited creator fees (launch side) -> protocol-owned liquidity: the pure parts.
 *
 * `forfeit_creator_fees` on the launch program moves a curve's locked SOL to `global.fee_recipient` and emits
 * `CreatorFeesForfeited { mint, amount }`. scripts/treasury.ts scans the launch program's transactions, feeds
 * them here, and converts exactly the forfeited-but-not-yet-converted lamports to USDC. Nothing here touches the
 * network or the disk, so the parsing and the accounting are unit-tested (test/forfeits.test.mjs).
 *
 * Perps forfeits emit an event with the SAME name and discriminator (USDC, not SOL). The log parser therefore
 * only accepts "Program data:" lines written while the launch program is the innermost running program.
 */
import { createHash } from "node:crypto";

export const FORFEIT_EVENT_DISC = createHash("sha256").update("event:CreatorFeesForfeited").digest().subarray(0, 8);
/** Most recent processed signatures kept in the state file (re-run protection on top of the cursor). */
export const PROCESSED_CAP = 2000;

export interface ForfeitEvent { mint: string; lamports: bigint }
/** A transaction as fetched from RPC, reduced to what matters. `err` is null for a successful transaction. */
export interface ScannedTx { signature: string; err: unknown | null; logs: string[] | null }

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(b: Uint8Array): string {
  let n = BigInt("0x0" + Buffer.from(b).toString("hex"));
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const byte of b) { if (byte === 0) s = "1" + s; else break; }
  return s;
}

/** Decodes one "Program data: <base64>" payload; null if it is not a CreatorFeesForfeited event. */
export function decodeForfeitEvent(base64: string): ForfeitEvent | null {
  const d = Buffer.from(base64, "base64");
  if (d.length !== 8 + 32 + 8 || !d.subarray(0, 8).equals(FORFEIT_EVENT_DISC)) return null;
  return { mint: base58(d.subarray(8, 40)), lamports: d.readBigUInt64LE(40) };
}

/**
 * CreatorFeesForfeited events emitted by `program` in one transaction's logs. Tracks the invoke stack so
 * that data written by another program (e.g. the perps program's same-named event) is ignored.
 * `truncated` is true when the runtime cut the logs: the caller must not trust such a result.
 */
export function parseForfeitEvents(logs: string[], program: string): { events: ForfeitEvent[]; truncated: boolean } {
  const stack: string[] = [];
  const events: ForfeitEvent[] = [];
  let truncated = false;
  for (const line of logs) {
    if (line.startsWith("Log truncated")) { truncated = true; continue; }
    let m = /^Program (\S+) invoke \[\d+\]$/.exec(line);
    if (m) { stack.push(m[1]); continue; }
    m = /^Program (\S+) (?:success|failed)/.exec(line);
    if (m) { stack.pop(); continue; }
    if (line.startsWith("Program data: ") && stack[stack.length - 1] === program) {
      const ev = decodeForfeitEvent(line.slice("Program data: ".length).trim());
      if (ev) events.push(ev);
    }
  }
  return { events, truncated };
}

/** Persisted accounting. Lamport amounts are decimal strings (JSON has no bigint). */
export interface ForfeitState {
  /** Newest signature of the last completed scan; the next scan stops there. */
  cursor: string | null;
  totalForfeited: string;
  totalConverted: string;
  /** USDC (6 dp) received from a swap and not yet deposited (a deposit failed): retried first. */
  usdcPendingDeposit: string;
  /** Total USDC (6 dp) deposited as treasury liquidity from forfeits. */
  totalDepositedUsdc: string;
  /** Newest first, capped at PROCESSED_CAP. */
  processed: string[];
  /**
   * Optional (absent in older state files): seeded from FORFEIT_START_SLOT on the first run. While `cursor` is
   * still null, a scan ignores transactions in slots below it, so a scan that found nothing cannot fall back to
   * reading the whole history on the next run.
   */
  startSlot?: number | null;
}

export const emptyState = (): ForfeitState => ({ cursor: null, totalForfeited: "0", totalConverted: "0", usdcPendingDeposit: "0", totalDepositedUsdc: "0", processed: [] });

/** Validates a parsed state file (a hand-edited or corrupt one must not silently reset the totals). */
export function parseState(raw: unknown): ForfeitState {
  const o = raw as Partial<ForfeitState> | null;
  const big = (v: unknown) => typeof v === "string" && /^\d+$/.test(v);
  if (!o || typeof o !== "object" || !(o.cursor === null || typeof o.cursor === "string") || !big(o.totalForfeited) || !big(o.totalConverted)
    || !big(o.usdcPendingDeposit) || !big(o.totalDepositedUsdc) || !Array.isArray(o.processed) || !o.processed.every((s) => typeof s === "string")) {
    throw new Error("forfeit state file is malformed; fix or remove it (removing it re-scans the whole history)");
  }
  if (o.startSlot !== undefined && o.startSlot !== null && !(Number.isSafeInteger(o.startSlot) && o.startSlot > 0)) throw new Error("forfeit state: startSlot must be a positive integer");
  if (BigInt(o.totalConverted as string) > BigInt(o.totalForfeited as string)) throw new Error("forfeit state: totalConverted exceeds totalForfeited");
  return o as ForfeitState;
}

/** The operator's starting point for a first run, from FORFEIT_START_SIGNATURE / FORFEIT_START_SLOT. */
export interface ForfeitStart { signature: string | null; slot: number | null }

/** Reads and validates the two env vars (empty counts as unset). Throws on a malformed value or on both being set. */
export function parseStart(env: { FORFEIT_START_SIGNATURE?: string; FORFEIT_START_SLOT?: string }): ForfeitStart {
  const sigRaw = (env.FORFEIT_START_SIGNATURE ?? "").trim();
  const slotRaw = (env.FORFEIT_START_SLOT ?? "").trim();
  // A transaction signature is 64 bytes: 86 to 88 base58 characters.
  if (sigRaw && !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(sigRaw)) throw new Error("FORFEIT_START_SIGNATURE is not a base58 transaction signature");
  if (slotRaw && !/^[1-9]\d{0,15}$/.test(slotRaw)) throw new Error("FORFEIT_START_SLOT must be a positive integer slot number");
  if (sigRaw && slotRaw) throw new Error("set only one of FORFEIT_START_SIGNATURE and FORFEIT_START_SLOT");
  return { signature: sigRaw || null, slot: slotRaw ? Number(slotRaw) : null };
}

export const NO_START_MESSAGE =
  "first forfeit run with no state file: refusing to read the launch program's whole signature history. "
  + "Set FORFEIT_START_SIGNATURE to any launch-program transaction signature from before the first forfeit "
  + "(forfeits only exist 30 days after the 20/80 upgrade), or FORFEIT_START_SLOT to a slot before it, and run again";

/**
 * Applies the starting point to the state that was loaded (or is new). With an existing state file the start
 * is ignored: the saved cursor is the audit trail and is never overwritten. Without one, a start is required;
 * a signature becomes the cursor (that transaction itself is not scanned), a slot becomes `startSlot`.
 */
export function seedState(state: ForfeitState, stateFileExists: boolean, start: ForfeitStart): { state: ForfeitState; seeded: boolean } {
  if (stateFileExists) return { state, seeded: false };
  if (start.signature) return { state: { ...state, cursor: start.signature }, seeded: true };
  if (start.slot) return { state: { ...state, startSlot: start.slot }, seeded: true };
  throw new Error(NO_START_MESSAGE);
}

/**
 * Trims one page of signatures (newest first, each with its slot) to `floorSlot` and above. `done` is true once
 * an older entry was seen, so paging can stop. Without a floor everything is kept.
 */
export function limitToSlot<T extends { slot: number }>(page: T[], floorSlot: number | null | undefined): { kept: T[]; done: boolean } {
  if (!floorSlot) return { kept: page, done: false };
  const kept = page.filter((p) => p.slot >= floorSlot);
  return { kept, done: kept.length < page.length };
}

export const pendingLamports = (s: ForfeitState): bigint => BigInt(s.totalForfeited) - BigInt(s.totalConverted);

/**
 * Folds a scan into the state. `txs` is newest -> oldest, exactly what the signature scan returned
 * (everything newer than the previous cursor). Only successful transactions count, each signature at most
 * once (already in `processed` is skipped), so re-running, overlapping scans or a lost cursor cannot double count.
 * Throws on a successful transaction whose logs were truncated, rather than guess.
 */
export function applyScan(state: ForfeitState, txs: ScannedTx[], program: string): { state: ForfeitState; events: (ForfeitEvent & { signature: string })[] } {
  const seen = new Set(state.processed);
  const events: (ForfeitEvent & { signature: string })[] = [];
  const fresh: string[] = [];
  let total = BigInt(state.totalForfeited);
  for (const tx of txs) {
    if (seen.has(tx.signature)) continue;
    seen.add(tx.signature);
    fresh.push(tx.signature);
    if (tx.err !== null && tx.err !== undefined) continue;
    const { events: evs, truncated } = parseForfeitEvents(tx.logs ?? [], program);
    if (truncated) throw new Error(`logs of ${tx.signature} are truncated; cannot read its events safely`);
    for (const e of evs) { total += e.lamports; events.push({ ...e, signature: tx.signature }); }
  }
  return {
    events,
    state: {
      ...state,
      cursor: txs.length > 0 ? txs[0].signature : state.cursor,
      totalForfeited: total.toString(),
      processed: [...fresh, ...state.processed].slice(0, PROCESSED_CAP),
    },
  };
}

/**
 * Lamports to swap now: never more than what is forfeited and not yet converted, never more than the balance
 * above the fee reserve, and zero below `minSwap` (the remainder carries over to a later run).
 */
export function planConversion(state: ForfeitState, balanceLamports: bigint, reserveLamports: bigint, minSwapLamports: bigint): bigint {
  const pending = pendingLamports(state);
  const spendable = balanceLamports > reserveLamports ? balanceLamports - reserveLamports : 0n;
  const amount = pending < spendable ? pending : spendable;
  return amount >= minSwapLamports && amount > 0n ? amount : 0n;
}

/** Records a completed swap: `lamports` converted, `usdc` received (not yet deposited). */
export function recordSwap(state: ForfeitState, lamports: bigint, usdc: bigint): ForfeitState {
  const converted = BigInt(state.totalConverted) + lamports;
  if (lamports < 0n || converted > BigInt(state.totalForfeited)) throw new Error("refusing to convert more than was forfeited");
  return { ...state, totalConverted: converted.toString(), usdcPendingDeposit: (BigInt(state.usdcPendingDeposit) + usdc).toString() };
}

/** Records a completed deposit of `usdc` (6 dp) out of the pending amount. */
export function recordDeposit(state: ForfeitState, usdc: bigint): ForfeitState {
  const pend = BigInt(state.usdcPendingDeposit);
  return { ...state, usdcPendingDeposit: (usdc >= pend ? 0n : pend - usdc).toString(), totalDepositedUsdc: (BigInt(state.totalDepositedUsdc) + usdc).toString() };
}

const sol = (l: bigint) => (Number(l) / 1e9).toString();
export function summaryLine(state: ForfeitState, depositedUsdc: bigint, tx: string | null): string {
  return `forfeited SOL: ${sol(BigInt(state.totalForfeited))} total, ${sol(BigInt(state.totalConverted))} converted, ${sol(pendingLamports(state))} pending`
    + ` → deposited ${Number(depositedUsdc) / 1e6} USDC as treasury-owned liquidity (tx ${tx ?? "none"})`;
}
