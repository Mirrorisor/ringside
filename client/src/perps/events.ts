/**
 * Decodes the perps program's events from transaction logs. Pure: no network, no DOM.
 *
 * IDL events used: `PositionChanged` (execute_order increase, lib.rs:434) is an open or increase;
 * `PositionClosed` with reason 0 (lib.rs:445) is a close. Reasons 1 (liquidation) and 2 (ADL) are
 * keeper actions, not leader decisions, and are not emitted as copyable events.
 * `MarketCreated`, `OrderRejected` and `BudgetExhausted` are ignored.
 *
 * Only `Program data:` lines logged while the perps program is the running program count: other
 * programs cannot spoof an event by logging the same bytes.
 */
import { PerpsCoders, perpsCoders } from "./accounts.js";
import type { Idl } from "./anchor.js";
import type { PerpEvent } from "../copy/ports.js";

/** An RPC `getTransaction` result, or any object with the same fields. */
export interface TxLogs {
  signature?: string;
  slot?: number;
  blockTime?: number | null;
  transaction?: { signatures?: string[] };
  meta?: { err?: unknown; logMessages?: string[] | null } | null;
  /** Alternative to meta.logMessages. */
  logMessages?: string[];
}
export interface DecodeOptions {
  /** Event market -> mint. Events for a market that does not resolve are dropped (a PerpEvent needs the mint). */
  mintOf: (market: string) => string | undefined;
  coders?: PerpsCoders;
}

export interface RawPerpEvent { name: string; data: Record<string, any>; }

const INVOKE = /^Program (\S+) invoke \[\d+\]$/;
const EXIT = /^Program (\S+) (success|failed: .*)$/;
const DATA = "Program data: ";

/** Base64 payloads logged by `programId` (outermost invoke or CPI), in order. */
export function programDataLines(logs: string[], programId: string): string[] {
  const stack: string[] = [], out: string[] = [];
  for (const l of logs) {
    let m = INVOKE.exec(l);
    if (m) { stack.push(m[1]); continue; }
    if (EXIT.test(l)) { stack.pop(); continue; }
    if (l.startsWith(DATA) && stack[stack.length - 1] === programId) out.push(l.slice(DATA.length).trim());
  }
  return out;
}

export function decodeRawEvents(idl: Idl, logs: string[], coders: PerpsCoders = perpsCoders(idl)): RawPerpEvent[] {
  const out: RawPerpEvent[] = [];
  for (const b64 of programDataLines(logs, idl.address)) {
    let ev: ReturnType<PerpsCoders["events"]["decode"]> = null;
    try { ev = coders.events.decode(b64); } catch { /* not one of ours */ }
    if (ev) out.push({ name: ev.name, data: ev.data as Record<string, any> });
  }
  return out;
}

const USDC = 1_000_000;
/**
 * Turns a confirmed transaction's logs into copyable PerpEvents. A failed transaction yields none.
 * `PositionChanged` carries no previous size, so `prevSizeUsd` is left unset and the copy engine tracks it.
 * For an open, sizeUsd is the event's `size_usd` (for an increase, the position's total after the fill) and
 * leverage is that size over the collateral after the fee. For a close sizeUsd is 0 and leverage 1.
 */
export function decodePerpEvents(idl: Idl, tx: TxLogs, opts: DecodeOptions): PerpEvent[] {
  if (tx.meta?.err) return [];
  const logs = tx.meta?.logMessages ?? tx.logMessages ?? [];
  const signature = tx.signature ?? tx.transaction?.signatures?.[0];
  if (!signature) return [];
  const out: PerpEvent[] = [];
  for (const { name, data } of decodeRawEvents(idl, logs, opts.coders)) {
    if (name !== "PositionChanged" && !(name === "PositionClosed" && Number(data.reason) === 0)) continue;
    const market = String(data.market), mint = opts.mintOf(market);
    if (!mint) continue;
    const open = name === "PositionChanged";
    // The event coder keeps the IDL's snake_case field names.
    const size = open ? Number(data.size_usd.toString()) / USDC : 0; // a close event carries realized pnl and payout, not a size
    const col = open ? Number(data.collateral.toString()) / USDC : 0;
    out.push({
      leader: String(data.owner), market, mint, side: Number(data.side) === 1 ? "short" : "long",
      sizeUsd: size, leverage: open && col > 0 ? size / col : 1,
      signature, slot: tx.slot ?? 0, timestamp: tx.blockTime ?? 0, action: open ? "open" : "close",
    });
  }
  return out;
}
