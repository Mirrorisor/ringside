/**
 * Copy service entry point. Env: SESSION_SECRET, COPY_INGEST_SECRET,
 * COPY_PORT (8793), COPY_HOST (127.0.0.1), COPY_CORS_ORIGIN, COPY_DB (default ./copy.sqlite),
 * COPY_RPC_URL, COPY_FEE_WALLET, JUPITER_API_KEY, SPONSOR_ADDRESS (optional).
 *
 * TODO(social): the SocialPort is the social backend's; until it is wired,
 * this entry point cannot run. Import `createCopyServer` from the backend
 * process and pass its own SocialPort and indexer store.
 */
import { Connection } from "@solana/web3.js";
import { createSolanaRpc } from "@solana/kit";
import { SqliteStore } from "../indexer/store.js";
import { readFileSync } from "node:fs";
import { hmacSessionAuth } from "../session.js";
import { Jupiter } from "../trade/jupiter.js";
import { type BuildDeps, meteoraPort, pumpPort } from "./build.js";
import { confirmPending, rpcTxPort } from "./confirm.js";
import { createCopyEngine } from "./engine.js";
import { perpsGateFromEnv } from "./perps.js";
import { rpcPerpsPort } from "./perpsport.js";
import { indexerFlagsPort } from "./flagsport.js";
import type { SocialPort } from "./ports.js";
import { createCopyServer } from "./server.js";
import { CopyStore } from "./store.js";

export function startCopyService(social: SocialPort, indexer: SqliteStore, env: NodeJS.ProcessEnv = process.env) {
  const need = (k: string) => env[k] || (() => { throw new Error(`${k} is required`); })();
  const store = new CopyStore(env.COPY_DB ?? "copy.sqlite");
  const engine = createCopyEngine({ social, flags: indexerFlagsPort(indexer), store, log: console.error });
  const rpcUrl = need("COPY_RPC_URL");
  const rpc = createSolanaRpc(rpcUrl);
  const jup = new Jupiter();
  const build: BuildDeps = {
    store,
    pump: pumpPort({ rpc: new Connection(rpcUrl, "confirmed"), feeWallet: need("COPY_FEE_WALLET") }),
    meteora: meteoraPort({ rpc: new Connection(rpcUrl, "confirmed") as never, feeWallet: need("COPY_FEE_WALLET") }),
    jupiter: { order: (r) => jup.getOrder(r) },
    chain: { latestBlockhash: async () => (await rpc.getLatestBlockhash().send()).value },
    sponsor: env.SPONSOR_ADDRESS,
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
  return { idl, port: rpcPerpsPort(new Connection(rpcUrl, "confirmed"), idl), rpcUrl, enabled: true };
}
