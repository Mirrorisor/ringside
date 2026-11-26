/**
 * Ringside gas sponsor.
 *
 * Users of the social trading app sign in with an embedded wallet and never
 * hold SOL for fees: the app builds each transaction with the sponsor as fee
 * payer, the user signs their part, and POSTs it here with their app session.
 * The sponsor co-signs as fee payer only if every check passes, then sends it.
 *
 * Unlike the relayer (relayer.ts), the sponsor never pays rent: its key may
 * appear in a transaction only as the fee payer, so the most a transaction
 * can cost it is the network fee. Checks run cheapest first, and every
 * request that gets past a rate limit is counted before any RPC work:
 *   1. App authentication (HTTP server; `authenticate`, e.g. the HMAC session
 *      tokens in session.ts). No authenticator means no server, unless
 *      anonymous mode is switched on explicitly (devnet only).
 *   2. Hourly request counts per app user and per client IP, and a temporary
 *      block after `maxFailuresPerHour` transactions failed on chain.
 *   3. Decode and static policy, from the wire alone: program allowlist
 *      (Ringside launch and perps, Jupiter, Pump, PumpSwap, System, Token,
 *      Token-2022, ATA, ComputeBudget); at least one instruction for an app
 *      program (plain System/Token transfers are not sponsored); no durable
 *      nonce (System AdvanceNonceAccount); caps on compute units, priority fee
 *      price and total priority fee; every user signature present.
 *   4. Hourly counts and failure blocks per signing wallet, then per-wallet,
 *      per-user and global daily lamport budgets (worst case reserved while
 *      in flight).
 *   5. RPC: lookup tables, then the blockhash must be recent
 *      (isBlockhashValid), the fee payer may not appear in any instruction's
 *      accounts (account roles are per message, so any appearance would make
 *      it a writable signer), optional fee recovery, fee quote under the cap,
 *      and simulation with signatures verified: the balance may drop by at
 *      most the fee plus `maxRentLamports` (0 by default).
 *   6. After sending, the signature is watched (bounded); an on-chain failure
 *      counts against the user, the client and the signing wallet.
 * Plus a kill switch (SPONSOR_DISABLED), read on every request.
 */
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import {
  address,
  assertIsFullySignedTransaction,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  fetchAddressesForLookupTables,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
  type Address,
  type KeyPairSigner,
  type Transaction,
} from "@solana/kit";
import { FileBudget, MemoryBudget, RedisBudget, RespClient, type BudgetStore } from "./budget.js";
import { LAUNCH_PROGRAM, PERPS_PROGRAM } from "./graduation.js";
import { hmacSessionAuth, type Authenticator } from "./session.js";
import {
  bigintJson,
  clientIp,
  decodeWire,
  quoteAndSimulate,
  refuse,
  rpcRetry,
  type Accepted,
  type Ix,
  type Refusal,
  type SimulationRpc,
} from "./txpolicy.js";

export type { Accepted, Refusal };

export const SPONSOR_PROGRAMS = {
  launch: LAUNCH_PROGRAM,
  perps: PERPS_PROGRAM,
  /** Jupiter Swap (aggregator v6). Confirmed on developers.jup.ag (swap-instructions example, common-errors page). */
  jupiter: address("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"),
  pump: address("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"),
  pumpSwap: address("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"),
  system: address("11111111111111111111111111111111"),
  token: address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  token2022: address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
  ata: address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
  computeBudget: address("ComputeBudget111111111111111111111111111111"),
} as const;

/**
 * Other Jupiter programs, not allowlisted by default. The order engine
 * (JupiterZ RFQ settlement) is listed as "Order Engine" in developers.jup.ag's
 * llms.txt index; add it to `programs` only if the app routes RFQ fills.
 */
export const JUPITER_OPTIONAL = {
  orderEngine: address("61DFfeTKM7trxYcPQCM78bJ794ddZprZpAwAnLiwTpYH"),
} as const;

/**
 * Programs that make a transaction worth sponsoring: at least one top-level
 * instruction must call one of these. System, Token, ATA and ComputeBudget
 * are allowed only alongside them, so the sponsor is not a free transfer service.
 */
export const APP_PROGRAMS: Address[] = [SPONSOR_PROGRAMS.launch, SPONSOR_PROGRAMS.perps, SPONSOR_PROGRAMS.jupiter, SPONSOR_PROGRAMS.pump, SPONSOR_PROGRAMS.pumpSwap];

