/**
 * Migration for the creator-fee model (docs/creator-fee-lock.md): grows every launch
 * `Curve` and perps `Market` created before `creator_fees_locked` existed (8 bytes short)
 * with the programs' permissionless `resize_curve` / `resize_market`. The payer
 * (ANCHOR_WALLET) funds the extra rent, about 0.00006 SOL per account. Safe to re-run:
 * accounts that are already full size are skipped, and the instructions are no-ops on them.
 *
 * Run it right after the programs are upgraded and before the keeper and relayer restart
 * (scripts/upgrade.sh does): until an account is resized, instructions that read it can fail.
 *
 * Accounts are found with raw getProgramAccounts on the 8-byte discriminator, so the old size
 * does not matter, and the instructions are built by hand because the IDL is stale until
 * `anchor build` regenerates it.
 *
 * Env: ANCHOR_PROVIDER_URL, ANCHOR_WALLET. Exits 1 if any account could not be resized.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";

const LAUNCH = new PublicKey("AfZWCTaDQEC9CVTwXkH7pFtDXs4RtLWCK5godexWQDVH");
const PERPS = new PublicKey("DsZ69w3q25nRmAzJCRBMLbwZWN6NyVbYipTWsCAUsg1F");
/** 8 + INIT_SPACE, with creator_fees_locked. Rust unit tests pin these numbers: keep them in step. */
const CURVE_LEN = 1219;
const MARKET_LEN = 228;
const PER_TX = 4;

const RPC_URL = process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
/** Hides the RPC URL (it can carry an API key in any form) and api-key params. */
const redact = (s: string) =>
  s.split(RPC_URL).join("<rpc>").replace(/(api[-_]?key|token)=[^&\s"']+/gi, "$1=<redacted>");
const disc = (kind: "account" | "global", name: string) => createHash("sha256").update(`${kind}:${name}`).digest().subarray(0, 8);

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58Encode(b: Buffer): string {
  let n = BigInt("0x" + (b.toString("hex") || "0"));
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const byte of b) { if (byte !== 0) break; out = "1" + out; }
  return out;
}

const walletPath = process.env.ANCHOR_WALLET ?? `${process.env.HOME}/.config/solana/id.json`;
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf8"))));
const conn = new Connection(RPC_URL, "confirmed");

async function shortAccounts(program: PublicKey, accountName: string, fullLen: number): Promise<{ all: number; short: PublicKey[] }> {
  const accs = await conn.getProgramAccounts(program, {
    filters: [{ memcmp: { offset: 0, bytes: bs58Encode(disc("account", accountName)), encoding: "base58" } }],
  });
  return { all: accs.length, short: accs.filter((a) => a.account.data.length < fullLen).map((a) => a.pubkey) };
}

async function resizeAll(label: string, program: PublicKey, accountName: string, ix: string, fullLen: number): Promise<number> {
  const { all, short } = await shortAccounts(program, accountName, fullLen);
  console.log(`${label}: ${all} account(s), ${short.length} need resizing`);
  let failed = 0;
  for (let i = 0; i < short.length; i += PER_TX) {
    const batch = short.slice(i, i + PER_TX);
    const tx = new Transaction().add(...batch.map((key) => new TransactionInstruction({
      programId: program,
      data: disc("global", ix),
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: key, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    })));
    try {
      await sendAndConfirmTransaction(conn, tx, [payer]);
      console.log(`  ✓ resized ${batch.map((k) => k.toBase58().slice(0, 6)).join(", ")}`);
    } catch (e: any) {
      failed += batch.length;
      console.log(`  ✗ ${batch.length} account(s) failed: ${redact(String(e?.message ?? e)).slice(0, 300)}`);
    }
  }
  const left = (await shortAccounts(program, accountName, fullLen)).short.length;
  console.log(`  ${label}: ${left} still short after resizing`);
  return left;
}

async function main() {
  console.log(`payer ${payer.publicKey.toBase58()}`);
  const left =
    (await resizeAll("curves", LAUNCH, "Curve", "resize_curve", CURVE_LEN)) +
    (await resizeAll("markets", PERPS, "Market", "resize_market", MARKET_LEN));
  if (left > 0) throw new Error(`${left} account(s) are still the old size; re-run, or check the programs are upgraded`);
  console.log("All curves and markets are at the current size.");
}

// Exit explicitly: the RPC websocket otherwise keeps the process alive after success.
main().then(
  () => process.exit(0),
  (e) => {
    console.error(redact(String(e?.message ?? e)));
    process.exit(1);
  },
);
