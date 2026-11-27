/**
 * One-time mainnet configuration, run after both programs are deployed and audited:
 *   1. launch program global config: 0.02 SOL launch fee, 1.5 SOL graduation fee (hard caps in the
 *      program: 0.5 SOL and 2 SOL; set_fees cannot exceed them), recipients fixed for good,
 *      0.5% protocol / 0.3% creator / 0.2% insurance on curve trades;
 *   2. perps vault on Circle USDC, with the manual SOL price authority set to a
 *      key nobody holds (11111111111111111111111111111111), so only Pyth moves SOL/USD;
 *   3. a seed deposit: this wallet pays SEED_DEPOSIT_USDC (default 1000) into the vault with
 *      deposit_to_treasury, so the vault is never empty for outsiders (first-depositor donation attack,
 *      docs/security-fixes.md F9). The LP shares go to the treasury (the multisig), not to this key, so
 *      they are protocol-owned and only a multisig vote can withdraw them. Runs right after set_treasury
 *      and before the admin handover; skipped when the vault already has shares. The wallet must hold
 *      the USDC (checked before anything is sent, also in the dry run);
 *   4. risk params: OI cap 1.5% of the SOL behind the price (the program's default is 1%; this script sets 1.5%),
 *      net exposure 25% of that.
 *
 * Who may run it: `initialize_global` and `initialize_vault` accept only the
 * program's upgrade authority, so whoever deployed the programs must run the
 * first-time initialization, BEFORE the upgrade authority moves to the multisig
 * (the script prints the commands for that at the end). Once Global and the vault
 * exist, the script only checks them and applies the admin steps below.
 *
 * Safety checks:
 *   - refuses a devnet/testnet RPC;
 *   - when a program still has to be initialized, requires this key to be its
 *     upgrade authority (nobody else can initialize it);
 *   - when Global / the vault already exist, compares EVERY field with what this
 *     script would set and aborts on any difference (an already-initialized
 *     account is never silently trusted);
 *   - prints everything and waits for CONFIRM=yes before sending.
 *
 * Env: ANCHOR_PROVIDER_URL, ANCHOR_WALLET, FEE_RECIPIENT, INSURANCE_RECIPIENT,
 *      MIGRATION_AUTHORITY (optional, defaults to FEE_RECIPIENT), MULTISIG,
 *      SEED_DEPOSIT_USDC (optional, default 1000), CONFIRM=yes.
 * Idempotent: steps already done on chain are skipped.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { decideSeed, formatUsdc, parseSeedAmount } from "../src/seeddeposit.js";

const { AnchorProvider, Program, Wallet, BN } = anchor;
const ROOT = resolve(import.meta.dirname, "../..");
const USDC_MAINNET = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const NOBODY = new PublicKey("11111111111111111111111111111111");
const BPF_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const LAMPORTS = 1_000_000_000;

export const MAINNET_PARAMS = {
  launchFeeLamports: 0.02 * LAMPORTS,
  graduationFeeLamports: 1.5 * LAMPORTS,
  protocolFeeBps: 50,
  creatorFeeBps: 30,
  insuranceFeeBps: 20,
  tier0CapBps: 150,
  skewCapBps: 2_500,
};

// Hard caps in the launch program (MAX_LAUNCH_FEE_LAMPORTS, MAX_GRADUATION_FEE_LAMPORTS on the mainnet build).
const MAX_LAUNCH_FEE = 0.5 * LAMPORTS;
const MAX_GRADUATION_FEE = 2 * LAMPORTS;

const pda = (seeds: Buffer[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];
const die = (m: string): never => {
  console.error(`\n✗ ${m}`);
  process.exit(1);
};

async function upgradeAuthority(c: Connection, program: PublicKey): Promise<PublicKey | null> {
  const pd = pda([program.toBuffer()], BPF_UPGRADEABLE);
  const acc = await c.getAccountInfo(pd);
  if (!acc) die(`program ${program.toBase58()} is not deployed (no program data account)`);
  // ProgramData: u32 tag (3) | u64 slot | Option<Pubkey>
  return acc!.data[12] === 1 ? new PublicKey(acc!.data.subarray(13, 45)) : null;
}

/** Collects differences between an on-chain account and what this script would set; aborts if there are any. */
function verifyFields(what: string, onChain: Record<string, unknown>, expected: Record<string, unknown>) {
  const show = (v: unknown) => (v && typeof (v as any).toBase58 === "function" ? (v as PublicKey).toBase58() : String(v));
  const same = (a: unknown, b: unknown) =>
    a && b && typeof (a as any).equals === "function" ? (a as PublicKey).equals(b as PublicKey) : String(a) === String(b);
  const bad = Object.keys(expected).filter((k) => !same(onChain[k], expected[k]));
  if (bad.length) {
    die(`${what} already exists but differs from what this script would set:\n` +
      bad.map((k) => `    ${k}: on chain ${show(onChain[k])}, expected ${show(expected[k])}`).join("\n") +
      `\n  Someone else may have initialized it first. Do NOT continue with this deployment: investigate (redeploy under a fresh program id if the account is not yours).`);
  }
}

