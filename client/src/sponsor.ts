/**
 * Ringside gas sponsor.
 *
 * Users of the social trading app sign in with an embedded wallet and never
 * hold SOL for fees: the app builds each transaction with the sponsor as fee
 * payer, the user signs their part, and POSTs it here. The sponsor co-signs
 * as fee payer only if every check passes, then sends it.
 *
 * Unlike the relayer (relayer.ts), the sponsor never pays rent: its key may
 * appear in a transaction only as the fee payer, so the most a transaction
 * can cost it is the network fee. What bounds the loss:
 *   1. Program allowlist (Ringside launch and perps, Jupiter, Pump, PumpSwap,
 *      System, Token, Token-2022, ATA, ComputeBudget). Anything else is refused.
 *   2. The fee payer may not appear in any instruction's accounts. Account
 *      roles are per message, so any appearance would make it writable and a
 *      signer for that instruction (a transfer source, a rent payer, ...).
 *   3. Caps on compute units, priority fee price and total priority fee, and
 *      on the network fee quoted by the RPC.
 *   4. Simulation with signatures verified: the fee payer's balance may drop
 *      by at most the fee plus `maxRentLamports` (0 by default).
 *   5. Per-user and per-client hourly counts, per-user and global daily
 *      lamport budgets (with in-flight requests reserved), and a kill switch
 *      (SPONSOR_DISABLED).
 *   6. Optional fee recovery: a System transfer of at least N lamports from
 *      the user to our fee wallet.
 */
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  address,
  assertIsFullySignedTransaction,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  fetchAddressesForLookupTables,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  partiallySignTransaction,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import { MemoryBudget, type BudgetStore } from "./budget.js";
