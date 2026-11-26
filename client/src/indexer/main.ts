/**
 * Runs the indexer.
 *   INDEXER_PORT           HTTP port (default 8787)
 *   INDEXER_DB             SQLite file (default ./indexer.db)
 *   HELIUS_WEBHOOK_SECRET  shared secret Helius sends in the Authorization header (required)
 *   INDEXER_SPONSOR_ADDRESSES     comma-separated sponsor / relayer / fee wallets, never taken as traders
 *   INDEXER_RATE_LIMIT_MAX        read requests per client IP per window (default 120; 0 disables)
 *   INDEXER_RATE_LIMIT_WINDOW_MS  rate-limit window (default 60000)
 *   INDEXER_REQUEST_TIMEOUT_MS    whole-request timeout (default 10000)
 *   INDEXER_TRUST_PROXY=1         key clients by the last X-Forwarded-For entry (behind one trusted proxy)
 */
import { isAddress } from "./helius.js";
import { createIndexerServer, DEFAULT_RATE_LIMIT, DEFAULT_REQUEST_TIMEOUT_MS } from "./server.js";
import { SqliteStore } from "./store.js";

const port = Number(process.env.INDEXER_PORT ?? 8787);
const dbPath = process.env.INDEXER_DB ?? "./indexer.db";
const secret = process.env.HELIUS_WEBHOOK_SECRET ?? "";

if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("INDEXER_PORT must be a port number");
if (secret.length < 16) {
  console.error("HELIUS_WEBHOOK_SECRET must be set (at least 16 characters)");
  process.exit(1);
}

const sponsorAddresses = (process.env.INDEXER_SPONSOR_ADDRESSES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const badSponsor = sponsorAddresses.find((a) => !isAddress(a));
if (badSponsor) throw new Error(`INDEXER_SPONSOR_ADDRESSES: not an address: ${badSponsor}`);
const intEnv = (name: string, def: number) => {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  if (!/^\d{1,12}$/.test(v)) throw new Error(`${name} must be a non-negative integer`);
  return Number(v);
};
const rateMax = intEnv("INDEXER_RATE_LIMIT_MAX", DEFAULT_RATE_LIMIT.max);
const rateWindow = intEnv("INDEXER_RATE_LIMIT_WINDOW_MS", DEFAULT_RATE_LIMIT.windowMs);
const requestTimeoutMs = intEnv("INDEXER_REQUEST_TIMEOUT_MS", DEFAULT_REQUEST_TIMEOUT_MS);
if (sponsorAddresses.length === 0) console.warn("[indexer] INDEXER_SPONSOR_ADDRESSES is empty: sponsored trades rely on account order alone");

const store = new SqliteStore(dbPath);
const server = createIndexerServer({
  store,
  webhookSecret: secret,
  sponsorAddresses,
  rateLimit: rateMax > 0 ? { windowMs: rateWindow, max: rateMax } : false,
  requestTimeoutMs,
  trustProxy: process.env.INDEXER_TRUST_PROXY === "1",
});
server.listen(port, () => console.log(`[indexer] listening on :${port}, db ${dbPath}`));

const shutdown = () => server.close(() => { store.close(); process.exit(0); });
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
