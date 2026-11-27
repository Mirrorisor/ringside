/**
 * Devnet check for the upgrade: admin settings, Pyth price, and a full
 * graduation to Raydium.
 *
 *   1. Sets devnet-sized fees and caps (admin; idempotent).
 *   2. Waits for the keeper to refresh SOL/USD from Pyth and compares it with Hermes.
 *   3. Launches a token, buys the whole curve (~1.5 SOL on the devnet build),
 *      then waits for the keeper to migrate it to Raydium and graduate its
 *      perp market.
 *   4. Checks the pool opened at the curve's final price with every LP token
 *      burned, and that the market now prices from the pool.
 *
 * Needs the keeper running (scripts/services.sh). Uses ANCHOR_WALLET as admin and buyer.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";

const { AnchorProvider, Program, Wallet, BN } = anchor;
const ROOT = resolve(import.meta.dirname, "../..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];
const enc = (s: string) => Buffer.from(s);
const META = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const CPMM = new PublicKey("DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb");
const AMM_CONFIG = new PublicKey("5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy");
const GRADUATION_FEE = 0.05 * LAMPORTS_PER_SOL;
const LAUNCH_FEE = 0.02 * LAMPORTS_PER_SOL;
/** 600% of the 0.5 virtual SOL on devnet curves: about $200 a side at $68/SOL. */
const TIER0_CAP_BPS = 60_000;
const SKEW_CAP_BPS = 2_500;

const ok = (m: string) => console.log(`  ✓ ${m}`);
function check(cond: boolean, m: string): asserts cond {
  if (!cond) throw new Error(`✗ ${m}`);
  ok(m);
}

async function until<T>(label: string, secs: number, fn: () => Promise<T | null | undefined | false>): Promise<T> {
  const end = Date.now() + secs * 1000;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* RPC hiccup; retry */ }
    if (Date.now() > end) throw new Error(`✗ timed out waiting for ${label}. Is the keeper running? (ringside-logs/keeper.log)`);
    await sleep(4000);
  }
}