async function main() {
  const url = process.env.ANCHOR_PROVIDER_URL ?? die("set ANCHOR_PROVIDER_URL to a mainnet RPC");
  if (/devnet|testnet|localhost|127\.0\.0\.1/.test(url)) die("this is the mainnet script; ANCHOR_PROVIDER_URL points at devnet/testnet/local");
  const fee = new PublicKey(process.env.FEE_RECIPIENT ?? die("set FEE_RECIPIENT"));
  const insurance = new PublicKey(process.env.INSURANCE_RECIPIENT ?? die("set INSURANCE_RECIPIENT"));
  const migration = new PublicKey(process.env.MIGRATION_AUTHORITY ?? fee.toBase58());
  // fee_recipient and insurance_recipient are FIXED at initialization: the launch program has no setter for them.
  // Both must be accounts the team will still control for the life of the program (the treasury / multisig, or the
  // treasury key that runs `treasury.ts forfeits`), and never the deployer key, which is a throwaway after the handover.
  if (MAINNET_PARAMS.launchFeeLamports > MAX_LAUNCH_FEE || MAINNET_PARAMS.graduationFeeLamports > MAX_GRADUATION_FEE) {
    die("MAINNET_PARAMS fees exceed the launch program's hard caps (0.5 SOL launch, 2 SOL graduation); the program would refuse them");
  }
  for (const [name, key] of [["FEE_RECIPIENT", fee], ["INSURANCE_RECIPIENT", insurance]] as const) {
    if (key.equals(NOBODY)) die(`${name} is the system program address: SOL sent there is lost, and it cannot be changed later`);
  }
  // The Squads vault: owns protocol-owned liquidity now, and is proposed as admin of both programs at the end.
  let seedAmount: bigint;
  try { seedAmount = parseSeedAmount(process.env.SEED_DEPOSIT_USDC); } catch (e: any) { return die(e.message); }
  const multisig = new PublicKey(process.env.MULTISIG ?? die("set MULTISIG to the Squads vault address (not the multisig account)"));
  const walletPath = process.env.ANCHOR_WALLET ?? `${process.env.HOME}/.config/solana/id.json`;
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf8"))));
  for (const [name, key] of [["FEE_RECIPIENT", fee], ["INSURANCE_RECIPIENT", insurance], ["MIGRATION_AUTHORITY", migration]] as const) {
    if (key.equals(payer.publicKey)) die(`${name} is the deployer key (${key.toBase58()}). The recipients cannot be changed after initialization: use the treasury or multisig.`);
  }
  const connection = new Connection(url, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
  const launch = new Program(JSON.parse(readFileSync(resolve(ROOT, "target/idl/ringside_launch.json"), "utf8")), provider) as any;
  const perps = new Program(JSON.parse(readFileSync(resolve(ROOT, "target/idl/ringside_perps.json"), "utf8")), provider) as any;

  const genesis = await connection.getGenesisHash();
  if (genesis !== "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d") die(`RPC genesis ${genesis} is not mainnet-beta`);

  const global = pda([Buffer.from("global")], launch.programId);
  const vault = pda([Buffer.from("vault")], perps.programId);
  const vaultUsdc = pda([Buffer.from("vault_usdc")], perps.programId);
  const authorities: Record<string, PublicKey | null> = {};
  for (const [name, id, state] of [["ringside_launch", launch.programId, global], ["ringside_perps", perps.programId, vault]] as const) {
    const auth = await upgradeAuthority(connection, id);
    authorities[name] = auth;
    console.log(`${name} ${id.toBase58()} upgrade authority: ${auth?.toBase58() ?? "none (immutable)"}`);
    if (!(await connection.getAccountInfo(state)) && !auth?.equals(payer.publicKey)) {
      die(`${name} is not initialized yet and only its upgrade authority (${auth?.toBase58() ?? "none: immutable"}) can initialize it. ` +
        `Run this script with that key (before moving the upgrade authority to the multisig), or use a Squads transaction.`);
    }
  }
  const launchProgramData = pda([launch.programId.toBuffer()], BPF_UPGRADEABLE);
  const perpsProgramData = pda([perps.programId.toBuffer()], BPF_UPGRADEABLE);
  const p = MAINNET_PARAMS;
  // Seed deposit preflight: needs the USDC in this wallet before ANYTHING is sent, so a short wallet
  // cannot leave a half-initialized, empty vault behind.
  const myUsdc = getAssociatedTokenAddressSync(USDC_MAINNET, payer.publicKey);
  const usdcBalance = await getAccount(connection, myUsdc).then((a) => a.amount, () => 0n);
  const vaultInfo = await connection.getAccountInfo(vault);
  const sharesNow = vaultInfo ? BigInt((await perps.account.vault.fetch(vault)).totalShares.toString()) : null;
  const seed = decideSeed(sharesNow, usdcBalance, seedAmount);
  if (seed.action === "insufficient") {
    die(`seed deposit: this wallet (${payer.publicKey.toBase58()}) holds ${formatUsdc(seed.have)} USDC in ${myUsdc.toBase58()} but ` +
      `needs ${formatUsdc(seed.need)} (SEED_DEPOSIT_USDC). Fund it with USDC, or set a smaller SEED_DEPOSIT_USDC, and re-run. Nothing was sent.`);
  }
  console.log(`
Admin (this key):   ${payer.publicKey.toBase58()}
Seed deposit:       ${seed.action === "skip" ? `skipped (${seed.reason})` : `${formatUsdc(seedAmount)} USDC from this wallet (has ${formatUsdc(usdcBalance)}), shares owned by the multisig`}`);
  console.log(`Fee recipient:      ${fee.toBase58()}   (fixed for the life of the program: no setter)
Insurance:          ${insurance.toBase58()}   (fixed: no setter)
Migration auth:     ${migration.toBase58()}   (stored, unused by the program)
Multisig (Squads):  ${multisig.toBase58()} (treasury now; admin once it accepts)
Launch fee:         ${p.launchFeeLamports / LAMPORTS} SOL, graduation fee ${p.graduationFeeLamports / LAMPORTS} SOL
Curve trade fees:   ${p.protocolFeeBps / 100}% protocol, ${p.creatorFeeBps / 100}% creator, ${p.insuranceFeeBps / 100}% insurance
Vault:              USDC ${USDC_MAINNET.toBase58()}, SOL price authority ${NOBODY.toBase58()} (nobody: Pyth only)
Risk:               OI cap ${p.tier0CapBps / 100}% of SOL behind the price, net exposure ${p.skewCapBps / 100}% of the cap`);
  if (process.env.CONFIRM !== "yes") die("dry run. Check the values above, then re-run with CONFIRM=yes");

  // Admin may already have moved to the multisig (the handover below), so either is fine for the admin field.
  const adminIs = (a: PublicKey) => a.equals(payer.publicKey) || a.equals(multisig);
  if (!(await connection.getAccountInfo(global))) {
    const sig = await launch.methods
      .initializeGlobal({
        feeRecipient: fee, insuranceRecipient: insurance, migrationAuthority: migration,
        launchFeeLamports: new BN(p.launchFeeLamports), graduationFeeLamports: new BN(p.graduationFeeLamports),
        protocolFeeBps: p.protocolFeeBps, creatorFeeBps: p.creatorFeeBps, insuranceFeeBps: p.insuranceFeeBps,
      })
      .accountsPartial({ authority: payer.publicKey, global, programData: launchProgramData, systemProgram: SystemProgram.programId })
      .rpc();
    console.log(`✓ global config ${sig}`);
  } else {
    const g = await launch.account.global.fetch(global);
    if (!adminIs(g.authority)) die(`global config admin is ${g.authority.toBase58()}, neither this key nor the multisig`);
    verifyFields("global config", g, {
      feeRecipient: fee, insuranceRecipient: insurance, migrationAuthority: migration,
      launchFeeLamports: p.launchFeeLamports, graduationFeeLamports: p.graduationFeeLamports,
      protocolFeeBps: p.protocolFeeBps, creatorFeeBps: p.creatorFeeBps, insuranceFeeBps: p.insuranceFeeBps, paused: false,
    });
    console.log("• global config exists and matches every field");
  }

  if (!(await connection.getAccountInfo(vault))) {
    const sig = await perps.methods
      .initializeVault(NOBODY)
      .accountsPartial({ authority: payer.publicKey, vault, usdcMint: USDC_MAINNET, programData: perpsProgramData, vaultUsdc, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
      .rpc();
    console.log(`✓ vault ${sig}`);
  } else {
    const ex = await perps.account.vault.fetch(vault);
    if (!adminIs(ex.authority)) die(`vault admin is ${ex.authority.toBase58()}, neither this key nor the multisig`);
    // The risk params are left out on purpose: the steps below set them, so a run that stopped after
    // creating the vault can resume. The fields that identify whose vault this is are all compared.
    verifyFields("perps vault", ex, { usdcMint: USDC_MAINNET, priceAuthority: NOBODY, paused: false });
    console.log("• vault exists and matches every field");
  }

  const v = await perps.account.vault.fetch(vault);
  if (!v.priceAuthority.equals(NOBODY)) {
    await perps.methods.setPriceAuthority(NOBODY).accountsPartial({ authority: payer.publicKey, vault }).rpc();
    console.log("✓ SOL price authority handed to nobody (Pyth only)");
  }
  if (v.tier0CapBps !== p.tier0CapBps || v.skewCapBps !== p.skewCapBps) {
    await perps.methods.setRiskParams(p.tier0CapBps, p.skewCapBps).accountsPartial({ authority: payer.publicKey, vault }).rpc();
    console.log(`✓ risk params ${p.tier0CapBps} / ${p.skewCapBps}`);
  }
  const treasuryConfig = pda([Buffer.from("treasury")], perps.programId);
  const cfg = await connection.getAccountInfo(treasuryConfig);
  if (!cfg || !new PublicKey(cfg.data.subarray(8, 40)).equals(multisig)) {
    await perps.methods.setTreasury(multisig).accountsPartial({ authority: payer.publicKey, vault, treasuryConfig, systemProgram: SystemProgram.programId }).rpc();
    console.log("✓ treasury (owner of protocol-owned LP shares) = multisig");
  }
  // Seed deposit: before the handover below and before anyone is told the vault exists. deposit_to_treasury
  // mints the shares to the treasury (set to the multisig just above), never to this key.
  const seedNow = decideSeed(BigInt((await perps.account.vault.fetch(vault)).totalShares.toString()), usdcBalance, seedAmount);
  if (seedNow.action === "skip") {
    console.log(`• seed deposit skipped: ${seedNow.reason}`);
  } else if (seedNow.action === "insufficient") {
    die(`seed deposit: wallet holds ${formatUsdc(seedNow.have)} USDC, needs ${formatUsdc(seedNow.need)}`);
  } else {
    const sig = await perps.methods
      .depositToTreasury(new BN(seedAmount.toString()))
      .accountsPartial({
        depositor: payer.publicKey, vault, vaultUsdc, treasuryConfig,
        treasuryLp: pda([Buffer.from("lp"), multisig.toBuffer()], perps.programId),
        depositorUsdc: myUsdc, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`✓ seed deposit ${formatUsdc(seedAmount)} USDC, shares owned by the multisig ${sig}`);
  }
  for (const [program, admin, name] of [[perps, vault, "perps vault"], [launch, global, "launch global config"]] as const) {
    const current = program === perps ? (await perps.account.vault.fetch(vault)).authority : (await launch.account.global.fetch(global)).authority;
    if (!current.equals(payer.publicKey)) { console.log(`• ${name} admin is already ${current.toBase58()}`); continue; }
    const pending = pda([Buffer.from("pending_authority")], program.programId);
    await program.methods.proposeAuthority(multisig).accountsPartial({ authority: payer.publicKey, [program === perps ? "vault" : "global"]: admin, pending, systemProgram: SystemProgram.programId }).rpc();
    console.log(`✓ proposed the multisig as admin of the ${name}; approve accept_authority in Squads to finish`);
  }
  for (const [name, id] of [["ringside_launch", launch.programId], ["ringside_perps", perps.programId]] as const) {
    const auth = await upgradeAuthority(connection, id);
    if (auth?.equals(payer.publicKey)) {
      console.log(`\n! ${name}'s upgrade authority is still this key. Move it to the multisig now:\n    solana program set-upgrade-authority ${id.toBase58()} --new-upgrade-authority ${multisig.toBase58()} -u mainnet-beta`);
    }
  }
  console.log("\nDone (the vault is already seeded). Next: start two keepers with PYTH_API_KEY and NETWORK=mainnet, then the relayer.");
}

main().then(() => process.exit(0), (e) => die(e.message ?? String(e)));
