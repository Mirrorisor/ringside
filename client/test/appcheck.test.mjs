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
import { readFileSync } from "node:fs";

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


const WSOL = "So11111111111111111111111111111111111111112";
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
/** What the review step shows for a 0.1 SOL buy of MINT, 100 bps slippage, no Ringside fee unless `fee`. */
const BUY = { side: "buy", slippageBps: 100, built: { transaction: "x", venue: "jupiter", lamports: 100_000_000, tokens: "5000000", expectedOut: "5000000", minOut: "4950000", slippageBps: 100, feeLamports: 0 } };
const FEE_BPS_BUY = { ...BUY, built: { ...BUY.built, feeLamports: 500_000 } };
/** An honest routeV2 buy of MINT with WSOL (layout from build-live.json); `o` tampers. */
async function routeV2(c, o, feeSlot = null) {
  const bps = o.bps ?? (feeSlot ? 50 : 0);
  const data = Buffer.concat([Buffer.from("bb64facc31c4af14", "hex"), u64(o.inAmount ?? 100_000_000), u64(o.quotedOut ?? 5_000_000), u16(o.slippage ?? 100), u16(bps), Buffer.alloc(12)]);
  const wsolAta = await associatedTokenAddress(c.user, WSOL);
  const a = [
    [c.user, RS], [wsolAta, RW], [o.destination ?? c.ata, RW], [WSOL, RO], [MINT, RO], [TX_PROGRAMS.token, RO], [TX_PROGRAMS.token, RO],
    [o.slot7 ?? TX_PROGRAMS.jupiterSwap, RO], [OTHER, RO], [TX_PROGRAMS.jupiterSwap, RO],
    ...(feeSlot ? [[feeSlot, RW]] : []),
  ];
  return { programAddress: TX_PROGRAMS.jupiterSwap, accounts: a.map(([address, role]) => ({ address, role })), data };
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
  const w = wire(c.user, [await routeV2(c, {})]);
  const r = await checkBuiltTransaction(w, { user: c.user, mint: MINT, venue: "jupiter", feeWallet: null, feeLamports: null, swap: BUY });
  assert.deepEqual(r.venues, ["jupiter"]);
  // a Jupiter swap is never signed without the displayed values to check it against
  await assert.rejects(checkBuiltTransaction(w, { user: c.user, mint: MINT, venue: "jupiter", feeWallet: null, feeLamports: null }), { code: "swap_unverified" });
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

// ---- Jupiter /swap/v2/build transactions -----------------------------------------------------

test("a Jupiter /build swap with the platform fee to our fee token account is accepted: no SOL transfer, no outflow", async () => {
  const [c, fee] = [await ctx(), (await generateKeyPairSigner()).address];
  const w = wire(c.sponsor, [await routeV2(c, {}, fee)]);
  const opts = { user: c.user, sponsor: c.sponsor, mint: MINT, venue: "jupiter", feeWallet: c.feeWallet, feeLamports: 500_000, feeAccounts: [fee], swap: FEE_BPS_BUY };
  const r = await checkBuiltTransaction(w, opts);
  assert.deepEqual(r.venues, ["jupiter"]);
  assert.equal(r.feeLamportsInTx, 0n); // the fee is taken inside the swap, in the input or output token
  // no fee at all (empty slot) is fine too, when the displayed fee is 0
  await checkBuiltTransaction(wire(c.sponsor, [await routeV2(c, {})]), { ...opts, feeLamports: 0, swap: BUY });
});

test("a Jupiter /build swap that pays the fee to anyone else, or that we cannot read, is refused", async () => {
  const [c, fee] = [await ctx(), (await generateKeyPairSigner()).address];
  const opts = { user: c.user, sponsor: c.sponsor, mint: MINT, venue: "jupiter", feeWallet: c.feeWallet, feeLamports: 500_000, feeAccounts: [fee], swap: FEE_BPS_BUY };
  await assert.rejects(checkBuiltTransaction(wire(c.sponsor, [await routeV2(c, {}, c.attacker)]), opts), { code: "fee_account_mismatch" });
  // an unknown swap layout cannot be verified
  const odd = { ...(await routeV2(c, {}, fee)), data: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]) };
  await assert.rejects(checkBuiltTransaction(wire(c.sponsor, [odd]), opts), { code: "fee_account_unverified" });
  await assert.rejects(checkBuiltTransaction(wire(c.sponsor, [odd]), { ...opts, feeAccounts: null }), { code: "swap_unverified" });
  // the SOL rules still apply: a stranger transfer next to a good swap is refused
  await assert.rejects(checkBuiltTransaction(wire(c.sponsor, [await routeV2(c, {}, fee), transfer(c.user, c.attacker, 5_000_000_000)]), opts), { code: "user_transfer" });
  // without configured fee accounts the app does not judge the fee slot (older config), but still the swap
  await checkBuiltTransaction(wire(c.sponsor, [await routeV2(c, {}, c.attacker)]), { ...opts, feeAccounts: null });
});

