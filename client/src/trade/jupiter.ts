/**
 * Jupiter trade layer: Swap V2 (order + execute), Trigger V2 (price and DCA
 * orders), Tokens V2 search and Price V3.
 *
 * Every endpoint lives under https://api.jup.ag and needs an `x-api-key`
 * header (env JUPITER_API_KEY, or the `apiKey` option). `fetch` is injectable
 * so tests never touch the network.
 *
 * Safety: we never sign a transaction Jupiter hands back without first
 * decoding it and checking that the fee payer is who we expect and that the
 * wallet we sign for is one of its required signers. Our signer only ever
 * adds its own signature.
 *
 * Shapes follow https://developers.jup.ag/docs (checked 2026-11-26). Anything
 * the docs leave open is marked ASSUMPTION.
 *
 * ---------------------------------------------------------------------------
 * Referral fees: setup notes
 * ---------------------------------------------------------------------------
 * - Range is 50 to 255 bps. Jupiter keeps 20% of the referral fee (and charges
 *   no separate platform fee when a referral is active), so 50 bps nets us 40
 *   bps: see `netReferralBps`.
 * - Create the referral account once, with `@jup-ag/referral-sdk` (a dev-time
 *   script, not a dependency of this client) or at https://referral.jup.ag/:
 *     const provider = new ReferralProvider(connection);
 *     const { tx, referralAccountPubKey } = await provider.initializeReferralAccountWithName({
 *       payerPubKey: wallet.publicKey, partnerPubKey: wallet.publicKey,
 *       projectPubKey: new PublicKey("DkiqsTrw1u1bYFumumC7sCG2S8K25qc2vemJFHyW2wJc"), // Jupiter Ultra/Swap project
 *       name: "ringside",
 *     });
 *     await sendAndConfirmTransaction(connection, tx, [wallet]);
 * - Then create one referral token account per fee mint we expect to collect
 *   in (start with wSOL and USDC):
 *     const { tx, tokenAccount } = await provider.initializeReferralTokenAccountV2({
 *       payerPubKey: wallet.publicKey, referralAccountPubKey, mint,
 *     });
 * - Jupiter picks the fee mint from its priority list. If our referral token
 *   account for that `feeMint` does not exist, the order still succeeds but we
 *   collect nothing, so watch `feeMint` / `feeBps` on order responses.
 * - Put the referral account in env JUPITER_REFERRAL_ACCOUNT, or pass
 *   `referralAccount` to the constructor.
 */
import {
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  isAddress,
  type Address,
  type MessagePartialSigner,
  type Transaction,
  type TransactionPartialSigner,
} from "@solana/kit";

export const JUPITER_API = "https://api.jup.ag";

// ---------------------------------------------------------------------------
// Referral fee maths
// ---------------------------------------------------------------------------

export const REFERRAL_FEE_MIN_BPS = 50;
export const REFERRAL_FEE_MAX_BPS = 255;
export const DEFAULT_REFERRAL_FEE_BPS = 50;
/** Jupiter's share of the referral fee, in bps of the fee (20%). */
export const JUPITER_REFERRAL_SHARE_BPS = 2_000;

export function assertReferralFee(feeBps: number): void {
  if (!Number.isInteger(feeBps) || feeBps < REFERRAL_FEE_MIN_BPS || feeBps > REFERRAL_FEE_MAX_BPS) {
    throw new JupiterError(0, "referral_fee", `Referral fee must be an integer from ${REFERRAL_FEE_MIN_BPS} to ${REFERRAL_FEE_MAX_BPS} bps, got ${feeBps}.`);
  }
}

/** What we keep of a referral fee after Jupiter's 20%: 50 bps → 40, 255 → 204. */
export function netReferralBps(feeBps: number): number {
  assertReferralFee(feeBps);
  return (feeBps * (10_000 - JUPITER_REFERRAL_SHARE_BPS)) / 10_000;
}

// ---------------------------------------------------------------------------
// Errors and HTTP
// ---------------------------------------------------------------------------

/** `status` is the HTTP status, or 0 for a check that failed on our side. */
export class JupiterError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = "JupiterError";
  }
}

export interface JupiterOptions {
  /** Defaults to env JUPITER_API_KEY. Read when a request is made. */
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Our referral account. Defaults to env JUPITER_REFERRAL_ACCOUNT. `null` turns fees off. */
  referralAccount?: string | null;
  referralFeeBps?: number;
}

type Query = Record<string, string | number | boolean | undefined>;

class Http {
  private fetchImpl: typeof fetch;
  constructor(private opts: JupiterOptions) {
    this.fetchImpl = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  }

