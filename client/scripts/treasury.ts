/**
 * Treasury jobs for protocol-owned liquidity ($RING plan).
 *
 *   sweep                                    claim $RING's creator fees and put them in the vault,
 *                                            then run `forfeits` (below)
 *   forfeits [--dry-run]                     turn forfeited creator-fee SOL into treasury-owned liquidity
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
 *
 * Forfeits (`forfeits`, and the last part of `sweep`): launch `forfeit_creator_fees` pays the locked SOL to
 * global.fee_recipient, mixed with ordinary protocol revenue. This job scans the launch program's finalized
 * transactions for the `CreatorFeesForfeited` event (successful ones only), keeps a cursor and running totals in
 * FORFEIT_STATE_FILE (default ./forfeit-state.json), and, only when the running wallet IS the fee_recipient, swaps
 * exactly the not-yet-converted forfeited lamports (never more than balance - SOL_RESERVE) to USDC and calls
 * deposit_to_treasury with the USDC received. Otherwise it prints what should be converted and exits 0.
 * --dry-run / FORFEIT_DRY_RUN=1: scan and report only, send nothing, write no state (on `sweep` the whole
 * sweep is skipped and only this report runs). The pure parsing and accounting are in src/forfeits.ts.
 * Env: FORFEIT_STATE_FILE, FORFEIT_DRY_RUN, FORFEIT_SCAN_MAX (signatures per scan, default 20000).
 *
 * Env: ANCHOR_PROVIDER_URL, ANCHOR_WALLET (treasury key), RING_MINT, NETWORK,
 *      TREASURY_KEEP_USDC (default 0), SWAP_SOL, SOL_RESERVE (default 0.5).
 * Instructions are built from discriminators so this runs before the IDL is rebuilt.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { decodeFeeRecipient } from "../src/graduation.js";
import { applyScan, emptyState, parseState, pendingLamports, planConversion, recordDeposit, recordSwap, summaryLine, type ForfeitState, type ScannedTx } from "../src/forfeits.js";
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";

const LAUNCH = new PublicKey("AfZWCTaDQEC9CVTwXkH7pFtDXs4RtLWCK5godexWQDVH");
const PERPS = new PublicKey("DsZ69w3q25nRmAzJCRBMLbwZWN6NyVbYipTWsCAUsg1F");
const USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const pda = (seeds: (Buffer | Uint8Array)[], p: PublicKey) => PublicKey.findProgramAddressSync(seeds, p)[0];
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });

const rawArgs = process.argv.slice(2);
const DRY = rawArgs.includes("--dry-run") || process.env.FORFEIT_DRY_RUN === "1";
const [cmd, ...args] = rawArgs.filter((a) => a !== "--dry-run");
if (!(cmd === "sweep" || (cmd === "forfeits" && args.length === 0) || (["set-treasury", "handover"].includes(cmd) && args.length === 1) || (cmd === "limits" && args.length === 3))) {
  console.log("usage: treasury.ts sweep | set-treasury <pubkey> | handover <newAuthority> | limits <mint> <capUsd> <reduceOnly 0|1> | forfeits [--dry-run]");
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
  if (DRY) {
    console.log("dry run: only the forfeits report runs; nothing is claimed, deposited or compounded");
    await forfeits(v.usdcMint);
    return;
  }
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

  // Forfeits first: they convert exactly the forfeited SOL, before SWAP_SOL below can sweep it up with everything else.
  await forfeits(v.usdcMint, usdc, lp);

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
    if (process.env.SWAP_SOL === "1") await swapSol(v.usdcMint, usdc);
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

/**
 * Mainnet only: swap SOL to USDC through Jupiter (50 bps slippage cap). `lamports` is the exact amount to swap
 * (the forfeits job); without it, everything above SOL_RESERVE (the SWAP_SOL=1 sweep). Returns the USDC (6 dp)
 * that arrived in `usdcAta` (measured from the balance), or null when nothing was swapped.
 */
