/**
 * Runs the indexer.
 *   INDEXER_PORT           HTTP port (default 8787)
 *   INDEXER_DB             SQLite file (default ./indexer.db)
 *   HELIUS_WEBHOOK_SECRET  shared secret Helius sends in the Authorization header (required)
 */
import { createIndexerServer } from "./server.js";
import { SqliteStore } from "./store.js";

const port = Number(process.env.INDEXER_PORT ?? 8787);
const dbPath = process.env.INDEXER_DB ?? "./indexer.db";
const secret = process.env.HELIUS_WEBHOOK_SECRET ?? "";

if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("INDEXER_PORT must be a port number");
if (secret.length < 16) {
  console.error("HELIUS_WEBHOOK_SECRET must be set (at least 16 characters)");
  process.exit(1);
}

const store = new SqliteStore(dbPath);
const server = createIndexerServer({ store, webhookSecret: secret });
server.listen(port, () => console.log(`[indexer] listening on :${port}, db ${dbPath}`));

const shutdown = () => server.close(() => { store.close(); process.exit(0); });
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