export interface SponsorPolicy {
  /** Programs a sponsored transaction may call (top level). */
  programs: Address[];
  /** At least one top-level instruction must call one of these. */
  appPrograms: Address[];
  /** Max compute-unit limit (explicit, or the runtime default of 200k per instruction). */
  maxComputeUnits: number;
  /** Max SetComputeUnitPrice, in micro-lamports per CU. */
  maxMicroLamportsPerCu: bigint;
  /** Max priority fee in lamports (price x limit). */
  maxPriorityFeeLamports: bigint;
  /** Max network fee (base + priority) the RPC quotes. */
  maxFeeLamports: bigint;
  /** Allowed balance drop beyond the fee. The fee payer may not appear in instructions, so 0 is expected. */
  maxRentLamports: bigint;
  /** Max signatures (each costs a base fee). */
  maxSignatures: number;
  /** Hourly requests per signing wallet and per app user (every request past the caller checks counts). */
  perUserPerHour: number;
  /** Daily lamports per signing wallet and per app user. */
  perUserDailyLamports: bigint;
  perClientPerHour: number;
  globalDailyLamports: bigint;
  /** On-chain failures in the last hour that block a user, client or wallet until the hour rolls over. */
  maxFailuresPerHour: number;
  /** Fee recovery: each transaction must transfer at least `minLamports` to `wallet` (System Transfer). */
  feeRecovery?: { wallet: Address; minLamports: bigint };
}

/**
 * Defaults. Fee caps are sized for app trades, not for winning congested
 * auctions:
 *   - maxComputeUnits 600k: a Pump/PumpSwap trade needs ~100-150k, a
 *     multi-hop Jupiter route up to ~500k.
 *   - maxMicroLamportsPerCu 200k (0.2 lamport/CU) and maxPriorityFeeLamports
 *     50k (0.00005 SOL): well above typical priority fees, but one request can
 *     no longer burn 0.0005 SOL.
 *   - maxFeeLamports 70k: the priority cap plus four 5k signatures. This is
 *     also the worst case reserved per request against the daily budgets.
 * Raise them through `policy` (or SPONSOR_* env) only with monitoring.
 */
export const DEFAULT_POLICY: SponsorPolicy = {
  programs: Object.values(SPONSOR_PROGRAMS),
  appPrograms: APP_PROGRAMS,
  maxComputeUnits: 600_000,
  maxMicroLamportsPerCu: 200_000n,
  maxPriorityFeeLamports: 50_000n,
  maxFeeLamports: 70_000n,
  maxRentLamports: 0n,
  maxSignatures: 4,
  perUserPerHour: 30,
  perUserDailyLamports: 5_000_000n, // 0.005 SOL
  perClientPerHour: 120,
  globalDailyLamports: 2_000_000_000n, // 2 SOL
  maxFailuresPerHour: 3,
};

/** The RPC methods the sponsor uses, so tests can pass a fake. */
export type SponsorRpc = SimulationRpc & {
  isBlockhashValid(blockhash: never, c?: { commitment: "confirmed" }): { send(): Promise<{ value: boolean }> };
  getSignatureStatuses(signatures: never): { send(): Promise<{ value: readonly ({ err: unknown; confirmationStatus: string | null } | null)[] }> };
};

export interface SponsorOptions {
  policy?: Partial<SponsorPolicy>;
  /** Where counts and spend live; defaults to this process's memory. */
  budget?: BudgetStore;
  /** Kill switch, read on every request. Defaults to the SPONSOR_DISABLED env var. */
  disabled?: () => boolean;
  /** Resolves address lookup tables. Without it, transactions using lookup tables are refused. */
  resolveLookupTables?: (tables: Address[]) => Promise<Record<Address, Address[]>>;
  /**
   * Confirmation watch after sending: polls getSignatureStatuses every
   * `pollMs` for at most `timeoutMs`. With `wait`, sponsor() waits for the
   * outcome (and reports it as `status`); otherwise it checks in the background.
   */
  confirm?: { timeoutMs?: number; pollMs?: number; wait?: boolean };
}

const truthy = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v ?? "");
export const envKillSwitch = () => truthy(process.env.SPONSOR_DISABLED);

// ---------------------------------------------------------------------------
// Static checks
// ---------------------------------------------------------------------------

type Verdict = { status: number; code: string; message: string; details?: Record<string, unknown> } | null;

const u32 = (d: Uint8Array, o: number) => Buffer.from(d.buffer, d.byteOffset, d.byteLength).readUInt32LE(o);
const u64 = (d: Uint8Array, o: number) => Buffer.from(d.buffer, d.byteOffset, d.byteLength).readBigUInt64LE(o);

/** Where the fee payer appears in an instruction, and a precise reason. */
function feePayerVerdict(ix: Ix, payer: Address): Verdict {
  const at = ix.accounts.flatMap((a, j) => (a.address === payer ? [j] : []));
  if (ix.programAddress === payer) return { status: 403, code: "fee_payer_as_program", message: "the fee payer cannot be invoked as a program" };
  if (at.length === 0) return null;
  const tag = ix.data[0];
  const isSource =
    (ix.programAddress === SPONSOR_PROGRAMS.system && [0, 2, 3, 11].includes(tag) && (at.includes(0) || (tag === 11 && at.includes(1)))) ||
    ((ix.programAddress === SPONSOR_PROGRAMS.token || ix.programAddress === SPONSOR_PROGRAMS.token2022) &&
      ((tag === 3 && (at.includes(0) || at.includes(2))) || (tag === 12 && (at.includes(0) || at.includes(3)))));
  if (isSource) return { status: 403, code: "fee_payer_transfer_source", message: "the fee payer cannot be the source or authority of a transfer", details: { accountIndex: at[0] } };
  return { status: 403, code: "fee_payer_writable", message: "the fee payer may appear only as fee payer, not in instruction accounts", details: { accountIndex: at[0] } };
}

