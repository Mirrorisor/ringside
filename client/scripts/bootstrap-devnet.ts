/**
 * Ringside devnet bootstrap and smoke test.
 *
 * Run after `anchor deploy` (scripts/devnet.sh does both). Uses the IDLs that
 * `anchor build` wrote to target/idl and the wallet in ANCHOR_WALLET.
 *
 *  1. Initialises the launch program's global config (fees to your wallet).
 *  2. Creates a test USDC mint you control, the perps vault, a SOL price, and
 *     deposits 5,000 test USDC as LP.
 *  3. Launches a token with a small dev buy, buys on the curve, opens its
 *     perp market.
 *  4. Opens a $5 long, waits for the fill delay, fills it as keeper, then
 *     closes it the same way.
 *
 * Re-running reuses what exists (state in devnet-deployment.json) and
 * launches a fresh token each time.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import anchor from "@coral-xyz/anchor";
import { acceptablePrice } from "../src/perps/order.js";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";

const { AnchorProvider, Program, Wallet, BN } = anchor;
const ROOT = resolve(import.meta.dirname, "../..");
const STATE = resolve(ROOT, "devnet-deployment.json");
const USDC = 1_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rateLimited = (e: unknown) => /429|Too Many Requests|rate limit/i.test(String(e));

/** Retries a call that the public devnet RPC rate-limits, backing off up to ~1 minute. */
async function retry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!rateLimited(e) || i >= 6) throw e;
      const wait = 2_000 * 2 ** i;
      console.log(`  devnet RPC is rate-limiting (${label}); waiting ${wait / 1000}s`);
      await sleep(wait);
    }
  }
}
const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];
const enc = (s: string) => Buffer.from(s);

