/**
 * Jupiter trade layer: Swap V2 (order + execute), Trigger V2 (price and DCA
 * orders), Tokens V2 search and Price V3.
 *
 * Every endpoint lives under https://api.jup.ag and needs an `x-api-key`
 * header (env JUPITER_API_KEY, or the `apiKey` option). `baseUrl` is pinned to
 * that host: another one needs `allowCustomBaseUrl: true` and must be https.
 * `fetch` is injectable so tests never touch the network.
 *
 * Safety. Treat every Jupiter response as untrusted (a compromised API, a
 * proxy, a misconfigured baseUrl):
 * - This module signs only as the user (taker / wallet). It never signs with a
 *   server key. With a gas sponsor (`payer`), `signOrder` / `swap` return the
 *   user-signed transaction; the caller sends it to the gas sponsor service
 *   (sponsor.ts, `Sponsor.sponsor()`), which applies its own program, fee and
 *   rent policy and simulates before it co-signs and sends.
 * - Before the user signs, `checkTransaction` decodes the message and refuses
 *   it (a JupiterError with a named code) unless: the fee payer is expected;
 *   every top-level program is allowlisted (Jupiter Swap and Order Engine,
 *   System, Token, Token-2022, ATA, ComputeBudget); no System transfer sends
 *   the user's SOL anywhere but their own wallet / wSOL account (or allowed
 *   tip accounts or deposit recipients); no Assign or AdvanceNonce; user-funded
 *   CreateAccount and ATA rent stays under a cap; no Token transfer, Approve,
 *   SetAuthority or CloseAccount moves the user's value to someone else; and
 *   the priority fee plus tips is under a cap. See `checkTransaction`.
 * - JupiterZ (RFQ) routes are accepted only from makers on `jupiterZMakers`.
 * The swap and order-engine programs themselves are trusted to honour the
 * route and slippage in their instruction data; we do not parse those.
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
  decompileTransactionMessage,
  getAddressEncoder,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress,
  getTransactionDecoder,
  isAddress,
  type Address,
  type MessagePartialSigner,
  type Transaction,
  type TransactionPartialSigner,
} from "@solana/kit";
import { lookupTablesOf } from "../txpolicy.js";

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

/** What we keep of a referral fee after Jupiter's 20%, in whole bps (floored): 50 → 40, 51 → 40, 255 → 204. */
export function netReferralBps(feeBps: number): number {
  assertReferralFee(feeBps);
  return Math.floor((feeBps * (10_000 - JUPITER_REFERRAL_SHARE_BPS)) / 10_000);
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
  /** Pinned to https://api.jup.ag. Anything else needs `allowCustomBaseUrl: true`, and must be https. */
  baseUrl?: string;
  allowCustomBaseUrl?: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Our referral account. Defaults to env JUPITER_REFERRAL_ACCOUNT. `null` turns fees off. */
  referralAccount?: string | null;
  referralFeeBps?: number;
  /** Overrides for the checks run before the user signs (program allowlist, priority fee and rent caps, tip accounts). */
  txPolicy?: Partial<TxPolicy>;
  /**
   * JupiterZ market makers we accept, by maker public key (the order's
   * `maker`, which is also the RFQ fee payer). Jupiter publishes no list and
   * the address varies per quote, so routes from any other maker are refused.
   * Empty by default: JupiterZ routes are refused (or exclude them with
   * `excludeRouters: ["jupiterz"]`).
   */
  jupiterZMakers?: string[];
  /** Resolves address lookup tables so destinations loaded from them can be checked. Without it they count as strangers. */
  resolveLookupTables?: (tables: Address[]) => Promise<Record<Address, Address[]>>;
}