type Budget = { unitLimit: number; microLamports: bigint; priorityLamports: bigint };

/** Parses ComputeBudget instructions and applies the caps. */
function computeBudgetVerdict(instructions: Ix[], P: SponsorPolicy): { ok: true; budget: Budget } | (NonNullable<Verdict> & { instruction?: number }) {
  let limit: number | undefined;
  let price: bigint | undefined;
  const seen = new Set<number>();
  for (const [i, ix] of instructions.entries()) {
    if (ix.programAddress !== SPONSOR_PROGRAMS.computeBudget) continue;
    const tag = ix.data[0];
    const len = { 1: 5, 2: 5, 3: 9, 4: 5 }[tag as 1 | 2 | 3 | 4];
    if (len === undefined || ix.data.length !== len) return { status: 400, code: "compute_budget_instruction", message: `Instruction ${i}: unsupported compute budget instruction`, instruction: i };
    if (seen.has(tag)) return { status: 400, code: "compute_budget_duplicate", message: `Instruction ${i}: duplicate compute budget instruction`, instruction: i };
    seen.add(tag);
    if (tag === 2) limit = u32(ix.data, 1);
    if (tag === 3) price = u64(ix.data, 1);
  }
  const others = instructions.filter((ix) => ix.programAddress !== SPONSOR_PROGRAMS.computeBudget).length;
  const unitLimit = limit ?? Math.min(1_400_000, 200_000 * others);
  if (unitLimit > P.maxComputeUnits) {
    return { status: 403, code: "compute_units_too_high", message: `Compute unit limit ${unitLimit} is over the ${P.maxComputeUnits} cap.`, details: { requested: unitLimit, cap: P.maxComputeUnits } };
  }
  const microLamports = price ?? 0n;
  if (microLamports > P.maxMicroLamportsPerCu) {
    return { status: 403, code: "priority_fee_too_high", message: `Priority fee ${microLamports} micro-lamports/CU is over the ${P.maxMicroLamportsPerCu} cap.`, details: { microLamports, cap: P.maxMicroLamportsPerCu } };
  }
  const priorityLamports = (microLamports * BigInt(unitLimit) + 999_999n) / 1_000_000n;
  if (priorityLamports > P.maxPriorityFeeLamports) {
    return { status: 403, code: "priority_fee_too_high", message: `Priority fee ${priorityLamports} lamports is over the ${P.maxPriorityFeeLamports} cap.`, details: { priorityLamports, cap: P.maxPriorityFeeLamports } };
  }
  return { ok: true, budget: { unitLimit, microLamports, priorityLamports } };
}

/** Lamports a System Transfer (2) sends to `dest`, else 0. */
export function lamportsTo(ix: Ix, dest: Address): bigint {
  if (ix.programAddress !== SPONSOR_PROGRAMS.system || ix.data.length !== 12 || u32(ix.data, 0) !== 2) return 0n;
  return ix.accounts[1]?.address === dest ? u64(ix.data, 4) : 0n;
}

// ---------------------------------------------------------------------------
// Sponsor
// ---------------------------------------------------------------------------

