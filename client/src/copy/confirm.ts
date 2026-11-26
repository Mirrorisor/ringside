/**
 * Proves, on chain, that a follower's reported signature is the copy they
 * were asked to make. The follower's say-so alone never creates a position.
 *
 * A sent_unconfirmed intent becomes `sent` only if the transaction exists,
 * succeeded, was signed by the follower and involves the intent's mint. The
 * position moves by the follower's actual token balance change in that
 * transaction (post minus pre token balances), not by the quote.
 */
import type { CopyStore, StoredIntent } from "./store.js";

export interface TokenBalance { owner: string; mint: string; amount: string }
/** The parts of a confirmed transaction the engine needs. Fakeable in tests. */
export interface ChainTx {
  /** Null when the transaction succeeded. */
  err: unknown;
  /** Accounts that signed (fee payer and other required signers). */
  signers: string[];
  accounts: string[];
  preTokenBalances: TokenBalance[];
  postTokenBalances: TokenBalance[];
}
export interface TxPort {
  /** Resolves null if the transaction is not found (yet). */
  getTransaction(signature: string): Promise<ChainTx | null>;
}

/** After this long without the transaction appearing, its blockhash is dead and it will never land. */
export const UNCONFIRMED_TIMEOUT_MS = 180_000;

export type ConfirmOutcome = "confirmed" | "unconfirmed" | "failed" | "not_found";

export interface ConfirmDeps { store: CopyStore; tx: TxPort; now?: () => number; unconfirmedTimeoutMs?: number }

/** The follower's net token change for `mint` in the transaction. */
export function tokenDelta(tx: ChainTx, follower: string, mint: string): bigint {
  const sum = (bs: TokenBalance[]) => bs.filter((b) => b.owner === follower && b.mint === mint).reduce((s, b) => s + BigInt(b.amount), 0n);
  return sum(tx.postTokenBalances) - sum(tx.preTokenBalances);
}

function verify(i: StoredIntent, tx: ChainTx): { ok: true; delta: bigint } | { ok: false } {
  if (tx.err !== null && tx.err !== undefined) return { ok: false };
  if (!tx.signers.includes(i.follower)) return { ok: false };
  if (i.kind !== "spot") return { ok: true, delta: 0n };
  const mentions = tx.accounts.includes(i.mint) || [...tx.preTokenBalances, ...tx.postTokenBalances].some((b) => b.mint === i.mint);
  if (!mentions) return { ok: false };
  const delta = tokenDelta(tx, i.follower, i.mint);
  if (i.side === "buy" ? delta <= 0n : delta >= 0n) return { ok: false }; // not the trade that was asked for
  return { ok: true, delta };
}

/** Verifies one sent_unconfirmed intent. An RPC error leaves it unconfirmed (retry later). */
export async function confirmIntent(deps: ConfirmDeps, id: string): Promise<ConfirmOutcome> {
  const i = deps.store.get(id);
  if (!i || i.status !== "sent_unconfirmed" || !i.signature) return "not_found";
  let tx: ChainTx | null;
  try { tx = await deps.tx.getTransaction(i.signature); } catch { return "unconfirmed"; }
  if (!tx) {
    const age = (deps.now ?? Date.now)() - (i.sentAt ?? 0);
    if (age > (deps.unconfirmedTimeoutMs ?? UNCONFIRMED_TIMEOUT_MS)) { deps.store.markFailed(id); return "failed"; }
    return "unconfirmed";
  }
  const v = verify(i, tx);
  if (!v.ok) { deps.store.markFailed(id); return "failed"; }
  return deps.store.confirmSent(id, v.delta) ? "confirmed" : "not_found";
}

/** Re-checks every sent_unconfirmed intent. Run on an interval. */
export async function confirmPending(deps: ConfirmDeps): Promise<number> {
  let n = 0;
  for (const i of deps.store.unconfirmed()) if ((await confirmIntent(deps, i.id)) === "confirmed") n++;
  return n;
}

type RpcCall = { send(): Promise<unknown> };
/** TxPort over a @solana/kit RPC (jsonParsed, so token balances carry owners). */
export function rpcTxPort(rpc: { getTransaction: (sig: never, cfg: never) => RpcCall }): TxPort {
  return {
    async getTransaction(signature) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = (await rpc.getTransaction(signature as never, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" } as never).send()) as any;
      if (!r) return null;
      const keys: { pubkey: string; signer: boolean }[] = r.transaction?.message?.accountKeys ?? [];
      const bal = (xs: { mint: string; owner?: string; uiTokenAmount: { amount: string } }[] | null | undefined): TokenBalance[] =>
        (xs ?? []).map((b) => ({ owner: b.owner ?? "", mint: b.mint, amount: b.uiTokenAmount.amount }));
      return {
        err: r.meta ? (r.meta.err ?? null) : "no_meta",
        signers: keys.filter((k) => k.signer).map((k) => String(k.pubkey)),
        accounts: keys.map((k) => String(k.pubkey)),
        preTokenBalances: bal(r.meta?.preTokenBalances), postTokenBalances: bal(r.meta?.postTokenBalances),
      };
    },
  };
}