  async request<T>(method: "GET" | "POST" | "PATCH", path: string, o: { query?: Query; body?: unknown; bearer?: string } = {}): Promise<T> {
    const apiKey = this.opts.apiKey ?? process.env.JUPITER_API_KEY;
    if (!apiKey) throw new JupiterError(0, "no_api_key", "Set JUPITER_API_KEY or pass apiKey.");
    const url = new URL((this.opts.baseUrl ?? JUPITER_API).replace(/\/$/, "") + path);
    for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { "x-api-key": apiKey, accept: "application/json" };
    if (o.body !== undefined) headers["content-type"] = "application/json";
    if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;

    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      });
    } catch (e) {
      throw new JupiterError(0, "network", `Jupiter ${method} ${path} failed: ${(e as Error).message}`);
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      const b = (body ?? {}) as { error?: unknown; message?: unknown; code?: unknown };
      const msg = String(b.error ?? b.message ?? text ?? res.statusText).slice(0, 300);
      throw new JupiterError(res.status, b.code !== undefined ? String(b.code) : `http_${res.status}`, `Jupiter ${method} ${path}: ${msg}`, body);
    }
    if (body === undefined) throw new JupiterError(res.status, "bad_json", `Jupiter ${method} ${path} returned no JSON.`);
    return body as T;
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function addr(v: unknown, name: string): Address {
  if (typeof v !== "string" || !isAddress(v)) throw new JupiterError(0, "bad_address", `${name} is not a valid address.`);
  return v;
}

function units(v: unknown, name: string): string {
  const s = typeof v === "bigint" ? v.toString() : typeof v === "number" && Number.isSafeInteger(v) ? String(v) : v;
  if (typeof s !== "string" || !/^[0-9]+$/.test(s) || BigInt(s) <= 0n) throw new JupiterError(0, "bad_amount", `${name} must be a positive integer in base units.`);
  return BigInt(s).toString();
}

function intIn(v: number | undefined, lo: number, hi: number, name: string): number | undefined {
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || v < lo || v > hi) throw new JupiterError(0, "bad_param", `${name} must be an integer from ${lo} to ${hi}.`);
  return v;
}

function usd(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new JupiterError(0, "bad_param", `${name} must be a positive USD price.`);
  return v;
}

/** Address of `x`, whether it is a signer or a bare address. */
const addressOf = (x: { address: Address } | Address): Address => (typeof x === "string" ? x : x.address);

// ---------------------------------------------------------------------------
// Transaction checks and signing
// ---------------------------------------------------------------------------

export interface TxInspection {
  tx: Transaction;
  feePayer: Address;
  requiredSigners: Address[];
  version: "legacy" | 0 | 1;
}

/** Decode a base64 wire transaction and read its fee payer and required signers. */
export function inspectTransaction(wireBase64: string): TxInspection {
  try {
    const tx = getTransactionDecoder().decode(Buffer.from(wireBase64, "base64"));
    const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const n = msg.header.numSignerAccounts;
    if (n < 1 || msg.staticAccounts.length < n) throw new Error("no signers");
    return { tx, feePayer: msg.staticAccounts[0], requiredSigners: msg.staticAccounts.slice(0, n), version: msg.version };
  } catch (e) {
    throw new JupiterError(0, "malformed_tx", `Could not decode the transaction: ${(e as Error).message}`);
  }
}

/**
 * Check a transaction from Jupiter, then add our signatures.
 * - The fee payer must be one of `feePayers`.
 * - Every address in `mustSign` must be a required signer.
 * - Each signer in `signers` signs only if it is a required signer (match by
 *   key, not position: Jupiter's signer order varies between quotes).
 */
export async function checkAndSign(
  wireBase64: string,
  o: { feePayers: Address[]; mustSign: Address[]; signers: TransactionPartialSigner[] },
): Promise<{ signedTransaction: string; inspection: TxInspection }> {
  const ins = inspectTransaction(wireBase64);
  if (!o.feePayers.includes(ins.feePayer)) {
    throw new JupiterError(0, "fee_payer", `Unexpected fee payer ${ins.feePayer}; expected ${o.feePayers.join(" or ")}.`);
  }
  for (const a of o.mustSign) {
    if (!ins.requiredSigners.includes(a)) throw new JupiterError(0, "not_a_signer", `${a} is not a required signer of this transaction.`);
  }
  let tx = ins.tx;
  for (const s of o.signers) {
    if (!ins.requiredSigners.includes(s.address)) continue;
    const [dict] = await s.signTransactions([tx as never]);
    const sig = dict?.[s.address];
    if (!sig) throw new JupiterError(0, "sign_failed", `Signer ${s.address} returned no signature.`);
    tx = { ...tx, signatures: { ...tx.signatures, [s.address]: sig } };
  }
  return { signedTransaction: getBase64EncodedWireTransaction(tx), inspection: ins };
}

// ---------------------------------------------------------------------------
// Swap V2 types
// ---------------------------------------------------------------------------

export type Router = "metis" | "jupiterz" | "dflow" | "okx";

