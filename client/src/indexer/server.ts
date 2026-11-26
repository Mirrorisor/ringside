/**
 * Indexer HTTP API.
 *
 *   POST /webhooks/helius        Helius enhanced-transaction webhook (JSON array).
 *                                Authorization header must equal the shared secret.
 *   GET  /feed?wallets=a,b&limit=50&before=<unix s>
 *   GET  /wallet/:addr
 *   GET  /token/:mint/flags
 *   GET  /leaderboard?window=7d&by=pnl&limit=50
 *   GET  /health
 *
 * Read endpoints are rate limited per client IP (in memory, fixed window;
 * IPv6 clients are keyed by their /64) and /leaderboard and /token flags
 * responses are cached for a few seconds. Requests that do not finish in
 * `requestTimeoutMs` are cut off by the HTTP server.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { bundles, holderBalances, insiders, snipers, topHolderConcentration } from "./flags.js";
import { DEFAULT_PARSERS, isAddress, parseTransaction, type ProgramParser } from "./helius.js";
import { isIP } from "node:net";
import { isMetric, isWindow, walletStats, WINDOWS } from "./stats.js";
import type { Store } from "./store.js";
import type { ParsedTx } from "./types.js";

export const MAX_BODY_BYTES = 5 * 1024 * 1024;
export const MAX_TXS_PER_WEBHOOK = 1_000;
export const MAX_FEED_WALLETS = 100;
export const MAX_FEED_LIMIT = 200;
export const DEFAULT_FEED_LIMIT = 50;
export const MAX_LEADERBOARD_LIMIT = 100;
/** Minimum non-wash SOL volume in the window to appear on the leaderboard. */
export const LEADERBOARD_MIN_VOLUME_SOL = 2;
/** Minimum non-wash trade count in the window to appear on the leaderboard. */
export const LEADERBOARD_MIN_TRADES = 4;
/** Default read-API rate limit: requests per client IP per window. */
export const DEFAULT_RATE_LIMIT = { windowMs: 60_000, max: 120 } as const;
/** Default time allowed for a whole request (headers and body). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** Default lifetime of cached /leaderboard and /token flags responses. */
export const DEFAULT_CACHE_TTL_MS = 5_000;
/** Cached responses kept at most (oldest evicted first). */
export const MAX_CACHE_ENTRIES = 2_000;
/** Client IPs tracked at most by the rate limiter. */
export const MAX_RATE_LIMIT_KEYS = 100_000;