test("a malicious /build swap (output to the attacker, in_amount raised, slippage 100%, other fee bps) is refused app-side", async () => {
  const [c, fee] = [await ctx(), (await generateKeyPairSigner()).address];
  const opts = { user: c.user, sponsor: c.sponsor, mint: MINT, venue: "jupiter", feeWallet: c.feeWallet, feeLamports: 500_000, feeAccounts: [fee], swap: FEE_BPS_BUY };
  const thiefAta = await associatedTokenAddress(c.attacker, MINT);
  const bad = async (o, code, extra = {}) => assert.rejects(checkBuiltTransaction(wire(c.sponsor, [await routeV2(c, o, fee)]), { ...opts, ...extra }), { code });
  await bad({ destination: thiefAta }, "swap_destination");
  await bad({ slot7: thiefAta }, "swap_destination");
  await bad({ inAmount: 100_000_000_000 }, "swap_amount_mismatch");
  await bad({ quotedOut: 1, slippage: 10_000 }, "swap_slippage");
  await bad({ quotedOut: 1 }, "swap_slippage");
  await bad({ slippage: 5_000 }, "swap_slippage");
  await bad({ bps: 255 }, "swap_fee_bps");
  await bad({ bps: 0 }, "swap_fee_bps"); // no fee in the instruction but one displayed
  // a second swap instruction is refused outright
  await assert.rejects(checkBuiltTransaction(wire(c.sponsor, [await routeV2(c, {}, fee), await routeV2(c, {}, fee)]), opts), { code: "swap_unverified" });
});

test("a Meteora DBC swap whose output goes to the attacker is refused app-side", async () => {
  const { METEORA_DBC_PROGRAM } = await import("../dist/appcheck.js");
  const c = await ctx();
  const wsolAta = await associatedTokenAddress(c.user, WSOL);
  const dbc = (output, referral = METEORA_DBC_PROGRAM) => ({
    programAddress: METEORA_DBC_PROGRAM, data: Buffer.concat([Buffer.from("414b3f4ceb5b5b88", "hex"), Buffer.alloc(17)]),
    accounts: [OTHER, OTHER, OTHER, wsolAta, output, OTHER, OTHER, MINT, WSOL, c.user, TX_PROGRAMS.token, TX_PROGRAMS.token, referral, OTHER, METEORA_DBC_PROGRAM]
      .map((address, i) => ({ address, role: i === 9 ? WS : address === METEORA_DBC_PROGRAM ? RO : RW })),
  });
  const opts = { user: c.user, mint: MINT, venue: "meteora", feeWallet: null, feeLamports: null };
  await checkBuiltTransaction(wire(c.user, [dbc(c.ata)]), opts);
  await assert.rejects(checkBuiltTransaction(wire(c.user, [dbc(await associatedTokenAddress(c.attacker, MINT))]), opts), { code: "swap_destination" });
  await assert.rejects(checkBuiltTransaction(wire(c.user, [dbc(c.ata, c.attacker)]), opts), { code: "swap_referral" });
});