export interface OrderRequest {
  inputMint: string;
  outputMint: string;
  /** Input amount in base units (ExactIn is the only mode). */
  amount: bigint | string | number;
  /** Omit for a quote with no transaction. Required to execute. */
  taker?: string;
  /** 0–10000. Omit to let Jupiter pick. */
  slippageBps?: number;
  /** Overrides the client default; `null` turns the referral fee off for this order. */
  referralAccount?: string | null;
  /** 50–255. Defaults to the client's, else 50. */
  referralFeeBps?: number;
  /** Integrator wallet that pays fees and rent (gasless for the taker). Ignored by Jupiter when equal to taker. */
  payer?: string;
  receiver?: string;
  priorityFeeLamports?: number;
  jitoTipLamports?: number;
  broadcastFeeType?: "maxCap" | "exactFee";
  excludeRouters?: Router[];
  excludeDexes?: string[];
  maxSupportedTransactionVersion?: 0 | 1;
}

export interface RoutePlanStep {
  swapInfo: { ammKey: string; label: string; inputMint: string; outputMint: string; inAmount: string; outAmount: string };
  percent: number;
  bps: number;
  usdValue?: number;
}

export interface SwapOrder {
  mode?: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  inUsdValue?: number;
  outUsdValue?: number;
  /** Percentage points. */
  priceImpact?: number;
  swapUsdValue?: number;
  otherAmountThreshold: string;
  swapMode?: string;
  slippageBps: number;
  routePlan?: RoutePlanStep[];
  referralAccount?: string;
  feeMint?: string;
  feeBps?: number;
  platformFee?: { amount: string; feeBps: number; feeMint: string };
  signatureFeeLamports?: number;
  signatureFeePayer?: string | null;
  prioritizationFeeLamports?: number;
  prioritizationFeePayer?: string | null;
  rentFeeLamports?: number;
  rentFeePayer?: string | null;
  router?: Router;
  transactionVersion?: 0 | 1;
  /** Base64, unsigned. Null without a taker; "" when the build failed (see errorCode). */
  transaction: string | null;
  lastValidBlockHeight?: string;
  gasless?: boolean;
  requestId: string;
  totalTime?: number;
  taker?: string | null;
  quoteId?: string;
  maker?: string;
  expireAt?: string;
  errorCode?: number;
  errorMessage?: string;
  error?: string;
}

export interface ExecuteResult {
  status: "Success" | "Failed";
  signature?: string;
  slot?: string;
  error?: string;
  /** 0 on success. */
  code: number;
  totalInputAmount?: string;
  totalOutputAmount?: string;
  inputAmountResult?: string;
  outputAmountResult?: string;
  swapEvents?: { inputMint: string; inputAmount: string; outputMint: string; outputAmount: string }[];
}

