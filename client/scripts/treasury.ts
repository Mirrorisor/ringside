/**
 * Treasury jobs for protocol-owned liquidity ($RING plan).
 *
 *   sweep                                    claim $RING's creator fees and put them in the vault
 *   set-treasury <pubkey>                    admin: who owns protocol-owned LP shares
 *   limits <mint> <capUsd> <reduceOnly 0|1>  admin: market limits (keep $RING off perps)
 *   handover <newAuthority>                  admin: propose a new admin for both programs
 *                                            (the new key, e.g. the Squads vault, then accepts)
 *
 * Roles. The treasury (set-treasury; on mainnet the Squads vault) owns the LP
 * shares, so taking liquidity out needs the multisig. The sweep runs from a hot
 * ops key (ANCHOR_WALLET), which is also $RING's creator:
 *   1. perps creator fees on the $RING market (USDC) are claimed to the ops key,
 *   2. curve creator fees on $RING (SOL) are claimed to the ops key
 *      (mainnet + SWAP_SOL=1: swapped to USDC through Jupiter, keeping SOL_RESERVE),
 *   3. ops USDC above TREASURY_KEEP_USDC is deposited with deposit_to_treasury:
 *      the shares go to the treasury's LP account, never the ops key's
 *      (holders of $RING get no yield),
 *   4. accrued protocol fees are compounded into the treasury's LP shares.
 * The keeper also compounds hourly; running it here as well is harmless.
 *
 * Creator-fee model (docs/creator-fee-lock.md): a creator claim pays the early 20% at any time
 * and the locked 80% only once the curve has graduated. The claim instructions' accounts are
 * unchanged, so steps 1 and 2 only ever pay out what is claimable; before graduation that is the
 * early share, and a claim with nothing claimable logs "nothing to claim" and carries on.
 * Locked fees that are forfeited after 30 days are not claimed here: on the launch side they land
 * in the program's fee_recipient as SOL, and only reach vault liquidity when the SOL is swapped to
 * USDC and deposited (step 3), which is this sweep's job (SWAP_SOL=1), not an on-chain step.
 *
 * Env: ANCHOR_PROVIDER_URL, ANCHOR_WALLET (treasury key), RING_MINT, NETWORK,
 *      TREASURY_KEEP_USDC (default 0), SWAP_SOL, SOL_RESERVE (default 0.5).
 * Instructions are built from discriminators so this runs before the IDL is rebuilt.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";

const LAUNCH = new PublicKey("AfZWCTaDQEC9CVTwXkH7pFtDXs4RtLWCK5godexWQDVH");
const PERPS = new PublicKey("DsZ69w3q25nRmAzJCRBMLbwZWN6NyVbYipTWsCAUsg1F");
const USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const pda = (seeds: (Buffer | Uint8Array)[], p: PublicKey) => PublicKey.findProgramAddressSync(seeds, p)[0];
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });

const [cmd, ...args] = process.argv.slice(2);
if (!(cmd === "sweep" || (["set-treasury", "handover"].includes(cmd) && args.length === 1) || (cmd === "limits" && args.length === 3))) {
  console.log("usage: treasury.ts sweep | set-treasury <pubkey> | handover <newAuthority> | limits <mint> <capUsd> <reduceOnly 0|1>");
  process.exit(1);
}
const url = process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
const conn = new Connection(url, "confirmed");
const treasury = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.ANCHOR_WALLET ?? `${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const VAULT = pda([Buffer.from("vault")], PERPS);
const VAULT_USDC = pda([Buffer.from("vault_usdc")], PERPS);
const TREASURY_CONFIG = pda([Buffer.from("treasury")], PERPS);
async function readTreasury(): Promise<PublicKey | null> {
  const acc = await conn.getAccountInfo(TREASURY_CONFIG);
  return acc ? new PublicKey(acc.data.subarray(8, 40)) : null;
}
const send = (...ixs: TransactionInstruction[]) => sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [treasury]);

async function readVault() {
  const d = (await conn.getAccountInfo(VAULT))!.data;
  return { authority: new PublicKey(d.subarray(8, 40)), usdcMint: new PublicKey(d.subarray(72, 104)), protocolFees: d.readBigUInt64LE(128) };
}

async function sweep() {
  const v = await readVault();
  let owner = await readTreasury();
  if (!owner && process.env.NETWORK !== "mainnet" && v.authority.equals(treasury.publicKey)) {
    console.log("devnet: no treasury set; naming this wallet as the treasury");
    await setTreasury(treasury.publicKey.toBase58());
    owner = treasury.publicKey;
  }
  if (!owner) throw new Error("No treasury set yet: the admin runs `treasury.ts set-treasury <multisig vault>` first");
  console.log(`treasury (owns the LP shares): ${owner.toBase58()}; sweeping as ${treasury.publicKey.toBase58()}`);
  const lp = pda([Buffer.from("lp"), owner.toBuffer()], PERPS);
  const usdc = getAssociatedTokenAddressSync(v.usdcMint, treasury.publicKey);
  await send(createAssociatedTokenAccountIdempotentInstruction(treasury.publicKey, usdc, treasury.publicKey, v.usdcMint));

  const ring = process.env.RING_MINT ? new PublicKey(process.env.RING_MINT) : null;
  if (ring) {
    const market = pda([Buffer.from("market"), ring.toBuffer()], PERPS);
    const curve = pda([Buffer.from("curve"), ring.toBuffer()], LAUNCH);
    await trySend("perps creator fees on $RING (early 20%, plus the locked 80% after graduation)", new TransactionInstruction({ programId: PERPS, data: disc("claim_creator_fees"),
      keys: [{ pubkey: treasury.publicKey, isSigner: true, isWritable: false }, w(VAULT), w(VAULT_USDC), w(market), w(usdc), r(TOKEN_PROGRAM_ID), r(curve)] }));
    const before = await conn.getBalance(treasury.publicKey);
    const cix = new TransactionInstruction({ programId: LAUNCH, data: disc("claim_creator_fees"), keys: [w(treasury.publicKey, true), w(curve)] });
    if (await trySend("curve creator fees on $RING (early 20%, plus the locked 80% after graduation)", cix)) {
      console.log(`  +${((await conn.getBalance(treasury.publicKey)) - before) / LAMPORTS_PER_SOL} SOL (net of fee)`);
    }
    if (process.env.SWAP_SOL === "1") await swapSol(v.usdcMint);
  } else {
    console.log("RING_MINT not set: skipping $RING creator fees");
  }

  const keep = BigInt(Math.round(Number(process.env.TREASURY_KEEP_USDC ?? "0") * 1e6));
  const bal = (await getAccount(conn, usdc)).amount;
  if (bal > keep) {
    await send(new TransactionInstruction({ programId: PERPS, data: Buffer.concat([disc("deposit_to_treasury"), u64(bal - keep)]),
      keys: [w(treasury.publicKey, true), w(VAULT), w(VAULT_USDC), r(TREASURY_CONFIG), w(lp), w(usdc), r(TOKEN_PROGRAM_ID), r(SystemProgram.programId)] }));
    console.log(`✓ deposited ${Number(bal - keep) / 1e6} USDC as treasury-owned vault liquidity`);
  }

  const fees = (await readVault()).protocolFees;
  if (fees > 0n) {
    await send(new TransactionInstruction({ programId: PERPS, data: disc("compound_protocol_fees"),
      keys: [w(treasury.publicKey, true), w(VAULT), r(VAULT_USDC), r(TREASURY_CONFIG), w(lp), r(SystemProgram.programId)] }));
    console.log(`✓ compounded ${Number(fees) / 1e6} USDC of protocol fees`);
  }
  const lpAcc = await conn.getAccountInfo(lp);
  if (lpAcc) console.log(`treasury LP shares: ${Number(lpAcc.data.readBigUInt64LE(40)) / 1e6}`);
}

async function trySend(label: string, ix: TransactionInstruction): Promise<boolean> {
  const tx = new Transaction().add(ix);
  tx.feePayer = treasury.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) {
    const why = (sim.value.logs ?? []).find((l) => l.includes("Error Message"))?.split("Error Message: ")[1] ?? JSON.stringify(sim.value.err);
    console.log(`- ${label}: nothing to claim (${why})`);
    return false;
  }
  await send(ix);
  console.log(`✓ claimed ${label}`);
  return true;
}

/** Mainnet only: swap SOL above SOL_RESERVE to USDC through Jupiter (50 bps slippage cap). */
async function swapSol(usdcMint: PublicKey) {
  if (process.env.NETWORK !== "mainnet" || usdcMint.toBase58() !== USDC_MAINNET) {
    console.log("- SOL→USDC swap: mainnet only, skipped");
    return;
  }
  const reserve = Math.round(Number(process.env.SOL_RESERVE ?? "0.5") * LAMPORTS_PER_SOL);
  const amount = (await conn.getBalance(treasury.publicKey)) - reserve;
  if (amount < 0.05 * LAMPORTS_PER_SOL) return;
  const api = "https://lite-api.jup.ag/swap/v1";
  const quote = await (await fetch(`${api}/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${USDC_MAINNET}&amount=${amount}&slippageBps=50`)).json();
  if (!quote.outAmount) throw new Error(`Jupiter quote failed: ${JSON.stringify(quote).slice(0, 200)}`);
  const { swapTransaction } = await (await fetch(`${api}/swap`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: treasury.publicKey.toBase58(), wrapAndUnwrapSol: true }) })).json();
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([treasury]);
  const sig = await conn.sendTransaction(tx);
  await conn.confirmTransaction(sig, "confirmed");
  console.log(`✓ swapped ${amount / LAMPORTS_PER_SOL} SOL → ~${Number(quote.outAmount) / 1e6} USDC (${sig})`);
}

