/**
 * Devnet-only faucet for the Ringside web app.
 *
 * POST /v1/faucet { wallet?: string, tradingAccount?: string }
 *   wallet         -> 0.25 devnet SOL (to launch tokens and buy on the curve)
 *   tradingAccount -> 50 test USDC (stands in for a Rings withdrawal)
 *
 * Runs with your devnet wallet, which is the test USDC mint authority.
 * Each address can be topped up once every 10 minutes.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { clusterOf } from "../src/cluster.js";

const ROOT = resolve(import.meta.dirname, "../..");
const url = process.env.RPC_URL ?? "https://api.devnet.solana.com";
if (!/devnet/.test(url) && process.env.FAUCET_ALLOW_ANY_RPC !== "1") throw new Error("The faucet only runs against devnet.");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.FAUCET_KEYPAIR!, "utf8"))));
const usdcMint = new PublicKey(JSON.parse(readFileSync(resolve(ROOT, "devnet-deployment.json"), "utf8")).usdcMint);
const connection = new Connection(url, "confirmed");
// It hands out SOL from your wallet: prove the cluster is devnet, whatever the URL says.
if (process.env.FAUCET_ALLOW_ANY_RPC !== "1" && clusterOf(await connection.getGenesisHash()) !== "devnet") {
  throw new Error("The faucet only runs against devnet (the RPC's genesis hash is not devnet's).");
}
const SOL_DRIP = 0.25 * LAMPORTS_PER_SOL;
const USDC_DRIP = 50_000_000;
const COOLDOWN_MS = 10 * 60_000;
const last = new Map<string, number>();

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "content-type": "application/json" };

createServer(async (req, res) => {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, cors);
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method === "OPTIONS") return reply(204, {});
    if (req.method === "GET" && req.url === "/v1/info") return reply(200, { usdcMint: usdcMint.toBase58(), solDrip: SOL_DRIP / LAMPORTS_PER_SOL, usdcDrip: USDC_DRIP / 1e6 });
    if (req.method !== "POST" || req.url !== "/v1/faucet") return reply(404, { code: "not_found" });
    let raw = "";
    for await (const c of req) {
      raw += c;
      if (raw.length > 2_000) return reply(413, { code: "too_large" });
    }
    const body = JSON.parse(raw || "{}") as { wallet?: string; tradingAccount?: string };
    const out: Record<string, string> = {};
    const ready = (k: string) => Date.now() - (last.get(k) ?? 0) > COOLDOWN_MS;

    if (body.wallet) {
      const to = new PublicKey(body.wallet);
      if (!ready(`sol:${to}`)) out.wallet = "cooldown";
      else {
        const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports: SOL_DRIP }));
        out.wallet = await connection.sendTransaction(tx, [payer]);
        await connection.confirmTransaction(out.wallet, "confirmed");
        last.set(`sol:${to}`, Date.now());
      }
    }
    if (body.tradingAccount) {
      const to = new PublicKey(body.tradingAccount);
      if (!ready(`usdc:${to}`)) out.tradingAccount = "cooldown";
      else {
        const ata = await getOrCreateAssociatedTokenAccount(connection, payer, usdcMint, to);
        out.tradingAccount = await mintTo(connection, payer, usdcMint, ata.address, payer, USDC_DRIP);
        last.set(`usdc:${to}`, Date.now());
      }
    }
    console.log(`[faucet] ${JSON.stringify(out)}`);
    reply(200, out);
  } catch (e) {
    console.error(`[faucet] error: ${(e as Error).message}`);
    reply(/429/.test(String(e)) ? 503 : 500, { code: "error", message: (e as Error).message });
  }
}).listen(Number(process.env.PORT ?? 8788), () => console.log(`[faucet] ${payer.publicKey.toBase58()} on :${process.env.PORT ?? 8788}`));
