/**
 * Devnet check for the creator-fee model (docs/creator-fee-lock.md), run after
 * scripts/upgrade.sh has upgraded and resized the launch accounts.
 *
 *   1. Launches a fresh token and buys a little, so a creator fee accrues.
 *   2. The fee is split 20% / 80%: creator_fees_owed = floor(fee * 20%),
 *      creator_fees_locked = the rest, and they sum to the fee exactly.
 *   3. Claims at once: succeeds and pays only the 20%; the locked 80% stays in the curve.
 *   4. Forfeiting before 30 days must fail with NotForfeitable (nothing moves).
 *
 * The forfeit that succeeds (after 30 days on a curve that never graduated) is covered by the
 * local tests (tests/tests/flow.rs); it cannot be waited for here, and forfeiting a real devnet
 * curve would move its owner's fees.
 *
 * The IDL is stale until `anchor build` regenerates it, so the new field is decoded by hand and
 * the forfeit instruction is built from its discriminator.
 *
 * Costs about 0.1 SOL (launch fee, a 0.05 SOL buy, rent, metadata). Uses ANCHOR_WALLET as creator.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";

const { AnchorProvider, Program, Wallet, BN } = anchor;
const ROOT = resolve(import.meta.dirname, "../..");
const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];
const enc = (s: string) => Buffer.from(s);
const META = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
/** Mirrors ringside_launch::CREATOR_FEE_EARLY_BPS and CREATOR_FEE_FORFEIT_SECONDS. */
const EARLY_BPS = 2_000n;
const FORFEIT_SECONDS = 30 * 24 * 3600;
const CURVE_LEN = 1219;
const RPC_URL = process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
/** Hides the RPC URL (it can carry an API key in any form) and api-key params. */
const redact = (s: string) =>
  s.split(RPC_URL).join("<rpc>").replace(/(api[-_]?key|token)=[^&\s"']+/gi, "$1=<redacted>");

const ok = (m: string) => console.log(`  ✓ ${m}`);
function check(cond: boolean, m: string): asserts cond {
  if (!cond) throw new Error(`✗ ${m}`);
  ok(m);
}

/** creator_fees_owed and creator_fees_locked from raw Curve bytes (name/symbol/uri are variable-length). */
function readCreatorFees(d: Buffer): { owed: bigint; locked: bigint } {
  let off = 8 + 32 + 32;
  for (let i = 0; i < 3; i++) off += 4 + d.readUInt32LE(off); // name, symbol, uri
  const owed = d.readBigUInt64LE(off + 32); // after virtual_sol, virtual_tokens, real_sol, real_tokens
  // dev_locked_tokens 8, dev_unlock_ts 8, complete 1, migrated 1, created_slot 8, created_ts 8,
  // price_cumulative 16, last_price_q64 16, last_slot 8, observations 32 * 24, obs_index 1, obs_count 1, bump 1
  const locked = d.readBigUInt64LE(off + 40 + 8 + 8 + 2 + 8 + 8 + 16 + 16 + 8 + 768 + 3);
  return { owed, locked };
}

async function main() {
  const walletPath = process.env.ANCHOR_WALLET ?? `${process.env.HOME}/.config/solana/id.json`;
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf8"))));
  const connection = new Connection(RPC_URL, { commitment: "confirmed" });
  const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
  const idl = JSON.parse(readFileSync(resolve(ROOT, "target/idl/ringside_launch.json"), "utf8"));
  const launch = new Program(idl, provider) as any;
  const global = pda([enc("global")], launch.programId);
  const g = await launch.account.global.fetch(global);
  console.log(`  creator ${payer.publicKey.toBase58()}, launch program ${launch.programId.toBase58()}`);

  console.log("\n1. Launch a token and accrue a creator fee");
  const mint = Keypair.generate();
  const curve = pda([enc("curve"), mint.publicKey.toBuffer()], launch.programId);
  const trade = {
    global, mint: mint.publicKey, curve, curveTokenVault: getAssociatedTokenAddressSync(mint.publicKey, curve, true),
    feeRecipient: g.feeRecipient, insuranceRecipient: g.insuranceRecipient,
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  };
  await launch.methods
    .createToken({ name: "Fee Split Test", symbol: "SPLIT", uri: "", devBuyLamports: new BN(0) })
    .accountsPartial({
      creator: payer.publicKey, ...trade, devLockVault: pda([enc("dev_lock"), mint.publicKey.toBuffer()], launch.programId),
      metadata: pda([enc("metadata"), META.toBuffer(), mint.publicKey.toBuffer()], META), tokenMetadataProgram: META,
    })
    .signers([mint])
    .rpc();
  const buyLamports = BigInt(0.05 * LAMPORTS_PER_SOL);
  await launch.methods.buy(new BN(buyLamports.toString()), new BN(1)).accountsPartial({ trader: payer.publicKey, ...trade,
    traderTokenAccount: getAssociatedTokenAddressSync(mint.publicKey, payer.publicKey) }).rpc();
  const info0 = (await connection.getAccountInfo(curve))!;
  check(info0.data.length === CURVE_LEN, `curve account is ${CURVE_LEN} bytes (has creator_fees_locked: the programs are upgraded)`);
  const c0 = await launch.account.curve.fetch(curve);
  check(!c0.complete, `curve not complete (mint ${mint.publicKey.toBase58()})`);

  console.log("\n2. The creator fee is split 20% / 80%");
  const fee = (buyLamports * BigInt(g.creatorFeeBps)) / 10_000n;
  const early = (fee * EARLY_BPS) / 10_000n;
  const { owed, locked } = readCreatorFees(info0.data);
  check(fee > 0n, `creator fee on the buy: ${fee} lamports`);
  check(owed === early, `creator_fees_owed = floor(20%) = ${early} (got ${owed})`);
  check(locked === fee - early, `creator_fees_locked = ${fee - early} (got ${locked})`);
  check(owed + locked === fee, "owed + locked equals the fee exactly");

  console.log("\n3. Claim now: pays only the early 20%");
  const curveBefore = await connection.getBalance(curve);
  const walletBefore = await connection.getBalance(payer.publicKey);
  await launch.methods.claimCreatorFees().accountsPartial({ creator: payer.publicKey, curve }).rpc();
  const curveAfter = await connection.getBalance(curve);
  const walletAfter = await connection.getBalance(payer.publicKey);
  check(BigInt(curveBefore - curveAfter) === early, `the curve paid out exactly ${early} lamports`);
  check(walletAfter - walletBefore > Number(early) - 50_000 && walletAfter - walletBefore <= Number(early), "the creator received it (less the tx fee)");
  const info1 = (await connection.getAccountInfo(curve))!;
  const after = readCreatorFees(info1.data);
  check(after.owed === 0n, "creator_fees_owed is now 0");
  check(after.locked === locked, `creator_fees_locked unchanged (${locked}): held until graduation`);

  console.log("\n4. Forfeit before 30 days must fail");
  const forfeit = new TransactionInstruction({
    programId: launch.programId,
    data: createHash("sha256").update("global:forfeit_creator_fees").digest().subarray(0, 8),
    keys: [
      { pubkey: global, isSigner: false, isWritable: false },
      { pubkey: curve, isSigner: false, isWritable: true },
      { pubkey: g.feeRecipient, isSigner: false, isWritable: true },
    ],
  });
  const tx = new Transaction().add(forfeit);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const sim = await connection.simulateTransaction(tx);
  const logs = (sim.value.logs ?? []).join("\n");
  check(sim.value.err !== null, "forfeit was rejected (if it succeeded, the 30-day rule is not enforced)");
  check(/NotForfeitable/.test(logs), `rejected with NotForfeitable (${redact(JSON.stringify(sim.value.err))})`);
  const info2 = (await connection.getAccountInfo(curve))!;
  check(readCreatorFees(info2.data).locked === locked, "creator_fees_locked still intact");
  ok(`forfeit opens at ${new Date((Number(c0.createdTs) + FORFEIT_SECONDS) * 1000).toISOString()} if the curve has not graduated`);
  console.log("\nCreator-fee split, early claim and forfeit guard verified on devnet.");
}

// Exit explicitly: the RPC websocket otherwise keeps the process alive after success.
main().then(() => process.exit(0)).catch((e) => {
  console.error(redact(String(e?.message ?? e)));
  process.exit(1);
});
