/**
 * Pieces shared by the fee relayer (relayer.ts) and the gas sponsor
 * (sponsor.ts): structured refusals, RPC retry, wire decoding and the
 * simulate-and-measure step that bounds what the fee payer can lose.
 */
import {
  AccountRole,
  decompileTransactionMessage,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getTransactionSize,
  type Address,
  type Transaction,
} from "@solana/kit";

/**
 * A structured refusal the app can show. `instruction` is the index of the
 * offending instruction, if any. `internal` is for server logs only and must
 * never be sent to clients.
 */
export type Refusal = { ok: false; status: number; code: string; message: string; instruction?: number; details?: Record<string, unknown>; internal?: string };
/** `status` is set only when the caller waited for confirmation. */
export type Accepted = { ok: true; signature: string; spentLamports: bigint; status?: "confirmed" | "failed" | "unknown" };

export const refuse = (status: number, code: string, message: string, extra: { instruction?: number; details?: Record<string, unknown>; internal?: string } = {}): Refusal => ({
  ok: false,
  status,
  code,
  message,
  ...extra,
});

/** JSON.stringify replacer that writes bigints as strings. */
export const bigintJson = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

/** Retries an RPC call the provider rate-limits (HTTP 429), backing off up to ~30 s. */
export async function rpcRetry<T>(call: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await call();
    } catch (e) {
      if (!/429|Too Many Requests/i.test(String((e as Error)?.message ?? e)) || i >= 4) throw e;
      await new Promise((r) => setTimeout(r, 1_000 * 2 ** i));
    }
  }
}

export type Ix = { programAddress: Address; accounts: { address: Address; role: AccountRole }[]; data: Uint8Array };

export type Decoded = {
  ok: true;
  tx: Transaction;
  feePayer: Address;
  instructions: Ix[];
  /** Addresses with a signature slot, fee payer included. */
  signerSlots: Address[];
};

/** The lookup-table addresses a wire transaction references (empty for legacy / static v0). */
export function lookupTablesOf(wireBase64: string): Address[] {
  try {
    const tx = getTransactionDecoder().decode(Buffer.from(wireBase64, "base64"));
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    if (compiled.version !== 0) return [];
    return (compiled.addressTableLookups ?? []).map((l) => l.lookupTableAddress);
  } catch {
    return [];
  }
}

/**
 * Decodes a base64 wire transaction and checks the fee payer and size.
 * Lookup tables are refused unless their contents are given in `lookups`.
 * Instruction account roles come from the message header, so the fee payer
 * shows as WRITABLE_SIGNER wherever it appears.
 */
export function decodeWire(
  wireBase64: string,
  expectedFeePayer: Address,
  opts: { lookups?: Record<Address, Address[]>; feePayerName?: string } = {},
): Decoded | Refusal {
  const who = opts.feePayerName ?? "relayer";
  let tx: Transaction;
  let message: ReturnType<typeof decompileTransactionMessage>;
  try {
    tx = getTransactionDecoder().decode(Buffer.from(wireBase64, "base64"));
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const hasLookups = compiled.version === 0 && (compiled.addressTableLookups?.length ?? 0) > 0;
    if (hasLookups && !opts.lookups) return refuse(400, "lookup_tables", "Address lookup tables are not accepted.");
    message = decompileTransactionMessage(compiled as never, hasLookups ? { addressesByLookupTableAddress: opts.lookups } : undefined);
  } catch (e) {
    // The decoder's text describes our internals; log it, don't return it.
    return refuse(400, "malformed", "Could not decode the transaction.", { internal: String((e as Error)?.message ?? e) });
  }
  if (getTransactionSize(tx) > 4096) return refuse(400, "too_large", "Transaction is over 4,096 bytes.");
  if (message.feePayer.address !== expectedFeePayer) return refuse(400, "fee_payer", `The ${who} must be the fee payer.`);

  type AnyIx = { programAddress: Address; accounts?: readonly { address: Address; role: AccountRole }[]; data?: Uint8Array | ArrayLike<number> };
  const instructions = (message.instructions as readonly AnyIx[]).map((ix) => ({
    programAddress: ix.programAddress,
    accounts: (ix.accounts ?? []).map((a) => ({ address: a.address, role: a.role })),
    data: new Uint8Array(ix.data ?? []),
  }));
  if (instructions.length === 0) return refuse(400, "empty", "No instructions.");
  return { ok: true, tx, feePayer: message.feePayer.address, instructions, signerSlots: Object.keys(tx.signatures) as Address[] };
}

