// Web app signing checks: backend allowlist, sign-in message, built-transaction check, review fields. No network.
// Run: npx tsc --outDir dist && node --test test/appcheck.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AccountRole, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, generateKeyPairSigner,
  getBase64EncodedWireTransaction, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { checkBuiltTransaction, checkSiwsMessage, describeBuilt, resolveBase, PUMP_PROGRAM, PUMPSWAP_PROGRAM } from "../dist/appcheck.js";
import { associatedTokenAddress, TX_PROGRAMS } from "../dist/trade/jupiter.js";

const MINT = "AbYGhAcF86iLQpQQynmZPZAyMejskVFowy2P2LBktuaH";
const OTHER = "8y5FVi7aTTSjwvLQkXFyRojbDrL8w9svysX8mZcEgmyK";
const RW = AccountRole.WRITABLE, RS = AccountRole.READONLY_SIGNER, WS = AccountRole.WRITABLE_SIGNER, RO = AccountRole.READONLY;
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

const transfer = (from, to, lamports) => ({ programAddress: TX_PROGRAMS.system, accounts: [{ address: from, role: WS }, { address: to, role: RW }], data: Buffer.concat([u32(2), u64(lamports)]) });
const approve = (src, delegate, owner) => ({ programAddress: TX_PROGRAMS.token, accounts: [{ address: src, role: RW }, { address: delegate, role: RO }, { address: owner, role: RS }], data: Buffer.concat([Buffer.from([4]), u64(1_000_000)]) });
const swap = (program, user, accts) => ({ programAddress: program, accounts: [{ address: user, role: RS }, ...accts.map((address) => ({ address, role: RW }))], data: new Uint8Array([1, 2, 3]) });

function wire(feePayer, ixs) {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k", lastValidBlockHeight: 100n }, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  return getBase64EncodedWireTransaction(compileTransaction(msg));
}

async function ctx() {
  const [user, sponsor, feeWallet, attacker] = await Promise.all([1, 2, 3, 4].map(() => generateKeyPairSigner()));
  const ata = await associatedTokenAddress(user.address, MINT);
  return { user: user.address, sponsor: sponsor.address, feeWallet: feeWallet.address, attacker: attacker.address, ata };
}

test("resolveBase: production ignores overrides; dev honours only allowlisted origins", () => {
  const o = { pageOrigin: "https://app.ringside.gg" };
  assert.equal(resolveBase("https://evil.example", "https://app.ringside.gg/copy", { ...o, dev: false, allowedCsv: "https://evil.example" }), "https://app.ringside.gg/copy");
  assert.equal(resolveBase("https://evil.example", "https://app.ringside.gg/copy", { ...o, dev: true }), "https://app.ringside.gg/copy");
  assert.equal(resolveBase("http://localhost:8793/", "/d", { ...o, dev: true }), "http://localhost:8793");
  assert.equal(resolveBase("https://staging.ringside.gg/x", "/d", { ...o, dev: true, allowedCsv: "https://staging.ringside.gg" }), "https://staging.ringside.gg/x");
  assert.equal(resolveBase("https://localhost.evil.example", "/d", { ...o, dev: true }), "/d");
  assert.equal(resolveBase("https://user:pw@staging.ringside.gg", "/d", { ...o, dev: true, allowedCsv: "https://staging.ringside.gg" }), "/d");
  assert.equal(resolveBase("javascript:alert(1)", "/d", { ...o, dev: true }), "/d");
});

const W = "99cnRnduE5KdqhuJmYN5YH3WcnSiPQ152bF3hbxSfvKU";
const msg = (host = "app.ringside.gg", wallet = W) => [
  `${host} wants you to sign in with your Solana account:`, wallet, "",
  "Sign in to Ringside. This request will not trigger a transaction or cost any fee.", "",
  `Nonce: ${"a1".repeat(16)}`, "Issued At: 2026-01-01T00:00:00.000Z", "Expiration Time: 2026-01-01T00:05:00.000Z",
].join("\n");

test("sign-in message: right host and wallet pass; relayed or odd messages are refused", () => {
  checkSiwsMessage(msg(), { host: "app.ringside.gg", wallet: W });
  assert.throws(() => checkSiwsMessage(msg("evil.example"), { host: "app.ringside.gg", wallet: W }), { code: "bad_signin_message" });
  assert.throws(() => checkSiwsMessage(msg("app.ringside.gg", OTHER), { host: "app.ringside.gg", wallet: W }), { code: "bad_signin_message" });
  assert.throws(() => checkSiwsMessage(msg() + "\nResources: x", { host: "app.ringside.gg", wallet: W }), { code: "bad_signin_message" });
  assert.throws(() => checkSiwsMessage(msg().replace("Sign in to Ringside.", "Transfer all funds."), { host: "app.ringside.gg", wallet: W }), { code: "bad_signin_message" });
});

