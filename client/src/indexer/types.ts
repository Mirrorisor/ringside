/**
 * Shared shapes for the indexer: the subset of a Helius enhanced transaction
 * we read, and the normalised records we store.
 *
 * Helius payload notes (https://www.helius.dev/docs/webhooks, enhanced
 * transactions): a webhook POST body is a JSON array of enhanced
 * transactions. `nativeTransfers[].amount` is lamports (number);
 * `tokenTransfers[].tokenAmount` is a pre-scaled (UI) decimal number;
 * `events.swap` token legs carry `rawTokenAmount { tokenAmount: string,
 * decimals: number }` and native legs `{ account, amount }` with amount as a
 * lamport string. Every field is treated as optional and untrusted.
 */

export interface HeliusNativeTransfer { fromUserAccount?: string; toUserAccount?: string; amount?: number | string }

export interface HeliusTokenTransfer {
  fromUserAccount?: string | null;
  toUserAccount?: string | null;
  fromTokenAccount?: string | null;
  toTokenAccount?: string | null;
  mint?: string;
  tokenAmount?: number | string;
  tokenStandard?: string;
}

export interface HeliusRawTokenAmount { tokenAmount?: string | number; decimals?: number }
export interface HeliusSwapTokenLeg { userAccount?: string; tokenAccount?: string; mint?: string; rawTokenAmount?: HeliusRawTokenAmount }
export interface HeliusSwapNativeLeg { account?: string; amount?: string | number }

export interface HeliusSwapEvent {
  nativeInput?: HeliusSwapNativeLeg | null;
  nativeOutput?: HeliusSwapNativeLeg | null;
  tokenInputs?: HeliusSwapTokenLeg[];
  tokenOutputs?: HeliusSwapTokenLeg[];
  innerSwaps?: { programInfo?: { source?: string; account?: string; programName?: string; instructionName?: string } }[];
}

export interface HeliusTokenBalanceChange { userAccount?: string; tokenAccount?: string; mint?: string; rawTokenAmount?: HeliusRawTokenAmount }
/** One entry per account key of the transaction, in message order (signers first). */
export interface HeliusAccountData { account?: string; nativeBalanceChange?: number; tokenBalanceChanges?: HeliusTokenBalanceChange[] }

export interface HeliusInstruction { programId?: string; accounts?: string[]; data?: string; innerInstructions?: HeliusInstruction[] }

export interface HeliusEnhancedTransaction {
  signature: string;
  slot?: number;
  timestamp?: number;
  type?: string;
  source?: string;
  fee?: number;
  feePayer?: string;
  description?: string;
  nativeTransfers?: HeliusNativeTransfer[];
  tokenTransfers?: HeliusTokenTransfer[];
  accountData?: HeliusAccountData[];
  instructions?: HeliusInstruction[];
  events?: { swap?: HeliusSwapEvent | null; [k: string]: unknown };
  transactionError?: unknown;
}

export type Side = "buy" | "sell";
export type Quote = "SOL" | "USDC";

/** One wallet's swap of one token against SOL or USDC. Amounts are UI units. */
export interface Trade {
  signature: string;
  wallet: string;
  mint: string;
  side: Side;
  tokenAmount: number;
  quote: Quote;
  /** SOL (not lamports) or USDC spent on a buy / received on a sell. */
  quoteAmount: number;
  slot: number;
  timestamp: number; // unix seconds
  source: string; // Helius `source` label or a program id
}

/** A plain SOL transfer (used for insider funding). */
export interface SolTransfer { signature: string; from: string; to: string; lamports: number; slot: number; timestamp: number }

/** A token launch, e.g. decoded from the Ringside launch program. */
export interface Launch { mint: string; creator: string; slot: number; timestamp: number; signature: string }

/** What one transaction contributes to the index. */
export interface ParsedTx { signature: string; slot: number; timestamp: number; trades: Trade[]; transfers: SolTransfer[]; launches: Launch[] }

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const LAMPORTS_PER_SOL = 1_000_000_000;