import { LAUNCH_PROGRAM, PERPS_PROGRAM } from "./graduation.js";
import {
  bigintJson,
  decodeWire,
  lookupTablesOf,
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

export interface SponsorPolicy {
  /** Programs a sponsored transaction may call (top level). */
  programs: Address[];
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
  perUserPerHour: number;
  perUserDailyLamports: bigint;
  perClientPerHour: number;
  globalDailyLamports: bigint;
  /** Fee recovery: each transaction must transfer at least `minLamports` to `wallet` (System Transfer). */
  feeRecovery?: { wallet: Address; minLamports: bigint };
}

export const DEFAULT_POLICY: SponsorPolicy = {
  programs: Object.values(SPONSOR_PROGRAMS),
  maxComputeUnits: 800_000,
  maxMicroLamportsPerCu: 1_000_000n, // 1 lamport per CU
  maxPriorityFeeLamports: 500_000n, // 0.0005 SOL
  maxFeeLamports: 520_000n, // priority cap plus four signatures
  maxRentLamports: 0n,
  maxSignatures: 4,
  perUserPerHour: 30,
  perUserDailyLamports: 5_000_000n, // 0.005 SOL
  perClientPerHour: 120,
  globalDailyLamports: 2_000_000_000n, // 2 SOL
};

/** The RPC methods the sponsor uses, so tests can pass a fake. */
export type SponsorRpc = SimulationRpc;

export interface SponsorOptions {
  policy?: Partial<SponsorPolicy>;
  /** Where counts and spend live; defaults to this process's memory. */
  budget?: BudgetStore;
  /** Kill switch, read on every request. Defaults to the SPONSOR_DISABLED env var. */
  disabled?: () => boolean;
  /** Resolves address lookup tables. Without it, transactions using lookup tables are refused. */
  resolveLookupTables?: (tables: Address[]) => Promise<Record<Address, Address[]>>;
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

export class Sponsor {
  readonly policy: SponsorPolicy;
  private budget: BudgetStore;
  private allowed: Set<Address>;
  /** Requests between their limit check and their record, per key. */
  private inflight = new Map<string, { count: number; lamports: bigint }>();
  private salt = randomBytes(32);
  private saltDay = Math.floor(Date.now() / 86_400_000);

  constructor(private rpc: SponsorRpc, readonly signer: KeyPairSigner, private opts: SponsorOptions = {}) {
    this.policy = { ...DEFAULT_POLICY, ...opts.policy };
    this.budget = opts.budget ?? new MemoryBudget();
    this.allowed = new Set(this.policy.programs);
    if (this.policy.feeRecovery?.wallet === signer.address) throw new Error("The fee recovery wallet must not be the fee payer.");
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

  /** Static policy checks only (no RPC beyond lookup tables). Exported for tests. */
  async inspect(wireBase64: string) {
    const P = this.policy;
    const payer = this.signer.address;
    const tables = lookupTablesOf(wireBase64);
    let lookups: Record<Address, Address[]> | undefined;
    if (tables.length) {
      if (!this.opts.resolveLookupTables) return refuse(400, "lookup_tables", "Address lookup tables are not accepted.");
      try {
        lookups = await this.opts.resolveLookupTables(tables);
      } catch {
        return refuse(400, "lookup_tables", "Could not resolve the address lookup tables.");
      }
    }
    const d = decodeWire(wireBase64, payer, { lookups, feePayerName: "sponsor" });
    if (!d.ok) return d;
    if (d.signerSlots.length > P.maxSignatures) return refuse(400, "too_many_signers", `At most ${P.maxSignatures} signatures.`, { details: { signatures: d.signerSlots.length } });

    for (const [i, ix] of d.instructions.entries()) {
      const v = feePayerVerdict(ix, payer);
      if (v) return refuse(v.status, v.code, `Instruction ${i}: ${v.message}`, { instruction: i, details: v.details });
      if (!this.allowed.has(ix.programAddress)) {
        return refuse(403, "program_not_allowed", `Instruction ${i}: program ${ix.programAddress} is not sponsored`, { instruction: i, details: { program: ix.programAddress } });
      }
    }
    const cb = computeBudgetVerdict(d.instructions, P);
    if (!("ok" in cb)) return refuse(cb.status, cb.code, cb.message, { instruction: cb.instruction, details: cb.details });

    const users = d.signerSlots.filter((a) => a !== payer);
    if (users.length === 0) return refuse(400, "no_signer", "The user must sign too.");

    const fr = P.feeRecovery;
    if (fr && fr.minLamports > 0n) {
      const paid = d.instructions.reduce((s, ix) => s + lamportsTo(ix, fr.wallet), 0n);
      if (paid < fr.minLamports) {
        return refuse(402, "fee_recovery", `Include a transfer of at least ${fr.minLamports} lamports to ${fr.wallet} (the sponsorship fee).`, { details: { wallet: fr.wallet, minLamports: fr.minLamports, paid } });
      }
    }
    return { ok: true as const, tx: d.tx, instructions: d.instructions, users, compute: cb.budget };
  }

  /**
   * Reads stored counts and spend, then (with no await in between) checks
   * them plus in-flight reservations and reserves this request's worst case,
   * so concurrent requests cannot all pass the same check.
   */
  private async checkAndReserve(users: Address[], client: string, keys: string[]): Promise<Refusal | null> {
    const P = this.policy;
    const stored = await Promise.all(
      users.map(async (u) => ({ k: `u:${u}`, count: await this.budget.countLastHour(`u:${u}`), spent: await this.budget.spentToday(`u:${u}`) })),
    );
    const clientCount = await this.budget.countLastHour(client);
    const globalSpent = await this.budget.spentToday("global");
    // Synchronous from here.
    const pend = (k: string) => this.inflight.get(k) ?? { count: 0, lamports: 0n };
    for (const s of stored) {
      if (s.count + pend(s.k).count >= P.perUserPerHour) return refuse(429, "user_rate", "Too many sponsored transactions for this wallet. Try later.");
      if (s.spent + pend(s.k).lamports + this.worstCase > P.perUserDailyLamports) return refuse(429, "user_budget", "This wallet's daily gas sponsorship is used up.");
    }
    if (clientCount + pend(client).count >= P.perClientPerHour) return refuse(429, "client_rate", "Too many requests. Try later.");
    if (globalSpent + pend("global").lamports + this.worstCase > P.globalDailyLamports) return refuse(503, "global_budget", "Gas sponsorship is paused for today.");
    this.reserve(keys, 1);
    return null;
  }

  private reserve(keys: string[], sign: 1 | -1) {
    for (const k of keys) {
      const p = this.inflight.get(k) ?? { count: 0, lamports: 0n };
      const next = { count: p.count + sign, lamports: p.lamports + BigInt(sign) * this.worstCase };
      if (next.count <= 0) this.inflight.delete(k);
      else this.inflight.set(k, next);
    }
  }

  async sponsor(wireBase64: string, client: string): Promise<Accepted | Refusal> {
    if (this.disabled) return refuse(503, "disabled", "Gas sponsorship is switched off.");
    const P = this.policy;
    const d = await this.inspect(wireBase64);
    if (!d.ok) return d;

    // Limits before any RPC call.
    const keys = [...d.users.map((u) => `u:${u}`), client, "global"];
    const limited = await this.checkAndReserve(d.users, client, keys);
    if (limited) return limited;
    try {
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
        await this.budget.record(keys, q.spent);
        throw e;
      }
      await this.budget.record(keys, q.spent);
      return { ok: true, signature: signature ?? getSignatureFromTransaction(signed), spentLamports: q.spent };
    } finally {
      this.reserve(keys, -1);
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const MAX_BODY = 16 * 1024;

export function createSponsorServer(sponsor: Sponsor, opts: { allowOrigin?: string; trustProxy?: boolean } = {}) {
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "access-control-allow-origin": opts.allowOrigin ?? "*",
      "access-control-allow-headers": "content-type",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(body, bigintJson));
  };
  const ipOf = (req: IncomingMessage) =>
    (opts.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "") || req.socket.remoteAddress || "unknown";

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
        const out = await sponsor.sponsor(body.transaction, sponsor.clientKey(ipOf(req)));
        if (out.ok) {
          console.log(`[sponsor] sent ${out.signature} spent=${out.spentLamports}`);
          return json(res, 200, { ok: true, signature: out.signature, spentLamports: out.spentLamports });
        }
        console.log(`[sponsor] refused ${out.code}`);
        const { status, ...rest } = out;
        return json(res, status, rest);
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

async function main() {
  const { RPC_URL, SPONSOR_PORT, SPONSOR_KEYPAIR_PATH, SPONSOR_DAILY_LAMPORTS, SPONSOR_FEE_WALLET, SPONSOR_FEE_LAMPORTS, SPONSOR_LOOKUP_TABLES, ALLOW_ORIGIN, TRUST_PROXY } =
    process.env;
  if (!RPC_URL || !SPONSOR_KEYPAIR_PATH) {
    console.error(
      "Set RPC_URL and SPONSOR_KEYPAIR_PATH. Optional: SPONSOR_PORT, SPONSOR_DAILY_LAMPORTS, SPONSOR_DISABLED=1, SPONSOR_FEE_WALLET + SPONSOR_FEE_LAMPORTS, SPONSOR_LOOKUP_TABLES=1, ALLOW_ORIGIN, TRUST_PROXY=1",
    );
    process.exit(1);
  }
  const signer = await createKeyPairSignerFromBytes(loadKeypairFile(SPONSOR_KEYPAIR_PATH));
  const rpc = createSolanaRpc(RPC_URL);
  const sponsor = new Sponsor(rpc as unknown as SponsorRpc, signer, {
    policy: {
      ...(SPONSOR_DAILY_LAMPORTS ? { globalDailyLamports: BigInt(SPONSOR_DAILY_LAMPORTS) } : {}),
      ...(SPONSOR_FEE_WALLET ? { feeRecovery: { wallet: address(SPONSOR_FEE_WALLET), minLamports: BigInt(SPONSOR_FEE_LAMPORTS ?? "10000") } } : {}),
    },
    resolveLookupTables: truthy(SPONSOR_LOOKUP_TABLES) ? (t) => fetchAddressesForLookupTables(t, rpc, { commitment: "confirmed" }) : undefined,
  });
  const P = sponsor.policy;
  console.log(
    `[sponsor] global ${P.globalDailyLamports} lamports/day; fee recovery ${P.feeRecovery ? `${P.feeRecovery.minLamports} to ${P.feeRecovery.wallet}` : "off"}; lookup tables ${truthy(SPONSOR_LOOKUP_TABLES) ? "on" : "off"}; ${sponsor.disabled ? "DISABLED" : "enabled"}`,
  );
  const port = Number(SPONSOR_PORT ?? 8788);
  createSponsorServer(sponsor, { allowOrigin: ALLOW_ORIGIN, trustProxy: TRUST_PROXY === "1" }).listen(port, () => console.log(`[sponsor] ${signer.address} listening on :${port}`));
}

if (process.argv[1]?.endsWith("sponsor.js") || process.argv[1]?.endsWith("sponsor.ts")) void main();