async function main() {
  const url = process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
  const walletPath = process.env.ANCHOR_WALLET ?? `${process.env.HOME}/.config/solana/id.json`;
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf8"))));
  const connection = new Connection(url, { commitment: "confirmed" });
  const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
  const launch = new Program(JSON.parse(readFileSync(resolve(ROOT, "target/idl/ringside_launch.json"), "utf8")), provider) as any;
  const perps = new Program(JSON.parse(readFileSync(resolve(ROOT, "target/idl/ringside_perps.json"), "utf8")), provider) as any;
  const global = pda([enc("global")], launch.programId);
  const vault = pda([enc("vault")], perps.programId);

  console.log("\n1. Devnet settings");
  const g = await launch.account.global.fetch(global);
  if (Number(g.graduationFeeLamports) !== GRADUATION_FEE || Number(g.launchFeeLamports) !== LAUNCH_FEE) {
    await launch.methods.setFees(new BN(LAUNCH_FEE), new BN(GRADUATION_FEE)).accountsPartial({ authority: payer.publicKey, global }).rpc();
  }
  ok(`graduation fee ${GRADUATION_FEE / LAMPORTS_PER_SOL} SOL (mainnet keeps 1.5 SOL)`);
  let v = await perps.account.vault.fetch(vault);
  if (v.tier0CapBps !== TIER0_CAP_BPS || v.skewCapBps !== SKEW_CAP_BPS) {
    await perps.methods.setRiskParams(TIER0_CAP_BPS, SKEW_CAP_BPS).accountsPartial({ authority: payer.publicKey, vault }).rpc();
  }
  ok(`tier 0 cap ${TIER0_CAP_BPS / 100}% of virtual SOL, skew cap ${SKEW_CAP_BPS / 100}%`);

  console.log("\n2. SOL/USD from Pyth");
  const startTs = Math.floor(Date.now() / 1000);
  v = await until("a Pyth price refresh", 120, async () => {
    const x = await perps.account.vault.fetch(vault);
    return Number(x.solUsdTs) >= startTs - 40 ? x : null;
  });
  const onChain = Number(v.solUsdE6) / 1e6;
  let live: number, ref: string;
  if (process.env.PYTH_API_KEY) {
    const hermes = (await (await fetch("https://hermes.pyth.network/v2/updates/price/latest?ids[]=0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", {
      headers: { Authorization: `Bearer ${process.env.PYTH_API_KEY}` },
    })).json()) as { parsed: { price: { price: string; expo: number } }[] };
    const p = hermes.parsed[0].price;
    live = Number(p.price) * 10 ** p.expo;
    ref = "Hermes";
  } else {
    const acc = (await connection.getAccountInfo(new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE")))!.data;
    live = Number(acc.readBigInt64LE(73)) * 10 ** acc.readInt32LE(89);
    ref = "Pyth's on-chain SOL/USD";
  }
  check(Math.abs(onChain / live - 1) < 0.02, `vault SOL/USD $${onChain.toFixed(2)} vs ${ref} $${live.toFixed(2)}, ${Math.round(Date.now() / 1000 - Number(v.solUsdTs))}s old`);

  console.log("\n3. Launch and sell out a curve");
  const mint = Keypair.generate();
  const curve = pda([enc("curve"), mint.publicKey.toBuffer()], launch.programId);
  const market = pda([enc("market"), mint.publicKey.toBuffer()], perps.programId);
  const trade = {
    global, mint: mint.publicKey, curve, curveTokenVault: getAssociatedTokenAddressSync(mint.publicKey, curve, true),
    feeRecipient: g.feeRecipient, insuranceRecipient: g.insuranceRecipient,
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  };
  await launch.methods
    .createToken({ name: "Graduation Test", symbol: "GRAD", uri: "", devBuyLamports: new BN(0) })
    .accountsPartial({
      creator: payer.publicKey, ...trade, devLockVault: pda([enc("dev_lock"), mint.publicKey.toBuffer()], launch.programId),
      metadata: pda([enc("metadata"), META.toBuffer(), mint.publicKey.toBuffer()], META), tokenMetadataProgram: META,
    })
    .signers([mint])
    .rpc();
  await perps.methods.createMarket().accountsPartial({ payer: payer.publicKey, curve, market }).rpc();
  ok(`launched ${mint.publicKey.toBase58()} with a perp market`);
  const meta = await connection.getAccountInfo(pda([enc("metadata"), META.toBuffer(), mint.publicKey.toBuffer()], META));
  check(!!meta && meta.owner.equals(META), "Metaplex metadata created (wallets and explorers show the name)");
  const c0 = await launch.account.curve.fetch(curve);
  check(Number(c0.virtualSol) === 0.5 * LAMPORTS_PER_SOL, "devnet build: curve starts at 0.5 virtual SOL");
  await launch.methods.buy(new BN(2 * LAMPORTS_PER_SOL), new BN(1)).accountsPartial({ trader: payer.publicKey, ...trade,
    traderTokenAccount: getAssociatedTokenAddressSync(mint.publicKey, payer.publicKey) }).rpc();
  const c1 = await launch.account.curve.fetch(curve);
  check(c1.complete, `curve sold out, raised ${(Number(c1.realSol) / LAMPORTS_PER_SOL).toFixed(3)} SOL`);

  console.log("\n4. Keeper graduates it");
  // migrate creates the pool at a PDA of the launch program (nobody can create it first), not Raydium's canonical address.
  const pool = pda([enc("raydium_pool"), mint.publicKey.toBuffer()], launch.programId);
  const poolVault = (m: PublicKey) => pda([enc("pool_vault"), pool.toBuffer(), m.toBuffer()], CPMM);
  await until("migrate", 120, async () => (await launch.account.curve.fetch(curve)).migrated);
  const [tv, sv] = await connection.getMultipleAccountsInfo([poolVault(mint.publicKey), poolVault(NATIVE_MINT)]);
  const tokens = tv!.data.readBigUInt64LE(64), sol = sv!.data.readBigUInt64LE(64);
  const curvePx = Number(c1.virtualSol) / Number(c1.virtualTokens), poolPx = Number(sol) / Number(tokens);
  check(Math.abs(poolPx / curvePx - 1) < 0.0005, `Raydium pool ${pool.toBase58().slice(0, 8)}… opened at the curve's final price (${(Number(sol) / LAMPORTS_PER_SOL).toFixed(3)} SOL + ${(Number(tokens) / 1e6 / 1e6).toFixed(1)}M tokens)`);
  const lpMint = await getMint(connection, pda([enc("pool_lp_mint"), pool.toBuffer()], CPMM));
  check(lpMint.supply <= 100n, "all LP tokens burned (only Raydium's locked 100 units remain)");
  // The keeper refreshes its market list once a minute and cranks every market each loop,
  // so graduate_market can land a few minutes after the migrate.
  const m = await until("graduate_market", 300, async () => {
    const x = await perps.account.market.fetch(market);
    return x.tier >= 1 ? x : null;
  });
  check(!m.reduceOnly, "perp market is tier 1 and open for trading, priced from the pool");
  console.log(`\nAll good. Open the app and trade ${mint.publicKey.toBase58().slice(0, 6)}… (GRAD) on Raydium and perps.`);
}

// Exit explicitly: open RPC websocket subscriptions would keep Node alive.
main().then(
  () => process.exit(0),
  (e) => {
    console.error(`\n${e.message ?? e}`);
    process.exit(1);
  },
);
