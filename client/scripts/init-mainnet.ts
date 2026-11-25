/**
 * One-time mainnet configuration, run after both programs are deployed and audited:
 *   1. launch program global config: 0.02 SOL launch fee, 1.5 SOL graduation fee,
 *      0.5% protocol / 0.3% creator / 0.2% insurance on curve trades;
 *   2. perps vault on Circle USDC, with the manual SOL price authority set to a
 *      key nobody holds (11111111111111111111111111111111), so only Pyth moves SOL/USD;
 *   3. risk params: OI cap 1.5% of the SOL behind the price, net exposure 25% of that.
 *
 * Safety checks (override only on purpose):
 *   - refuses a devnet/testnet RPC;
 *   - refuses if either program's upgrade authority is the key running this
 *     script (it should be a multisig) — ALLOW_SINGLE_KEY_AUTHORITY=1 to override;
 *   - prints everything and waits for CONFIRM=yes before sending.
 *
 * Env: ANCHOR_PROVIDER_URL, ANCHOR_WALLET, FEE_RECIPIENT, INSURANCE_RECIPIENT,
 *      MIGRATION_AUTHORITY (optional, defaults to FEE_RECIPIENT), CONFIRM=yes.
 * Idempotent: steps already done on chain are skipped.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

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

async function main() {
  const url = process.env.ANCHOR_PROVIDER_URL ?? die("set ANCHOR_PROVIDER_URL to a mainnet RPC");
  if (/devnet|testnet|localhost|127\.0\.0\.1/.test(url)) die("this is the mainnet script; ANCHOR_PROVIDER_URL points at devnet/testnet/local");
  const fee = new PublicKey(process.env.FEE_RECIPIENT ?? die("set FEE_RECIPIENT"));
  const insurance = new PublicKey(process.env.INSURANCE_RECIPIENT ?? die("set INSURANCE_RECIPIENT"));
  const migration = new PublicKey(process.env.MIGRATION_AUTHORITY ?? fee.toBase58());
  // The Squads vault: owns protocol-owned liquidity now, and is proposed as admin of both programs at the end.
  const multisig = new PublicKey(process.env.MULTISIG ?? die("set MULTISIG to the Squads vault address (not the multisig account)"));
  const walletPath = process.env.ANCHOR_WALLET ?? `${process.env.HOME}/.config/solana/id.json`;
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf8"))));
  const connection = new Connection(url, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
  const launch = new Program(JSON.parse(readFileSync(resolve(ROOT, "target/idl/ringside_launch.json"), "utf8")), provider) as any;
  const perps = new Program(JSON.parse(readFileSync(resolve(ROOT, "target/idl/ringside_perps.json"), "utf8")), provider) as any;

  const genesis = await connection.getGenesisHash();
  if (genesis !== "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d") die(`RPC genesis ${genesis} is not mainnet-beta`);

  for (const [name, id] of [["ringside_launch", launch.programId], ["ringside_perps", perps.programId]] as const) {
    const auth = await upgradeAuthority(connection, id);
    console.log(`${name} ${id.toBase58()} upgrade authority: ${auth?.toBase58() ?? "none (immutable)"}`);
    if (auth?.equals(payer.publicKey) && process.env.ALLOW_SINGLE_KEY_AUTHORITY !== "1") {
      die(`${name}'s upgrade authority is this single key. Move it to a Squads multisig first (solana program set-upgrade-authority), or set ALLOW_SINGLE_KEY_AUTHORITY=1.`);
    }
  }

  const global = pda([Buffer.from("global")], launch.programId);
  const vault = pda([Buffer.from("vault")], perps.programId);
  const vaultUsdc = pda([Buffer.from("vault_usdc")], perps.programId);
  const p = MAINNET_PARAMS;
  console.log(`
Admin (this key):   ${payer.publicKey.toBase58()}
Fee recipient:      ${fee.toBase58()}
Insurance:          ${insurance.toBase58()}
Migration auth:     ${migration.toBase58()}
Multisig (Squads):  ${multisig.toBase58()} (treasury now; admin once it accepts)
Launch fee:         ${p.launchFeeLamports / LAMPORTS} SOL, graduation fee ${p.graduationFeeLamports / LAMPORTS} SOL
Curve trade fees:   ${p.protocolFeeBps / 100}% protocol, ${p.creatorFeeBps / 100}% creator, ${p.insuranceFeeBps / 100}% insurance
Vault:              USDC ${USDC_MAINNET.toBase58()}, SOL price authority ${NOBODY.toBase58()} (nobody: Pyth only)
Risk:               OI cap ${p.tier0CapBps / 100}% of SOL behind the price, net exposure ${p.skewCapBps / 100}% of the cap`);
  if (process.env.CONFIRM !== "yes") die("dry run. Check the values above, then re-run with CONFIRM=yes");

  if (!(await connection.getAccountInfo(global))) {
    const sig = await launch.methods
      .initializeGlobal({
        feeRecipient: fee, insuranceRecipient: insurance, migrationAuthority: migration,
        launchFeeLamports: new BN(p.launchFeeLamports), graduationFeeLamports: new BN(p.graduationFeeLamports),
        protocolFeeBps: p.protocolFeeBps, creatorFeeBps: p.creatorFeeBps, insuranceFeeBps: p.insuranceFeeBps,
      })
      .accountsPartial({ authority: payer.publicKey, global, systemProgram: SystemProgram.programId })
      .rpc();
    console.log(`✓ global config ${sig}`);
  } else console.log("• global config exists; leaving it");

  if (!(await connection.getAccountInfo(vault))) {
    const sig = await perps.methods
      .initializeVault(NOBODY)
      .accountsPartial({ authority: payer.publicKey, vault, usdcMint: USDC_MAINNET, vaultUsdc, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
      .rpc();
    console.log(`✓ vault ${sig}`);
  } else console.log("• vault exists");

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
  for (const [program, admin, name] of [[perps, vault, "perps vault"], [launch, global, "launch global config"]] as const) {
    const current = program === perps ? (await perps.account.vault.fetch(vault)).authority : (await launch.account.global.fetch(global)).authority;
    if (!current.equals(payer.publicKey)) { console.log(`• ${name} admin is already ${current.toBase58()}`); continue; }
    const pending = pda([Buffer.from("pending_authority")], program.programId);
    await program.methods.proposeAuthority(multisig).accountsPartial({ authority: payer.publicKey, [program === perps ? "vault" : "global"]: admin, pending, systemProgram: SystemProgram.programId }).rpc();
    console.log(`✓ proposed the multisig as admin of the ${name}; approve accept_authority in Squads to finish`);
  }
  console.log("\nDone. Next: seed the vault (deposit_liquidity), start two keepers with PYTH_API_KEY and NETWORK=mainnet, then the relayer.");
}

main().then(() => process.exit(0), (e) => die(e.message ?? String(e)));
