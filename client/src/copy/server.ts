/**
 * Copy HTTP API.
 *
 *   GET  /intents?status=pending   the caller's own intents (session auth)
 *   POST /intents/:id/build        build the unsigned transaction (session auth)
 *   POST /intents/:id/sent         {signature}: record that the follower sent it (session auth)
 *   POST /ingest/trade             the indexer reports leader trades (COPY_INGEST_SECRET)
 *   GET  /health
 *
 * The session's `userId` is the follower's wallet address. Errors are
 * `{error: {code}}` with a fixed code and never carry internal text.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isAddress } from "../indexer/helius.js";
import { RateLimiter, clientKey, secretMatches } from "../indexer/server.js";
import type { Trade } from "../indexer/types.js";
import type { Authenticator } from "../session.js";
import { buildIntent, BuildError, type BuildDeps } from "./build.js";
import type { CopyEngine } from "./engine.js";
import type { CopyIntent } from "./ports.js";
import { publicIntent, type CopyStore } from "./store.js";

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_TRADES_PER_INGEST = 50;
const STATUSES = ["pending", "skipped", "built", "sent", "expired"] as const;
const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

export interface CopyServerOptions {
  store: CopyStore;
  engine: CopyEngine;
  build: BuildDeps;
  authenticate: Authenticator;
  /** Secret for POST /ingest/trade. Required. */
  ingestSecret: string;
  /** One exact origin, never "*". Unset: no CORS headers. */
  corsOrigin?: string;
  /** Requests per window: per IP before auth, per user after. */
  rateLimit?: { windowMs: number; max: number };
  buildRateLimit?: { windowMs: number; max: number };
  trustProxy?: boolean;
  now?: () => number;
}