export interface SignOrderOptions {
  taker: TransactionPartialSigner;
  /** The integrator payer the order was requested with: its signer, so we can co-sign, or just its address if it signs elsewhere. */
  payer?: TransactionPartialSigner | Address;
  /** When given, the order must echo these back. */
  expect?: { inputMint: string; outputMint: string; amount: bigint | string | number };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class Jupiter {
  readonly trigger: JupiterTrigger;
  private http: Http;

  constructor(private opts: JupiterOptions = {}) {
    this.http = new Http(opts);
    this.trigger = new JupiterTrigger(this.http);
    const fee = opts.referralFeeBps;
    if (fee !== undefined) assertReferralFee(fee);
  }

  private referral(req: OrderRequest): { referralAccount?: string; referralFee?: number } {
    const account = req.referralAccount !== undefined ? req.referralAccount : this.opts.referralAccount !== undefined ? this.opts.referralAccount : process.env.JUPITER_REFERRAL_ACCOUNT;
    if (!account) {
      if (req.referralFeeBps !== undefined) throw new JupiterError(0, "referral_account", "referralFeeBps needs a referralAccount.");
      return {};
    }
    const fee = req.referralFeeBps ?? this.opts.referralFeeBps ?? DEFAULT_REFERRAL_FEE_BPS;
    assertReferralFee(fee);
    return { referralAccount: addr(account, "referralAccount"), referralFee: fee };
  }

  /** GET /swap/v2/order. */
  async getOrder(req: OrderRequest): Promise<SwapOrder> {
    const inputMint = addr(req.inputMint, "inputMint");
    const outputMint = addr(req.outputMint, "outputMint");
    if (inputMint === outputMint) throw new JupiterError(0, "same_mint", "inputMint and outputMint must differ.");
    const taker = req.taker === undefined ? undefined : addr(req.taker, "taker");
    const payer = req.payer === undefined ? undefined : addr(req.payer, "payer");
    const receiver = req.receiver === undefined ? undefined : addr(req.receiver, "receiver");
    if (receiver && receiver === taker) throw new JupiterError(0, "bad_param", "receiver must differ from taker.");
    const q: Query = {
      inputMint,
      outputMint,
      amount: units(req.amount, "amount"),
      taker,
      slippageBps: intIn(req.slippageBps, 0, 10_000, "slippageBps"),
      ...this.referral(req),
      payer,
      receiver,
      priorityFeeLamports: intIn(req.priorityFeeLamports, 0, Number.MAX_SAFE_INTEGER, "priorityFeeLamports"),
      jitoTipLamports: intIn(req.jitoTipLamports, 0, Number.MAX_SAFE_INTEGER, "jitoTipLamports"),
      broadcastFeeType: req.broadcastFeeType,
      excludeRouters: req.excludeRouters?.length ? req.excludeRouters.join(",") : undefined,
      excludeDexes: req.excludeDexes?.length ? req.excludeDexes.join(",") : undefined,
      maxSupportedTransactionVersion: req.maxSupportedTransactionVersion === undefined ? undefined : String(req.maxSupportedTransactionVersion),
    };
    return this.http.request<SwapOrder>("GET", "/swap/v2/order", { query: q });
  }

  /**
   * Check an order's transaction and sign it as the taker (and the payer, if
   * we hold its key and it is a required signer).
   *
   * Expected fee payer: the integrator `payer` when one differs from the
   * taker, else the taker. On a JupiterZ (RFQ) route the market maker pays
   * the fee instead, so `order.maker` is also accepted there.
   */
  async signOrder(order: SwapOrder, o: SignOrderOptions): Promise<string> {
    if (!order.transaction) {
      throw new JupiterError(0, "no_transaction", `Order has no transaction${order.errorCode !== undefined ? ` (router ${order.router}, errorCode ${order.errorCode}: ${order.errorMessage ?? order.error ?? ""})` : ""}.`, order);
    }
    const taker = o.taker.address;
    if (order.taker && order.taker !== taker) throw new JupiterError(0, "taker", `Order is for taker ${order.taker}, not ${taker}.`);
    if (o.expect) {
      if (order.inputMint !== o.expect.inputMint || order.outputMint !== o.expect.outputMint) throw new JupiterError(0, "order_mismatch", "Order mints differ from the request.");
      if (order.inAmount !== units(o.expect.amount, "amount")) throw new JupiterError(0, "order_mismatch", "Order inAmount differs from the request.");
    }
    const payer = o.payer === undefined ? undefined : addressOf(o.payer);
    const feePayers: Address[] = [payer && payer !== taker ? payer : taker];
    // ASSUMPTION: on JupiterZ routes the fee payer is the `maker` in the order
    // response. Docs say "the market maker is the transaction fee payer" but
    // don't name the field; `maker` is the only candidate.
    if (order.router === "jupiterz" && order.maker && isAddress(order.maker)) feePayers.push(order.maker);
    const signers = [o.taker, ...(o.payer && typeof o.payer !== "string" ? [o.payer] : [])];
    const { signedTransaction } = await checkAndSign(order.transaction, { feePayers, mustSign: [taker], signers });
    return signedTransaction;
  }

  /** POST /swap/v2/execute. Returns the result as is, including `status: "Failed"`. */
  async execute(signedTransaction: string, requestId: string, lastValidBlockHeight?: string): Promise<ExecuteResult> {
    if (!signedTransaction || !requestId) throw new JupiterError(0, "bad_param", "signedTransaction and requestId are required.");
    return this.http.request<ExecuteResult>("POST", "/swap/v2/execute", { body: { signedTransaction, requestId, ...(lastValidBlockHeight ? { lastValidBlockHeight } : {}) } });
  }

  /** Order, check and sign, execute. */
  async swap(req: Omit<OrderRequest, "taker" | "payer"> & { taker: TransactionPartialSigner; payer?: TransactionPartialSigner | Address }) {
    const order = await this.getOrder({ ...req, taker: req.taker.address, payer: req.payer === undefined ? undefined : addressOf(req.payer) });
    const signed = await this.signOrder(order, { taker: req.taker, payer: req.payer, expect: req });
    const result = await this.execute(signed, order.requestId);
    return { order, result };
  }

  // -------------------------------------------------------------------------
  // Tokens V2 and Price V3
  // -------------------------------------------------------------------------

  /**
   * GET /tokens/v2/search. `query` is a symbol, name or mint, or a list of up
   * to 100 mints. Name/symbol searches return at most 20 results.
   * `minOrganicScore` (0–100) filters the results on our side.
   */
  async searchTokens(query: string | string[], o: { minOrganicScore?: number } = {}): Promise<TokenInfo[]> {
    let q: string;
    if (Array.isArray(query)) {
      if (query.length === 0 || query.length > 100) throw new JupiterError(0, "bad_param", "Pass 1 to 100 mints.");
      q = [...new Set(query.map((m) => addr(m, "mint")))].join(",");
    } else {
      q = query.trim();
      if (!q || q.length > 200) throw new JupiterError(0, "bad_param", "Search query must be 1 to 200 characters.");
    }
    const out = await this.http.request<TokenInfo[]>("GET", "/tokens/v2/search", { query: { query: q } });
    if (!Array.isArray(out)) throw new JupiterError(0, "bad_response", "Token search did not return a list.");
    const min = o.minOrganicScore;
    return min === undefined ? out : out.filter((t) => typeof t.organicScore === "number" && t.organicScore >= min);
  }

  /** GET /price/v3?ids=… for up to 50 mints. Mints Jupiter cannot price are absent from the result. */
  async getPrices(mints: string[]): Promise<Record<string, PriceInfo>> {
    const ids = [...new Set(mints.map((m) => addr(m, "mint")))];
    if (ids.length === 0 || ids.length > 50) throw new JupiterError(0, "bad_param", "Pass 1 to 50 mints.");
    // Docs give the path as "/" under the https://api.jup.ag/price/v3 server.
    return this.http.request<Record<string, PriceInfo>>("GET", "/price/v3/", { query: { ids: ids.join(",") } });
  }
}

export interface TokenInfo {
  id: string;
  name: string;
  symbol: string;
  decimals: number;
  /** 0–100. */
  organicScore: number;
  organicScoreLabel?: "high" | "medium" | "low";
  isVerified?: boolean | null;
  usdPrice?: number | null;
  tags?: string[] | null;
  audit?: {
    /** Present only when flagged: test for the key, not the value. */
    isSus?: boolean | null;
    mintAuthorityDisabled?: boolean | null;
    freezeAuthorityDisabled?: boolean | null;
    topHoldersPercentage?: number | null;
    devBalancePercentage?: number | null;
    devMints?: number | null;
  } | null;
  [k: string]: unknown;
}

export interface PriceInfo {
  usdPrice: number;
  blockId: number | null;
  decimals: number;
  /** Percent. */
  priceChange24h: number | null;
  liquidity: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Trigger V2
// ---------------------------------------------------------------------------

/** A wallet signer that can sign both the auth challenge and transactions (a KeyPairSigner does). */
export type WalletSigner = TransactionPartialSigner & MessagePartialSigner;

interface PriceOrderBase {
  inputMint: string;
  outputMint: string;
  inputAmount: bigint | string | number;
  /** Mint whose USD price is watched. */
  triggerMint: string;
  /** Unix ms, in the future. */
  expiresAt: number;
}

export type PriceOrder =
  | (PriceOrderBase & { orderType: "single"; triggerCondition: "above" | "below"; triggerPriceUsd?: number; trailingBps?: number; slippageBps?: number })
  | (PriceOrderBase & { orderType: "oco"; tpPriceUsd: number; slPriceUsd: number; tpSlippageBps?: number; slSlippageBps?: number })
  | (PriceOrderBase & {
      orderType: "otoco";
      triggerCondition: "above" | "below";
      triggerPriceUsd: number;
      tpPriceUsd: number;
      slPriceUsd: number;
      slippageBps?: number;
      tpSlippageBps?: number;
      slSlippageBps?: number;
    });

export interface PriceOrderUpdate {
  orderType: "single" | "oco" | "otoco";
  triggerPriceUsd?: number;
  slippageBps?: number;
  tpPriceUsd?: number;
  slPriceUsd?: number;
  trailingBps?: number;
}

export interface DcaOrder {
  inputMint: string;
  outputMint: string;
  /** Total, in base units. */
  inputAmount: bigint | string | number;
  /** Rounds, at least 2; each must be worth at least $10. */
  orderCount: number;
  /** 60 to 31,536,000. */
  intervalSeconds: number;
  orderType?: "time_based" | "price_conditional";
  minPriceUsd?: number;
  maxPriceUsd?: number;
  /** Required for price_conditional: the input or output mint. */
  triggerMint?: string;
  /** ISO-8601, up to 30 days out. */
  beginFillAt?: string;
  /** Earn While You Wait: time_based with a supported stablecoin input. */
  jlEnabled?: boolean;
  jlMint?: string;
}

export interface OrderHistoryQuery {
  state?: "active" | "past";
  mint?: string;
  /** 1–100, default 20. */
  limit?: number;
  offset?: number;
  sort?: "updated_at" | "created_at" | "expires_at";
  dir?: "asc" | "desc";
}

export interface TriggerOrderRecord {
  id: string;
  orderType: string;
  orderState: string;
  rawState?: string;
  userPubkey: string;
  privyWalletPubkey?: string;
  inputMint: string;
  initialInputAmount: string;
  remainingInputAmount: string;
  outputMint: string;
  triggerMint?: string;
  triggerCondition?: string;
  triggerPriceUsd?: number;
  slippageBps?: number;
  expiresAt?: number | string;
  createdAt?: number | string;
  updatedAt?: number | string;
  events?: unknown[];
  [k: string]: unknown;
}

export interface OrderHistory<T = TriggerOrderRecord> {
  orders: T[];
  pagination: { total: number; limit: number; offset: number };
}

const JWT_TTL_MS = 23 * 3_600_000; // docs: 24 h; refresh an hour early

export class JupiterTrigger {
  private tokens = new Map<string, { token: string; until: number }>();
  private vaults = new Set<string>();

