/**
 * Helius enhanced-transaction parsing: turns one webhook transaction into
 * normalised trades, plain SOL transfers and (via program hooks) launches.
 *
 * Swap legs come from `events.swap` when Helius fills it in, else from the
 * trader's net `tokenTransfers` / `nativeTransfers` (see `pickTrader`: the
 * fee payer is not assumed to be the trader, since gasless trades are paid
 * for by our sponsor). Wrapped SOL counts
 * as SOL. A trade is emitted only for a single non-quote mint moving against
 * SOL or USDC in the opposite direction; token-to-token routes and
 * SOL<->USDC swaps are skipped.
 */
import { LAMPORTS_PER_SOL, SOL_MINT, USDC_MINT } from "./types.js";
import type { HeliusEnhancedTransaction, HeliusInstruction, HeliusSwapEvent, Launch, ParsedTx, Quote, SolTransfer, Trade } from "./types.js";

export const RINGSIDE_LAUNCH_PROGRAM = "AfZWCTaDQEC9CVTwXkH7pFtDXs4RtLWCK5godexWQDVH";

const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
/** Deltas smaller than this (UI units) are rounding noise. */
const DUST = 1e-9;

export const isAddress = (s: unknown): s is string => typeof s === "string" && ADDRESS_RE.test(s);
export const isSignature = (s: unknown): s is string => typeof s === "string" && SIGNATURE_RE.test(s);

/** A decoder for one on-chain program's instructions. */
export interface ProgramParser {
  programId: string;
  /**
   * Returns what this program's instructions in `tx` contribute, or null if
   * it decodes nothing. Trades it returns replace the generic swap parse for
   * this transaction (the program decoder is authoritative).
   */
  parse(tx: HeliusEnhancedTransaction): { trades?: Trade[]; launches?: Launch[] } | null;
}

/**
 * Ringside launch program hook.
 * TODO: decode the launch program's instructions (create / buy / sell /
 * graduate) from `tx.instructions[].data` with the program's Anchor IDL and
 * return launches (mint, creator) and bonding-curve trades. Until then it
 * decodes nothing and Ringside curve trades are covered by the generic
 * transfer-based parse.
 */
export const ringsideLaunchParser: ProgramParser = {
  programId: RINGSIDE_LAUNCH_PROGRAM,
  parse(_tx) {
    return null;
  },
};

export const DEFAULT_PARSERS: ProgramParser[] = [ringsideLaunchParser];

/** Helius `type` labels parsed as swaps (some AMMs label legs BUY / SELL). */
export const SWAP_TYPES = new Set(["SWAP", "BUY", "SELL"]);

function touches(ixs: HeliusInstruction[] | undefined, programId: string): boolean {
  if (!Array.isArray(ixs)) return false;
  return ixs.some((ix) => ix?.programId === programId || touches(ix?.innerInstructions, programId));
}

function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

function rawToUi(raw: { tokenAmount?: string | number; decimals?: number } | undefined): number {
  if (!raw) return 0;
  const dec = Number.isInteger(raw.decimals) && raw.decimals! >= 0 && raw.decimals! <= 18 ? raw.decimals! : 0;
  return num(raw.tokenAmount) / 10 ** dec;
}

/** Net UI deltas per mint (SOL under SOL_MINT) for the swapping wallet. */
type Deltas = Map<string, number>;
const add = (d: Deltas, mint: string, x: number) => d.set(mint, (d.get(mint) ?? 0) + x);

/** Parse options. */
export interface ParseOptions {
  /**
   * Our own sponsor / relayer / fee wallets (INDEXER_SPONSOR_ADDRESSES).
   * They are never taken as the trader, and SOL transfers to or from them
   * are not stored (they are gas top-ups and fee recovery, not funding).
   */
  sponsors?: ReadonlySet<string>;
}
const NO_SPONSORS: ReadonlySet<string> = new Set();

function swapWallet(s: HeliusSwapEvent, sponsors: ReadonlySet<string>): string | undefined {
  return [s.nativeInput?.account, s.nativeOutput?.account, s.tokenInputs?.[0]?.userAccount, s.tokenOutputs?.[0]?.userAccount].find((a) => isAddress(a) && !sponsors.has(a));
}