const STATUS_OF: Record<string, number> = {
  bad_request: 400, unauthorized: 401, not_found: 404, method_not_allowed: 405, conflict: 409, payload_too_large: 413, rate_limited: 429,
  intent_expired: 410, perps_build_unsupported: 501, venue_unavailable: 422, build_failed: 502, internal_error: 500,
};
class ApiError extends Error { constructor(readonly code: string) { super(code); } }

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) throw new ApiError("payload_too_large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new ApiError("payload_too_large");
    chunks.push(c as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ApiError("bad_request"); }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finitePos = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/** Validates untrusted ingest input into a Trade, or null. */
export function parseTrade(v: unknown): Trade | null {
  if (!isObj(v)) return null;
  const { signature, wallet, mint, side, tokenAmount, quote, quoteAmount, slot, timestamp, source } = v;
  if (typeof signature !== "string" || !SIG_RE.test(signature)) return null;
  if (!isAddress(wallet) || !isAddress(mint)) return null;
  if (side !== "buy" && side !== "sell") return null;
  if (quote !== "SOL" && quote !== "USDC") return null;
  if (!finitePos(tokenAmount) || !finitePos(quoteAmount)) return null;
  if (!Number.isSafeInteger(slot) || !Number.isSafeInteger(timestamp)) return null;
  if (typeof source !== "string" || source.length > 64) return null;
  return { signature, wallet, mint, side, tokenAmount, quote, quoteAmount, slot: slot as number, timestamp: timestamp as number, source };
}

export function createCopyServer(o: CopyServerOptions): Server {
  if (!o.ingestSecret) throw new Error("ingestSecret is required");
  if (o.corsOrigin === "*") throw new Error("COPY_CORS_ORIGIN must be one exact origin, not *.");
  const now = o.now ?? Date.now;
  const rl = o.rateLimit ?? { windowMs: 60_000, max: 120 };
  const brl = o.buildRateLimit ?? { windowMs: 60_000, max: 30 };
  const ipLimit = new RateLimiter(rl.windowMs, rl.max * 2);
  const userLimit = new RateLimiter(rl.windowMs, rl.max);
  const buildLimit = new RateLimiter(brl.windowMs, brl.max);
  const ingestLimit = new RateLimiter(rl.windowMs, 600);
  const ipOf = (req: IncomingMessage) => {
    const xff = o.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",").pop()!.trim() : "";
    return clientKey(xff || req.socket.remoteAddress || "unknown");
  };
  const limit = (l: RateLimiter, key: string) => { const w = l.take(key); if (w) throw Object.assign(new ApiError("rate_limited"), { wait: w }); };

  async function route(req: IncomingMessage, res: ServerResponse, cors: Record<string, string>) {
    const url = new URL(req.url ?? "/", "http://copy.local");
    const path = url.pathname;
    const method = req.method ?? "GET";
    if (method === "OPTIONS") return send(res, 204, {}, { ...cors, "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-max-age": "600" });
    if (path === "/health" && method === "GET") return send(res, 200, { ok: true }, cors);
    const ip = ipOf(req);

    if (path === "/ingest/trade") {
      if (method !== "POST") throw new ApiError("method_not_allowed");
      limit(ipLimit, ip);
      const auth = req.headers.authorization;
      const given = typeof auth === "string" ? /^Bearer\s+(\S+)$/i.exec(auth)?.[1] : undefined;
      if (!secretMatches(given, o.ingestSecret)) throw new ApiError("unauthorized");
      limit(ingestLimit, "ingest");
      const body = await readJson(req);
      const raw = isObj(body) && Array.isArray(body.trades) ? body.trades : isObj(body) && isObj(body.trade) ? [body.trade] : null;
      if (!raw || raw.length === 0 || raw.length > MAX_TRADES_PER_INGEST) throw new ApiError("bad_request");
      const trades = raw.map(parseTrade);
      if (trades.some((t) => t === null)) throw new ApiError("bad_request");
      let intents = 0;
      for (const t of trades as Trade[]) intents += (await o.engine.onLeaderTrade(t)).filter((i) => i.status === "pending").length;
      return send(res, 200, { trades: trades.length, pending: intents }, cors);
    }

    const m = /^\/intents\/([0-9a-fA-F-]{36})\/(build|sent)$/.exec(path);
    if (path !== "/intents" && !m) throw new ApiError("not_found");
    limit(ipLimit, ip);
    const user = await o.authenticate(req);
    if (!user) throw new ApiError("unauthorized");
    limit(userLimit, user.userId);

    if (path === "/intents") {
      if (method !== "GET") throw new ApiError("method_not_allowed");
      const status = url.searchParams.get("status");
      if (status !== null && !(STATUSES as readonly string[]).includes(status)) throw new ApiError("bad_request");
      const intents: CopyIntent[] = o.store.list(user.userId, (status ?? undefined) as CopyIntent["status"] | undefined, now()).map(publicIntent);
      return send(res, 200, { intents }, cors);
    }
    if (method !== "POST" || !m) throw new ApiError("method_not_allowed");
    const [, id, action] = m;
    if (action === "build") {
      limit(buildLimit, user.userId);
      const built = await buildIntent({ ...o.build, now }, id, user.userId);
      return send(res, 200, built, cors);
    }
    const body = await readJson(req);
    if (!isObj(body) || typeof body.signature !== "string" || !SIG_RE.test(body.signature)) throw new ApiError("bad_request");
    const own = o.store.get(id);
    if (!own || own.follower !== user.userId) throw new ApiError("not_found");
    if (!o.store.markSent(id, body.signature, user.userId)) throw new ApiError("conflict");
    return send(res, 200, { ok: true }, cors);
  }

  const server = createServer({ requestTimeout: 10_000, headersTimeout: 10_000 }, (req, res) => {
    const origin = req.headers.origin;
    const cors: Record<string, string> = o.corsOrigin && origin === o.corsOrigin ? { "access-control-allow-origin": o.corsOrigin, vary: "Origin" } : {};
    route(req, res, cors).catch((e) => {
      if (res.headersSent) return res.destroy();
      let code = "internal_error";
      const headers: Record<string, string> = { ...cors };
      if (e instanceof ApiError) {
        code = e.code;
        const wait = (e as { wait?: number }).wait;
        if (wait) headers["retry-after"] = String(wait);
      } else if (e instanceof BuildError) code = e.code === "expired" ? "intent_expired" : e.code === "not_pending" ? "conflict" : e.code;
      else console.error(`[copy] ${(e as Error).stack ?? e}`);
      send(res, STATUS_OF[code] ?? 500, { error: { code } }, headers);
    });
  });
  server.setTimeout(10_000, (s) => s.destroy());
  return server;
}
