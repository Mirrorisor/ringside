/**
 * Ringside fee relayer.
 *
 * Pays SOL fees (and order rent) for fresh trading accounts so they never
 * need SOL from a traceable wallet. The client builds a transaction with the
 * relayer as fee payer, signs its own part, and POSTs it here. The relayer
 * co-signs only if every check passes, then submits it.
 *
 * What stops the relayer from being drained:
 *   1. Program allowlist: Rings (shielded pool, registry), Ringside perps
 *      request/cancel, ATA create-idempotent, SPL Token transfers, and
 *      compute budget. Anything else is refused.
 *   2. The relayer's key may appear in an instruction only where it pays
 *      rent (perps `payer`, ATA `payer`) or receives a refund. Never as a
 *      token authority or a system-transfer source.
 *   3. Simulation, with signatures verified: the relayer's balance may drop
 *      by at most `maxSpendLamports`, fee included, and the network fee alone
 *      is capped.
 *   4. Limits per trading account, per client and per day.
 *
 * Privacy: the relayer sees which trading account it sponsors, never which
 * shielded wallet funded it. It keeps no logs that tie an IP to an account.
 * Client keys for rate limiting are HMACs of the IP under a salt that rotates
 * daily and is never stored.
 */
import { createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MetadataStore, MAX_METADATA_BODY } from "./metadata.js";
import { MemoryBudget, RedisBudget, RespClient, type BudgetStore } from "./budget.js";
import {
  address,
  AccountRole,
  assertIsFullySignedTransaction,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  decompileTransactionMessage,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionSize,
  partiallySignTransaction,
  type Address,
  type KeyPairSigner,
  type Transaction,
} from "@solana/kit";
import { createHash } from "node:crypto";

export const PROGRAMS = {
  shieldedPool: address("ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW"),
  userRegistry: address("regy3WAeRXMYuMYxr5iK3Bf9Arr3PcxGxyzAddbiqDQ"),
  perps: address(process.env.PERPS_PROGRAM_ID ?? "DsZ69w3q25nRmAzJCRBMLbwZWN6NyVbYipTWsCAUsg1F"),
  token: address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  ata: address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
  computeBudget: address("ComputeBudget111111111111111111111111111111"),
};

const anchorIx = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8).toString("hex");
const PERPS_IX = { requestOrder: anchorIx("request_order"), cancelOrder: anchorIx("cancel_order") };

export interface RelayerLimits {
  /** Max network fee (base + priority) per transaction. */
  maxFeeLamports: bigint;
  /** Max total drop in the relayer's balance per transaction, fee and rent included. */
  maxSpendLamports: bigint;
  perAccountPerHour: number;
  perAccountDailyLamports: bigint;
  perClientPerHour: number;
  globalDailyLamports: bigint;
}

export const DEFAULT_LIMITS: RelayerLimits = {
  maxFeeLamports: 200_000n,
  maxSpendLamports: 5_000_000n, // 0.005 SOL: fee plus one position's rent
  perAccountPerHour: 20,
  perAccountDailyLamports: 20_000_000n, // 0.02 SOL
  perClientPerHour: 60,
  globalDailyLamports: 5_000_000_000n, // 5 SOL
};

/** The RPC methods the relayer uses, so tests can pass a fake. */
export interface RelayerRpc {
  getBalance(a: Address, c?: { commitment: "confirmed" }): { send(): Promise<{ value: bigint }> };
  getFeeForMessage(m: never, c?: { commitment: "confirmed" }): { send(): Promise<{ value: bigint | null }> };
  simulateTransaction(
    tx: never,
    c: { encoding: "base64"; sigVerify: true; accounts: { addresses: Address[]; encoding: "base64" }; commitment: "confirmed" },
  ): { send(): Promise<{ value: { err: unknown; accounts: ({ lamports: bigint } | null)[] | null; logs: string[] | null } }> };
  sendTransaction(tx: never, c: { encoding: "base64"; preflightCommitment: "confirmed" }): { send(): Promise<string> };
}

export type Refusal = { ok: false; status: number; code: string; message: string };
export type Accepted = { ok: true; signature: string; spentLamports: bigint };

const refuse = (status: number, code: string, message: string): Refusal => ({ ok: false, status, code, message });