async function setTreasury(to: string) {
  const owner = new PublicKey(to);
  await send(new TransactionInstruction({ programId: PERPS, data: Buffer.concat([disc("set_treasury"), owner.toBuffer()]),
    keys: [w(treasury.publicKey, true), r(VAULT), w(TREASURY_CONFIG), r(SystemProgram.programId)] }));
  console.log(`✓ treasury set to ${owner.toBase58()} (owns protocol-owned LP shares)`);
}

/** Step 1 of moving admin to a multisig. Step 2 (accept_authority) is signed by the new authority, e.g. as a Squads proposal. */
async function handover(to: string) {
  const next = new PublicKey(to);
  const global = pda([Buffer.from("global")], LAUNCH);
  for (const [program, admin] of [[PERPS, VAULT], [LAUNCH, global]] as const) {
    const pending = pda([Buffer.from("pending_authority")], program);
    await send(new TransactionInstruction({ programId: program, data: Buffer.concat([disc("propose_authority"), next.toBuffer()]),
      keys: [w(treasury.publicKey, true), r(admin), w(pending), r(SystemProgram.programId)] }));
    console.log(`✓ proposed ${next.toBase58()} as admin of ${program.toBase58()}; it must now call accept_authority (pending ${pending.toBase58()})`);
  }
}

async function limits(mintArg: string, capUsd: string, reduceOnly: string) {
  const mint = new PublicKey(mintArg);
  const market = pda([Buffer.from("market"), mint.toBuffer()], PERPS);
  const curve = pda([Buffer.from("curve"), mint.toBuffer()], LAUNCH);
  const data = Buffer.concat([disc("set_market_limits"), u64(BigInt(Math.round(Number(capUsd) * 1e6))), Buffer.from([reduceOnly === "1" ? 1 : 0])]);
  await send(new TransactionInstruction({ programId: PERPS, data, keys: [{ pubkey: treasury.publicKey, isSigner: true, isWritable: false }, r(VAULT), w(market), r(curve)] }));
  console.log(`✓ ${mint}: OI cap override ${capUsd === "0" ? "none" : `$${capUsd}`}, reduce-only ${reduceOnly === "1"}`);
}

(cmd === "sweep" ? sweep() : cmd === "set-treasury" ? setTreasury(args[0]) : cmd === "handover" ? handover(args[0]) : limits(args[0], args[1], args[2])).then(() => process.exit(0), (e) => { console.error(e.message ?? e); process.exit(1); });