  constructor(private http: Http) {}

  /** Challenge → sign → verify. Returns a JWT, cached per wallet. */
  async authenticate(signer: WalletSigner, force = false): Promise<string> {
    const hit = this.tokens.get(signer.address);
    if (!force && hit && hit.until > Date.now()) return hit.token;
    const { challenge } = await this.http.request<{ challenge?: unknown }>("POST", "/trigger/v2/auth/challenge", { body: { walletPubkey: signer.address, type: "message" } });
    if (typeof challenge !== "string" || !challenge) throw new JupiterError(0, "bad_response", "No auth challenge returned.");
    const [dict] = await signer.signMessages([{ content: new TextEncoder().encode(challenge), signatures: {} }]);
    const sig = dict?.[signer.address];
    if (!sig) throw new JupiterError(0, "sign_failed", "Wallet did not sign the challenge.");
    const { token } = await this.http.request<{ token?: unknown }>("POST", "/trigger/v2/auth/verify", {
      body: { type: "message", walletPubkey: signer.address, signature: getBase58Decoder().decode(sig) },
    });
    if (typeof token !== "string" || !token) throw new JupiterError(0, "bad_response", "No JWT returned.");
    this.tokens.set(signer.address, { token, until: Date.now() + JWT_TTL_MS });
    return token;
  }

