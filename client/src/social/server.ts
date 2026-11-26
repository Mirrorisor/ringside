/**
 * Social backend HTTP API (JSON; errors are `{error: {code, message}}` with fixed messages).
 *
 *   POST /auth/nonce {wallet}                      -> {nonce, message}
 *   POST /auth/verify {wallet, message, signature} -> {token, tokens: {social, copy, sponsor}}
 *                                                    (`token` is the social token; use tokens.copy / tokens.sponsor
 *                                                    at those services: each token works at its own service only)
 *   POST /auth/logout                              revokes every token issued to the caller up to now
 *   GET/PUT /me                                    profile (public: displayName, bio, avatarUrl, public)
 *   GET /users/:wallet                             public profile + followers/following counts
 *   GET /users/:wallet/followers?limit&cursor      private profiles are hidden from others' lists and counts
 *   GET /users/:wallet/following
 *   GET /follows                                   -> {following}
 *   POST/DELETE /follows/:wallet                   idempotent
 *   GET/PUT /copy-settings/:leader                 requires following the leader
 *   GET /notifications?limit&before                -> {notifications, next}
 *   GET /notifications/stream                      Server-Sent Events (Authorization: Bearer)
 *   GET /health
 */
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { RateLimiter, clientKey } from "../indexer/server.js";
import { hmacSessionAuth, createSessionToken, MIN_SECRET_BYTES, type Authenticator } from "../session.js";
import type { CopySettings, RiskFlag } from "./ports.js";
import { buildMessage, decodeSignature, isWallet, newNonce, nonceOf, verifyEd25519 } from "./siws.js";
import { RISK_FLAGS, type SocialStore, type StoredNotification } from "./store.js";

export const LAMPORTS_PER_SOL = 1_000_000_000;
export const DEFAULT_MAX_BODY_BYTES = 16 * 1024;
export const DEFAULT_MAX_TRADE_LAMPORTS = 5 * LAMPORTS_PER_SOL;
export const MAX_SLIPPAGE_BPS = 3000;
export const MAX_MIN_TOKEN_AGE_SEC = 30 * 86_400;
export const MAX_DISPLAY_NAME = 50;
export const MAX_BIO = 280;
export const MAX_AVATAR_URL = 512;
const MAX_STREAMS_PER_USER = 5;
const MAX_STREAMS_TOTAL = 2_000;
const MAX_STREAMS_PER_IP = 20;
export const DEFAULT_SESSION_TTL_SECONDS = 12 * 3600;
const HEARTBEAT_MS = 25_000;

export interface SocialOptions {
  store: SocialStore;
  /** SESSION_SECRET, shared with the sponsor and copy engine. At least 32 bytes. */
  secret: string;
  /** SOCIAL_DOMAIN: the domain the sign-in message names. */
  domain: string;
  /** SOCIAL_CORS_ORIGIN: allowed origins (never "*"). Empty means no CORS headers. */
  corsOrigins?: string[];
  authenticate?: Authenticator;
  now?: () => number; // ms
  nonceTtlSeconds?: number;
  sessionTtlSeconds?: number;
  maxBodyBytes?: number;
  maxTradeLamports?: number;
  ipRateLimit?: { windowMs: number; max: number } | false;
  /** Stricter per-IP limit for /auth/*. */
  authRateLimit?: { windowMs: number; max: number } | false;
  userRateLimit?: { windowMs: number; max: number } | false;
  trustProxy?: boolean;
  requestTimeoutMs?: number;
  heartbeatMs?: number;
  /** Per-wallet limit on /auth/nonce (in addition to per-IP). Default 10 per minute. */
  walletNonceRateLimit?: { windowMs: number; max: number } | false;
  /** Bind each nonce to the requesting IP and require the same IP at verify. Default true (SOCIAL_NONCE_BIND_IP=0 opts out for mobile networks). */
  bindNonceIp?: boolean;
  /** Open notification streams: global and per client IP. */
  maxStreams?: number;
  maxStreamsPerIp?: number;
}

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const bad = (code: string, message: string) => new HttpError(400, code, message);

