/**
 * Runs the social backend.
 *   SESSION_SECRET            shared with sponsor and copy engine, at least 32 bytes (required)
 *   SOCIAL_DOMAIN             domain named in the sign-in message (required)
 *   SOCIAL_CORS_ORIGIN        comma-separated exact origins (no *)
 *   SOCIAL_PORT               default 8791
 *   SOCIAL_HOST               default 127.0.0.1
 *   SOCIAL_DB                 SQLite file (default ./social.db)
 *   SOCIAL_MAX_FOLLOWS        follows per user (default 500)
 *   SOCIAL_MAX_TRADE_SOL      server cap on a copy's per-trade size in SOL (default 5)
 *   SOCIAL_MAX_BODY_BYTES     JSON body limit (default 16384)
 *   SOCIAL_RATE_LIMIT_IP / _USER / _AUTH   requests per minute (defaults 300 / 120 / 20; 0 disables)
 *   SOCIAL_SESSION_TTL_SECONDS  default 43200 (12 h)
 *   SOCIAL_NONCE_BIND_IP=0    do not bind sign-in nonces to the requesting IP (mobile networks that change IP)
 *   SOCIAL_MAX_STREAMS / _PER_IP   open notification streams, global and per IP (defaults 2000 / 20)
 *   SOCIAL_TRUST_PROXY=1      key clients by the last X-Forwarded-For entry
 */
import { MIN_SECRET_BYTES } from "../session.js";
import { createSocialServer, LAMPORTS_PER_SOL, DEFAULT_MAX_BODY_BYTES } from "./server.js";
import { SocialStore } from "./store.js";

const num = (name: string, def: number) => {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  if (!/^\d{1,12}(\.\d{1,9})?$/.test(v)) throw new Error(`${name} must be a non-negative number`);
  return Number(v);
};
const secret = process.env.SESSION_SECRET ?? "";
if (Buffer.byteLength(secret, "utf8") < MIN_SECRET_BYTES) {
  console.error(`SESSION_SECRET must be set (at least ${MIN_SECRET_BYTES} bytes)`);
  process.exit(1);
}
const domain = process.env.SOCIAL_DOMAIN ?? "";
if (!domain) { console.error("SOCIAL_DOMAIN must be set"); process.exit(1); }
const port = num("SOCIAL_PORT", 8791);
if (!Number.isInteger(port) || port > 65_535) throw new Error("SOCIAL_PORT must be a port number");
const limit = (name: string, def: number) => { const max = num(name, def); return max > 0 ? { windowMs: 60_000, max } : false as const; };

const dbPath = process.env.SOCIAL_DB ?? "./social.db";
const store = new SocialStore(dbPath, num("SOCIAL_MAX_FOLLOWS", 500));
const server = createSocialServer({
  store, secret, domain,
  corsOrigins: (process.env.SOCIAL_CORS_ORIGIN ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  maxTradeLamports: Math.round(num("SOCIAL_MAX_TRADE_SOL", 5) * LAMPORTS_PER_SOL),
  maxBodyBytes: num("SOCIAL_MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES),
  sessionTtlSeconds: num("SOCIAL_SESSION_TTL_SECONDS", 43_200),
  ipRateLimit: limit("SOCIAL_RATE_LIMIT_IP", 300),
  userRateLimit: limit("SOCIAL_RATE_LIMIT_USER", 120),
  authRateLimit: limit("SOCIAL_RATE_LIMIT_AUTH", 20),
  bindNonceIp: process.env.SOCIAL_NONCE_BIND_IP !== "0",
  maxStreams: num("SOCIAL_MAX_STREAMS", 2000),
  maxStreamsPerIp: num("SOCIAL_MAX_STREAMS_PER_IP", 20),
  trustProxy: process.env.SOCIAL_TRUST_PROXY === "1",
});
server.listen(port, process.env.SOCIAL_HOST ?? "127.0.0.1", () => console.log(`[social] listening on :${port}, db ${dbPath}`));

const shutdown = () => { server.close(() => { store.close(); process.exit(0); }); server.closeAllConnections(); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