async function swapSol(usdcMint: PublicKey, usdcAta: PublicKey, lamports?: bigint): Promise<{ usdc: bigint; sig: string } | null> {
  if (process.env.NETWORK !== "mainnet" || usdcMint.toBase58() !== USDC_MAINNET) {
    console.log("- SOL→USDC swap: mainnet only, skipped");
    return null;
  }
  const reserve = Math.round(Number(process.env.SOL_RESERVE ?? "0.5") * LAMPORTS_PER_SOL);
  const available = (await conn.getBalance(treasury.publicKey)) - reserve;
  const amount = lamports === undefined ? available : Number(lamports);
  if (lamports !== undefined && amount > available) throw new Error(`swap of ${amount} lamports exceeds the balance above SOL_RESERVE (${available})`);
  if (amount < 0.05 * LAMPORTS_PER_SOL && lamports === undefined) return null;
  if (amount <= 0) return null;
  const api = "https://lite-api.jup.ag/swap/v1";
  const quote = await (await fetch(`${api}/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${USDC_MAINNET}&amount=${amount}&slippageBps=50`)).json();
  if (!quote.outAmount) throw new Error(`Jupiter quote failed: ${JSON.stringify(quote).slice(0, 200)}`);
  if (String(quote.inAmount) !== String(amount)) throw new Error(`Jupiter quote is for ${quote.inAmount} lamports, expected ${amount}`);
  const before = (await getAccount(conn, usdcAta)).amount;
  const { swapTransaction } = await (await fetch(`${api}/swap`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: treasury.publicKey.toBase58(), wrapAndUnwrapSol: true }) })).json();
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([treasury]);
  const sig = await conn.sendTransaction(tx);
  await conn.confirmTransaction(sig, "confirmed");
  const usdc = (await getAccount(conn, usdcAta)).amount - before;
  console.log(`✓ swapped ${amount / LAMPORTS_PER_SOL} SOL → ${Number(usdc) / 1e6} USDC (${sig})`);
  return { usdc, sig };
}

// ---- forfeited creator-fee SOL -> treasury-owned liquidity ----

const stateFile = () => process.env.FORFEIT_STATE_FILE ?? "./forfeit-state.json";
const loadState = (): ForfeitState => (existsSync(stateFile()) ? parseState(JSON.parse(readFileSync(stateFile(), "utf8"))) : emptyState());
function saveState(st: ForfeitState) {
  const tmp = `${stateFile()}.tmp`;
  writeFileSync(tmp, JSON.stringify(st, null, 2) + "\n");
  renameSync(tmp, stateFile());
}