export interface IndexerOptions {
  store: Store;
  /** Shared secret Helius sends in the Authorization header. Required. */
  webhookSecret: string;
  parsers?: ProgramParser[];
  now?: () => number; // unix seconds
  /** Sponsor / relayer / fee wallets never taken as the trader (INDEXER_SPONSOR_ADDRESSES). */
  sponsorAddresses?: Iterable<string>;
  /** Per-IP read rate limit; false disables it. */
  rateLimit?: { windowMs: number; max: number } | false;
  /** Key clients by the last X-Forwarded-For entry (set only behind one trusted proxy). */
  trustProxy?: boolean;
  requestTimeoutMs?: number;
  /** 0 disables the response cache. */
  cacheTtlMs?: number;
  leaderboardMinVolumeSol?: number;
  leaderboardMinTrades?: number;
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();
/** Constant-time compare (hashing first equalises lengths). */
export function secretMatches(given: string | undefined, secret: string): boolean {
  if (!secret || typeof given !== "string") return false;
  return timingSafeEqual(digest(given), digest(secret));
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

/** Rate-limit key: the IPv4 address, or the /64 of an IPv6 address (one host usually owns a /64). */
export function clientKey(ip: string): string {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (v4) return v4[1];
  if (isIP(ip) !== 6) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = ip.includes("::") ? (tail ? tail.split(":") : []) : [];
  const groups = ip.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

/** Fixed-window request counter per key, bounded in memory. */
export class RateLimiter {
  private hits = new Map<string, { start: number; count: number }>();
  constructor(private windowMs: number, private max: number, private maxKeys = MAX_RATE_LIMIT_KEYS, private clock: () => number = Date.now) {}

  /** Seconds to wait, or 0 if the request is allowed. */
  take(key: string): number {
    const t = this.clock();
    let h = this.hits.get(key);
    if (!h || t - h.start >= this.windowMs) {
      this.hits.delete(key);
      if (this.hits.size >= this.maxKeys) this.evict(t);
      this.hits.set(key, (h = { start: t, count: 0 }));
    }
    if (++h.count > this.max) return Math.max(1, Math.ceil((h.start + this.windowMs - t) / 1000));
    return 0;
  }

  private evict(t: number) {
    for (const [k, h] of this.hits) if (t - h.start >= this.windowMs) this.hits.delete(k);
    // Still full: drop the oldest windows (Map keeps insertion order).
    for (const k of this.hits.keys()) {
      if (this.hits.size < this.maxKeys) break;
      this.hits.delete(k);
    }
  }

  get size() { return this.hits.size; }
}

/** Small TTL cache of serialised responses, bounded, oldest evicted first. */
class ResponseCache {
  private m = new Map<string, { expires: number; body: string }>();
  constructor(private ttlMs: number, private max = MAX_CACHE_ENTRIES) {}
  get(key: string, make: () => unknown): string {
    if (this.ttlMs <= 0) return JSON.stringify(make());
    const t = Date.now();
    const hit = this.m.get(key);
    if (hit && hit.expires > t) return hit.body;
    const body = JSON.stringify(make());
    this.m.delete(key);
    if (this.m.size >= this.max) for (const k of this.m.keys()) { this.m.delete(k); if (this.m.size < this.max) break; }
    this.m.set(key, { expires: t + this.ttlMs, body });
    return body;
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const declared = Number(req.headers["content-length"]);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function intParam(v: string | null, def: number, min: number, max: number, name: string): number {
  if (v === null || v === "") return def;
  if (!/^\d{1,15}$/.test(v)) throw new HttpError(400, `${name} must be a non-negative integer`);
  return Math.min(Math.max(Number(v), min), max);
}

export function createIndexerServer(opts: IndexerOptions): Server {
  const { store, webhookSecret } = opts;
  if (!webhookSecret) throw new Error("webhookSecret is required");
  const parsers = opts.parsers ?? DEFAULT_PARSERS;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const parseOpts = { sponsors: new Set(opts.sponsorAddresses ?? []) };
  const rl = opts.rateLimit === false ? null : new RateLimiter((opts.rateLimit ?? DEFAULT_RATE_LIMIT).windowMs, (opts.rateLimit ?? DEFAULT_RATE_LIMIT).max);
  const cache = new ResponseCache(opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
  const minVolumeSol = opts.leaderboardMinVolumeSol ?? LEADERBOARD_MIN_VOLUME_SOL;
  const minTrades = opts.leaderboardMinTrades ?? LEADERBOARD_MIN_TRADES;
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const ipOf = (req: IncomingMessage) => {
    const xff = opts.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",").pop()!.trim() : "";
    return clientKey(xff || req.socket.remoteAddress || "unknown");
  };

  async function webhook(req: IncomingMessage, res: ServerResponse) {
    if (!secretMatches(req.headers.authorization, webhookSecret)) throw new HttpError(401, "unauthorized");
    let payload: unknown;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, "invalid JSON");
    }
    if (!Array.isArray(payload)) throw new HttpError(400, "expected an array of transactions");
    if (payload.length > MAX_TXS_PER_WEBHOOK) throw new HttpError(413, "too many transactions");
    let ingested = 0, duplicates = 0, skipped = 0, trades = 0;
    const batch: ParsedTx[] = [];
    for (const tx of payload) {
      const parsed = parseTransaction(tx, parsers, parseOpts);
      if (parsed) batch.push(parsed);
      else skipped++;
    }
    store.ingestMany(batch).forEach((ok, i) => {
      if (ok) { ingested++; trades += batch[i].trades.length; }
      else duplicates++;
    });
    send(res, 200, { received: payload.length, ingested, duplicates, skipped, trades });
  }

  function feed(q: URLSearchParams) {
    const raw = q.get("wallets") ?? "";
    const wallets = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
    if (wallets.length === 0) throw new HttpError(400, "wallets is required");
    if (wallets.length > MAX_FEED_WALLETS) throw new HttpError(400, `at most ${MAX_FEED_WALLETS} wallets`);
    const bad = wallets.find((w) => !isAddress(w));
    if (bad) throw new HttpError(400, "invalid wallet address");
    const limit = intParam(q.get("limit"), DEFAULT_FEED_LIMIT, 1, MAX_FEED_LIMIT, "limit");
    const before = intParam(q.get("before"), Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER, "before");
    const trades = store.feed(wallets, limit, before);
    return { trades, next: trades.length === limit ? trades[trades.length - 1].timestamp : null };
  }

  function tokenFlags(mint: string) {
    const trades = store.mintTrades(mint);
    const launch = store.launch(mint);
    const creator = launch?.creator;
    return {
      mint,
      trades: trades.length,
      creator: creator ?? null,
      snipers: snipers(trades, launch?.slot, creator),
      bundles: bundles(trades),
      insiders: creator ? insiders(creator, trades, store.transfersToBuyers(creator, mint)) : null,
      concentration: topHolderConcentration(holderBalances(trades)),
    };
  }

  function leaderboard(q: URLSearchParams) {
    const window = q.get("window") ?? "7d";
    const by = q.get("by") ?? "pnl";
    if (!isWindow(window)) throw new HttpError(400, `window must be one of ${Object.keys(WINDOWS).join(", ")}`);
    if (!isMetric(by)) throw new HttpError(400, "by must be one of pnl, volume, winrate, trades");
    const limit = intParam(q.get("limit"), 50, 1, MAX_LEADERBOARD_LIMIT, "limit");
    const since = now() - WINDOWS[window];
    return cache.get(`lb|${window}|${by}|${limit}`, () => ({
      window, by, quote: "SOL",
      minVolumeSol, minTrades,
      entries: store.leaderboard({ sinceTimestamp: since, by, limit, minVolumeSol, minTrades }).map((r, i) => ({ rank: i + 1, ...r })),
    }));
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://indexer.local");
    const path = url.pathname;
    if (path === "/webhooks/helius") {
      if (req.method !== "POST") throw new HttpError(405, "method not allowed");
      return webhook(req, res);
    }
    if (req.method !== "GET") throw new HttpError(405, "method not allowed");
    if (path === "/health") return send(res, 200, { ok: true });
    const wait = rl?.take(ipOf(req)) ?? 0;
    if (wait) return send(res, 429, { error: "rate limited" }, { "retry-after": String(wait) });
    if (path === "/feed") return send(res, 200, feed(url.searchParams));
    if (path === "/leaderboard") return send(res, 200, leaderboard(url.searchParams));
    let m = /^\/wallet\/([^/]+)$/.exec(path);
    if (m) {
      if (!isAddress(m[1])) throw new HttpError(400, "invalid wallet address");
      return send(res, 200, walletStats(m[1], store.walletTrades(m[1]), now()));
    }
    m = /^\/token\/([^/]+)\/flags$/.exec(path);
    if (m) {
      if (!isAddress(m[1])) throw new HttpError(400, "invalid mint address");
      return send(res, 200, cache.get(`flags|${m[1]}`, () => tokenFlags(m[1])));
    }
    throw new HttpError(404, "not found");
  }

  const server = createServer({
    requestTimeout: requestTimeoutMs,
    headersTimeout: Math.min(requestTimeoutMs, 60_000),
    // How often Node checks the two timeouts above (its default is 30 s).
    connectionsCheckingInterval: Math.min(Math.max(Math.floor(requestTimeoutMs / 2), 100), 30_000),
  }, (req, res) => {
    route(req, res).catch((e) => {
      if (res.headersSent) return res.destroy();
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(`[indexer] ${(e as Error).stack ?? e}`);
      send(res, 500, { error: "internal error" });
    });
  });
  // Idle sockets (keep-alive or stalled responses) are closed too.
  server.setTimeout(requestTimeoutMs, (sock) => sock.destroy());
  return server;
}