  /** Runs an authenticated call, re-authenticating once on 401. */
  private async authed<T>(signer: WalletSigner, method: "GET" | "POST" | "PATCH", path: string, o: { query?: Query; body?: unknown } = {}): Promise<T> {
    const bearer = await this.authenticate(signer);
    try {
      return await this.http.request<T>(method, path, { ...o, bearer });
    } catch (e) {
      if (!(e instanceof JupiterError) || e.status !== 401) throw e;
      this.tokens.delete(signer.address);
      return this.http.request<T>(method, path, { ...o, bearer: await this.authenticate(signer, true) });
    }
  }

  /** GET /vault, registering on first use. The vault is resolved from the JWT. */
  async vault(signer: WalletSigner): Promise<unknown> {
    try {
      const v = await this.authed<unknown>(signer, "GET", "/trigger/v2/vault");
      this.vaults.add(signer.address);
      return v;
    } catch (e) {
      if (!(e instanceof JupiterError) || e.status === 0 || e.status === 401) throw e;
      // ASSUMPTION: GET for /vault/register (the docs sample omits the method).
      const v = await this.authed<unknown>(signer, "GET", "/trigger/v2/vault/register");
      this.vaults.add(signer.address);
      return v;
    }
  }

  /** POST /deposit/craft, check the deposit transaction and sign it. */
  private async deposit(signer: WalletSigner, d: { inputMint: Address; outputMint: Address; amount: string; orderType: "price" | "dca"; orderSubType?: string; jlMint?: string }) {
    if (!this.vaults.has(signer.address)) await this.vault(signer);
    const crafted = await this.authed<{ requestId?: unknown; transaction?: unknown }>(signer, "POST", "/trigger/v2/deposit/craft", {
      body: { inputMint: d.inputMint, outputMint: d.outputMint, userAddress: signer.address, amount: d.amount, orderType: d.orderType, ...(d.orderSubType ? { orderSubType: d.orderSubType } : {}), ...(d.jlMint ? { jlMint: d.jlMint } : {}) },
    });
    if (typeof crafted.requestId !== "string" || typeof crafted.transaction !== "string") throw new JupiterError(0, "bad_response", "Deposit craft returned no transaction.");
    const signed = await this.signWalletTx(signer, crafted.transaction);
    return { depositRequestId: crafted.requestId, depositSignedTx: signed };
  }

  // ASSUMPTION: deposit and withdrawal transactions have the wallet as fee
  // payer. The docs show the wallet signing them but don't say who pays.
  private async signWalletTx(signer: WalletSigner, wire: string): Promise<string> {
    const { signedTransaction } = await checkAndSign(wire, { feePayers: [signer.address], mustSign: [signer.address], signers: [signer] });
    return signedTransaction;
  }