/** Retries an RPC call the provider rate-limits (HTTP 429), backing off up to ~30 s. */
async function rpcRetry<T>(call: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await call();
    } catch (e) {
      if (!/429|Too Many Requests/i.test(String((e as Error)?.message ?? e)) || i >= 4) throw e;
      await new Promise((r) => setTimeout(r, 1_000 * 2 ** i));
    }
  }
}

type Decoded = {
  ok: true;
  tx: Transaction;
  feePayer: Address;
  instructions: { programAddress: Address; accounts: { address: Address; role: AccountRole }[]; data: Uint8Array }[];
  signers: Address[];
};

/** Decode and run the static checks. Exported for tests. */
export function inspect(wireBase64: string, relayer: Address): Decoded | Refusal {
  let tx: Transaction;
  let message: ReturnType<typeof decompileTransactionMessage>;
  try {
    tx = getTransactionDecoder().decode(Buffer.from(wireBase64, "base64"));
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    if (compiled.version === 0 && (compiled.addressTableLookups?.length ?? 0) > 0) {
      return refuse(400, "lookup_tables", "Address lookup tables are not accepted.");
    }
    message = decompileTransactionMessage(compiled as never);
  } catch (e) {
    return refuse(400, "malformed", `Could not decode the transaction: ${(e as Error).message}`);
  }
  if (getTransactionSize(tx) > 4096) return refuse(400, "too_large", "Transaction is over 4,096 bytes.");
  if (message.feePayer.address !== relayer) return refuse(400, "fee_payer", "The relayer must be the fee payer.");

  type AnyIx = { programAddress: Address; accounts?: readonly { address: Address; role: AccountRole }[]; data?: Uint8Array | ArrayLike<number> };
  const instructions = (message.instructions as readonly AnyIx[]).map((ix) => ({
    programAddress: ix.programAddress,
    accounts: (ix.accounts ?? []) as { address: Address; role: AccountRole }[],
    data: new Uint8Array(ix.data ?? []),
  }));
  if (instructions.length === 0) return refuse(400, "empty", "No instructions.");

  for (const [i, ix] of instructions.entries()) {
    const relayerAt = ix.accounts.flatMap((a, j) => (a.address === relayer ? [j] : []));
    const verdict = checkInstruction(ix, relayerAt);
    if (verdict) return refuse(403, verdict.code, `Instruction ${i}: ${verdict.message}`);
  }
  const signers = Object.keys(tx.signatures).filter((a) => a !== relayer) as Address[];
  if (signers.length === 0) return refuse(400, "no_signer", "A trading account must sign too.");
  return { ok: true, tx, feePayer: message.feePayer.address, instructions, signers };
}

function checkInstruction(
  ix: { programAddress: Address; data: Uint8Array; accounts: { address: Address; role: AccountRole }[] },
  relayerAt: number[],
): { code: string; message: string } | null {
  const hex = Buffer.from(ix.data.subarray(0, 8)).toString("hex");
  switch (ix.programAddress) {
    case PROGRAMS.shieldedPool:
    case PROGRAMS.userRegistry:
      // Rings may charge the fee payer rent for its own accounts; the
      // simulated spend cap bounds it.
      return null;
    case PROGRAMS.perps:
      if (hex === PERPS_IX.requestOrder) return onlyAt(relayerAt, [1], "the relayer may only be the rent payer");
      if (hex === PERPS_IX.cancelOrder) return onlyAt(relayerAt, [3], "the relayer may only receive the rent refund");
      return { code: "perps_instruction", message: "only request_order and cancel_order are sponsored" };
    case PROGRAMS.ata:
      if (ix.data.length !== 1 || ix.data[0] !== 1) return { code: "ata_instruction", message: "only CreateIdempotent is sponsored" };
      return onlyAt(relayerAt, [0], "the relayer may only pay for the account");
    case PROGRAMS.token: {
      // Transfer (3) or TransferChecked (12), never with the relayer as authority.
      if (ix.data[0] !== 3 && ix.data[0] !== 12) return { code: "token_instruction", message: "only token transfers are sponsored" };
      return relayerAt.length ? { code: "relayer_authority", message: "the relayer cannot appear in a token transfer" } : null;
    }
    case PROGRAMS.computeBudget:
      return relayerAt.length ? { code: "relayer_account", message: "unexpected relayer account" } : null;
    default:
      return { code: "program", message: `program ${ix.programAddress} is not sponsored` };
  }
}

