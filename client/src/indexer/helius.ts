/**
 * Helius enhanced-transaction parsing: turns one webhook transaction into
 * normalised trades, plain SOL transfers and (via program hooks) launches.
 *
 * Swap legs come from `events.swap` when Helius fills it in, else from the
 * fee payer's net `tokenTransfers` / `nativeTransfers`. Wrapped SOL counts
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

function swapWallet(s: HeliusSwapEvent): string | undefined {
  return [s.nativeInput?.account, s.nativeOutput?.account, s.tokenInputs?.[0]?.userAccount, s.tokenOutputs?.[0]?.userAccount].find(isAddress);
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

/** Parses one swap into at most one trade (or null). Exposed for tests. */
export function parseSwap(tx: HeliusEnhancedTransaction): Trade | null {
  const base = { signature: tx.signature, slot: tx.slot!, timestamp: tx.timestamp!, source: typeof tx.source === "string" && tx.source ? tx.source.slice(0, 64) : "UNKNOWN" };
  const ev = tx.events?.swap;
  if (ev && typeof ev === "object") {
    const wallet = swapWallet(ev);
    if (wallet) {
      const t = tradeFromDeltas(deltasFromSwapEvent(ev), { ...base, wallet });
      if (t) return t;
    }
  }
  if (!isAddress(tx.feePayer)) return null;
  return tradeFromDeltas(deltasFromTransfers(tx, tx.feePayer), { ...base, wallet: tx.feePayer });
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
 * legs to pools are not mistaken for wallet funding.
 */
export function parseTransaction(tx: HeliusEnhancedTransaction, parsers: ProgramParser[] = DEFAULT_PARSERS): ParsedTx | null {
  if (!isValidTx(tx)) return null;
  if (tx.transactionError != null) return null;
  const out: ParsedTx = { signature: tx.signature, slot: tx.slot!, timestamp: tx.timestamp!, trades: [], transfers: [], launches: [] };

  let programTrades: Trade[] | undefined;
  for (const p of parsers) {
    if (!touches(tx.instructions, p.programId)) continue;
    const r = p.parse(tx);
    if (!r) continue;
    if (r.launches) out.launches.push(...r.launches.filter((l) => isAddress(l.mint) && isAddress(l.creator)));
    if (r.trades) (programTrades ??= []).push(...r.trades);
  }
  if (programTrades) out.trades = programTrades;
  else if (SWAP_TYPES.has(tx.type ?? "") || tx.events?.swap) {
    const t = parseSwap(tx);
    if (t) out.trades.push(t);
  }

  if (out.trades.length === 0) {
    for (const n of tx.nativeTransfers ?? []) {
      if (!n || !isAddress(n.fromUserAccount) || !isAddress(n.toUserAccount) || n.fromUserAccount === n.toUserAccount) continue;
      const lamports = num(n.amount);
      if (lamports > 0) out.transfers.push({ signature: tx.signature, from: n.fromUserAccount, to: n.toUserAccount, lamports, slot: out.slot, timestamp: out.timestamp } satisfies SolTransfer);
    }
  }
  return out;
}