  /** Single (limit / stop-loss / trailing), OCO or OTOCO. Deposit and create in one call. */
  async createPriceOrder(signer: WalletSigner, o: PriceOrder): Promise<{ id: string; txSignature: string; depositConfirmed: boolean }> {
    const inputMint = addr(o.inputMint, "inputMint");
    const outputMint = addr(o.outputMint, "outputMint");
    const triggerMint = addr(o.triggerMint, "triggerMint");
    if (inputMint === outputMint) throw new JupiterError(0, "same_mint", "inputMint and outputMint must differ.");
    const inputAmount = units(o.inputAmount, "inputAmount");
    if (!Number.isInteger(o.expiresAt) || o.expiresAt <= Date.now()) throw new JupiterError(0, "bad_param", "expiresAt must be a future Unix time in ms.");

    let extra: Record<string, unknown>;
    if (o.orderType === "single") {
      if ((o.triggerPriceUsd === undefined) === (o.trailingBps === undefined)) throw new JupiterError(0, "bad_param", "Set exactly one of triggerPriceUsd or trailingBps.");
      if (o.trailingBps !== undefined) {
        intIn(o.trailingBps, 50, 9_000, "trailingBps");
        const want = o.triggerCondition === "below" ? inputMint : outputMint;
        if (triggerMint !== want) throw new JupiterError(0, "bad_param", `A trailing ${o.triggerCondition} order must trigger on ${o.triggerCondition === "below" ? "inputMint" : "outputMint"}.`);
      }
      if (o.triggerCondition !== "above" && o.triggerCondition !== "below") throw new JupiterError(0, "bad_param", "triggerCondition must be above or below.");
      extra = {
        triggerCondition: o.triggerCondition,
        triggerPriceUsd: o.triggerPriceUsd === undefined ? undefined : usd(o.triggerPriceUsd, "triggerPriceUsd"),
        trailingBps: o.trailingBps,
        slippageBps: intIn(o.slippageBps, 0, 10_000, "slippageBps"),
      };
    } else if (o.orderType === "oco" || o.orderType === "otoco") {
      const tp = usd(o.tpPriceUsd, "tpPriceUsd");
      const sl = usd(o.slPriceUsd, "slPriceUsd");
      if (tp <= sl) throw new JupiterError(0, "bad_param", "tpPriceUsd must be above slPriceUsd.");
      extra = { tpPriceUsd: tp, slPriceUsd: sl, tpSlippageBps: intIn(o.tpSlippageBps, 0, 10_000, "tpSlippageBps"), slSlippageBps: intIn(o.slSlippageBps, 0, 10_000, "slSlippageBps") };
      if (o.orderType === "otoco") {
        if (o.triggerCondition !== "above" && o.triggerCondition !== "below") throw new JupiterError(0, "bad_param", "triggerCondition must be above or below.");
        extra = { ...extra, triggerCondition: o.triggerCondition, triggerPriceUsd: usd(o.triggerPriceUsd, "triggerPriceUsd"), slippageBps: intIn(o.slippageBps, 0, 10_000, "slippageBps") };
      }
    } else {
      throw new JupiterError(0, "bad_param", "orderType must be single, oco or otoco.");
    }

    const dep = await this.deposit(signer, { inputMint, outputMint, amount: inputAmount, orderType: "price", orderSubType: o.orderType });
    const body = stripUndefined({ orderType: o.orderType, ...dep, userPubkey: signer.address, inputMint, inputAmount, outputMint, triggerMint, expiresAt: o.expiresAt, ...extra });
    return this.authed(signer, "POST", "/trigger/v2/orders/price", { body });
  }

  /** PATCH /orders/price/{id}. */
  async updatePriceOrder(signer: WalletSigner, orderId: string, u: PriceOrderUpdate): Promise<{ id: string }> {
    for (const k of ["triggerPriceUsd", "tpPriceUsd", "slPriceUsd"] as const) if (u[k] !== undefined) usd(u[k], k);
    intIn(u.slippageBps, 0, 10_000, "slippageBps");
    intIn(u.trailingBps, 50, 9_000, "trailingBps");
    if (u.tpPriceUsd !== undefined && u.slPriceUsd !== undefined && u.tpPriceUsd <= u.slPriceUsd) throw new JupiterError(0, "bad_param", "tpPriceUsd must be above slPriceUsd.");
    return this.authed(signer, "PATCH", `/trigger/v2/orders/price/${orderPath(orderId)}`, { body: stripUndefined({ ...u }) });
  }

  /** Two steps: initiate (returns a withdrawal tx), sign it, confirm. */
  async cancelPriceOrder(signer: WalletSigner, orderId: string): Promise<{ id: string; txSignature: string }> {
    const id = orderPath(orderId);
    const w = await this.authed<{ transaction?: unknown; requestId?: unknown }>(signer, "POST", `/trigger/v2/orders/price/cancel/${id}`);
    if (typeof w.transaction !== "string" || typeof w.requestId !== "string") throw new JupiterError(0, "bad_response", "Cancel returned no withdrawal transaction.");
    const signedTransaction = await this.signWalletTx(signer, w.transaction);
    return this.authed(signer, "POST", `/trigger/v2/orders/price/confirm-cancel/${id}`, { body: { signedTransaction, cancelRequestId: w.requestId } });
  }