type Pre = { ok: true; tx: Transaction; users: Address[]; tables: Address[]; blockhash: string };
type Limit = { base: string; limit: number; code: string; message: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Sponsor {
  readonly policy: SponsorPolicy;
  private budget: BudgetStore;
  private allowed: Set<Address>;
  private app: Set<Address>;
  /** Requests between their limit check and their record, per key. */
  private inflight = new Map<string, { count: number; lamports: bigint }>();
  private watching = new Set<Promise<unknown>>();
  private salt = randomBytes(32);
  private saltDay = Math.floor(Date.now() / 86_400_000);

  constructor(private rpc: SponsorRpc, readonly signer: KeyPairSigner, private opts: SponsorOptions = {}) {
    this.policy = { ...DEFAULT_POLICY, ...opts.policy };
    this.budget = opts.budget ?? new MemoryBudget();
    this.allowed = new Set(this.policy.programs);
    this.app = new Set(this.policy.appPrograms);
    if (this.policy.feeRecovery?.wallet === signer.address) throw new Error("The fee recovery wallet must not be the fee payer.");
    if (this.app.size === 0) throw new Error("appPrograms must not be empty.");
  }

  get disabled(): boolean {
    return (this.opts.disabled ?? envKillSwitch)();
  }

  /** Daily-rotating HMAC of a client identifier (IP). The salt is never stored. */
  clientKey(ip: string): string {
    const d = Math.floor(Date.now() / 86_400_000);
    if (d !== this.saltDay) {
      this.salt = randomBytes(32);
      this.saltDay = d;
    }
    return "c:" + createHmac("sha256", this.salt).update(ip).digest("hex").slice(0, 32);
  }

  /** Worst-case cost of one transaction, reserved against budgets before simulation. */
  private get worstCase() {
    return this.policy.maxFeeLamports + this.policy.maxRentLamports;
  }

  /**
   * Static checks from the wire alone: no RPC, no lookup tables. Program
   * addresses and signers are always static keys, so the allowlist, the
   * app-program rule, the nonce ban, compute caps and signature presence can
   * all be checked here.
   */
  precheck(wireBase64: string): Pre | Refusal {
    const P = this.policy;
    const payer = this.signer.address;
    let tx: Transaction;
    let compiled: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]>;
    try {
      tx = getTransactionDecoder().decode(Buffer.from(wireBase64, "base64"));
      compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    } catch (e) {
      return refuse(400, "malformed", "Could not decode the transaction.", { internal: String((e as Error)?.message ?? e) });
    }
    if (compiled.version !== "legacy" && compiled.version !== 0) return refuse(400, "unsupported_version", "Only legacy and v0 transactions are sponsored.");
    const keys = compiled.staticAccounts;
    if (keys[0] !== payer) return refuse(400, "fee_payer", "The sponsor must be the fee payer.");
    const slots = Object.keys(tx.signatures) as Address[];
    if (slots.length > P.maxSignatures) return refuse(400, "too_many_signers", `At most ${P.maxSignatures} signatures.`, { details: { signatures: slots.length } });
    const users = slots.filter((a) => a !== payer);
    if (users.length === 0) return refuse(400, "no_signer", "The user must sign too.");
    if (users.some((u) => !tx.signatures[u])) return refuse(400, "missing_signature", "Sign with every required key before sending.");

    const ixs: Ix[] = [];
    for (const [i, c] of compiled.instructions.entries()) {
      const programAddress = keys[c.programAddressIndex];
      if (!programAddress) return refuse(400, "malformed", "Could not decode the transaction.", { internal: `instruction ${i}: program index ${c.programAddressIndex} is not a static key` });
      ixs.push({ programAddress, accounts: [], data: new Uint8Array(c.data ?? []) });
    }
    if (ixs.length === 0) return refuse(400, "empty", "No instructions.");
    for (const [i, ix] of ixs.entries()) {
      if (ix.programAddress === payer) return refuse(403, "fee_payer_as_program", `Instruction ${i}: the fee payer cannot be invoked as a program`, { instruction: i });
      if (!this.allowed.has(ix.programAddress)) {
        return refuse(403, "program_not_allowed", `Instruction ${i}: program ${ix.programAddress} is not sponsored`, { instruction: i, details: { program: ix.programAddress } });
      }
      // System AdvanceNonceAccount (4): a durable-nonce transaction never expires.
      if (ix.programAddress === SPONSOR_PROGRAMS.system && ix.data.length >= 4 && u32(ix.data, 0) === 4) {
        return refuse(403, "durable_nonce", `Instruction ${i}: durable-nonce transactions are not sponsored`, { instruction: i });
      }
    }
    if (!ixs.some((ix) => this.app.has(ix.programAddress))) {
      return refuse(403, "no_app_instruction", "Only Ringside, Jupiter and Pump trades are sponsored, not plain transfers.");
    }
    const cb = computeBudgetVerdict(ixs, P);
    if (!("ok" in cb)) return refuse(cb.status, cb.code, cb.message, { instruction: cb.instruction, details: cb.details });

    const tables = compiled.version === 0 ? (compiled.addressTableLookups ?? []).map((l) => l.lookupTableAddress) : [];
    if (tables.length && !this.opts.resolveLookupTables) return refuse(400, "lookup_tables", "Address lookup tables are not accepted.");
    return { ok: true, tx, users, tables, blockhash: String(compiled.lifetimeToken) };
  }

  /** Static policy checks (no RPC beyond lookup tables). Exported for tests. */
  async inspect(wireBase64: string) {
    const pre = this.precheck(wireBase64);
    if (!pre.ok) return pre;
    return this.inspectResolved(wireBase64, pre);
  }

  /** Resolves lookup tables, then the checks that need every account. */
  private async inspectResolved(wireBase64: string, pre: Pre) {
    const P = this.policy;
    const payer = this.signer.address;
    let lookups: Record<Address, Address[]> | undefined;
    if (pre.tables.length) {
      try {
        lookups = await this.opts.resolveLookupTables!(pre.tables);
      } catch (e) {
        return refuse(400, "lookup_tables", "Could not resolve the address lookup tables.", { internal: String((e as Error)?.message ?? e) });
      }
    }
    const d = decodeWire(wireBase64, payer, { lookups, feePayerName: "sponsor" });
    if (!d.ok) return d;
    for (const [i, ix] of d.instructions.entries()) {
      const v = feePayerVerdict(ix, payer);
      if (v) return refuse(v.status, v.code, `Instruction ${i}: ${v.message}`, { instruction: i, details: v.details });
      if (!this.allowed.has(ix.programAddress)) {
        return refuse(403, "program_not_allowed", `Instruction ${i}: program ${ix.programAddress} is not sponsored`, { instruction: i, details: { program: ix.programAddress } });
      }
    }
    const cb = computeBudgetVerdict(d.instructions, P);
    if (!("ok" in cb)) return refuse(cb.status, cb.code, cb.message, { instruction: cb.instruction, details: cb.details });

    const fr = P.feeRecovery;
    if (fr && fr.minLamports > 0n) {
      const paid = d.instructions.reduce((s, ix) => s + lamportsTo(ix, fr.wallet), 0n);
      if (paid < fr.minLamports) {
        return refuse(402, "fee_recovery", `Include a transfer of at least ${fr.minLamports} lamports to ${fr.wallet} (the sponsorship fee).`, { details: { wallet: fr.wallet, minLamports: fr.minLamports, paid } });
      }
    }
    return { ok: true as const, tx: d.tx, instructions: d.instructions, users: pre.users, compute: cb.budget, blockhash: pre.blockhash };
  }

  private pend(k: string) {
    return this.inflight.get(k) ?? { count: 0, lamports: 0n };
  }

  private bump(keys: string[], count: number, lamports: bigint) {
    for (const k of keys) {
      const p = this.pend(k);
      const next = { count: p.count + count, lamports: p.lamports + lamports };
      if (next.count <= 0) this.inflight.delete(k);
      else this.inflight.set(k, next);
    }
  }

  /**
   * Hourly count and failure-block check for each key; if all pass, the
   * request is counted at once (before any RPC work), so refused and failing
   * requests use up the limit too.
   */
  private async admit(limits: Limit[]): Promise<Refusal | null> {
    const P = this.policy;
    const stored = await Promise.all(
      limits.map(async (l) => ({ l, count: await this.budget.countLastHour(`r:${l.base}`), failures: await this.budget.countLastHour(`f:${l.base}`) })),
    );
    // Synchronous from here until the in-flight bump.
    for (const { l, count, failures } of stored) {
      if (failures >= P.maxFailuresPerHour) return refuse(429, "too_many_failures", "Too many of your recent transactions failed on chain. Try again later.");
      if (count + this.pend(`r:${l.base}`).count >= l.limit) return refuse(429, l.code, l.message);
    }
    const keys = limits.map((l) => `r:${l.base}`);
    this.bump(keys, 1, 0n);
    try {
      await this.budget.record(keys, 0n);
    } finally {
      this.bump(keys, -1, 0n);
    }
    return null;
  }

  /** Daily spend checks; reserves this request's worst case (no await between check and reserve). */
  private async reserveSpend(keys: string[]): Promise<Refusal | null> {
    const P = this.policy;
    const spent = await Promise.all(keys.map((k) => this.budget.spentToday(k)));
    for (const [i, k] of keys.entries()) {
      const total = spent[i] + this.pend(k).lamports + this.worstCase;
      if (k === "global") {
        if (total > P.globalDailyLamports) return refuse(503, "global_budget", "Gas sponsorship is paused for today.");
      } else if (total > P.perUserDailyLamports) {
        return refuse(429, "user_budget", "This wallet's daily gas sponsorship is used up.");
      }
    }
    this.bump(keys, 1, this.worstCase);
    return null;
  }

  /**
   * Sponsors one transaction. `client` is the caller's client key (see
   * clientKey); `userId` the authenticated app user, if any. Limits are kept
   * per user, per client and per signing wallet.
   */
  async sponsor(wireBase64: string, client: string, userId?: string): Promise<Accepted | Refusal> {
    if (this.disabled) return refuse(503, "disabled", "Gas sponsorship is switched off.");
    const P = this.policy;
    const userBase = userId ? [`id:${userId}`] : [];

    // 1. The caller: hourly counts and failure blocks, counted now.
    let limited = await this.admit([
      ...userBase.map((base) => ({ base, limit: P.perUserPerHour, code: "user_rate", message: "Too many sponsored transactions for this account. Try later." })),
      { base: client, limit: P.perClientPerHour, code: "client_rate", message: "Too many requests. Try later." },
    ]);
    if (limited) return limited;

    // 2. Decode and static policy, no RPC.
    const pre = this.precheck(wireBase64);
    if (!pre.ok) return pre;

    // 3. The signing wallets: hourly counts and failure blocks, then daily budgets.
    const walletBase = pre.users.map((u) => `u:${u}`);
    limited = await this.admit(walletBase.map((base) => ({ base, limit: P.perUserPerHour, code: "user_rate", message: "Too many sponsored transactions for this wallet. Try later." })));
    if (limited) return limited;
    const spendKeys = [...walletBase, ...userBase, "global"];
    limited = await this.reserveSpend(spendKeys);
    if (limited) return limited;

    try {
      // 4. RPC work.
      const d = await this.inspectResolved(wireBase64, pre);
      if (!d.ok) return d;
      const fresh = await rpcRetry(() => this.rpc.isBlockhashValid(d.blockhash as never, { commitment: "confirmed" }).send());
      if (fresh.value !== true) return refuse(400, "stale_blockhash", "Use a recent blockhash. Rebuild and resend.");

      const signed = await partiallySignTransaction([this.signer.keyPair], d.tx);
      try {
        assertIsFullySignedTransaction(signed);
      } catch {
        return refuse(400, "missing_signature", "Sign with every required key before sending.");
      }
      const wire = getBase64EncodedWireTransaction(signed);
      const q = await quoteAndSimulate(this.rpc, this.signer.address, signed.messageBytes, wire, P.maxFeeLamports);
      if (!q.ok) return q;
      if (q.spent > q.fee + P.maxRentLamports) {
        return refuse(403, "spend_too_high", `Would cost the sponsor ${q.spent} lamports (fee ${q.fee}, allowance ${P.maxRentLamports}).`, {
          details: { spent: q.spent, fee: q.fee, allowance: P.maxRentLamports },
        });
      }
      let signature: string;
      try {
        signature = await rpcRetry(() => this.rpc.sendTransaction(wire as never, { encoding: "base64", preflightCommitment: "confirmed" }).send());
      } catch (e) {
        // The transaction may have reached a leader anyway: count the spend.
        await this.budget.record(spendKeys, q.spent);
        throw e;
      }
      await this.budget.record(spendKeys, q.spent);
      signature = signature ?? getSignatureFromTransaction(signed);
      const outcome = this.watch(signature, [...userBase, client, ...walletBase].map((k) => `f:${k}`));
      const out: Accepted = { ok: true, signature, spentLamports: q.spent };
      if (this.opts.confirm?.wait) out.status = await outcome;
      return out;
    } finally {
      this.bump(spendKeys, -1, -this.worstCase);
    }
  }

  /**
   * Polls the signature until it confirms, fails or `timeoutMs` passes. A
   * failure (the fee was paid but the transaction, fee recovery included,
   * reverted) is counted against every key in `failKeys`.
   */
  private watch(signature: string, failKeys: string[]): Promise<"confirmed" | "failed" | "unknown"> {
    const { timeoutMs = 60_000, pollMs = 2_000 } = this.opts.confirm ?? {};
    const task = (async () => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        await sleep(pollMs);
        const st = (await rpcRetry(() => this.rpc.getSignatureStatuses([signature] as never).send())).value[0];
        if (st?.err) {
          console.warn(`[sponsor] ${signature} failed on chain`);
          await this.budget.record(failKeys, 0n);
          return "failed" as const;
        }
        if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return "confirmed" as const;
        if (Date.now() >= deadline) return "unknown" as const;
      }
    })().catch((e) => {
      console.error(`[sponsor] confirming ${signature}: ${(e as Error)?.message ?? e}`);
      return "unknown" as const;
    });
    this.watching.add(task);
    void task.finally(() => this.watching.delete(task));
    return task;
  }

  /** Resolves once every background confirmation check has finished (for tests and shutdown). */
  async settled() {
    while (this.watching.size) await Promise.all([...this.watching]);
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const MAX_BODY = 16 * 1024;

export interface SponsorServerOptions {
  /** Identifies the app user; null refuses with 401. Required unless `allowAnonymous`. */
  authenticate?: Authenticator;
  /** Sponsor without authentication (devnet only): limits fall back to client IP and wallet. */
  allowAnonymous?: boolean;
  /** The app origin allowed by CORS. Unset: no CORS header, so browsers allow same-origin only. */
  allowOrigin?: string;
  /** Number of trusted reverse proxies in front (true = 1). The client IP is that many hops from the right of X-Forwarded-For. */
  trustProxy?: boolean | number;
}

export function createSponsorServer(sponsor: Sponsor, opts: SponsorServerOptions = {}) {
  if (!opts.authenticate && !opts.allowAnonymous) {
    throw new Error("The sponsor needs an authenticator (set SPONSOR_SESSION_SECRET); SPONSOR_ALLOW_ANON=1 is for devnet only.");
  }
  const hops = opts.trustProxy === true ? 1 : Math.max(0, Math.floor(Number(opts.trustProxy || 0)));
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, {
      "content-type": "application/json",
      ...(opts.allowOrigin
        ? {
            "access-control-allow-origin": opts.allowOrigin,
            "access-control-allow-headers": "content-type, authorization",
            "access-control-allow-methods": "GET, POST, OPTIONS",
            vary: "Origin",
          }
        : {}),
      "cache-control": "no-store",
    });
    res.end(status === 204 ? undefined : JSON.stringify(body, bigintJson));
  };

  return createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") return json(res, 204, {});
      if (req.method === "GET" && req.url === "/health") {
        const P = sponsor.policy;
        return json(res, 200, {
          ok: true,
          disabled: sponsor.disabled,
          feePayer: sponsor.signer.address,
          feeRecovery: P.feeRecovery ?? null,
          limits: { maxComputeUnits: P.maxComputeUnits, maxMicroLamportsPerCu: P.maxMicroLamportsPerCu, maxPriorityFeeLamports: P.maxPriorityFeeLamports },
        });
      }
      if (req.method === "POST" && req.url === "/sponsor") {
        // Cheapest first: authenticate before reading the body.
        let userId: string | undefined;
        if (opts.authenticate) {
          let who: { userId: string } | null;
          try {
            who = await opts.authenticate(req);
          } catch (e) {
            console.error(`[sponsor] authenticator error: ${(e as Error)?.message ?? e}`);
            return json(res, 503, { ok: false, code: "auth_unavailable", message: "Sign-in check is unavailable. Retry shortly." });
          }
          if (!who?.userId) return json(res, 401, { ok: false, code: "unauthenticated", message: "Sign in to use gas sponsorship." });
          userId = who.userId;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const c of req) {
          size += (c as Buffer).length;
          if (size > MAX_BODY) return json(res, 413, { ok: false, code: "body_too_large", message: "Request body is too large." });
          chunks.push(c as Buffer);
        }
        let body: { transaction?: unknown };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return json(res, 400, { ok: false, code: "bad_json", message: "Body must be JSON." });
        }
        if (typeof body?.transaction !== "string") return json(res, 400, { ok: false, code: "missing_transaction", message: "Send { transaction: <base64> }." });
        const out = await sponsor.sponsor(body.transaction, sponsor.clientKey(clientIp(req, hops)), userId);
        if (out.ok) {
          console.log(`[sponsor] sent ${out.signature} spent=${out.spentLamports}`);
          return json(res, 200, { ok: true, signature: out.signature, spentLamports: out.spentLamports, ...(out.status ? { status: out.status } : {}) });
        }
        // Detail stays in the log; the client gets the structured code only.
        console.log(`[sponsor] refused ${out.code}${out.internal ? `: ${out.internal}` : ""}`);
        const { status, code, message, instruction, details } = out;
        return json(res, status, { ok: false, code, message, ...(instruction !== undefined ? { instruction } : {}), ...(details ? { details } : {}) });
      }
      return json(res, 404, { ok: false, code: "not_found", message: "Not found." });
    } catch (e) {
      console.error(`[sponsor] error: ${(e as Error).message}`);
      if (/429|Too Many Requests/i.test((e as Error).message)) return json(res, 503, { ok: false, code: "rpc_busy", message: "The RPC provider is rate-limiting. Retry shortly." });
      return json(res, 500, { ok: false, code: "internal", message: "Internal error." });
    }
  });
}