function onlyAt(relayerAt: number[], allowed: number[], message: string) {
  return relayerAt.every((j) => allowed.includes(j)) ? null : { code: "relayer_position", message };
}

// ---------------------------------------------------------------------------
// Rate limits and budgets: MemoryBudget (one instance) or RedisBudget (shared)
// ---------------------------------------------------------------------------

/** Fee recovery: each sponsored transaction must pay the treasury at least `minAmount` (token base units). */
export interface FeeRecovery {
  /** The treasury's token account that must receive the transfer. */
  treasury: Address;
  minAmount: bigint;
}

/** The token amount a Transfer (3) or TransferChecked (12) sends to `dest`, else 0. */
export function amountTo(ix: { programAddress: Address; data: Uint8Array; accounts: { address: Address }[] }, dest: Address): bigint {
  if (ix.programAddress !== PROGRAMS.token || ix.data.length < 9) return 0n;
  const destIndex = ix.data[0] === 3 ? 1 : ix.data[0] === 12 ? 2 : -1;
  if (destIndex < 0 || ix.accounts[destIndex]?.address !== dest) return 0n;
  return Buffer.from(ix.data).readBigUInt64LE(1);
}

/**
 * Screening through an HTTP service: POST { addresses } → { allowed: boolean }.
 * Answers are cached for an hour. Any error, timeout or unexpected answer
 * refuses (fails closed).
 */
export function httpScreen(url: string, apiKey?: string, fetchImpl: typeof fetch = fetch) {
  const cache = new Map<string, { allowed: boolean; at: number }>();
  return async (addresses: Address[]): Promise<boolean> => {
    const key = [...addresses].sort().join(",");
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 3_600_000) return hit.allowed;
    try {
      const r = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ addresses }),
        signal: AbortSignal.timeout(5_000),
      });
      const body = (await r.json()) as { allowed?: unknown };
      const allowed = r.ok && body.allowed === true;
      cache.set(key, { allowed, at: Date.now() });
      return allowed;
    } catch {
      return false;
    }
  };
}

export interface RelayerOptions {
  limits?: Partial<RelayerLimits>;
  /** Where counts and spend live; defaults to this process's memory. */
  budget?: BudgetStore;
  feeRecovery?: FeeRecovery;
  /** Optional compliance screen on the accounts being sponsored. */
  screen?: (accounts: Address[]) => Promise<boolean>;
}

export class Relayer {
  readonly limits: RelayerLimits;
  private budget: BudgetStore;
  private salt = randomBytes(32);
  private saltDay = Math.floor(Date.now() / 86_400_000);

