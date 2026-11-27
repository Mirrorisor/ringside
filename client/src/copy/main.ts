/**
 * Copy service entry point. Run as its own process: `node dist/copy/main.js` (or `bash scripts/services.sh start copy`).
 * Env: SESSION_SECRET, COPY_INGEST_SECRET,
 * COPY_PORT (8793), COPY_HOST (127.0.0.1), COPY_CORS_ORIGIN, COPY_DB (default ./copy.sqlite),
 * COPY_RPC_URL, COPY_FEE_WALLET, JUPITER_API_KEY, JUPITER_FEE_ACCOUNTS (our fee token accounts by mint),
 * SPONSOR_ADDRESS (optional).
 * Social port (the social backend must run with the same SOCIAL_INTERNAL_SECRET): SOCIAL_INTERNAL_SECRET (32+ bytes),
 * SOCIAL_INTERNAL_URL (default http://127.0.0.1:$SOCIAL_PORT, loopback only; SOCIAL_PORT default 8791).
 * Indexer: INDEXER_DB (default ./indexer.db) is opened read-only; the indexer must have created it.
 *
 * As a separate process this one cannot see logouts (token audiences are per service); the 12 h token lifetime
 * bounds that, see the README's "Revocation gap". `startCopyService(social, indexer, env)` stays exported for
 * embedding with other ports.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { createSolanaRpc, fetchAddressesForLookupTables } from "@solana/kit";
import { SqliteStore } from "../indexer/store.js";
import { readFileSync } from "node:fs";
import { hmacSessionAuth } from "../session.js";
import { Jupiter, parseFeeAccounts } from "../trade/jupiter.js";
import { type BuildDeps, cachedGenesisHash, cachedMintDecimals, meteoraPort, pumpPort } from "./build.js";
import { confirmPending, rpcTxPort } from "./confirm.js";
import { createCopyEngine } from "./engine.js";
import { perpsGateFromEnv } from "./perps.js";
import { rpcPerpsPort } from "./perpsport.js";
import { indexerFlagsPort } from "./flagsport.js";
import type { SocialPort } from "./ports.js";
import { httpSocialPort } from "./socialport.js";
import { createCopyServer } from "./server.js";
import { CopyStore } from "./store.js";
import { installLogRedaction } from "../logredact.js";

export function startCopyService(social: SocialPort, indexer: SqliteStore, env: NodeJS.ProcessEnv = process.env) {
  installLogRedaction(env); // keys in COPY_RPC_URL, JUPITER_API_KEY etc. never reach the logs
  const need = (k: string) => env[k] || (() => { throw new Error(`${k} is required`); })();
  const store = new CopyStore(env.COPY_DB ?? "copy.sqlite");
  const engine = createCopyEngine({ social, flags: indexerFlagsPort(indexer), store, log: console.error });
  const rpcUrl = need("COPY_RPC_URL");
  const rpc = createSolanaRpc(rpcUrl);
  const jup = new Jupiter({
    feeAccounts: parseFeeAccounts(env.JUPITER_FEE_ACCOUNTS),
    latestBlockhash: async () => (await rpc.getLatestBlockhash().send()).value,
    // Lookup tables come from our RPC, never from the Jupiter response.
    resolveLookupTables: (t) => fetchAddressesForLookupTables(t, rpc, { commitment: "confirmed" }),
  });
  const mintConn = new Connection(rpcUrl, "confirmed");
  const build: BuildDeps = {
    store,
    pump: pumpPort({ rpc: new Connection(rpcUrl, "confirmed"), feeWallet: need("COPY_FEE_WALLET") }),
    meteora: meteoraPort({ rpc: new Connection(rpcUrl, "confirmed") as never, feeWallet: need("COPY_FEE_WALLET") }),
    jupiter: { build: (r) => jup.buildSwap(r) },
    chain: { latestBlockhash: async () => (await rpc.getLatestBlockhash().send()).value },
    sponsor: env.SPONSOR_ADDRESS,
    // Real decimals from the mint account (cached), so 9-decimal coins are not compared at 6.
    tokenDecimals: cachedMintDecimals(async (m) => {
      const a = await mintConn.getAccountInfo(new PublicKey(m));
      return a ? { owner: a.owner.toBase58(), data: a.data } : null;
    }),
    // Perps: off unless RINGSIDE_COPY_PERPS=1; needs RINGSIDE_PERPS_IDL (path to target/idl/ringside_perps.json).
    perps: perpsGateFromEnv(env) && env.RINGSIDE_PERPS_IDL ? perpsDeps(env.RINGSIDE_PERPS_IDL, rpcUrl) : undefined,
  };
  const tx = rpcTxPort(rpc as never);
  const sweep = setInterval(() => { confirmPending({ store, tx }).catch((e) => console.error(`[copy] confirm sweep: ${(e as Error).message}`)); }, 15_000);
  sweep.unref();
  const server = createCopyServer({
    store, engine, build,
    // aud "copy": tokens for other services are refused. Revocation: see RevocationPort (multi-process gap).
    authenticate: hmacSessionAuth(need("SESSION_SECRET"), { aud: "copy" }),
    ingestSecret: need("COPY_INGEST_SECRET"),
    tx,
    corsOrigin: env.COPY_CORS_ORIGIN,
    trustProxy: env.COPY_TRUST_PROXY === "1",
  });
  // Loopback unless told otherwise: put a proxy in front, or set COPY_HOST deliberately.
  server.listen(Number(env.COPY_PORT ?? 8793), env.COPY_HOST || "127.0.0.1");
  return { server, store, engine };
}

function perpsDeps(idlPath: string, rpcUrl: string): NonNullable<BuildDeps["perps"]> {
  const idl = JSON.parse(readFileSync(idlPath, "utf8"));
  const conn = new Connection(rpcUrl, "confirmed");
  return { idl, port: rpcPerpsPort(conn, idl), rpcUrl, enabled: true, genesisHash: cachedGenesisHash(() => conn.getGenesisHash()) };
}

/** Ports for the standalone process, from env. Throws on a missing or short secret before anything is opened. */
export function copyPortsFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const social = httpSocialPort({
    baseUrl: env.SOCIAL_INTERNAL_URL || `http://127.0.0.1:${env.SOCIAL_PORT || 8791}`,
    secret: env.SOCIAL_INTERNAL_SECRET ?? "",
  });
  // Read-only: the indexer owns this file (WAL, so our reads never block its writes).
  const indexer = new SqliteStore(env.INDEXER_DB || "./indexer.db", { readOnly: true });
  return { social, indexer };
}

function main() {
  const { social, indexer } = copyPortsFromEnv();
  const { server, store } = startCopyService(social, indexer);
  server.on("listening", () => console.log(`[copy] listening on ${JSON.stringify(server.address())}`));
  const shutdown = () => { server.close(() => { store.close(); indexer.close(); process.exit(0); }); server.closeAllConnections(); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
if (/[\\/]copy[\\/]main\.[jt]s$/.test(process.argv[1] ?? "")) {
  try { main(); } catch (e) { console.error(`[copy] ${(e as Error).message}`); process.exit(1); }
}