/** Reads a Solana CLI keypair file without ever echoing its contents (JSON.parse errors can quote input). */
export function loadKeypairFile(path: string): Uint8Array {
  const mode = statSync(path).mode;
  if (mode & 0o077) console.warn("[sponsor] WARNING: the keypair file is readable by group or others; chmod 600 it");
  let bytes: unknown;
  try {
    bytes = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("SPONSOR_KEYPAIR_PATH is not a Solana CLI keypair file (JSON array of 64 numbers).");
  }
  if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b < 256)) {
    throw new Error("SPONSOR_KEYPAIR_PATH is not a Solana CLI keypair file (JSON array of 64 numbers).");
  }
  return Uint8Array.from(bytes as number[]);
}

const USAGE = `Set RPC_URL, SPONSOR_KEYPAIR_PATH and SPONSOR_SESSION_SECRET (>= 32 bytes).
Optional: SPONSOR_PORT, SPONSOR_CORS_ORIGIN (the app origin), TRUST_PROXY=1 [+ TRUST_PROXY_HOPS],
SPONSOR_REDIS_URL (shared limits) or SPONSOR_STATE_FILE (single instance, default ./sponsor-state.json),
SPONSOR_DAILY_LAMPORTS, SPONSOR_MAX_FAILURES, SPONSOR_FEE_WALLET + SPONSOR_FEE_LAMPORTS, SPONSOR_LOOKUP_TABLES=1,
SPONSOR_DISABLED=1, SPONSOR_ALLOW_ANON=1 (devnet only: no authentication).`;