async function main() {
  const url = process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
  const walletPath = process.env.ANCHOR_WALLET ?? `${process.env.HOME}/.config/solana/id.json`;
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf8"))));
  const connection = new Connection(url, { commitment: "confirmed", disableRetryOnRateLimit: true });
  const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
  anchor.setProvider(provider);

  const launchIdl = JSON.parse(readFileSync(resolve(ROOT, "target/idl/ringside_launch.json"), "utf8"));
  const perpsIdl = JSON.parse(readFileSync(resolve(ROOT, "target/idl/ringside_perps.json"), "utf8"));
  const launch = new Program(launchIdl, provider) as any;
  const perps = new Program(perpsIdl, provider) as any;
  const me = payer.publicKey;
  const state: Record<string, string> = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
  const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
  state.cluster = url;
  state.launchProgram = launch.programId.toBase58();
  state.perpsProgram = perps.programId.toBase58();
  const step = (s: string) => console.log(`\n▸ ${s}`);
  console.log(`Wallet ${me.toBase58()}  balance ${(await connection.getBalance(me)) / LAMPORTS_PER_SOL} SOL`);

  // initialize_global / initialize_vault accept only the programs' upgrade authority (the deployer's key).
  const BPF_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
  const launchProgramData = pda([launch.programId.toBuffer()], BPF_UPGRADEABLE);
  const perpsProgramData = pda([perps.programId.toBuffer()], BPF_UPGRADEABLE);

  // 1. Launch global config ---------------------------------------------------
  const global = pda([enc("global")], launch.programId);
  if (!(await connection.getAccountInfo(global))) {
    step("Initialising launch config");
    await launch.methods
      .initializeGlobal({
        feeRecipient: me,
        insuranceRecipient: me,
        migrationAuthority: me,
        launchFeeLamports: new BN(LAMPORTS_PER_SOL / 50),
        graduationFeeLamports: new BN((3 * LAMPORTS_PER_SOL) / 2),
        protocolFeeBps: 50,
        creatorFeeBps: 30,
        insuranceFeeBps: 20,
      })
      .accountsPartial({ authority: me, global, programData: launchProgramData, systemProgram: SystemProgram.programId })
      .rpc();
  }

  // 2. Test USDC, vault, price, liquidity -------------------------------------
  if (!state.usdcMint) {
    step("Creating a test USDC mint");
    state.usdcMint = (await createMint(connection, payer, me, null, 6)).toBase58();
    save();
  }
  const usdcMint = new PublicKey(state.usdcMint);
  const myUsdc = (await getOrCreateAssociatedTokenAccount(connection, payer, usdcMint, me)).address;
  const vault = pda([enc("vault")], perps.programId);
  const vaultUsdc = pda([enc("vault_usdc")], perps.programId);
  if (!(await connection.getAccountInfo(vault))) {
    step("Initialising the perps vault");
    await perps.methods
      .initializeVault(me)
      .accountsPartial({ authority: me, vault, usdcMint, programData: perpsProgramData, vaultUsdc, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
      .rpc();
    await mintTo(connection, payer, usdcMint, myUsdc, payer, 10_000 * USDC);
    const lp = pda([enc("lp"), me.toBuffer()], perps.programId);
    await perps.methods
      .depositLiquidity(new BN(5_000 * USDC))
      .accountsPartial({ owner: me, vault, vaultUsdc, lp, ownerUsdc: myUsdc, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
      .rpc();
    console.log("  deposited 5,000 test USDC as LP");
  }
  step("Setting SOL/USD to $150 (test feed)");
  await retry("set price", () => perps.methods.setSolPrice(new BN(150 * USDC)).accountsPartial({ priceAuthority: me, vault }).rpc());

  // Helpers for one token's perp market.
  const side = 0;
  const forMint = (mintKey: PublicKey) => {
    const curve = pda([enc("curve"), mintKey.toBuffer()], launch.programId);
    const market = pda([enc("market"), mintKey.toBuffer()], perps.programId);
    const position = pda([enc("position"), me.toBuffer(), market.toBuffer(), Uint8Array.from([side])], perps.programId);
    const order = pda([enc("order"), me.toBuffer(), market.toBuffer(), Uint8Array.from([side])], perps.programId);
    const request = async (kind: number, collateral: number, size: number) => {
      // Orders need a price bound (the program refuses 0): 50% around the market's band anchor.
      const mk = await perps.account.market.fetch(market);
      const bound = new BN(acceptablePrice(side as 0 | 1, kind ? "close" : "open", BigInt(mk.bandAnchorQ64.toString()), 5_000).toString());
      return retry("request order", () =>
        perps.methods
          .requestOrder({ side, kind, collateral: new BN(collateral), sizeUsd: new BN(size), acceptablePriceQ64: bound })
          .accountsPartial({ owner: me, payer: me, vault, vaultUsdc, market, position, order, ownerUsdc: myUsdc, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
          .rpc(),
      );
    };
    const execute = async () => {
      for (let i = 0; i < 30; i++) {
        await sleep(2_000); // fill delay is 2 slots (~0.8 s); go easy on the public RPC
        if (!(await retry("order lookup", () => connection.getAccountInfo(order)))) return "already filled";
        try {
          return await perps.methods
            .executeOrder()
            .accountsPartial({
              keeper: me, vault, vaultUsdc, market, curve, rentPayer: me, order, position,
              ownerUsdc: myUsdc, keeperUsdc: myUsdc, tokenProgram: TOKEN_PROGRAM_ID,
            })
            .rpc();
        } catch (e) {
          if (rateLimited(e)) {
            console.log("  devnet RPC is rate-limiting; waiting 5s");
            await sleep(5_000);
          } else if (!String(e).includes("TooEarly")) throw e;
        }
      }
      throw new Error("order never became fillable");
    };
    const positionSize = async () => {
      const info = await retry("position lookup", () => connection.getAccountInfo(position));
      return info ? (await perps.account.position.fetch(position)).sizeUsd.toNumber() : 0;
    };
    const close = async () => {
      const before = Number((await retry("balance", () => getAccount(connection, myUsdc))).amount);
      if (!(await retry("order lookup", () => connection.getAccountInfo(order)))) await request(1, 0, 0);
      await execute();
      const after = Number((await retry("balance", () => getAccount(connection, myUsdc))).amount);
      console.log(`  closed: $${((after - before) / USDC).toFixed(4)} back (collateral minus fees, plus or minus PnL)`);
    };
    return { curve, market, position, order, request, execute, positionSize, close };
  };

  // A run that stopped half way (e.g. rate limited) leaves a position or an
  // order on the last token: finish that and stop.
  if (state.lastMint) {
    const prev = forMint(new PublicKey(state.lastMint));
    const pendingOrder = await retry("order lookup", () => connection.getAccountInfo(prev.order));
    if (pendingOrder || (await prev.positionSize()) > 0) {
      step(`Finishing the open position on ${state.lastMint}`);
      if (pendingOrder) await prev.execute();
      if ((await prev.positionSize()) > 0) await prev.close();
      console.log(`  position size now $${(await prev.positionSize()) / USDC}`);
      console.log(`\nDone. Explorer: https://explorer.solana.com/address/${prev.market.toBase58()}?cluster=devnet`);
      return;
    }
  }

  // 3. Launch a token, buy, open its market ------------------------------------
  const mint = Keypair.generate();
  const t = forMint(mint.publicKey);
  const { curve, market, position } = t;
  const devLock = pda([enc("dev_lock"), mint.publicKey.toBuffer()], launch.programId);
  const curveVault = getAssociatedTokenAddressSync(mint.publicKey, curve, true);
  step(`Launching token ${mint.publicKey.toBase58()}`);
  await retry("create token", () =>
    launch.methods
      .createToken({ name: "Ringside Test", symbol: "RTEST", uri: "https://example.com/rtest.json", devBuyLamports: new BN(LAMPORTS_PER_SOL / 10) })
      .accountsPartial({
        creator: me, global, mint: mint.publicKey, curve, curveTokenVault: curveVault, devLockVault: devLock,
        feeRecipient: me, insuranceRecipient: me, tokenProgram: TOKEN_PROGRAM_ID,
        metadata: pda([enc("metadata"), new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s").toBuffer(), mint.publicKey.toBuffer()], new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s")), tokenMetadataProgram: new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"),
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .signers([mint])
      .rpc(),
  );
  state.lastMint = mint.publicKey.toBase58();
  save();

  const myTokens = getAssociatedTokenAddressSync(mint.publicKey, me);
  await retry("buy", () =>
    launch.methods
      .buy(new BN(LAMPORTS_PER_SOL / 5), new BN(1))
      .accountsPartial({
        trader: me, global, mint: mint.publicKey, curve, curveTokenVault: curveVault, traderTokenAccount: myTokens,
        feeRecipient: me, insuranceRecipient: me, tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .rpc(),
  );
  console.log(`  bought ${(Number((await retry("balance", () => getAccount(connection, myTokens))).amount) / 1e6).toLocaleString()} RTEST for 0.2 SOL`);

  await retry("create market", () => perps.methods.createMarket().accountsPartial({ payer: me, curve, market, systemProgram: SystemProgram.programId }).rpc());
  console.log(`  perp market ${market.toBase58()}`);

  // 4. Open and close a $5 long --------------------------------------------------
  step("Opening a $5 long at ~2x");
  await t.request(0, 2_600_000, 5 * USDC);
  await t.execute();
  const p = await perps.account.position.fetch(position);
  console.log(`  filled: size $${p.sizeUsd.toNumber() / USDC}, collateral $${p.collateral.toNumber() / USDC}`);

  step("Closing it");
  await t.close();

  save();
  console.log(`\nDone. Addresses saved to ${STATE}`);
  console.log(`Explorer: https://explorer.solana.com/address/${market.toBase58()}?cluster=devnet`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