function deltasFromSwapEvent(s: HeliusSwapEvent): Deltas {
  const d: Deltas = new Map();
  if (s.nativeInput) add(d, SOL_MINT, -num(s.nativeInput.amount) / LAMPORTS_PER_SOL);
  if (s.nativeOutput) add(d, SOL_MINT, num(s.nativeOutput.amount) / LAMPORTS_PER_SOL);
  for (const l of s.tokenInputs ?? []) if (isAddress(l?.mint)) add(d, l.mint, -rawToUi(l.rawTokenAmount));
  for (const l of s.tokenOutputs ?? []) if (isAddress(l?.mint)) add(d, l.mint, rawToUi(l.rawTokenAmount));
  return d;
}

function deltasFromTransfers(tx: HeliusEnhancedTransaction, wallet: string): Deltas {
  const d: Deltas = new Map();
  const ownTokenAccounts = new Set<string>();
  for (const t of tx.tokenTransfers ?? []) {
    if (!t || !isAddress(t.mint)) continue;
    const amt = num(t.tokenAmount);
    if (t.toUserAccount === wallet) {
      add(d, t.mint, amt);
      if (t.toTokenAccount) ownTokenAccounts.add(t.toTokenAccount);
    }
    if (t.fromUserAccount === wallet) add(d, t.mint, -amt);
  }
  for (const n of tx.nativeTransfers ?? []) {
    if (!n) continue;
    // Rent paid into the wallet's own new token account is not trade cost.
    if (n.toUserAccount && ownTokenAccounts.has(n.toUserAccount)) continue;
    const sol = num(n.amount) / LAMPORTS_PER_SOL;
    if (n.toUserAccount === wallet) add(d, SOL_MINT, sol);
    if (n.fromUserAccount === wallet) add(d, SOL_MINT, -sol);
  }
  return d;
}

function tradeFromDeltas(d: Deltas, base: Omit<Trade, "mint" | "side" | "tokenAmount" | "quote" | "quoteAmount">): Trade | null {
  const sol = d.get(SOL_MINT) ?? 0;
  const usdc = d.get(USDC_MINT) ?? 0;
  const others = [...d].filter(([m, x]) => m !== SOL_MINT && m !== USDC_MINT && Math.abs(x) > DUST);
  if (others.length !== 1) return null;
  const [mint, tokenDelta] = others[0];
  let quote: Quote;
  let quoteDelta: number;
  if (Math.abs(sol) > DUST && Math.sign(sol) !== Math.sign(tokenDelta)) [quote, quoteDelta] = ["SOL", sol];
  else if (Math.abs(usdc) > DUST && Math.sign(usdc) !== Math.sign(tokenDelta)) [quote, quoteDelta] = ["USDC", usdc];
  else return null;
  return { ...base, mint, side: tokenDelta > 0 ? "buy" : "sell", tokenAmount: Math.abs(tokenDelta), quote, quoteAmount: Math.abs(quoteDelta) };
}

/**
 * The trader of a transfer-parsed swap: a wallet whose token balance changed
 * and that signed, never a configured sponsor.
 *
 * Enhanced transactions carry no signer list, so signing is inferred:
 *  - a candidate must have a net non-quote token delta that forms a trade
 *    and must show authority over the transaction: it is the fee payer, or
 *    it is the source of a token or SOL transfer (spending needs its
 *    signature; a pool's PDA also "spends", via the program, hence the next);
 *  - the fee payer wins if it qualifies (ordinary, self-paid trades);
 *  - otherwise the candidate listed first in `accountData` wins: it mirrors
 *    the message's account keys, which put all signers before any
 *    non-signer, so a signing user precedes the pool's accounts;
 *  - with no `accountData` only a single candidate is accepted; an
 *    ambiguous transaction yields no trade rather than a wrong trader.
 */
export function pickTrader(tx: HeliusEnhancedTransaction, sponsors: ReadonlySet<string> = NO_SPONSORS): string | undefined {
  const tokenDelta = new Map<string, number>();
  const spent = new Set<string>();
  for (const t of tx.tokenTransfers ?? []) {
    if (!t || !isAddress(t.mint) || t.mint === SOL_MINT || t.mint === USDC_MINT) continue;
    const amt = num(t.tokenAmount);
    if (isAddress(t.toUserAccount)) tokenDelta.set(t.toUserAccount, (tokenDelta.get(t.toUserAccount) ?? 0) + amt);
    if (isAddress(t.fromUserAccount)) tokenDelta.set(t.fromUserAccount, (tokenDelta.get(t.fromUserAccount) ?? 0) - amt);
  }
  for (const t of tx.tokenTransfers ?? []) if (t && isAddress(t.fromUserAccount)) spent.add(t.fromUserAccount);
  for (const n of tx.nativeTransfers ?? []) if (n && isAddress(n.fromUserAccount)) spent.add(n.fromUserAccount);
  const feePayer = isAddress(tx.feePayer) ? tx.feePayer : undefined;
  const base = { signature: tx.signature, slot: 0, timestamp: 0, source: "" };
  const candidates: string[] = [];
  for (const [w, d] of tokenDelta) {
    if (sponsors.has(w) || !(Math.abs(d) > DUST)) continue;
    if (w !== feePayer && !spent.has(w)) continue;
    if (tradeFromDeltas(deltasFromTransfers(tx, w), { ...base, wallet: w })) candidates.push(w);
  }
  if (feePayer && candidates.includes(feePayer)) return feePayer;
  if (candidates.length <= 1) return candidates[0];
  const order = new Map<string, number>();
  (tx.accountData ?? []).forEach((a, i) => { if (a && isAddress(a.account) && !order.has(a.account)) order.set(a.account, i); });
  let best: string | undefined;
  for (const c of candidates) {
    const i = order.get(c);
    if (i !== undefined && (best === undefined || i < order.get(best)!)) best = c;
  }
  return best;
}