async function main() {
  const env = process.env;
  const { RPC_URL, SPONSOR_PORT, SPONSOR_KEYPAIR_PATH, SPONSOR_DAILY_LAMPORTS, SPONSOR_FEE_WALLET, SPONSOR_FEE_LAMPORTS, SPONSOR_LOOKUP_TABLES } = env;
  if (!RPC_URL || !SPONSOR_KEYPAIR_PATH) {
    console.error(USAGE);
    process.exit(1);
  }

  // Authentication: required, unless anonymous mode is switched on for devnet.
  let authenticate: Authenticator | undefined;
  const anon = truthy(env.SPONSOR_ALLOW_ANON);
  // SESSION_SECRET is shared with the social backend and copy engine; SPONSOR_SESSION_SECRET overrides it.
  const sessionSecret = env.SPONSOR_SESSION_SECRET || env.SESSION_SECRET;
  if (sessionSecret) {
    if (Buffer.byteLength(sessionSecret, "utf8") < 32) {
      console.error("The session secret (SESSION_SECRET or SPONSOR_SESSION_SECRET) must be at least 32 bytes.");
      process.exit(1);
    }
    authenticate = hmacSessionAuth(sessionSecret);
  } else if (anon) {
    if (/mainnet/i.test(RPC_URL)) {
      console.error("SPONSOR_ALLOW_ANON=1 is refused on mainnet. Set SPONSOR_SESSION_SECRET.");
      process.exit(1);
    }
    console.warn("[sponsor] ******************************************************************");
    console.warn("[sponsor] WARNING: SPONSOR_ALLOW_ANON=1 - anyone can spend this fee payer's SOL.");
    console.warn("[sponsor] WARNING: devnet only. Set SPONSOR_SESSION_SECRET for any real deployment.");
    console.warn("[sponsor] ******************************************************************");
  } else {
    console.error("Refusing to start without authentication: set SPONSOR_SESSION_SECRET (or SPONSOR_ALLOW_ANON=1 on devnet).");
    process.exit(1);
  }

  // Budgets: shared in Redis, or persisted to a file with a single-instance lock.
  let budget: BudgetStore;
  let where: string;
  if (env.SPONSOR_REDIS_URL) {
    budget = new RedisBudget(new RespClient(env.SPONSOR_REDIS_URL), "ringside:sponsor:");
    where = "Redis (shared)";
  } else {
    const file = env.SPONSOR_STATE_FILE ?? "sponsor-state.json";
    try {
      budget = new FileBudget(file);
    } catch (e) {
      console.error(`[sponsor] ${(e as Error).message}`);
      process.exit(1);
    }
    where = `${file} (single instance)`;
  }

  const hops = truthy(env.TRUST_PROXY) ? Math.max(1, Number(env.TRUST_PROXY_HOPS ?? 1) || 1) : 0;
  if (!env.SPONSOR_CORS_ORIGIN) console.warn("[sponsor] SPONSOR_CORS_ORIGIN is not set: browsers on other origins cannot call the sponsor");
  else if (env.SPONSOR_CORS_ORIGIN === "*") console.warn("[sponsor] WARNING: SPONSOR_CORS_ORIGIN=* lets any site call the sponsor");

  const signer = await createKeyPairSignerFromBytes(loadKeypairFile(SPONSOR_KEYPAIR_PATH));
  const rpc = createSolanaRpc(RPC_URL);
  const sponsor = new Sponsor(rpc as unknown as SponsorRpc, signer, {
    budget,
    policy: {
      ...(SPONSOR_DAILY_LAMPORTS ? { globalDailyLamports: BigInt(SPONSOR_DAILY_LAMPORTS) } : {}),
      ...(env.SPONSOR_MAX_FAILURES ? { maxFailuresPerHour: Number(env.SPONSOR_MAX_FAILURES) } : {}),
      ...(SPONSOR_FEE_WALLET ? { feeRecovery: { wallet: address(SPONSOR_FEE_WALLET), minLamports: BigInt(SPONSOR_FEE_LAMPORTS ?? "10000") } } : {}),
    },
    resolveLookupTables: truthy(SPONSOR_LOOKUP_TABLES) ? (t) => fetchAddressesForLookupTables(t, rpc, { commitment: "confirmed" }) : undefined,
  });
  const P = sponsor.policy;
  console.log(
    `[sponsor] auth ${authenticate ? "session tokens" : "NONE (anonymous)"}; limits in ${where}; global ${P.globalDailyLamports} lamports/day; caps ${P.maxComputeUnits} CU, ${P.maxMicroLamportsPerCu} uL/CU, ${P.maxFeeLamports} lamports fee; block after ${P.maxFailuresPerHour} failures/h; fee recovery ${P.feeRecovery ? `${P.feeRecovery.minLamports} to ${P.feeRecovery.wallet}` : "off"}; lookup tables ${truthy(SPONSOR_LOOKUP_TABLES) ? "on" : "off"}; proxy hops ${hops}; ${sponsor.disabled ? "DISABLED" : "enabled"}`,
  );
  const port = Number(SPONSOR_PORT ?? 8788);
  createSponsorServer(sponsor, { authenticate, allowAnonymous: anon && !authenticate, allowOrigin: env.SPONSOR_CORS_ORIGIN, trustProxy: hops })
    .listen(port, () => console.log(`[sponsor] ${signer.address} listening on :${port}`));
}

if (process.argv[1]?.endsWith("sponsor.js") || process.argv[1]?.endsWith("sponsor.ts")) void main();
