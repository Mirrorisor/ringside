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
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { bundles, holderBalances, insiders, snipers, topHolderConcentration } from "./flags.js";
import { DEFAULT_PARSERS, isAddress, parseTransaction, type ProgramParser } from "./helius.js";
import { isMetric, isWindow, metricValue, walletStats, WINDOWS } from "./stats.js";
import type { Store } from "./store.js";

export const MAX_BODY_BYTES = 5 * 1024 * 1024;
export const MAX_TXS_PER_WEBHOOK = 1_000;
export const MAX_FEED_WALLETS = 100;
export const MAX_FEED_LIMIT = 200;
export const DEFAULT_FEED_LIMIT = 50;
export const MAX_LEADERBOARD_LIMIT = 100;
/** Wallets scanned per leaderboard request; beyond this the board is partial. */
export const LEADERBOARD_SCAN_CAP = 5_000;

export interface IndexerOptions {
  store: Store;
  /** Shared secret Helius sends in the Authorization header. Required. */
  webhookSecret: string;
  parsers?: ProgramParser[];
  now?: () => number; // unix seconds
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

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
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

  async function webhook(req: IncomingMessage, res: ServerResponse) {
    if (!secretMatches(req.headers.authorization, webhookSecret)) throw new HttpError(401, "unauthorized");
    let payload: unknown;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, "invalid JSON");
    }
    if (!Array.isArray(payload)) throw new HttpError(400, "expected an array of enhanced transactions");
    if (payload.length > MAX_TXS_PER_WEBHOOK) throw new HttpError(413, "too many transactions");
    let ingested = 0, duplicates = 0, skipped = 0, trades = 0;
    for (const tx of payload) {
      const parsed = parseTransaction(tx, parsers);
      if (!parsed) { skipped++; continue; }
      if (store.ingest(parsed)) { ingested++; trades += parsed.trades.length; }
      else duplicates++;
    }
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
    const buyers = [...new Set(trades.filter((t) => t.side === "buy").map((t) => t.wallet))];
    return {
      mint,
      trades: trades.length,
      creator: creator ?? null,
      snipers: snipers(trades, launch?.slot, creator),
      bundles: bundles(trades),
      insiders: creator ? insiders(creator, trades, store.transfersFrom(creator, buyers)) : null,
      concentration: topHolderConcentration(holderBalances(trades)),
    };
  }

  function leaderboard(q: URLSearchParams) {
    const window = q.get("window") ?? "7d";
    const by = q.get("by") ?? "pnl";
    if (!isWindow(window)) throw new HttpError(400, `window must be one of ${Object.keys(WINDOWS).join(", ")}`);
    if (!isMetric(by)) throw new HttpError(400, "by must be one of pnl, volume, winrate, trades");
    const limit = intParam(q.get("limit"), 50, 1, MAX_LEADERBOARD_LIMIT, "limit");
    const t = now();
    const rows = store.activeWallets(t - WINDOWS[window], LEADERBOARD_SCAN_CAP).map((w) => {
      const s = walletStats(w, store.walletTrades(w), t).windows[window];
      return { wallet: w, value: metricValue(s, by), ...s };
    });
    rows.sort((a, b) => b.value - a.value || a.wallet.localeCompare(b.wallet));
    return { window, by, quote: "SOL", entries: rows.slice(0, limit).map((r, i) => ({ rank: i + 1, ...r })) };
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
      return send(res, 200, tokenFlags(m[1]));
    }
    throw new HttpError(404, "not found");
  }

  return createServer((req, res) => {
    route(req, res).catch((e) => {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(`[indexer] ${(e as Error).stack ?? e}`);
      send(res, 500, { error: "internal error" });
    });
  });
}
