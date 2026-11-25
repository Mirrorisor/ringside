/**
 * Full private path on devnet, with Helius Rings:
 *
 *   identity wallet --shield in--> Rings --sponsored withdrawal--> fresh trading account
 *   trading account --perp open/close via relayer, keeper fills--> PnL
 *   trading account --sponsored shield out--> Rings
 *
 * The identity wallet is the only account that ever pays its own fee (the
 * shield-in). The trading account never holds SOL.
 *
 * Reads the Helius key from HELIUS_KEY_FILE (default: Documents/helius-key.txt),
 * which may hold the key or a full RPC URL. Needs the relayer and keeper running.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo, getAccount } from "@solana/spl-token";
import { address } from "@solana/kit";
import { connect, loadShieldedUser, relayerInfo, shieldIn, fundTradingAccount, shieldOut } from "../src/rings.js";

const { AnchorProvider, Program, Wallet, BN } = anchor;
const ROOT = resolve(import.meta.dirname, "../..");
const USDC = 1_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = (s: string) => Buffer.from(s);
const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];
const step = (s: string) => console.log(`\n▸ ${s}`);

function heliusKey(): string {
  const file = process.env.HELIUS_KEY_FILE ?? "/mnt/c/Users/glyde/Documents/helius-key.txt";
  const text = readFileSync(file, "utf8").replace(/^﻿/, "").trim();
  const key = /api-key=([A-Za-z0-9-]+)/.exec(text)?.[1] ?? text;
  if (!/^[0-9a-f-]{36}$/.test(key)) throw new Error(`No Helius API key found in ${file}`);
  return key;
}

async function main() {
  const key = heliusKey();
  const rpcUrl = `https://devnet.helius-rpc.com/?api-key=${key}`;
  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.ANCHOR_WALLET!, "utf8"))));
  const provider = new AnchorProvider(connection, new Wallet(wallet), { commitment: "confirmed" });
  const perps = new Program(JSON.parse(readFileSync(resolve(ROOT, "target/idl/ringside_perps.json"), "utf8")), provider) as any;
  const state = JSON.parse(readFileSync(resolve(ROOT, "devnet-deployment.json"), "utf8"));
  const usdcMint = new PublicKey(state.usdcMint);
  const mint = new PublicKey(state.lastMint);
  const relayerUrl = process.env.RELAYER_URL ?? "http://localhost:8787";

  // Identity wallet: the user's "real" wallet. Kept in a file so reruns reuse its shielded balance.
  const idFile = resolve(ROOT, "test-trading-accounts/rings-identity.json");
  mkdirSync(resolve(ROOT, "test-trading-accounts"), { recursive: true });
  const identity = existsSync(idFile)
    ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(idFile, "utf8"))))
    : Keypair.generate();
  writeFileSync(idFile, JSON.stringify(Array.from(identity.secretKey)));
  const seed = identity.secretKey.slice(0, 32);
  console.log(`Identity wallet ${identity.publicKey.toBase58()}`);

  step("Connecting to Helius Rings (devnet, via your Helius RPC)");
  const client = await connect({ network: "devnet", heliusApiKey: key });
  const user = await loadShieldedUser(client, seed as never);
  const asset = address(usdcMint.toBase58());
  // A token Rings hasn't seen yet has no registry entry; its first deposit creates one.
  const shielded = () => {
    try { return Number(user.wallet.balance(asset).amount) / USDC; }
    catch (e) { if ((e as { code?: string }).code === "TRANSACTION_UNKNOWN_MINT") return 0; throw e; }
  };
  console.log(`  shielded test USDC: $${shielded().toFixed(2)}`);

  // Fund the identity wallet (devnet stand-in for the user's own funds).
  const idUsdc = (await getOrCreateAssociatedTokenAccount(connection, wallet, usdcMint, identity.publicKey)).address;
  if ((await connection.getBalance(identity.publicKey)) < 0.02 * LAMPORTS_PER_SOL) {
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: identity.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }));
    await provider.sendAndConfirm(tx);
  }
  if (shielded() < 10) {
    await mintTo(connection, wallet, usdcMint, idUsdc, wallet, 25 * USDC);
    step("Shield in: identity wallet deposits 20 test USDC into Rings (the only public link)");
    await shieldIn(client, user, address(idUsdc.toBase58()), 20n * BigInt(USDC), asset);
    console.log(`  shielded test USDC: $${shielded().toFixed(2)}`);
  }

  // Fresh trading account, derived from the identity seed so it can be recovered.
  const idx = Number(process.env.TRADING_INDEX ?? Date.now() % 100000);
  const tradingSeed = new Uint8Array(createHash("sha256").update(Buffer.concat([Buffer.from(seed), Buffer.from(`ringside/trading-account/v1/${idx}`)])).digest());
  const trader = Keypair.fromSeed(tradingSeed);
  writeFileSync(resolve(ROOT, `test-trading-accounts/${trader.publicKey.toBase58()}.json`), JSON.stringify(Array.from(trader.secretKey)));
  console.log(`\nTrading account ${trader.publicKey.toBase58()} (index ${idx})`);

  const relayer = await relayerInfo(relayerUrl);
  step("Private funding: Rings withdraws 10 test USDC straight to the trading account; the relayer pays");
  await fundTradingAccount(client, user, address(trader.publicKey.toBase58()), 10n * BigInt(USDC), relayer, asset);
  const traderUsdc = getAssociatedTokenAddressSync(usdcMint, trader.publicKey);
  console.log(`  trading account: $${(Number((await getAccount(connection, traderUsdc)).amount) / USDC).toFixed(2)} USDC, ${await connection.getBalance(trader.publicKey)} lamports`);
  console.log(`  shielded test USDC left: $${shielded().toFixed(2)}`);

  // Perp round trip through the relayer, filled by the keeper.
  const vault = pda([enc("vault")], perps.programId);
  const vaultUsdc = pda([enc("vault_usdc")], perps.programId);
  const market = pda([enc("market"), mint.toBuffer()], perps.programId);
  const m = await perps.account.market.fetch(market);
  const side = m.oiLong.gt(m.oiShort) ? 1 : 0;
  const position = pda([enc("position"), trader.publicKey.toBuffer(), market.toBuffer(), Uint8Array.from([side])], perps.programId);
  const order = pda([enc("order"), trader.publicKey.toBuffer(), market.toBuffer(), Uint8Array.from([side])], perps.programId);
  const sponsored = async (kind: number, collateral: number, size: number) => {
    const ix = await perps.methods
      .requestOrder({ side, kind, collateral: new BN(collateral), sizeUsd: new BN(size), acceptablePriceQ64: new BN(0) })
      .accountsPartial({ owner: trader.publicKey, payer: new PublicKey(relayer.address), vault, vaultUsdc, market, position, order, ownerUsdc: traderUsdc, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
      .instruction();
    const tx = new Transaction({ feePayer: new PublicKey(relayer.address), recentBlockhash: (await connection.getLatestBlockhash()).blockhash }).add(ix);
    tx.partialSign(trader);
    const res = await fetch(`${relayerUrl}/v1/sponsor`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transaction: tx.serialize({ requireAllSignatures: false }).toString("base64") }) });
    const body = await res.json();
    if (!res.ok) throw new Error(`relayer refused: ${body.code} ${body.message ?? ""}`);
    await connection.confirmTransaction(body.signature, "confirmed");
    for (let i = 0; i < 40; i++) {
      await sleep(3_000);
      if (!(await connection.getAccountInfo(order))) return;
    }
    throw new Error("keeper did not fill the order");
  };
  step(`Opening a $5 ${side ? "short" : "long"} from the trading account (relayer + keeper)`);
  await sponsored(0, 2_600_000, 5 * USDC);
  console.log("  filled");
  step("Closing it");
  await sponsored(1, 0, 0);
  const back = Number((await getAccount(connection, traderUsdc)).amount);
  console.log(`  closed; trading account holds $${(back / USDC).toFixed(4)}`);

  step("Shield out: trading account deposits everything back into Rings; the relayer pays");
  const traderSigner = await (await import("@solana/kit")).createKeyPairSignerFromPrivateKeyBytes(tradingSeed);
  await shieldOut(client, user, traderSigner, address(traderUsdc.toBase58()), BigInt(back), relayer, asset);
  const sol = await connection.getBalance(trader.publicKey);
  console.log(`  shielded test USDC now: $${shielded().toFixed(2)}`);
  console.log(`\nTrading account SOL: ${sol} lamports (should be 0)`);
  console.log(`Explorer: https://explorer.solana.com/address/${trader.publicKey.toBase58()}?cluster=devnet`);
  if (sol !== 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