  /** POST /orders/dca, after a deposit with orderType "dca" (no sub-type). */
  async createDcaOrder(signer: WalletSigner, o: DcaOrder): Promise<{ id: string; txSignature: string }> {
    const inputMint = addr(o.inputMint, "inputMint");
    const outputMint = addr(o.outputMint, "outputMint");
    if (inputMint === outputMint) throw new JupiterError(0, "same_mint", "inputMint and outputMint must differ.");
    const inputAmount = units(o.inputAmount, "inputAmount");
    intIn(o.orderCount, 2, Number.MAX_SAFE_INTEGER, "orderCount");
    intIn(o.intervalSeconds, 60, 31_536_000, "intervalSeconds");
    const type = o.orderType ?? "time_based";
    let triggerMint: Address | undefined;
    if (type === "price_conditional") {
      triggerMint = addr(o.triggerMint, "triggerMint");
      if (triggerMint !== inputMint && triggerMint !== outputMint) throw new JupiterError(0, "bad_param", "triggerMint must be the input or output mint.");
      if (o.minPriceUsd === undefined && o.maxPriceUsd === undefined) throw new JupiterError(0, "bad_param", "A price_conditional DCA needs minPriceUsd and/or maxPriceUsd.");
      if (o.minPriceUsd !== undefined) usd(o.minPriceUsd, "minPriceUsd");
      if (o.maxPriceUsd !== undefined) usd(o.maxPriceUsd, "maxPriceUsd");
      if (o.minPriceUsd !== undefined && o.maxPriceUsd !== undefined && o.minPriceUsd >= o.maxPriceUsd) throw new JupiterError(0, "bad_param", "minPriceUsd must be below maxPriceUsd.");
    } else if (type !== "time_based") {
      throw new JupiterError(0, "bad_param", "orderType must be time_based or price_conditional.");
    } else if (o.minPriceUsd !== undefined || o.maxPriceUsd !== undefined) {
      throw new JupiterError(0, "bad_param", "Price bounds apply to price_conditional only.");
    }
    if (o.jlEnabled) {
      if (type !== "time_based") throw new JupiterError(0, "bad_param", "jlEnabled needs a time_based DCA.");
      addr(o.jlMint, "jlMint");
    }
    if (o.beginFillAt !== undefined && Number.isNaN(Date.parse(o.beginFillAt))) throw new JupiterError(0, "bad_param", "beginFillAt must be an ISO-8601 time.");

    const dep = await this.deposit(signer, { inputMint, outputMint, amount: inputAmount, orderType: "dca", jlMint: o.jlEnabled ? o.jlMint : undefined });
    const body = stripUndefined({
      ...dep, userPubkey: signer.address, inputMint, outputMint, inputAmount, orderCount: o.orderCount, intervalSeconds: o.intervalSeconds, orderType: type,
      minPriceUsd: o.minPriceUsd, maxPriceUsd: o.maxPriceUsd, triggerMint, beginFillAt: o.beginFillAt, jlEnabled: o.jlEnabled, jlMint: o.jlEnabled ? o.jlMint : undefined,
    });
    return this.authed(signer, "POST", "/trigger/v2/orders/dca", { body });
  }

  /**
   * Cancel a DCA order (must be active or withdrawing); the unfilled remainder
   * returns to the wallet.
   * ASSUMPTION: the DCA cancel pages were not reachable. Docs say it is the
   * same two-step withdrawal flow with a `cancelRequestId`, so these paths
   * mirror the price-order ones: POST /orders/dca/cancel/{id} then
   * POST /orders/dca/confirm-cancel/{id}.
   */
  async cancelDcaOrder(signer: WalletSigner, orderId: string): Promise<{ id: string; txSignature: string }> {
    const id = orderPath(orderId);
    const w = await this.authed<{ transaction?: unknown; requestId?: unknown }>(signer, "POST", `/trigger/v2/orders/dca/cancel/${id}`);
    if (typeof w.transaction !== "string" || typeof w.requestId !== "string") throw new JupiterError(0, "bad_response", "Cancel returned no withdrawal transaction.");
    const signedTransaction = await this.signWalletTx(signer, w.transaction);
    return this.authed(signer, "POST", `/trigger/v2/orders/dca/confirm-cancel/${id}`, { body: { signedTransaction, cancelRequestId: w.requestId } });
  }

  /** GET /orders/history (price orders) for the authenticated wallet. */
  async listPriceOrders(signer: WalletSigner, q: OrderHistoryQuery = {}): Promise<OrderHistory> {
    return this.authed(signer, "GET", "/trigger/v2/orders/history", { query: historyQuery(q) });
  }

  /**
   * GET /orders/history/dca.
   * ASSUMPTION: takes the same query parameters and returns the same
   * { orders, pagination } shape as /orders/history; the DCA history page was
   * not reachable.
   */
  async listDcaOrders(signer: WalletSigner, q: OrderHistoryQuery = {}): Promise<OrderHistory<Record<string, unknown>>> {
    return this.authed(signer, "GET", "/trigger/v2/orders/history/dca", { query: historyQuery(q) });
  }

  /** GET /orders/history/dca/{id}. */
  async getDcaOrder(signer: WalletSigner, orderId: string): Promise<Record<string, unknown>> {
    return this.authed(signer, "GET", `/trigger/v2/orders/history/dca/${orderPath(orderId)}`);
  }
}

function orderPath(id: string): string {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new JupiterError(0, "bad_param", "Invalid order id.");
  return id;
}

function historyQuery(q: OrderHistoryQuery): Query {
  if (q.state !== undefined && q.state !== "active" && q.state !== "past") throw new JupiterError(0, "bad_param", "state must be active or past.");
  return {
    state: q.state,
    mint: q.mint === undefined ? undefined : addr(q.mint, "mint"),
    limit: intIn(q.limit, 1, 100, "limit"),
    offset: intIn(q.offset, 0, Number.MAX_SAFE_INTEGER, "offset"),
    sort: q.sort,
    dir: q.dir,
  };
}

function stripUndefined<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
