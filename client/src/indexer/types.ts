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
  /**
   * Set only by `normalizeTransaction` for the parsed-events format, which names signers in its
   * decoded instruction accounts. When present, a trader must be one of these. Never read from an
   * incoming enhanced transaction (the normaliser clears it).
   */
  signers?: string[];
}

/**
 * Helius parsed-events format (https://www.helius.dev/docs/parsed-events/parsed-response.md): one item of
 * `POST /v1/parsed-events/transactions` or `transaction-history`. Differences from enhanced transactions:
 * the transaction sits under `parsed`, `timestamp` is `parsed.blockTime`, `type` and `description` move under
 * `parsed.summary` (nullable), token transfers carry `rawTokenAmount` (raw integer) plus `decimals` instead of
 * a pre-scaled `tokenAmount`, and instructions are a flat decoded list. Every field is untrusted.
 */
export interface HeliusParsedTokenTransfer {
  fromUserAccount?: string | null;
  toUserAccount?: string | null;
  fromTokenAccount?: string | null;
  toTokenAccount?: string | null;
  rawTokenAmount?: number | string;
  decimals?: number;
  tokenStandard?: string;
  mint?: string;
}
export interface HeliusParsedSummary { type?: string; description?: string; parsedData?: { protocol?: string; [k: string]: unknown } | null }
export interface HeliusParsedInstruction {
  instructionIndex?: number;
  innerInstructionIndex?: number | null;
  programId?: string;
  rawAccounts?: string[];
  rawData?: string;
  summary?: HeliusParsedSummary | null;
  programName?: string | null;
  instructionName?: string | null;
  decoded?: { args?: unknown; accounts?: { name?: string; pubkey?: string; isSigner?: boolean; isWritable?: boolean }[] } | null;
}
export interface HeliusParsedTransaction {
  slot?: number;
  blockTime?: number | null;
  fee?: number;
  feePayer?: string | null;
  transactionStatus?: string;
  error?: unknown;
  nativeTransfers?: HeliusNativeTransfer[];
  tokenTransfers?: HeliusParsedTokenTransfer[];
  summary?: HeliusParsedSummary | null;
  instructions?: HeliusParsedInstruction[];
}
export interface HeliusParsedEvent {
  signature: string;
  parserStatus?: string;
  parsed?: HeliusParsedTransaction;
  parserError?: unknown;
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
