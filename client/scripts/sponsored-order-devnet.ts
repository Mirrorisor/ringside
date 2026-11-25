/**
 * Devnet test of the relayer + keeper path.
 *
 * A brand-new trading account that never holds SOL:
 *   1. gets 20 test USDC (minted by your wallet, standing in for a Rings withdrawal),
 *   2. sends request_order through the relayer, which pays the fee and the rent,
 *   3. waits for the keeper to fill it (this script never calls execute),
 *   4. closes the same way,
 * then checks the trading account still has 0 SOL and shows the USDC it got back.
 *
 * Needs the keeper and relayer running (scripts/services.sh starts them).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount, mintTo, getAccount } from "@solana/spl-token";

const { AnchorProvider, Program, Wallet, BN } = anchor;
const ROOT = resolve(import.meta.dirname, "../..");
const USDC = 1_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = (s: string) => Buffer.from(s);
const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];

async function main() {
  const url = process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
  const relayerUrl = process.env.RELAYER_URL ?? "http://localhost:8787";
  const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.ANCHOR_WALLET!, "utf8"))));
  const connection = new Connection(url, { commitment: "confirmed" });
  const provider = new AnchorProvider(connection, new Wallet(wallet), { commitment: "confirmed" });
  const perps = new Program(JSON.parse(readFileSync(resolve(ROOT, "target/idl/ringside_perps.json"), "utf8")), provider) as any;
  const state = JSON.parse(readFileSync(resolve(ROOT, "devnet-deployment.json"), "utf8"));
  const usdcMint = new PublicKey(state.usdcMint);
  const mint = new PublicKey(state.lastMint);

  const info = await (await fetch(`${relayerUrl}/v1/info`)).json();
  const relayer = new PublicKey(info.relayer);
  console.log(`Relayer ${relayer.toBase58()}  (${(await connection.getBalance(relayer)) / LAMPORTS_PER_SOL} SOL)`);

  // Fresh trading account: no SOL, ever.
  const trader = Keypair.generate();
  // Keep the key so a run that stops half way can still be closed later.
  mkdirSync(resolve(ROOT, "test-trading-accounts"), { recursive: true });
  writeFileSync(resolve(ROOT, `test-trading-accounts/${trader.publicKey.toBase58()}.json`), JSON.stringify(Array.from(trader.secretKey)));
  console.log(`Trading account ${trader.publicKey.toBase58()}`);
  const traderUsdc = (await getOrCreateAssociatedTokenAccount(connection, wallet, usdcMint, trader.publicKey)).address;
  await mintTo(connection, wallet, usdcMint, traderUsdc, wallet, 20 * USDC);
  console.log("  funded with 20 test USDC (stands in for a Rings withdrawal)");

  const vault = pda([enc("vault")], perps.programId);
  const vaultUsdc = pda([enc("vault_usdc")], perps.programId);
  const market = pda([enc("market"), mint.toBuffer()], perps.programId);
  // Trade the side that reduces the vault's net exposure, so the skew cap
  // (25% of the per-side cap) never blocks the test.
  const m = await perps.account.market.fetch(pda([enc("market"), mint.toBuffer()], perps.programId));
  const side = m.oiLong.gt(m.oiShort) ? 1 : 0;
  console.log(`  market OI: long $${m.oiLong.toNumber() / USDC}, short $${m.oiShort.toNumber() / USDC} -> testing a ${side ? "short" : "long"}`);
  const position = pda([enc("position"), trader.publicKey.toBuffer(), market.toBuffer(), Uint8Array.from([side])], perps.programId);
  const order = pda([enc("order"), trader.publicKey.toBuffer(), market.toBuffer(), Uint8Array.from([side])], perps.programId);

  const sponsored = async (kind: number, collateral: number, size: number) => {
    const ix = await perps.methods
      .requestOrder({ side, kind, collateral: new BN(collateral), sizeUsd: new BN(size), acceptablePriceQ64: new BN(0) })
      .accountsPartial({
        owner: trader.publicKey, payer: relayer, vault, vaultUsdc, market, position, order,
        ownerUsdc: traderUsdc, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .instruction();
    let res: Response, body: any;
    for (let attempt = 0; ; attempt++) {
      const tx = new Transaction({ feePayer: relayer, recentBlockhash: (await connection.getLatestBlockhash()).blockhash }).add(ix);
      tx.partialSign(trader);
      res = await fetch(`${relayerUrl}/v1/sponsor`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transaction: tx.serialize({ requireAllSignatures: false }).toString("base64") }),
      });
      body = await res.json();
      if (res.ok || body.code !== "rpc_busy" || attempt >= 5) break;
      console.log("  devnet RPC is busy; retrying in 10s");
      await sleep(10_000);
    }
    if (!res.ok) throw new Error(`relayer refused: ${body.code} ${body.message ?? ""}`);
    console.log(`  relayer sponsored ${body.signature} (spent ${body.spentLamports} lamports)`);
    await connection.confirmTransaction(body.signature, "confirmed");
  };
  const waitForKeeper = async (label: string) => {
    for (let i = 0; i < 60; i++) {
      await sleep(2_000);
      if (!(await connection.getAccountInfo(order))) return console.log(`  keeper filled the ${label} order`);
    }
    throw new Error(`keeper didn't fill the ${label} order within 2 minutes; check keeper.log`);
  };

  console.log(`\n▸ Opening a $5 ${side ? "short" : "long"} via the relayer`);
  await sponsored(0, 2_600_000, 5 * USDC);
  await waitForKeeper("open");
  const p = await perps.account.position.fetch(position);
  console.log(`  position: size $${p.sizeUsd.toNumber() / USDC}, collateral $${p.collateral.toNumber() / USDC}`);

  console.log("\n▸ Closing via the relayer");
  await sponsored(1, 0, 0);
  await waitForKeeper("close");

  const sol = await connection.getBalance(trader.publicKey);
  const usdcLeft = Number((await getAccount(connection, traderUsdc)).amount) / USDC;
  console.log(`\nTrading account SOL balance: ${sol} lamports (should be 0)`);
  console.log(`Trading account USDC: $${usdcLeft.toFixed(4)} of the $20 it started with`);
  console.log(`Explorer: https://explorer.solana.com/address/${trader.publicKey.toBase58()}?cluster=devnet`);
  if (sol !== 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