  constructor(private rpc: RelayerRpc, readonly signer: KeyPairSigner, private opts: RelayerOptions = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.budget = opts.budget ?? new MemoryBudget();
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

  get feeRecovery() {
    return this.opts.feeRecovery;
  }

  async sponsor(wireBase64: string, client: string): Promise<Accepted | Refusal> {
    const L = this.limits;
    const d = inspect(wireBase64, this.signer.address);
    if (!d.ok) return d;
    const { tx, signers } = d;

    const fr = this.opts.feeRecovery;
    if (fr && fr.minAmount > 0n) {
      const paid = d.instructions.reduce((sum, ix) => sum + amountTo(ix, fr.treasury), 0n);
      if (paid < fr.minAmount) return refuse(402, "fee_recovery", `Include a transfer of at least ${fr.minAmount} to ${fr.treasury} (the sponsorship fee).`);
    }

    // Limits before any RPC call.
    const keys = [...signers.map((s) => `a:${s}`), client];
    for (const s of signers) {
      if ((await this.budget.countLastHour(`a:${s}`)) >= L.perAccountPerHour) return refuse(429, "account_rate", "Too many requests for this account. Try later.");
      if ((await this.budget.spentToday(`a:${s}`)) + L.maxSpendLamports > L.perAccountDailyLamports) return refuse(429, "account_budget", "This account's daily sponsorship is used up.");
    }
    if ((await this.budget.countLastHour(client)) >= L.perClientPerHour) return refuse(429, "client_rate", "Too many requests. Try later.");
    if ((await this.budget.spentToday("global")) + L.maxSpendLamports > L.globalDailyLamports) return refuse(503, "global_budget", "Sponsorship is paused for today.");
    if (this.opts.screen && !(await this.opts.screen(signers))) return refuse(403, "screened", "This account can't be sponsored.");

    // Sign our slot; every other signature must already be there.
    const signed = await partiallySignTransaction([this.signer.keyPair], tx);
    try {
      assertIsFullySignedTransaction(signed);
    } catch {
      return refuse(400, "missing_signature", "Sign with every required key before sending.");
    }
    const wire = getBase64EncodedWireTransaction(signed);

    const fee = (await rpcRetry(() => this.rpc.getFeeForMessage(Buffer.from(signed.messageBytes).toString("base64") as never, { commitment: "confirmed" }).send())).value;
    if (fee === null) return refuse(400, "stale_blockhash", "Blockhash expired. Rebuild and resend.");
    if (fee > L.maxFeeLamports) return refuse(403, "fee_too_high", `Network fee ${fee} is over the ${L.maxFeeLamports} lamport cap.`);

    const before = (await rpcRetry(() => this.rpc.getBalance(this.signer.address, { commitment: "confirmed" }).send())).value;
    const sim = (
      await rpcRetry(() =>
        this.rpc
          .simulateTransaction(wire as never, {
            encoding: "base64",
            sigVerify: true,
            accounts: { addresses: [this.signer.address], encoding: "base64" },
            commitment: "confirmed",
          })
          .send(),
      )
    ).value;
    if (sim.err) return refuse(400, "simulation_failed", `Simulation failed: ${JSON.stringify(sim.err, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    const after = sim.accounts?.[0]?.lamports;
    if (after === undefined) return refuse(502, "simulation_incomplete", "Simulation did not return the relayer balance.");
    // Count the fee even if the simulator didn't deduct it.
    const spent = before - after + (before - after >= fee ? 0n : fee);
    if (spent > L.maxSpendLamports) return refuse(403, "spend_too_high", `Would cost the relayer ${spent} lamports (cap ${L.maxSpendLamports}).`);

    const signature = await rpcRetry(() => this.rpc.sendTransaction(wire as never, { encoding: "base64", preflightCommitment: "confirmed" }).send());
    await this.budget.record([...keys, "global"], spent);
    return { ok: true, signature: signature ?? getSignatureFromTransaction(signed), spentLamports: spent };
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const MAX_BODY = 16 * 1024;

export function createRelayerServer(relayer: Relayer, opts: { allowOrigin?: string; trustProxy?: boolean; metadata?: MetadataStore } = {}) {
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "access-control-allow-origin": opts.allowOrigin ?? "*",
      "access-control-allow-headers": "content-type",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  };
  const ipOf = (req: IncomingMessage) =>
    (opts.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "") || req.socket.remoteAddress || "unknown";

  return createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") return json(res, 204, {});
      if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true });
      if (req.method === "GET" && req.url === "/v1/info") {
        return json(res, 200, { relayer: relayer.signer.address, limits: relayer.limits, programs: PROGRAMS, feeRecovery: relayer.feeRecovery ?? null });
      }
      if (opts.metadata && req.method === "GET" && req.url?.startsWith("/v1/metadata/")) {
        const f = opts.metadata.serve(req.url.slice("/v1/metadata/".length));
        if (!f) return json(res, 404, { code: "not_found" });
        res.writeHead(200, { "content-type": f.type, "access-control-allow-origin": "*", "cache-control": "public, max-age=31536000, immutable" });
        return res.end(f.body);
      }
      if (opts.metadata && req.method === "POST" && req.url === "/v1/metadata") {
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const c of req) {
          size += (c as Buffer).length;
          if (size > MAX_METADATA_BODY) return json(res, 413, { code: "body_too_large", message: "Image is limited to 1 MB." });
          chunks.push(c as Buffer);
        }
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return json(res, 400, { code: "bad_json" });
        }
        const out = await opts.metadata.create(body, relayer.clientKey(ipOf(req)));
        return out.ok ? json(res, 200, { uri: out.uri }) : json(res, out.status, { code: out.code, message: out.message });
      }
      if (req.method === "POST" && req.url === "/v1/sponsor") {
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const c of req) {
          size += (c as Buffer).length;
          if (size > MAX_BODY) return json(res, 413, { code: "body_too_large" });
          chunks.push(c as Buffer);
        }
        let body: { transaction?: unknown };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return json(res, 400, { code: "bad_json" });
        }
        if (typeof body.transaction !== "string") return json(res, 400, { code: "missing_transaction" });
        const out = await relayer.sponsor(body.transaction, relayer.clientKey(ipOf(req)));
        if (out.ok) {
          console.log(`[relayer] sponsored ${out.signature} spent=${out.spentLamports}`);
          return json(res, 200, { signature: out.signature, spentLamports: out.spentLamports });
        }
        console.log(`[relayer] refused ${out.code}`);
        return json(res, out.status, { code: out.code, message: out.message });
      }
      return json(res, 404, { code: "not_found" });
    } catch (e) {
      const msg = (e as Error).message;
      console.error(`[relayer] error: ${msg}`);
      if (/429|Too Many Requests/i.test(msg)) return json(res, 503, { code: "rpc_busy", message: "The RPC provider is rate-limiting. Retry shortly." });
      return json(res, 500, { code: "internal" });
    }
  });
}

async function main() {
  const {
    RPC_URL, RELAYER_KEY, RELAYER_KEYPAIR, PORT, ALLOW_ORIGIN, TRUST_PROXY, PINATA_JWT, PINATA_GATEWAY, METADATA_DIR, PUBLIC_URL, NETWORK,
    REDIS_URL, FEE_RECOVERY_TREASURY, FEE_RECOVERY_MIN, SCREENING_URL, SCREENING_KEY,
  } = process.env;
  if (!RPC_URL || (!RELAYER_KEY && !RELAYER_KEYPAIR)) {
    console.error("Set RPC_URL and RELAYER_KEY (base58) or RELAYER_KEYPAIR (Solana CLI JSON file). Optional: PORT, ALLOW_ORIGIN, TRUST_PROXY=1");
    process.exit(1);
  }
  const secret = RELAYER_KEYPAIR
    ? Uint8Array.from(JSON.parse((await import("node:fs")).readFileSync(RELAYER_KEYPAIR, "utf8")))
    : new Uint8Array(getBase58Encoder().encode(RELAYER_KEY!));
  const signer = await createKeyPairSignerFromBytes(secret);
  if (NETWORK === "mainnet" && !SCREENING_URL) console.warn("[relayer] WARNING: mainnet without SCREENING_URL — sponsored accounts are not screened");
  const relayer = new Relayer(createSolanaRpc(RPC_URL) as unknown as RelayerRpc, signer, {
    budget: REDIS_URL ? new RedisBudget(new RespClient(REDIS_URL)) : new MemoryBudget(),
    feeRecovery: FEE_RECOVERY_TREASURY ? { treasury: address(FEE_RECOVERY_TREASURY), minAmount: BigInt(FEE_RECOVERY_MIN ?? "10000") } : undefined,
    screen: SCREENING_URL ? httpScreen(SCREENING_URL, SCREENING_KEY) : undefined,
  });
  console.log(`[relayer] limits in ${REDIS_URL ? "Redis (shared)" : "memory (single instance)"}; fee recovery ${FEE_RECOVERY_TREASURY ? `${FEE_RECOVERY_MIN ?? "10000"} to ${FEE_RECOVERY_TREASURY}` : "off"}; screening ${SCREENING_URL ? "on" : "off"}`);
  const metadata = new MetadataStore({
    pinataJwt: PINATA_JWT, gateway: PINATA_GATEWAY, localDir: METADATA_DIR, publicUrl: PUBLIC_URL, mainnet: NETWORK === "mainnet",
  });
  console.log(`[relayer] token metadata: ${PINATA_JWT ? "IPFS via Pinata" : NETWORK === "mainnet" ? "NOT CONFIGURED (set PINATA_JWT)" : "local store (devnet)"}`);
  createRelayerServer(relayer, { allowOrigin: ALLOW_ORIGIN, trustProxy: TRUST_PROXY === "1", metadata }).listen(Number(PORT ?? 8787), () =>
    console.log(`[relayer] ${signer.address} listening on :${PORT ?? 8787}`),
  );
}

if (process.argv[1]?.endsWith("relayer.js") || process.argv[1]?.endsWith("relayer.ts")) void main();
