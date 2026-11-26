/**
 * Devnet check for the creator-fee lock (docs/creator-fee-lock.md), run after
 * scripts/upgrade.sh has upgraded the launch program.
 *
 *   1. Launches a fresh token and buys a little, so creator fees accrue.
 *   2. Claims them at once: must fail with CreatorFeesLocked, and leave
 *      creator_fees_owed untouched.
 *   3. If ANCHOR_WALLET created a curve over 7 days ago that still has fees
 *      owed, really claims those (to the same wallet): must succeed, since old
 *      curves are unaffected.
 *
 * Costs about 0.1 SOL (launch fee, a 0.05 SOL buy, rent, metadata). Uses ANCHOR_WALLET as creator.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";

const { AnchorProvider, Program, Wallet, BN } = anchor;
const ROOT = resolve(import.meta.dirname, "../..");
const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];
const enc = (s: string) => Buffer.from(s);
const META = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const LOCK_SECONDS = 7 * 24 * 3600;
const RPC_URL = process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
/** Hides the RPC URL (it can carry an API key in any form) and api-key params. */
const redact = (s: string) =>
  s.split(RPC_URL).join("<rpc>").replace(/(api[-_]?key|token)=[^&\s"']+/gi, "$1=<redacted>");

const ok = (m: string) => console.log(`  ✓ ${m}`);
function check(cond: boolean, m: string): asserts cond {
  if (!cond) throw new Error(`✗ ${m}`);
  ok(m);
}
const errCode = (e: any): string | undefined =>
  e?.error?.errorCode?.code ?? (String(e?.logs ?? e?.message ?? "").match(/Error Code: (\w+)/)?.[1]);

async function main() {
  const url = RPC_URL;
  const walletPath = process.env.ANCHOR_WALLET ?? `${process.env.HOME}/.config/solana/id.json`;
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf8"))));
  const connection = new Connection(url, { commitment: "confirmed" });
  const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
  const idl = JSON.parse(readFileSync(resolve(ROOT, "target/idl/ringside_launch.json"), "utf8"));
  check(idl.errors.some((e: any) => e.name === "CreatorFeesLocked"), "IDL has CreatorFeesLocked (built from the lock commit)");
  const launch = new Program(idl, provider) as any;
  const global = pda([enc("global")], launch.programId);
  const g = await launch.account.global.fetch(global);
  console.log(`  creator ${payer.publicKey.toBase58()}, launch program ${launch.programId.toBase58()}`);

  console.log("\n1. Launch a token and accrue creator fees");
  const mint = Keypair.generate();
  const curve = pda([enc("curve"), mint.publicKey.toBuffer()], launch.programId);
  const trade = {
    global, mint: mint.publicKey, curve, curveTokenVault: getAssociatedTokenAddressSync(mint.publicKey, curve, true),
    feeRecipient: g.feeRecipient, insuranceRecipient: g.insuranceRecipient,
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  };
  await launch.methods
    .createToken({ name: "Fee Lock Test", symbol: "LOCK", uri: "", devBuyLamports: new BN(0) })
    .accountsPartial({
      creator: payer.publicKey, ...trade, devLockVault: pda([enc("dev_lock"), mint.publicKey.toBuffer()], launch.programId),
      metadata: pda([enc("metadata"), META.toBuffer(), mint.publicKey.toBuffer()], META), tokenMetadataProgram: META,
    })
    .signers([mint])
    .rpc();
  await launch.methods.buy(new BN(0.05 * LAMPORTS_PER_SOL), new BN(1)).accountsPartial({ trader: payer.publicKey, ...trade,
    traderTokenAccount: getAssociatedTokenAddressSync(mint.publicKey, payer.publicKey) }).rpc();
  const c0 = await launch.account.curve.fetch(curve);
  check(!c0.complete, "curve not complete");
  check(Number(c0.creatorFeesOwed) > 0, `creator fees owed: ${Number(c0.creatorFeesOwed)} lamports (mint ${mint.publicKey.toBase58()})`);
  const unlock = Number(c0.createdTs) + LOCK_SECONDS;
  ok(`claimable from ${new Date(unlock * 1000).toISOString()}`);

  console.log("\n2. Claim before 7 days must fail");
  let code: string | undefined;
  try {
    await launch.methods.claimCreatorFees().accountsPartial({ creator: payer.publicKey, curve }).rpc();
    code = "SUCCEEDED";
  } catch (e) {
    code = errCode(e) ?? redact(String((e as any)?.message ?? e)).slice(0, 300);
  }
  check(code !== "SUCCEEDED", "claim was rejected (if it succeeded, the launch program on chain is not upgraded)");
  check(code === "CreatorFeesLocked", `rejected with CreatorFeesLocked (got ${code})`);
  const c1 = await launch.account.curve.fetch(curve);
  check(Number(c1.creatorFeesOwed) === Number(c0.creatorFeesOwed), "creator_fees_owed unchanged (nothing forfeited)");

  console.log("\n3. Old curves are unaffected");
  const now = Math.floor(Date.now() / 1000);
  const mine = (await launch.account.curve.all([{ memcmp: { offset: 8 + 32, bytes: payer.publicKey.toBase58() } }]).catch((e: any) => {
    console.log(`  ! could not list your curves: ${redact(String(e?.message ?? e))}`);
    return [];
  }))
    .filter((c: any) => c.account.creator?.equals?.(payer.publicKey));
  const old = mine.find((c: any) => Number(c.account.creatorFeesOwed) > 0 && !c.account.complete && Number(c.account.createdTs) + LOCK_SECONDS <= now - 60);
  if (!old) {
    console.log("  – skipped: no curve of yours older than 7 days with fees owed (the local tests cover this case)");
  } else {
    const owed = Number(old.account.creatorFeesOwed);
    const before = await connection.getBalance(payer.publicKey);
    await launch.methods.claimCreatorFees().accountsPartial({ creator: payer.publicKey, curve: old.publicKey }).rpc();
    const after = await connection.getBalance(payer.publicKey);
    check(Number((await launch.account.curve.fetch(old.publicKey)).creatorFeesOwed) === 0, `claimed ${owed} lamports on ${old.publicKey.toBase58()}`);
    if (owed > 20_000) check(after - before > owed - 20_000, "lamports arrived (less the tx fee)");
  }
  console.log("\nCreator-fee lock verified on devnet.");
}

// Exit explicitly: the RPC websocket otherwise keeps the process alive after success.
main().then(() => process.exit(0)).catch((e) => {
  console.error(redact(String(e?.message ?? e)));
  process.exit(1);
});