/** Every launch-program transaction newer than the cursor, newest first, with logs for the unseen successful ones. */
async function scanLaunch(state: ForfeitState): Promise<ScannedTx[]> {
  const max = Number(process.env.FORFEIT_SCAN_MAX ?? "20000");
  const infos: { signature: string; err: unknown | null }[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await conn.getSignaturesForAddress(LAUNCH, { before, until: state.cursor ?? undefined, limit: 1000 }, "finalized");
    infos.push(...page.map((p) => ({ signature: p.signature, err: p.err })));
    if (infos.length > max) throw new Error(`more than ${max} launch transactions since the cursor; raise FORFEIT_SCAN_MAX (nothing was saved)`);
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  const seen = new Set(state.processed);
  const todo = infos.filter((i) => !i.err && !seen.has(i.signature));
  const logs = new Map<string, string[]>();
  for (let i = 0; i < todo.length; i += 8) {
    await Promise.all(todo.slice(i, i + 8).map(async (t) => {
      const tx = await conn.getTransaction(t.signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
      if (!tx?.meta) throw new Error(`transaction ${t.signature} not available from the RPC (pruned?); nothing was saved`);
      logs.set(t.signature, tx.meta.err ? [] : tx.meta.logMessages ?? []);
    }));
  }
  return infos.map((i) => ({ signature: i.signature, err: i.err, logs: logs.get(i.signature) ?? null }));
}

async function forfeits(usdcMint: PublicKey, usdcAtaIn?: PublicKey, lp?: PublicKey) {
  let st = loadState();
  const scanned = applyScan(st, await scanLaunch(st), LAUNCH.toBase58());
  for (const e of scanned.events) console.log(`  forfeit ${Number(e.lamports) / LAMPORTS_PER_SOL} SOL on ${e.mint} (${e.signature})`);
  st = scanned.state;
  const g = await conn.getAccountInfo(pda([Buffer.from("global")], LAUNCH));
  if (!g) throw new Error("launch global account not found");
  const feeRecipient = new PublicKey(decodeFeeRecipient(new Uint8Array(g.data)));
  const reserve = BigInt(Math.round(Number(process.env.SOL_RESERVE ?? "0.5") * LAMPORTS_PER_SOL));
  const min = BigInt(Math.round(0.05 * LAMPORTS_PER_SOL));
  const plan = planConversion(st, BigInt(await conn.getBalance(treasury.publicKey)), reserve, min);
  if (!feeRecipient.equals(treasury.publicKey)) {
    console.log(`forfeited SOL: ${Number(st.totalForfeited) / 1e9} total, ${Number(st.totalConverted) / 1e9} converted, ${Number(pendingLamports(st)) / 1e9} pending.`
      + ` ${Number(pendingLamports(st)) / 1e9} SOL sits in the fee_recipient ${feeRecipient.toBase58()} and should be swapped to USDC and deposited with deposit_to_treasury; this wallet is not the fee_recipient, so nothing is sent and no state is written`);
    return;
  }
  if (DRY) {
    console.log(`dry run: forfeited SOL: ${Number(st.totalForfeited) / 1e9} total, ${Number(st.totalConverted) / 1e9} converted, ${Number(pendingLamports(st)) / 1e9} pending; would convert ${Number(plan) / 1e9} SOL`
      + ` (balance above the ${Number(reserve) / 1e9} SOL reserve, at least ${Number(min) / 1e9}), and deposit ${Number(BigInt(st.usdcPendingDeposit)) / 1e6} USDC left from an earlier run; state not written`);
    return;
  }
  saveState(st); // the scan itself is final: never read these transactions again
  const v = await readVault();
  const owner = await readTreasury();
  if (!owner) { console.log("- forfeits: no treasury set yet; nothing converted"); return; }
  const usdc = usdcAtaIn ?? getAssociatedTokenAddressSync(v.usdcMint, treasury.publicKey);
  const lpAcc = lp ?? pda([Buffer.from("lp"), owner.toBuffer()], PERPS);
  if (!usdcAtaIn) await send(createAssociatedTokenAccountIdempotentInstruction(treasury.publicKey, usdc, treasury.publicKey, v.usdcMint));

  let swapSig: string | null = null;
  if (plan > 0n) {
    const swapped = await swapSol(usdcMint, usdc, plan);
    if (swapped) {
      st = recordSwap(st, plan, swapped.usdc); // SOL is gone: record it before anything else can fail
      saveState(st);
      swapSig = swapped.sig;
    }
  }
  // Deposit what the swaps produced, never more than the wallet holds (the sweep may have deposited it already).
  const held = (await getAccount(conn, usdc)).amount;
  const owed = BigInt(st.usdcPendingDeposit);
  const dep = owed < held ? owed : held;
  let depTx: string | null = null;
  if (dep > 0n) {
    depTx = await send(new TransactionInstruction({ programId: PERPS, data: Buffer.concat([disc("deposit_to_treasury"), u64(dep)]),
      keys: [w(treasury.publicKey, true), w(VAULT), w(VAULT_USDC), r(TREASURY_CONFIG), w(lpAcc), w(usdc), r(TOKEN_PROGRAM_ID), r(SystemProgram.programId)] }));
  }
  if (dep > 0n || owed > 0n) { st = recordDeposit(st, dep < owed ? dep : owed); saveState(st); }
  console.log(summaryLine(st, dep, depTx ?? swapSig));
}

async function forfeitsCmd() {
  await forfeits((await readVault()).usdcMint);
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

(cmd === "sweep" ? sweep() : cmd === "forfeits" ? forfeitsCmd() : cmd === "set-treasury" ? setTreasury(args[0]) : cmd === "handover" ? handover(args[0]) : limits(args[0], args[1], args[2])).then(() => process.exit(0), (e) => { console.error(e.message ?? e); process.exit(1); });