/**
 * The client IP for rate limiting. Without a trusted proxy, the socket
 * address. Behind `hops` trusted proxies, each appends the address it saw to
 * X-Forwarded-For, so the trustworthy entry is the `hops`-th from the right;
 * everything left of it is whatever the client sent. Too few entries means
 * the request bypassed a proxy: use the socket address.
 */
export function clientIp(req: { headers: Record<string, string | string[] | undefined>; socket: { remoteAddress?: string } }, hops = 0): string {
  const socket = req.socket.remoteAddress || "unknown";
  if (hops <= 0) return socket;
  const raw = req.headers["x-forwarded-for"];
  const parts = (Array.isArray(raw) ? raw.join(",") : (raw ?? "")).split(",").map((x) => x.trim()).filter(Boolean);
  return parts.length >= hops ? parts[parts.length - hops] : socket;
}

/** RPC methods for fee quoting, simulation and sending, so tests can pass a fake. */
export interface SimulationRpc {
  getBalance(a: Address, c?: { commitment: "confirmed" }): { send(): Promise<{ value: bigint }> };
  getFeeForMessage(m: never, c?: { commitment: "confirmed" }): { send(): Promise<{ value: bigint | null }> };
  simulateTransaction(
    tx: never,
    c: { encoding: "base64"; sigVerify: true; accounts: { addresses: Address[]; encoding: "base64" }; commitment: "confirmed" },
  ): { send(): Promise<{ value: { err: unknown; accounts: ({ lamports: bigint } | null)[] | null; logs: string[] | null } }> };
  sendTransaction(tx: never, c: { encoding: "base64"; preflightCommitment: "confirmed" }): { send(): Promise<string> };
}

/**
 * Quotes the network fee, simulates with signatures verified and returns how
 * much the fee payer's balance drops (fee counted even if the simulator did
 * not deduct it).
 */
export async function quoteAndSimulate(
  rpc: SimulationRpc,
  payer: Address,
  messageBytes: ArrayLike<number>,
  wire: string,
  maxFeeLamports: bigint,
): Promise<{ ok: true; fee: bigint; spent: bigint } | Refusal> {
  const fee = (await rpcRetry(() => rpc.getFeeForMessage(Buffer.from(messageBytes as ArrayLike<number>).toString("base64") as never, { commitment: "confirmed" }).send())).value;
  if (fee === null) return refuse(400, "stale_blockhash", "Blockhash expired. Rebuild and resend.");
  if (fee > maxFeeLamports) return refuse(403, "fee_too_high", `Network fee ${fee} is over the ${maxFeeLamports} lamport cap.`, { details: { fee, cap: maxFeeLamports } });

  const before = (await rpcRetry(() => rpc.getBalance(payer, { commitment: "confirmed" }).send())).value;
  const sim = (
    await rpcRetry(() =>
      rpc
        .simulateTransaction(wire as never, {
          encoding: "base64",
          sigVerify: true,
          accounts: { addresses: [payer], encoding: "base64" },
          commitment: "confirmed",
        })
        .send(),
    )
  ).value;
  if (sim.err) return refuse(400, "simulation_failed", `Simulation failed: ${JSON.stringify(sim.err, bigintJson)}`);
  const after = sim.accounts?.[0]?.lamports;
  if (after === undefined || after === null) return refuse(502, "simulation_incomplete", "Simulation did not return the fee payer balance.");
  const drop = before - BigInt(after);
  const spent = drop + (drop >= fee ? 0n : fee);
  return { ok: true, fee, spent };
}