/** Returns the base URL to use, or throws `custom_base_url` / `insecure_base_url`. */
export function resolveBaseUrl(o: Pick<JupiterOptions, "baseUrl" | "allowCustomBaseUrl">): string {
  if (o.baseUrl === undefined) return JUPITER_API;
  let u: URL;
  try {
    u = new URL(o.baseUrl);
  } catch {
    throw new JupiterError(0, "insecure_base_url", "baseUrl is not a valid URL.");
  }
  if (u.protocol !== "https:" || u.username || u.password) throw new JupiterError(0, "insecure_base_url", "baseUrl must be a plain https URL.");
  const normalized = u.toString().replace(/\/$/, "");
  if (normalized === JUPITER_API) return JUPITER_API;
  if (!o.allowCustomBaseUrl) throw new JupiterError(0, "custom_base_url", `baseUrl ${u.origin} is not ${JUPITER_API}; set allowCustomBaseUrl: true to use it.`);
  return normalized;
}

type Query = Record<string, string | number | boolean | undefined>;

class Http {
  private fetchImpl: typeof fetch;
  private baseUrl: string;
  constructor(private opts: JupiterOptions) {
    this.baseUrl = resolveBaseUrl(opts);
    this.fetchImpl = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  }

  async request<T>(method: "GET" | "POST" | "PATCH", path: string, o: { query?: Query; body?: unknown; bearer?: string } = {}): Promise<T> {
    const apiKey = this.opts.apiKey ?? process.env.JUPITER_API_KEY;
    if (!apiKey) throw new JupiterError(0, "no_api_key", "Set JUPITER_API_KEY or pass apiKey.");
    const url = new URL(this.baseUrl + path);
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

// Programs a transaction we sign as the user may call at the top level.
export const TX_PROGRAMS = {
  /** Jupiter Swap (aggregator v6, Metis routes). */
  jupiterSwap: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address,
  /** Jupiter Order Engine (JupiterZ RFQ settlement). Confirmed on developers.jup.ag (rfq/v1/settlement) and jupiterz.jup.ag FAQ. */
  jupiterOrderEngine: "61DFfeTKM7trxYcPQCM78bJ794ddZprZpAwAnLiwTpYH" as Address,
  system: "11111111111111111111111111111111" as Address,
  token: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address,
  token2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address,
  ata: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address,
  computeBudget: "ComputeBudget111111111111111111111111111111" as Address,
} as const;

export const WSOL_MINT = "So11111111111111111111111111111111111111112" as Address;
/** Rent-exempt minimum of a 165-byte SPL token account; charged per ATA the user funds. */
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280n;

export interface TxPolicy {
  /** Top-level programs allowed. */
  programs: Address[];
  /** Cap on compute-budget priority fee plus any tips, in lamports. */
  maxPriorityFeeLamports: bigint;
  /** Cap on SOL the user may put into new accounts (CreateAccount lamports plus ATA rent). */
  maxRentLamports: bigint;
  /** Tip accounts (Jito etc.) a System transfer may pay; tips count toward `maxPriorityFeeLamports`. None by default. */
  tipAccounts: Address[];
}

export const DEFAULT_TX_POLICY: TxPolicy = {
  programs: Object.values(TX_PROGRAMS),
  maxPriorityFeeLamports: 5_000_000n, // 0.005 SOL
  maxRentLamports: 10_000_000n, // ~4 token accounts
  tipAccounts: [],
};

/**
 * Value the transaction may move from the user to named recipients (a
 * Trigger deposit into the user's vault): System and Token transfers to
 * `recipients`, at most `maxAmount` in total.
 */
export interface Outflow {
  recipients: Address[];
  maxAmount: bigint;
}

export interface TxCheck {
  inspection: TxInspection;
  priorityFeeLamports: bigint;
  rentLamports: bigint;
  outflow: bigint;
}

export type CheckIx = { program: Address; accounts: (Address | null)[]; data: Uint8Array };

const refuse = (code: string, i: number | undefined, msg: string): never => {
  throw new JupiterError(0, code, i === undefined ? msg : `Instruction ${i}: ${msg}`);
};
const rdU32 = (d: Uint8Array, o: number) => Buffer.from(d.buffer, d.byteOffset, d.byteLength).readUInt32LE(o);
const rdU64 = (d: Uint8Array, o: number) => Buffer.from(d.buffer, d.byteOffset, d.byteLength).readBigUInt64LE(o);

/** ATA of `owner` for `mint` under `tokenProgram`. */
export async function associatedTokenAddress(owner: Address, mint: Address, tokenProgram: Address = TX_PROGRAMS.token): Promise<Address> {
  const enc = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({ programAddress: TX_PROGRAMS.ata, seeds: [enc.encode(owner), enc.encode(tokenProgram), enc.encode(mint)] });
  return pda;
}

/** Top-level instructions with addresses; accounts loaded from an unresolved lookup table are `null`. */
export function instructionsOf(wireBase64: string, lookups?: Record<Address, Address[]>): { ixs: CheckIx[]; v1PriorityFee: bigint } {
  const tx = getTransactionDecoder().decode(Buffer.from(wireBase64, "base64"));
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (compiled.version === 1) {
    const m = decompileTransactionMessage(compiled as never) as unknown as {
      instructions: readonly { programAddress: Address; accounts?: readonly { address: Address }[]; data?: ArrayLike<number> }[];
      config?: { priorityFeeLamports?: bigint };
    };
    return {
      ixs: m.instructions.map((ix) => ({ program: ix.programAddress, accounts: (ix.accounts ?? []).map((a) => a.address), data: new Uint8Array(ix.data ?? []) })),
      v1PriorityFee: BigInt(m.config?.priorityFeeLamports ?? 0n),
    };
  }
  const c = compiled as unknown as {
    staticAccounts: Address[];
    instructions: { programAddressIndex: number; accountIndices?: number[]; data?: ArrayLike<number> }[];
    addressTableLookups?: { lookupTableAddress: Address; writableIndexes: readonly number[]; readonlyIndexes: readonly number[] }[];
  };
  const pick = (kind: "writableIndexes" | "readonlyIndexes") =>
    (c.addressTableLookups ?? []).flatMap((l) => l[kind].map((j) => lookups?.[l.lookupTableAddress]?.[j] ?? null));
  const keys: (Address | null)[] = [...c.staticAccounts, ...pick("writableIndexes"), ...pick("readonlyIndexes")];
  const ixs = c.instructions.map((ix, i) => {
    // The runtime loads program ids from static keys only.
    if (ix.programAddressIndex >= c.staticAccounts.length) refuse("program_not_allowed", i, "program id is not a static account.");
    return { program: c.staticAccounts[ix.programAddressIndex], accounts: (ix.accountIndices ?? []).map((j) => keys[j] ?? null), data: new Uint8Array(ix.data ?? []) };
  });
  return { ixs, v1PriorityFee: 0n };
}

/**
 * Decode a transaction from Jupiter and refuse it unless it is safe for
 * `user` to sign. Every refusal is a JupiterError with one of these codes:
 *   fee_payer, not_a_signer, malformed_tx,
 *   program_not_allowed        top-level program not on `policy.programs`
 *   system_instruction         System instruction other than CreateAccount / Transfer (or malformed)
 *   system_assign              System Assign
 *   system_nonce               System AdvanceNonceAccount (durable nonce)
 *   user_transfer              System transfer of the user's SOL to anyone but the user / their wSOL ATA
 *   foreign_transfer           System transfer by another signer to anyone but the user / their wSOL ATA
 *   rent_too_high              user-funded CreateAccount lamports + ATA rent over `maxRentLamports`
 *   token_transfer             top-level Token transfer under the user's authority
 *   token_approve              Approve to a delegate other than the user
 *   token_set_authority        SetAuthority to anyone but the user
 *   token_close                CloseAccount paying anyone but the user
 *   token_instruction          other Token instruction
 *   ata_instruction            ATA instruction other than Create / CreateIdempotent
 *   compute_budget_instruction unknown or duplicate ComputeBudget instruction
 *   priority_fee_too_high      priority fee plus tips over `maxPriorityFeeLamports`
 *   outflow_too_high           transfers to `outflow.recipients` over `outflow.maxAmount`
 */
export async function checkTransaction(
  wireBase64: string,
  o: { user: Address; feePayers: Address[]; policy?: Partial<TxPolicy>; lookups?: Record<Address, Address[]>; outflow?: Outflow },
): Promise<TxCheck> {
  const P: TxPolicy = { ...DEFAULT_TX_POLICY, ...(stripUndefined({ ...(o.policy ?? {}) } as Record<string, unknown>) as Partial<TxPolicy>) };
  const ins = inspectTransaction(wireBase64);
  if (!o.feePayers.includes(ins.feePayer)) refuse("fee_payer", undefined, `Unexpected fee payer ${ins.feePayer}; expected ${o.feePayers.join(" or ")}.`);
  if (!ins.requiredSigners.includes(o.user)) refuse("not_a_signer", undefined, `${o.user} is not a required signer of this transaction.`);

  let decoded: ReturnType<typeof instructionsOf>;
  try {
    decoded = instructionsOf(wireBase64, o.lookups);
  } catch (e) {
    if (e instanceof JupiterError) throw e;
    throw new JupiterError(0, "malformed_tx", `Could not decode the instructions: ${(e as Error).message}`);
  }
  const { ixs } = decoded;
  const user = o.user;
  const userWsol = await associatedTokenAddress(user, WSOL_MINT);
  const own = (a: Address | null) => a === user || a === userWsol;
  const recipients = new Set(o.outflow?.recipients ?? []);
  const tips = new Set(P.tipAccounts);
  const programs = new Set(P.programs);

  let rent = 0n;
  let tipLamports = 0n;
  let outflow = 0n;
  let cuLimit: number | undefined;
  let cuPrice: bigint | undefined;
  const cbSeen = new Set<number>();

  for (const [i, ix] of ixs.entries()) {
    const a = ix.accounts;
    const d = ix.data;
    if (!programs.has(ix.program)) refuse("program_not_allowed", i, `program ${ix.program} is not allowlisted.`);

    if (ix.program === TX_PROGRAMS.system) {
      if (d.length < 4) refuse("system_instruction", i, "malformed System instruction.");
      const tag = rdU32(d, 0);
      if (tag === 1) refuse("system_assign", i, "System Assign is not allowed.");
      if (tag === 4) refuse("system_nonce", i, "durable-nonce AdvanceNonceAccount is not allowed.");
      if (tag === 0) {
        if (d.length !== 52 || a.length < 2) refuse("system_instruction", i, "malformed CreateAccount.");
        if (a[0] === user) rent += rdU64(d, 4);
      } else if (tag === 2) {
        if (d.length !== 12 || a.length < 2) refuse("system_instruction", i, "malformed Transfer.");
        const lamports = rdU64(d, 4);
        const [from, to] = a;
        if (own(to)) continue; // into the user's own wallet or wSOL account
        if (to && tips.has(to)) tipLamports += lamports;
        else if (from === user && to && recipients.has(to)) outflow += lamports;
        else if (from === user) refuse("user_transfer", i, `transfer of ${lamports} lamports from the user to ${to ?? "a lookup-table account"}.`);
        else refuse("foreign_transfer", i, `transfer of ${lamports} lamports from ${from} to ${to ?? "a lookup-table account"}.`);
      } else {
        refuse("system_instruction", i, `System instruction ${tag} is not allowed.`);
      }
    } else if (ix.program === TX_PROGRAMS.token || ix.program === TX_PROGRAMS.token2022) {
      const tag = d[0];
      /** True when the user is the authority from account `k` on (single owner or a multisig signer). */
      const userAuth = (k: number) => a.slice(k).includes(user);
      switch (tag) {
        case 1: case 16: case 18: // InitializeAccount(2/3)
        case 5: // Revoke
        case 17: // SyncNative
          break;
        case 3: case 12: { // Transfer, TransferChecked
          if (d.length < 9) refuse("token_instruction", i, "malformed transfer.");
          const auth = tag === 3 ? 2 : 3;
          const dest = a[tag === 3 ? 1 : 2];
          if (!userAuth(auth)) break;
          if (dest && recipients.has(dest)) outflow += rdU64(d, 1);
          else refuse("token_transfer", i, `token transfer under the user's authority to ${dest ?? "a lookup-table account"}.`);
          break;
        }
        case 4: case 13: { // Approve, ApproveChecked
          const delegate = a[tag === 4 ? 1 : 2];
          if (userAuth(tag === 4 ? 2 : 3) && delegate !== user) refuse("token_approve", i, `approve to delegate ${delegate ?? "a lookup-table account"}.`);
          break;
        }
        case 6: { // SetAuthority
          if (d.length < 3) refuse("token_instruction", i, "malformed SetAuthority.");
          const next = d[2] === 1 && d.length >= 35 ? getBase58Decoder().decode(d.slice(3, 35)) : null;
          if (userAuth(1) && next !== user) refuse("token_set_authority", i, `set authority to ${next ?? "none"}.`);
          break;
        }
        case 9: // CloseAccount
          if (a[1] !== user) refuse("token_close", i, `close pays ${a[1] ?? "a lookup-table account"}, not the user.`);
          break;
        default:
          refuse("token_instruction", i, `Token instruction ${tag} is not allowed.`);
      }
    } else if (ix.program === TX_PROGRAMS.ata) {
      if (d.length > 1 || (d.length === 1 && d[0] !== 0 && d[0] !== 1)) refuse("ata_instruction", i, `ATA instruction ${d[0]} is not allowed.`);
      if (a[0] === user) rent += TOKEN_ACCOUNT_RENT_LAMPORTS;
    } else if (ix.program === TX_PROGRAMS.computeBudget) {
      const tag = d[0];
      const len = { 1: 5, 2: 5, 3: 9, 4: 5 }[tag as 1 | 2 | 3 | 4];
      if (len === undefined || d.length !== len) refuse("compute_budget_instruction", i, "unsupported compute budget instruction.");
      if (cbSeen.has(tag)) refuse("compute_budget_instruction", i, "duplicate compute budget instruction.");
      cbSeen.add(tag);
      if (tag === 2) cuLimit = rdU32(d, 1);
      if (tag === 3) cuPrice = rdU64(d, 1);
    }
  }

  if (rent > P.maxRentLamports) refuse("rent_too_high", undefined, `User-funded rent ${rent} lamports is over the ${P.maxRentLamports} cap.`);
  if (o.outflow && outflow > o.outflow.maxAmount) refuse("outflow_too_high", undefined, `Transfers of ${outflow} to the recipients exceed ${o.outflow.maxAmount}.`);
  const others = ixs.filter((ix) => ix.program !== TX_PROGRAMS.computeBudget).length;
  const limit = BigInt(cuLimit ?? Math.min(1_400_000, 200_000 * others));
  const priority = ((cuPrice ?? 0n) * limit + 999_999n) / 1_000_000n + decoded.v1PriorityFee + tipLamports;
  if (priority > P.maxPriorityFeeLamports) refuse("priority_fee_too_high", undefined, `Priority fee and tips ${priority} lamports are over the ${P.maxPriorityFeeLamports} cap.`);
  return { inspection: ins, priorityFeeLamports: priority, rentLamports: rent, outflow };
}

/**
 * Check a transaction from Jupiter (`checkTransaction`), then sign it as the
 * user, and only as the user. There is deliberately no way to pass a second
 * signer: server keys (our gas sponsor) never sign here.
 */
export async function checkAndSign(
  wireBase64: string,
  o: { user: TransactionPartialSigner; feePayers: Address[]; policy?: Partial<TxPolicy>; lookups?: Record<Address, Address[]>; outflow?: Outflow },
): Promise<{ signedTransaction: string; inspection: TxInspection; check: TxCheck }> {
  if ("signers" in (o as object) || !o.user || typeof o.user.signTransactions !== "function") {
    throw new JupiterError(0, "server_signer", "checkAndSign signs only as the user; send sponsored transactions to the gas sponsor.");
  }
  const check = await checkTransaction(wireBase64, { ...o, user: o.user.address });
  let tx = check.inspection.tx;
  const [dict] = await o.user.signTransactions([tx as never]);
  const sig = dict?.[o.user.address];
  if (!sig) throw new JupiterError(0, "sign_failed", `Signer ${o.user.address} returned no signature.`);
  tx = { ...tx, signatures: { ...tx.signatures, [o.user.address]: sig } };
  return { signedTransaction: getBase64EncodedWireTransaction(tx), inspection: check.inspection, check };
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
  /**
   * The gas sponsor address the order was requested with. Only an address:
   * this module never signs with it. The returned transaction is signed by the
   * taker only; send it to the gas sponsor (sponsor.ts, `Sponsor.sponsor()`).
   */
  payer?: Address;
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
    this.trigger = new JupiterTrigger(this.http, opts.txPolicy);
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
   * Check an order's transaction (`checkTransaction`) and sign it as the
   * taker, and only as the taker.
   *
   * Expected fee payer: the sponsor `payer` when one differs from the taker,
   * else the taker. On a JupiterZ (RFQ) route the market maker pays the fee
   * instead; the order's `maker` is accepted there only if it is on
   * `jupiterZMakers`, otherwise the route is refused (`maker_not_allowed`).
   */
  async signOrder(order: SwapOrder, o: SignOrderOptions): Promise<string> {
    if (!order.transaction) {
      throw new JupiterError(0, "no_transaction", `Order has no transaction${order.errorCode !== undefined ? ` (router ${order.router}, errorCode ${order.errorCode}: ${order.errorMessage ?? order.error ?? ""})` : ""}.`, order);
    }
    if (o.payer !== undefined && typeof o.payer !== "string") {
      throw new JupiterError(0, "server_signer", "Pass the sponsor payer as an address; jupiter.ts never signs with a server key.");
    }
    const taker = o.taker.address;
    if (order.taker && order.taker !== taker) throw new JupiterError(0, "taker", `Order is for taker ${order.taker}, not ${taker}.`);
    if (o.expect) {
      if (order.inputMint !== o.expect.inputMint || order.outputMint !== o.expect.outputMint) throw new JupiterError(0, "order_mismatch", "Order mints differ from the request.");
      if (order.inAmount !== units(o.expect.amount, "amount")) throw new JupiterError(0, "order_mismatch", "Order inAmount differs from the request.");
    }
    const payer = o.payer === undefined ? undefined : addr(o.payer, "payer");
    const feePayers: Address[] = [payer && payer !== taker ? payer : taker];
    if (order.router === "jupiterz") {
      const makers = this.opts.jupiterZMakers ?? [];
      if (typeof order.maker !== "string" || !isAddress(order.maker) || !makers.includes(order.maker)) {
        throw new JupiterError(0, "maker_not_allowed", `JupiterZ maker ${String(order.maker)} is not on the allowlist.`);
      }
      feePayers.push(order.maker);
    }
    const tables = lookupTablesOf(order.transaction);
    const lookups = tables.length && this.opts.resolveLookupTables ? await this.opts.resolveLookupTables(tables) : undefined;
    const { signedTransaction } = await checkAndSign(order.transaction, { user: o.taker, feePayers, policy: this.opts.txPolicy, lookups });
    return signedTransaction;
  }

  /** POST /swap/v2/execute. Returns the result as is, including `status: "Failed"`. */
  async execute(signedTransaction: string, requestId: string, lastValidBlockHeight?: string): Promise<ExecuteResult> {
    if (!signedTransaction || !requestId) throw new JupiterError(0, "bad_param", "signedTransaction and requestId are required.");
    return this.http.request<ExecuteResult>("POST", "/swap/v2/execute", { body: { signedTransaction, requestId, ...(lastValidBlockHeight ? { lastValidBlockHeight } : {}) } });
  }

  /**
   * Order, check and sign, execute. With a sponsor `payer`, nothing is
   * executed: the taker-signed transaction is returned for the caller to send
   * to the gas sponsor service (sponsor.ts), which applies its own policy and
   * simulation before co-signing.
   */
  async swap(
    req: Omit<OrderRequest, "taker" | "payer"> & { taker: TransactionPartialSigner; payer?: Address },
  ): Promise<{ order: SwapOrder; result: ExecuteResult } | { order: SwapOrder; sponsorTransaction: string }> {
    const order = await this.getOrder({ ...req, taker: req.taker.address, payer: req.payer });
    const signed = await this.signOrder(order, { taker: req.taker, payer: req.payer, expect: req });
    if (req.payer !== undefined && req.payer !== req.taker.address) return { order, sponsorTransaction: signed };
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
  /** Wallet → its vault pubkey from GET /vault (null if the response named none). */
  private vaults = new Map<string, Address | null>();

  constructor(private http: Http, private policy?: Partial<TxPolicy>) {}

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
    const remember = (v: unknown) => {
      const pk = (v as { vaultPubkey?: unknown } | null)?.vaultPubkey;
      this.vaults.set(signer.address, typeof pk === "string" && isAddress(pk) ? pk : null);
      return v;
    };
    try {
      return remember(await this.authed<unknown>(signer, "GET", "/trigger/v2/vault"));
    } catch (e) {
      if (!(e instanceof JupiterError) || e.status === 0 || e.status === 401) throw e;
      // ASSUMPTION: GET for /vault/register (the docs sample omits the method).
      return remember(await this.authed<unknown>(signer, "GET", "/trigger/v2/vault/register"));
    }
  }

  /** POST /deposit/craft, check the deposit transaction and sign it. */
  private async deposit(signer: WalletSigner, d: { inputMint: Address; outputMint: Address; amount: string; orderType: "price" | "dca"; orderSubType?: string; jlMint?: string }) {
    if (!this.vaults.has(signer.address)) await this.vault(signer);
    const crafted = await this.authed<{ requestId?: unknown; transaction?: unknown; receiverAddress?: unknown }>(signer, "POST", "/trigger/v2/deposit/craft", {
      body: { inputMint: d.inputMint, outputMint: d.outputMint, userAddress: signer.address, amount: d.amount, orderType: d.orderType, ...(d.orderSubType ? { orderSubType: d.orderSubType } : {}), ...(d.jlMint ? { jlMint: d.jlMint } : {}) },
    });
    if (typeof crafted.requestId !== "string" || typeof crafted.transaction !== "string") throw new JupiterError(0, "bad_response", "Deposit craft returned no transaction.");
    // The deposit may move up to `amount` into the vault (its wallet or its
    // token accounts for the input mint), and nowhere else.
    const vault = this.vaults.get(signer.address) ?? null;
    if (crafted.receiverAddress !== undefined && crafted.receiverAddress !== vault) {
      throw new JupiterError(0, "vault_mismatch", "Deposit receiverAddress is not the wallet's vault.");
    }
    const recipients: Address[] = vault
      ? [vault, ...(await Promise.all([TX_PROGRAMS.token, TX_PROGRAMS.token2022].map((p) => associatedTokenAddress(vault, d.inputMint, p))))]
      : [];
    const signed = await this.signWalletTx(signer, crafted.transaction, { recipients, maxAmount: BigInt(d.amount) });
    return { depositRequestId: crafted.requestId, depositSignedTx: signed };
  }

  // ASSUMPTION: deposit and withdrawal transactions have the wallet as fee
  // payer. The docs show the wallet signing them but don't say who pays.
  private async signWalletTx(signer: WalletSigner, wire: string, outflow?: Outflow): Promise<string> {
    const { signedTransaction } = await checkAndSign(wire, { user: signer, feePayers: [signer.address], policy: this.policy, outflow });
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