const CONTROL = /[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;
export function cleanText(s: string, keepNewlines = false): string {
  return s.replace(CONTROL, (c) => (keepNewlines && c === "\n" ? c : "")).trim();
}
const cpLen = (s: string) => [...s].length;

export function parseAvatarUrl(v: unknown): string | null {
  if (v === null || v === "") return null;
  if (typeof v !== "string") throw bad("invalid_avatar_url", "avatarUrl must be a string or null");
  const raw = cleanText(v);
  if (raw.length > MAX_AVATAR_URL) throw bad("invalid_avatar_url", "avatarUrl is too long");
  let u: URL;
  try { u = new URL(raw); } catch { throw bad("invalid_avatar_url", "avatarUrl must be an https URL"); }
  if (u.protocol !== "https:" || !u.hostname || u.username || u.password) throw bad("invalid_avatar_url", "avatarUrl must be an https URL");
  return u.href;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

export function createSocialServer(opts: SocialOptions): Server {
  const { store, domain } = opts;
  if (Buffer.byteLength(opts.secret ?? "", "utf8") < MIN_SECRET_BYTES) throw new Error(`SESSION_SECRET must be at least ${MIN_SECRET_BYTES} bytes`);
  if (!domain || /[\s/]/.test(domain)) throw new Error("SOCIAL_DOMAIN must be a bare domain such as app.example.com");
  const origins = new Set(opts.corsOrigins ?? []);
  for (const o of origins) if (o === "*" || !/^https?:\/\/[^\s/*]+$/.test(o)) throw new Error("SOCIAL_CORS_ORIGIN must list exact origins, never *");
  const authenticate = opts.authenticate ?? hmacSessionAuth(opts.secret, { aud: "social", revocation: store });
  const now = opts.now ?? Date.now;
  const nonceTtl = (opts.nonceTtlSeconds ?? 300) * 1000;
  const sessionTtl = opts.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxTrade = opts.maxTradeLamports ?? DEFAULT_MAX_TRADE_LAMPORTS;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
  const mk = (c: { windowMs: number; max: number } | false | undefined, def: { windowMs: number; max: number }) => {
    const v = c === undefined ? def : c;
    return v === false ? null : new RateLimiter(v.windowMs, v.max, undefined, now);
  };
  const ipRl = mk(opts.ipRateLimit, { windowMs: 60_000, max: 300 });
  const authRl = mk(opts.authRateLimit, { windowMs: 60_000, max: 20 });
  const walletRl = mk(opts.walletNonceRateLimit, { windowMs: 60_000, max: 10 });
  const bindIp = opts.bindNonceIp ?? true;
  const maxStreams = opts.maxStreams ?? MAX_STREAMS_TOTAL;
  const maxStreamsPerIp = opts.maxStreamsPerIp ?? MAX_STREAMS_PER_IP;
  const userRl = mk(opts.userRateLimit, { windowMs: 60_000, max: 120 });
  const ipOf = (req: IncomingMessage) => {
    const xff = opts.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",").pop()!.trim() : "";
    return clientKey(xff || req.socket.remoteAddress || "unknown");
  };

  const ipHashOf = (ip: string) => createHmac("sha256", opts.secret).update(`nonce-ip|${ip}`).digest("hex").slice(0, 32);
  let streamCount = 0;
  const streamsByIp = new Map<string, number>();
  const streams = new Map<string, Set<ServerResponse>>();
  const sseWrite = (res: ServerResponse, n: StoredNotification) => res.write(`id: ${n.seq}\nevent: intent\ndata: ${JSON.stringify(n.intent)}\n\n`);
  store.onNotify((follower, n) => { for (const r of streams.get(follower) ?? []) sseWrite(r, n); });

  async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    if (Number(req.headers["content-length"]) > maxBody) throw new HttpError(413, "body_too_large", "Request body is too large.");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > maxBody) throw new HttpError(413, "body_too_large", "Request body is too large.");
      chunks.push(c as Buffer);
    }
    let v: unknown;
    try { v = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw bad("invalid_json", "Body must be valid JSON."); }
    if (!v || typeof v !== "object" || Array.isArray(v)) throw bad("invalid_json", "Body must be a JSON object.");
    return v as Record<string, unknown>;
  }

  const walletParam = (s: string) => {
    if (!isWallet(s)) throw bad("invalid_wallet", "Not a valid wallet address.");
    return s;
  };

  // ---- auth ----
  async function nonce(req: IncomingMessage, res: ServerResponse, ip: string) {
    const { wallet } = await readJson(req);
    if (!isWallet(wallet)) throw bad("invalid_wallet", "Not a valid wallet address.");
    const wwait = walletRl?.take(`w|${wallet}`) ?? 0;
    if (wwait) return send(res, 429, { error: { code: "rate_limited", message: "Too many requests." } }, { "retry-after": String(wwait) });
    const issuedAt = now(), expiresAt = issuedAt + nonceTtl;
    const n = newNonce();
    const message = buildMessage({ domain, wallet, nonce: n, issuedAt, expiresAt });
    if (!store.issueNonce(wallet, n, message, expiresAt, issuedAt, ipHashOf(ip)))
      return send(res, 429, { error: { code: "rate_limited", message: "Too many requests." } }, { "retry-after": "60" });
    send(res, 200, { nonce: n, message });
  }

  async function verify(req: IncomingMessage, res: ServerResponse, ip: string) {
    const { wallet, message, signature } = await readJson(req);
    const fail = () => new HttpError(401, "invalid_signin", "Sign-in failed.");
    if (!isWallet(wallet) || typeof message !== "string" || message.length > 1024) throw fail();
    const sig = decodeSignature(signature);
    const n = nonceOf(message);
    if (!sig || !n) throw fail();
    const issued = store.consumeNonce(n); // burned whatever happens next
    if (!issued || issued.wallet !== wallet || issued.message !== message || issued.expiresAt <= now()) throw fail();
    if (bindIp && issued.ipHash !== ipHashOf(ip)) throw fail();
    if (!message.startsWith(`${domain} wants you to sign in`)) throw fail();
    if (!verifyEd25519(wallet, message, sig)) throw fail();
    const t = now();
    const firstSeen = store.recordSignIn(wallet, t);
    const tokens = {
      social: createSessionToken(opts.secret, wallet, sessionTtl, t, "social"),
      copy: createSessionToken(opts.secret, wallet, sessionTtl, t, "copy"),
      sponsor: createSessionToken(opts.secret, wallet, sessionTtl, t, "sponsor", { firstSeen }),
    };
    send(res, 200, { token: tokens.social, tokens });
  }

  // ---- profiles ----
  const publicProfile = (p: ReturnType<SocialStore["getProfile"]>) => ({ wallet: p.wallet, displayName: p.displayName, bio: p.bio, avatarUrl: p.avatarUrl, public: p.public });

  async function putMe(req: IncomingMessage, res: ServerResponse, me: string) {
    const b = await readJson(req);
    const p = store.getProfile(me);
    for (const k of Object.keys(b)) if (!["displayName", "bio", "avatarUrl", "public"].includes(k)) throw bad("unknown_field", `Unknown field: ${k.slice(0, 40)}`);
    if (b.displayName !== undefined) {
      if (typeof b.displayName !== "string") throw bad("invalid_display_name", "displayName must be a string.");
      p.displayName = cleanText(b.displayName);
      if (cpLen(p.displayName) > MAX_DISPLAY_NAME) throw bad("invalid_display_name", `displayName is at most ${MAX_DISPLAY_NAME} characters.`);
    }
    if (b.bio !== undefined) {
      if (typeof b.bio !== "string") throw bad("invalid_bio", "bio must be a string.");
      p.bio = cleanText(b.bio, true);
      if (cpLen(p.bio) > MAX_BIO) throw bad("invalid_bio", `bio is at most ${MAX_BIO} characters.`);
    }
    if (b.avatarUrl !== undefined) p.avatarUrl = parseAvatarUrl(b.avatarUrl);
    if (b.public !== undefined) {
      if (typeof b.public !== "boolean") throw bad("invalid_public", "public must be a boolean.");
      p.public = b.public;
    }
    store.putProfile(p);
    send(res, 200, publicProfile(p));
  }

  function publicUser(wallet: string, viewer: string) {
    const p = store.getProfile(wallet);
    if (viewer !== wallet && (!p.public || !store.userExists(wallet))) throw new HttpError(404, "not_found", "Not found.");
    return p;
  }

  // ---- copy settings ----
  function defaults(follower: string, leader: string): CopySettings {
    const perTrade = Math.min(LAMPORTS_PER_SOL, maxTrade);
    return {
      follower, leader, enabled: false, mode: "fixed",
      fixedLamports: Math.min(100_000_000, perTrade), ratioBps: 1000,
      maxPerTradeLamports: perTrade, dailyCapLamports: Math.max(perTrade, Math.min(5 * LAMPORTS_PER_SOL, maxTrade)),
      slippageBps: 300, copySells: true, copyPerps: false, maxLeverage: 1,
      skipFlags: [...RISK_FLAGS], minTokenAgeSec: 0,
    };
  }
  const int = (v: unknown, name: string, min: number, max: number) => {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) throw bad("invalid_copy_settings", `${name} must be an integer from ${min} to ${max}.`);
    return v;
  };
  const bool = (v: unknown, name: string) => {
    if (typeof v !== "boolean") throw bad("invalid_copy_settings", `${name} must be a boolean.`);
    return v;
  };

  function mergeSettings(base: CopySettings, b: Record<string, unknown>, follower: string, leader: string): CopySettings {
    const s: CopySettings = { ...base, skipFlags: [...base.skipFlags] };
    for (const [k, v] of Object.entries(b)) {
      switch (k) {
        case "follower": case "leader":
          if (v !== (k === "follower" ? follower : leader)) throw bad("invalid_copy_settings", `${k} must match the request.`);
          break;
        case "enabled": s.enabled = bool(v, k); break;
        case "copySells": s.copySells = bool(v, k); break;
        case "copyPerps": s.copyPerps = bool(v, k); break;
        case "mode":
          if (v !== "fixed" && v !== "ratio") throw bad("invalid_copy_settings", "mode must be fixed or ratio.");
          s.mode = v; break;
        case "fixedLamports": s.fixedLamports = int(v, k, 1, maxTrade); break;
        case "ratioBps": s.ratioBps = int(v, k, 1, 10_000); break;
        case "maxPerTradeLamports": s.maxPerTradeLamports = int(v, k, 1, maxTrade); break;
        case "dailyCapLamports": s.dailyCapLamports = int(v, k, 1, Number.MAX_SAFE_INTEGER); break;
        case "slippageBps": s.slippageBps = int(v, k, 0, MAX_SLIPPAGE_BPS); break;
        case "maxLeverage": s.maxLeverage = int(v, k, 1, 10); break;
        case "minTokenAgeSec": s.minTokenAgeSec = int(v, k, 0, MAX_MIN_TOKEN_AGE_SEC); break;
        case "skipFlags":
          if (!Array.isArray(v) || v.length > RISK_FLAGS.length || v.some((f) => !RISK_FLAGS.includes(f as RiskFlag)))
            throw bad("invalid_copy_settings", `skipFlags must be a list from: ${RISK_FLAGS.join(", ")}.`);
          s.skipFlags = [...new Set(v as RiskFlag[])]; break;
        default: throw bad("invalid_copy_settings", `Unknown field: ${k.slice(0, 40)}`);
      }
    }
    if (s.maxPerTradeLamports > s.dailyCapLamports) throw bad("invalid_copy_settings", "maxPerTradeLamports must not exceed dailyCapLamports.");
    if (s.fixedLamports > s.maxPerTradeLamports) throw bad("invalid_copy_settings", "fixedLamports must not exceed maxPerTradeLamports.");
    return s;
  }

  // ---- notifications ----
  const view = (n: StoredNotification) => {
    const i = { ...n.intent };
    if (i.status === "pending" && i.expiresAt <= now()) i.status = "expired";
    return i;
  };
  const limitParam = (v: string | null, def: number, max: number) => {
    if (v === null || v === "") return def;
    if (!/^\d{1,6}$/.test(v) || Number(v) < 1) throw bad("invalid_limit", "limit must be a positive integer.");
    return Math.min(Number(v), max);
  };
  const cursorParam = (v: string | null) => {
    if (v === null || v === "") return null;
    if (!/^\d{1,15}$/.test(v)) throw bad("invalid_cursor", "Invalid cursor.");
    return Number(v);
  };

  function stream(req: IncomingMessage, res: ServerResponse, me: string, ip: string, expSec?: number) {
    const set = streams.get(me) ?? new Set();
    if (set.size >= MAX_STREAMS_PER_USER || streamCount >= maxStreams || (streamsByIp.get(ip) ?? 0) >= maxStreamsPerIp)
      throw new HttpError(429, "too_many_streams", "Too many open streams.");
    streamCount++;
    streamsByIp.set(ip, (streamsByIp.get(ip) ?? 0) + 1);
    req.socket.setTimeout(0);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write("retry: 5000\n\n");
    const last = /^\d{1,15}$/.test(String(req.headers["last-event-id"] ?? "")) ? Number(req.headers["last-event-id"]) : null;
    if (last !== null) for (const n of store.notificationsAfter(me, last, 100)) sseWrite(res, n);
    set.add(res);
    streams.set(me, set);
    const beat = setInterval(() => res.write(": ping\n\n"), heartbeatMs);
    // Close the stream when the token that opened it expires (clients reconnect with a fresh token).
    const life = expSec === undefined ? null : setTimeout(() => res.end(), Math.max(0, expSec * 1000 - now()));
    life?.unref();
    res.on("close", () => {
      clearInterval(beat); if (life) clearTimeout(life);
      set.delete(res); if (!set.size) streams.delete(me);
      streamCount--;
      const k = (streamsByIp.get(ip) ?? 1) - 1;
      if (k <= 0) streamsByIp.delete(ip); else streamsByIp.set(ip, k);
    });
  }

  // ---- routing ----
  async function route(req: IncomingMessage, res: ServerResponse) {
    const origin = req.headers.origin;
    if (typeof origin === "string" && origins.has(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "Origin");
    }
    const url = new URL(req.url ?? "/", "http://social.local");
    const path = url.pathname;
    const method = req.method ?? "GET";
    if (method === "OPTIONS") {
      const ok = typeof origin === "string" && origins.has(origin);
      return send(res, ok ? 204 : 403, ok ? "" : { error: { code: "cors_denied", message: "Origin not allowed." } }, ok ? {
        "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
        "access-control-allow-headers": "authorization, content-type, last-event-id",
        "access-control-max-age": "600",
      } : {});
    }
    if (path === "/health" && method === "GET") return send(res, 200, { ok: true });

    const ip = ipOf(req);
    const wait = (path.startsWith("/auth/") ? authRl?.take(`a|${ip}`) : 0) || ipRl?.take(ip) || 0;
    if (wait) return send(res, 429, { error: { code: "rate_limited", message: "Too many requests." } }, { "retry-after": String(wait) });

    if (path === "/auth/nonce" || path === "/auth/verify") {
      if (method !== "POST") throw new HttpError(405, "method_not_allowed", "Method not allowed.");
      return path === "/auth/nonce" ? nonce(req, res, ip) : verify(req, res, ip);
    }

    const auth = await authenticate(req);
    const me = auth?.userId;
    if (!me || !isWallet(me)) throw new HttpError(401, "unauthorized", "Sign in required.");
    const uwait = userRl?.take(me) ?? 0;
    if (uwait) return send(res, 429, { error: { code: "rate_limited", message: "Too many requests." } }, { "retry-after": String(uwait) });

    if (path === "/auth/logout") {
      if (method !== "POST") throw new HttpError(405, "method_not_allowed", "Method not allowed.");
      store.revoke(me, Math.floor(now() / 1000)); // tokens issued before the next second are dead
      for (const r of streams.get(me) ?? []) r.end();
      return send(res, 200, { ok: true });
    }

    if (path === "/me") {
      if (method === "GET") return send(res, 200, publicProfile(store.getProfile(me)));
      if (method === "PUT") return putMe(req, res, me);
      throw new HttpError(405, "method_not_allowed", "Method not allowed.");
    }
    if (path === "/follows" && method === "GET") return send(res, 200, { following: store.following(me) });

    let m = /^\/follows\/([^/]+)$/.exec(path);
    if (m) {
      const leader = walletParam(m[1]);
      if (method === "POST") {
        if (leader === me) throw bad("self_follow", "You cannot follow yourself.");
        if (!store.isFollowing(me, leader)) publicUser(leader, me); // cannot start following a private profile
        const r = store.follow(me, leader);
        if (r === "limit") throw new HttpError(409, "follow_limit", "Follow limit reached.");
        return send(res, 200, { following: true });
      }
      if (method === "DELETE") { store.unfollow(me, leader); return send(res, 200, { following: false }); }
      throw new HttpError(405, "method_not_allowed", "Method not allowed.");
    }

    m = /^\/users\/([^/]+)(\/followers|\/following)?$/.exec(path);
    if (m) {
      if (method !== "GET") throw new HttpError(405, "method_not_allowed", "Method not allowed.");
      const w = walletParam(m[1]);
      const p = publicUser(w, me);
      const own = w === me;
      if (m[2] === "/following") return send(res, 200, { following: store.following(w, own) });
      if (m[2]) {
        const r = store.followers(w, limitParam(url.searchParams.get("limit"), 50, 200), cursorParam(url.searchParams.get("cursor")) ?? 0, own);
        return send(res, 200, { followers: r.wallets, next: r.next });
      }
      return send(res, 200, { ...publicProfile(p), ...store.counts(w, own) });
    }

    m = /^\/copy-settings\/([^/]+)$/.exec(path);
    if (m) {
      const leader = walletParam(m[1]);
      if (method !== "GET" && method !== "PUT") throw new HttpError(405, "method_not_allowed", "Method not allowed.");
      if (!store.isFollowing(me, leader)) throw new HttpError(403, "not_following", "Follow this trader before copying.");
      const cur = store.getCopySettings(me, leader) ?? defaults(me, leader);
      if (method === "GET") return send(res, 200, cur);
      const next = mergeSettings(cur, await readJson(req), me, leader);
      store.putCopySettings(next);
      return send(res, 200, next);
    }

    if (path === "/notifications" && method === "GET") {
      const r = store.notifications(me, limitParam(url.searchParams.get("limit"), 50, 100), cursorParam(url.searchParams.get("before")));
      return send(res, 200, { notifications: r.items.map(view), next: r.next });
    }
    if (path === "/notifications/stream" && method === "GET") return stream(req, res, me, ip, auth?.exp);

    throw new HttpError(404, "not_found", "Not found.");
  }

  const server = createServer({
    requestTimeout: requestTimeoutMs,
    headersTimeout: Math.min(requestTimeoutMs, 60_000),
    connectionsCheckingInterval: Math.min(Math.max(Math.floor(requestTimeoutMs / 2), 100), 30_000),
  }, (req, res) => {
    route(req, res).catch((e) => {
      if (res.headersSent) return res.destroy();
      if (e instanceof HttpError) return send(res, e.status, { error: { code: e.code, message: e.message } });
      console.error(`[social] ${(e as Error).stack ?? e}`);
      send(res, 500, { error: { code: "internal_error", message: "Internal error." } });
    });
  });
  server.setTimeout(requestTimeoutMs, (sock) => sock.destroy());
  server.on("close", () => { for (const set of streams.values()) for (const r of set) r.end(); });
  return server;
}