test("a correct Pump buy (sponsored, fee to the fee wallet) is accepted", async () => {
  const c = await ctx();
  const w = wire(c.sponsor, [swap(PUMP_PROGRAM, c.user, [c.ata, MINT]), transfer(c.user, c.feeWallet, 500_000)]);
  const r = await checkBuiltTransaction(w, { user: c.user, sponsor: c.sponsor, mint: MINT, venue: "pumpfun", feeWallet: c.feeWallet, feeLamports: 500_000 });
  assert.deepEqual(r.venues, ["pumpfun"]);
  assert.equal(r.feeLamportsInTx, 500_000n);
  await checkBuiltTransaction(wire(c.sponsor, [swap(PUMPSWAP_PROGRAM, c.user, [MINT])]), { user: c.user, sponsor: c.sponsor, mint: MINT, venue: "pumpfun", feeWallet: c.feeWallet, feeLamports: 0 });
});

test("a correct Jupiter swap is accepted", async () => {
  const c = await ctx();
  const w = wire(c.user, [swap(TX_PROGRAMS.jupiterSwap, c.user, [c.ata])]);
  const r = await checkBuiltTransaction(w, { user: c.user, mint: MINT, venue: "jupiter", feeWallet: null, feeLamports: null });
  assert.deepEqual(r.venues, ["jupiter"]);
});

test("a drain (user SOL to the attacker, or over the displayed fee) is refused", async () => {
  const c = await ctx();
  const drain = wire(c.sponsor, [swap(TX_PROGRAMS.jupiterSwap, c.user, [c.ata]), transfer(c.user, c.attacker, 5_000_000_000)]);
  await assert.rejects(checkBuiltTransaction(drain, { user: c.user, sponsor: c.sponsor, mint: MINT, venue: "jupiter", feeWallet: c.feeWallet, feeLamports: 1000 }), { code: "user_transfer" });
  const over = wire(c.sponsor, [swap(PUMP_PROGRAM, c.user, [c.ata]), transfer(c.user, c.feeWallet, 2_000_000)]);
  await assert.rejects(checkBuiltTransaction(over, { user: c.user, sponsor: c.sponsor, mint: MINT, venue: "pumpfun", feeWallet: c.feeWallet, feeLamports: 1_000_000 }), { code: "outflow_too_high" });
  await assert.rejects(checkBuiltTransaction(over, { user: c.user, sponsor: c.sponsor, mint: MINT, venue: "pumpfun", feeWallet: null, feeLamports: 1_000_000 }), { code: "user_transfer" });
});

test("a token Approve to the attacker is refused", async () => {
  const c = await ctx();
  const w = wire(c.sponsor, [approve(c.ata, c.attacker, c.user), swap(TX_PROGRAMS.jupiterSwap, c.user, [c.ata])]);
  await assert.rejects(checkBuiltTransaction(w, { user: c.user, sponsor: c.sponsor, mint: MINT, venue: "jupiter", feeWallet: null, feeLamports: null }), { code: "token_approve" });
});

test("a transaction for a different mint is refused", async () => {
  const c = await ctx();
  const otherAta = await associatedTokenAddress(c.user, OTHER);
  const w = wire(c.sponsor, [swap(TX_PROGRAMS.jupiterSwap, c.user, [otherAta, OTHER])]);
  await assert.rejects(checkBuiltTransaction(w, { user: c.user, sponsor: c.sponsor, mint: MINT, venue: "jupiter", feeWallet: null, feeLamports: null }), { code: "mint_mismatch" });
});

test("wrong fee payer, unknown program and wrong venue are refused", async () => {
  const c = await ctx();
  await assert.rejects(checkBuiltTransaction(wire(c.attacker, [swap(TX_PROGRAMS.jupiterSwap, c.user, [c.ata])]), { user: c.user, sponsor: c.sponsor, mint: MINT, venue: "jupiter", feeWallet: null, feeLamports: null }), { code: "fee_payer" });
  await assert.rejects(checkBuiltTransaction(wire(c.sponsor, [swap(c.attacker, c.user, [c.ata])]), { user: c.user, sponsor: c.sponsor, mint: MINT, venue: "jupiter", feeWallet: null, feeLamports: null }), { code: "program_not_allowed" });
  await assert.rejects(checkBuiltTransaction(wire(c.sponsor, [swap(TX_PROGRAMS.jupiterSwap, c.user, [c.ata])]), { user: c.user, sponsor: c.sponsor, mint: MINT, venue: "pumpfun", feeWallet: null, feeLamports: null }), { code: "venue_mismatch" });
});

test("describeBuilt: reads the build response, derives the minimum, reports what is unknown", () => {
  const buy = describeBuilt("buy", { transaction: "x", feeLamports: 1000, venue: "pumpfun", lamports: 1e8, tokensOut: "5000000" }, 100);
  assert.equal(buy.expectedOut, 5_000_000n);
  assert.equal(buy.minOut, 4_950_000n);
  assert.deepEqual(buy.unknown, []);
  const sell = describeBuilt("sell", { transaction: "x", feeLamports: 5, venue: "jupiter", lamports: 123_456 }, 50);
  assert.equal(sell.proceedsLamports, 123_456n);
  assert.equal(sell.minOut, 122_838n);
  const bare = describeBuilt("buy", { transaction: "x" }, undefined);
  assert.deepEqual(bare.unknown.sort(), ["Ringside fee", "expected output", "minimum after slippage", "venue"]);
});