/** Parses one swap into at most one trade (or null). Exposed for tests. */
export function parseSwap(tx: HeliusEnhancedTransaction, opts: ParseOptions = {}): Trade | null {
  const sponsors = opts.sponsors ?? NO_SPONSORS;
  const base = { signature: tx.signature, slot: tx.slot!, timestamp: tx.timestamp!, source: typeof tx.source === "string" && tx.source ? tx.source.slice(0, 64) : "UNKNOWN" };
  const ev = tx.events?.swap;
  if (ev && typeof ev === "object") {
    const wallet = swapWallet(ev, sponsors);
    if (wallet) {
      const t = tradeFromDeltas(deltasFromSwapEvent(ev), { ...base, wallet });
      if (t) return t;
    }
  }
  const wallet = pickTrader(tx, sponsors);
  if (!wallet) return null;
  return tradeFromDeltas(deltasFromTransfers(tx, wallet), { ...base, wallet });
}

/** Rejects anything without a valid signature, slot and timestamp. */
export function isValidTx(tx: unknown): tx is HeliusEnhancedTransaction {
  if (!tx || typeof tx !== "object") return false;
  const t = tx as HeliusEnhancedTransaction;
  return isSignature(t.signature) && Number.isSafeInteger(t.slot) && t.slot! >= 0 && Number.isSafeInteger(t.timestamp) && t.timestamp! > 0;
}

/**
 * Parses one enhanced transaction. Failed transactions return null. SOL
 * transfers are kept only from transactions that are not trades, so swap
 * legs to pools are not mistaken for wallet funding; transfers touching a
 * configured sponsor are dropped (gas top-ups and fee recovery).
 */
export function parseTransaction(tx: HeliusEnhancedTransaction, parsers: ProgramParser[] = DEFAULT_PARSERS, opts: ParseOptions = {}): ParsedTx | null {
  const sponsors = opts.sponsors ?? NO_SPONSORS;
  if (!isValidTx(tx)) return null;
  if (tx.transactionError != null) return null;
  const out: ParsedTx = { signature: tx.signature, slot: tx.slot!, timestamp: tx.timestamp!, trades: [], transfers: [], launches: [] };

  let programTrades: Trade[] | undefined;
  for (const p of parsers) {
    if (!touches(tx.instructions, p.programId)) continue;
    const r = p.parse(tx);
    if (!r) continue;
    for (const l of r.launches ?? []) if (isAddress(l.mint) && isAddress(l.creator)) out.launches.push(l);
    if (r.trades) {
      programTrades ??= [];
      for (const t of r.trades) programTrades.push(t);
    }
  }
  if (programTrades) out.trades = programTrades;
  else if (SWAP_TYPES.has(tx.type ?? "") || tx.events?.swap) {
    const t = parseSwap(tx, opts);
    if (t) out.trades.push(t);
  }

  if (out.trades.length === 0) {
    for (const n of tx.nativeTransfers ?? []) {
      if (!n || !isAddress(n.fromUserAccount) || !isAddress(n.toUserAccount) || n.fromUserAccount === n.toUserAccount) continue;
      if (sponsors.has(n.fromUserAccount) || sponsors.has(n.toUserAccount)) continue;
      const lamports = num(n.amount);
      if (lamports > 0) out.transfers.push({ signature: tx.signature, from: n.fromUserAccount, to: n.toUserAccount, lamports, slot: out.slot, timestamp: out.timestamp } satisfies SolTransfer);
    }
  }
  return out;
}
