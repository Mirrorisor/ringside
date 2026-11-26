/**
 * Signer lookup for trades whose gas was paid by a third party (trading bots, gasless apps).
 * Helius enhanced transactions list no signers, so such a trade cannot be attributed from the
 * payload. `SignerPort` fetches them (RPC `getTransaction`); `SignerQueue` resolves ambiguous
 * transactions in the background so ingest stays fast.
 *
 * Limits, honestly: the queue lives in memory (a restart loses it) and is bounded (the oldest are
 * dropped, counted in `/health`); a lookup that fails, times out or finds nothing leaves the
 * transaction without a trade, never a guessed one; unresolved transactions are not retried.
 */
import { needsSignerLookup, parseNormalizedTransaction, type ParseOptions, type ProgramParser } from "./helius.js";
import type { Store } from "./store.js";
import type { HeliusEnhancedTransaction } from "./types.js";

export interface SignerPort {
  /** The transaction's signers (fee payer first), or null if unknown. */
  signers(signature: string): Promise<string[] | null>;
}

export const DEFAULT_SIGNER_TIMEOUT_MS = 5_000;
export const DEFAULT_SIGNER_MIN_INTERVAL_MS = 100;
export const DEFAULT_SIGNER_CACHE_ENTRIES = 10_000;
export const DEFAULT_SIGNER_QUEUE_MAX = 1_000;

export interface RpcSignerOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Minimum gap between RPC request starts (rate limit; 100 ms is 10 requests/s). */
  minIntervalMs?: number;
  cacheEntries?: number;
}

/** Reads signers from a Solana JSON-RPC endpoint. Never throws: a failure is `null` (and not cached). */
export class RpcSignerPort implements SignerPort {
  private cache = new Map<string, string[]>();
  private inflight = new Map<string, Promise<string[] | null>>();
  private nextStart = 0;
  private fetchFn: typeof fetch;
  private timeoutMs: number;
  private minIntervalMs: number;
  private cacheEntries: number;
  /** Requests actually sent (cache hits excluded). */
  requests = 0;

  constructor(private url: string, o: RpcSignerOptions = {}) {
    this.fetchFn = o.fetch ?? fetch;
    this.timeoutMs = o.timeoutMs ?? DEFAULT_SIGNER_TIMEOUT_MS;
    this.minIntervalMs = o.minIntervalMs ?? DEFAULT_SIGNER_MIN_INTERVAL_MS;
    this.cacheEntries = o.cacheEntries ?? DEFAULT_SIGNER_CACHE_ENTRIES;
  }

  signers(signature: string): Promise<string[] | null> {
    const hit = this.cache.get(signature);
    if (hit) return Promise.resolve(hit);
    let p = this.inflight.get(signature);
    if (!p) {
      p = this.fetchSigners(signature).finally(() => this.inflight.delete(signature));
      this.inflight.set(signature, p);
    }
    return p;
  }

  private async fetchSigners(signature: string): Promise<string[] | null> {
    // Rate limit: reserve the next start slot synchronously, then wait for it.
    const t = Date.now();
    const start = Math.max(t, this.nextStart);
    this.nextStart = start + this.minIntervalMs;
    if (start > t) await new Promise((r) => setTimeout(r, start - t));
    this.requests++;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [signature, { maxSupportedTransactionVersion: 0, encoding: "json" }] }),
        signal: ac.signal,
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { result?: { transaction?: { message?: { header?: { numRequiredSignatures?: number }; accountKeys?: unknown[] } } } | null };
      const msg = body?.result?.transaction?.message;
      const n = msg?.header?.numRequiredSignatures;
      const keys = msg?.accountKeys;
      if (!Number.isInteger(n) || n! < 1 || !Array.isArray(keys) || keys.length < n! || !keys.slice(0, n!).every((k) => typeof k === "string")) return null;
      const out = keys.slice(0, n!) as string[];
      if (this.cache.size >= this.cacheEntries) this.cache.delete(this.cache.keys().next().value as string);
      this.cache.set(signature, out);
      return out;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface SignerQueueStats {
  queued: number;
  max: number;
  /** Transactions dropped because the queue was full (oldest first). */
  dropped: number;
  /** Lookups that returned signers. */
  resolved: number;
  /** Lookups that failed, timed out or returned nothing. */
  failed: number;
  /** Trades stored by the worker. */
  tradesStored: number;
}

export interface SignerQueueOptions {
  maxQueue?: number;
  /** The worker gives up on a lookup after this long (the port has its own timeout too). */
  timeoutMs?: number;
  parsers?: ProgramParser[];
  parse?: ParseOptions;
  log?: (msg: string) => void;
}

export class SignerQueue {
  private items: HeliusEnhancedTransaction[] = [];
  private known = new Set<string>();
  private running: Promise<void> | null = null;
  private maxQueue: number;
  private timeoutMs: number;
  private s = { dropped: 0, resolved: 0, failed: 0, tradesStored: 0 };

  constructor(private port: SignerPort, private store: Store, private o: SignerQueueOptions = {}) {
    this.maxQueue = Math.max(1, o.maxQueue ?? DEFAULT_SIGNER_QUEUE_MAX);
    this.timeoutMs = o.timeoutMs ?? DEFAULT_SIGNER_TIMEOUT_MS;
  }

  /** Queues a normalised transaction if it is ambiguous; returns whether it was queued. Synchronous and cheap. */
  consider(tx: HeliusEnhancedTransaction): boolean {
    if (this.known.has(tx.signature) || !needsSignerLookup(tx, this.o.parse)) return false;
    this.items.push(tx);
    this.known.add(tx.signature);
    while (this.items.length > this.maxQueue) {
      this.known.delete(this.items.shift()!.signature);
      this.s.dropped++;
    }
    this.running ??= this.run().finally(() => { this.running = null; });
    return true;
  }

  stats(): SignerQueueStats {
    return { queued: this.items.length, max: this.maxQueue, ...this.s };
  }

  /** Resolves when the queue is empty and the worker idle. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private async run() {
    await Promise.resolve(); // never work inside the caller's (webhook) tick
    for (let tx = this.items.shift(); tx; tx = this.items.shift()) {
      try {
        await this.resolve(tx);
      } catch (e) {
        this.s.failed++;
        (this.o.log ?? console.error)(`[indexer] signer lookup ${tx.signature.slice(0, 8)}: ${(e as Error).message}`);
      } finally {
        this.known.delete(tx.signature);
      }
    }
  }

  private async resolve(tx: HeliusEnhancedTransaction) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((r) => { timer = setTimeout(() => r(null), this.timeoutMs); });
    let signers: string[] | null;
    try {
      signers = await Promise.race([this.port.signers(tx.signature).catch(() => null), timeout]);
    } finally {
      clearTimeout(timer);
    }
    if (!Array.isArray(signers) || signers.length === 0) { this.s.failed++; return; }
    this.s.resolved++;
    const parsed = parseNormalizedTransaction({ ...tx, signers }, this.o.parsers, this.o.parse);
    if (parsed && parsed.trades.length) this.s.tradesStored += this.store.addTrades(parsed.trades);
  }
}
