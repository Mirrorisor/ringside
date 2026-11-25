// Policy, attack and server tests for the gas sponsor, against a fake RPC (no network).
// Run: npx tsc --outDir dist && node --test test/sponsor.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { SystemProgram, ComputeBudgetProgram } from "@solana/web3.js";
import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { Sponsor, SPONSOR_PROGRAMS, createSponsorServer, loadKeypairFile } from "../dist/sponsor.js";

const P = SPONSOR_PROGRAMS;
const W = AccountRole.WRITABLE, WS = AccountRole.WRITABLE_SIGNER, R = AccountRole.READONLY, RS = AccountRole.READONLY_SIGNER;
const meta = (address, role) => ({ address, role });
const someAddrs = async (n) => Promise.all(Array.from({ length: n }, async () => (await generateKeyPairSigner()).address));
const le = (n, bytes) => { const b = Buffer.alloc(bytes); bytes === 4 ? b.writeUInt32LE(Number(n)) : b.writeBigUInt64LE(BigInt(n)); return [...b]; };

const FEE = 5_000n;
function fakeRpc({ spend = FEE, fee = FEE, simErr = null } = {}) {
  const calls = { sent: 0, simulated: 0 };
  const balance = 1_000_000_000n;
  return {
    calls,
    getBalance: () => ({ send: async () => ({ value: balance }) }),
    getFeeForMessage: () => ({ send: async () => ({ value: fee }) }),
    simulateTransaction: () => ({ send: async () => { calls.simulated++; return { value: { err: simErr, accounts: [{ lamports: balance - spend }], logs: [] } }; } }),
    sendTransaction: () => ({ send: async () => { calls.sent++; return "FakeSig" + calls.sent; } }),
  };
}

async function build({ feePayer, instructions, signers, lookups }) {
  let msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k", lastValidBlockHeight: 100n }, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  if (lookups) msg = compressTransactionMessageUsingAddressLookupTables(msg, lookups);
  const tx = compileTransaction(msg);
  const signed = signers.length ? await partiallySignTransaction(signers.map((s) => s.keyPair), tx) : tx;
  return getBase64EncodedWireTransaction(signed);
}

const systemTransfer = (from, to, lamports) => ({ programAddress: P.system, accounts: [meta(from, WS), meta(to, W)], data: new Uint8Array([...le(2, 4), ...le(lamports, 8)]) });
const cuLimit = (n) => ({ programAddress: P.computeBudget, accounts: [], data: new Uint8Array([2, ...le(n, 4)]) });
const cuPrice = (n) => ({ programAddress: P.computeBudget, accounts: [], data: new Uint8Array([3, ...le(n, 8)]) });
async function pumpBuyIx(user) {
  const rest = await someAddrs(6);
  return { programAddress: P.pump, accounts: [...rest.map((a) => meta(a, W)), meta(user, WS)], data: new Uint8Array([102, 6, 61, 18, 1, 218, 235, 234, ...le(1000, 8), ...le(1000, 8)]) };
}

async function setup({ rpc: rpcOpts, ...opts } = {}) {
  const payerSigner = await generateKeyPairSigner();
  const user = await generateKeyPairSigner();
  const rpc = fakeRpc(rpcOpts);
  const sponsor = new Sponsor(rpc, payerSigner, { disabled: () => false, ...opts });
  return { sponsor, payerSigner, user, rpc, F: payerSigner.address, U: user.address };
}
const ok = async (s, ixs, client = "c:test") => s.sponsor.sponsor(await build({ feePayer: s.F, instructions: ixs, signers: [s.user] }), client);

test("program IDs match the official libraries", () => {
  assert.equal(P.token, TOKEN_PROGRAM_ID.toBase58());
  assert.equal(P.token2022, TOKEN_2022_PROGRAM_ID.toBase58());
  assert.equal(P.ata, ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
  assert.equal(P.system, SystemProgram.programId.toBase58());
  assert.equal(P.computeBudget, ComputeBudgetProgram.programId.toBase58());
});

test("sponsors a Pump buy with compute budget, paying only the fee", async () => {
  const s = await setup();
  const out = await ok(s, [cuLimit(200_000), cuPrice(10_000), await pumpBuyIx(s.U)]);
  assert.equal(out.ok, true, out.code);
  assert.equal(out.spentLamports, FEE);
  assert.equal(s.rpc.calls.sent, 1);
});

test("attack: fee payer as SOL transfer source", async () => {
  const s = await setup();
  const out = await ok(s, [systemTransfer(s.F, s.U, 1_000_000_000n), await pumpBuyIx(s.U)]);
  assert.equal(out.ok, false);
  assert.equal(out.code, "fee_payer_transfer_source");
  assert.equal(out.instruction, 0);
  assert.equal(s.rpc.calls.simulated, 0);
});

test("attack: fee payer as token transfer authority (Token and Token-2022)", async () => {
  for (const program of [P.token, P.token2022]) {
    const s = await setup();
    const [src, dst] = await someAddrs(2);
    const ix = { programAddress: program, accounts: [meta(src, W), meta(dst, W), meta(s.F, RS)], data: new Uint8Array([3, ...le(1, 8)]) };
    const out = await ok(s, [ix, await pumpBuyIx(s.U)]);
    assert.equal(out.code, "fee_payer_transfer_source", program);
  }
});

test("attack: fee payer writable in an instruction (rent payer, Pump account)", async () => {
  const s = await setup();
  const [ata, mint] = await someAddrs(2);
  const ataIx = { programAddress: P.ata, accounts: [meta(s.F, WS), meta(ata, W), meta(s.U, R), meta(mint, R), meta(P.system, R), meta(P.token, R)], data: new Uint8Array([1]) };
  let out = await ok(s, [ataIx, await pumpBuyIx(s.U)]);
  assert.equal(out.code, "fee_payer_writable");
  // Even when the client marks it read-only, the message makes the fee payer a writable signer.
  const buy = await pumpBuyIx(s.U);
  buy.accounts[0] = meta(s.F, R);
  out = await ok(s, [buy]);
  assert.equal(out.code, "fee_payer_writable");
  assert.equal(s.rpc.calls.sent, 0);
});

test("attack: unknown program", async () => {
  const s = await setup();
  const [evil] = await someAddrs(1);
  const out = await ok(s, [{ programAddress: evil, accounts: [meta(s.U, WS)], data: new Uint8Array([0]) }]);
  assert.equal(out.code, "program_not_allowed");
  assert.equal(out.details.program, evil);
});

test("attack: priority fee and compute units over the caps", async () => {
  const s = await setup();
  const buy = await pumpBuyIx(s.U);
  assert.equal((await ok(s, [cuLimit(200_000), cuPrice(5_000_000n), buy])).code, "priority_fee_too_high");
  // Price under the per-CU cap, but price x limit over the lamport cap.
  assert.equal((await ok(s, [cuLimit(800_000), cuPrice(900_000n), buy])).code, "priority_fee_too_high");
  assert.equal((await ok(s, [cuLimit(1_400_000), buy])).code, "compute_units_too_high");
  assert.equal((await ok(s, [cuPrice(1n), cuPrice(1n), buy])).code, "compute_budget_duplicate");
  // Without a limit, the runtime default (200k per instruction) counts.
  assert.equal((await ok(s, [buy, buy, buy, buy, buy])).code, "compute_units_too_high");
  assert.equal(s.rpc.calls.simulated, 0);
});

test("attack: network fee quoted over the cap", async () => {
  const s = await setup({ rpc: { fee: 1_000_000n } });
  assert.equal((await ok(s, [await pumpBuyIx(s.U)])).code, "fee_too_high");
});

test("attack: simulation shows the payer drained beyond the fee", async () => {
  const s = await setup({ rpc: { spend: 2_044_280n } });
  const out = await ok(s, [await pumpBuyIx(s.U)]);
  assert.equal(out.code, "spend_too_high");
  assert.equal(out.details.spent, 2_044_280n);
  assert.equal(s.rpc.calls.sent, 0);
});

test("failing simulation and missing user signature are refused", async () => {
  let s = await setup({ rpc: { simErr: { InstructionError: [0, { Custom: 6001 }] } } });
  assert.equal((await ok(s, [await pumpBuyIx(s.U)])).code, "simulation_failed");
  s = await setup();
  const wire = await build({ feePayer: s.F, instructions: [await pumpBuyIx(s.U)], signers: [] });
  assert.equal((await s.sponsor.sponsor(wire, "c")).code, "missing_signature");
});

test("attack: per-user daily budget exceeded", async () => {
  // Each request reserves its worst case (the 520k fee cap) against the cap before simulating.
  const s2 = await setup({ policy: { perUserDailyLamports: 530_000n }, rpc: { spend: 20_000n, fee: 20_000n } });
  const b2 = await pumpBuyIx(s2.U);
  assert.equal((await ok(s2, [b2], "c:a")).ok, true);
  const out = await ok(s2, [b2], "c:b");
  assert.equal(out.code, "user_budget");
});

test("attack: per-user hourly rate and global daily budget", async () => {
  const s = await setup({ policy: { perUserPerHour: 2 } });
  const buy = await pumpBuyIx(s.U);
  assert.equal((await ok(s, [buy], "c:1")).ok, true);
  assert.equal((await ok(s, [buy], "c:2")).ok, true);
  assert.equal((await ok(s, [buy], "c:3")).code, "user_rate");

  const g = await setup({ policy: { globalDailyLamports: 600_000n }, rpc: { spend: 100_000n, fee: 100_000n } });
  const other = await generateKeyPairSigner();
  assert.equal((await ok(g, [await pumpBuyIx(g.U)], "c:x")).ok, true);
  const wire = await build({ feePayer: g.F, instructions: [await pumpBuyIx(other.address)], signers: [other] });
  assert.equal((await g.sponsor.sponsor(wire, "c:y")).code, "global_budget");
});

test("attack: concurrent requests cannot overspend the global budget", async () => {
  const s = await setup({ policy: { globalDailyLamports: 2n * 520_000n } });
  const users = await Promise.all(Array.from({ length: 6 }, () => generateKeyPairSigner()));
  const wires = await Promise.all(users.map(async (u) => build({ feePayer: s.F, instructions: [await pumpBuyIx(u.address)], signers: [u] })));
  const outs = await Promise.all(wires.map((w, i) => s.sponsor.sponsor(w, `c:${i}`)));
  assert.equal(outs.filter((o) => o.ok).length, 2);
  assert.ok(outs.filter((o) => !o.ok).every((o) => o.code === "global_budget"));
});

test("kill switch refuses before any work", async () => {
  let off = true;
  const s = await setup({ disabled: () => off });
  let out = await ok(s, [await pumpBuyIx(s.U)]);
  assert.equal(out.code, "disabled");
  assert.equal(out.status, 503);
  assert.equal(s.rpc.calls.simulated, 0);
  off = false;
  assert.equal((await ok(s, [await pumpBuyIx(s.U)])).ok, true);

  // Default kill switch reads SPONSOR_DISABLED on every request.
  const e = await setup({ disabled: undefined });
  process.env.SPONSOR_DISABLED = "1";
  try {
    assert.equal((await ok(e, [await pumpBuyIx(e.U)])).code, "disabled");
  } finally {
    delete process.env.SPONSOR_DISABLED;
  }
  assert.equal((await ok(e, [await pumpBuyIx(e.U)])).ok, true);
});

test("fee recovery requires a transfer to the fee wallet", async () => {
  const [wallet, elsewhere] = await someAddrs(2);
  const s = await setup({ policy: { feeRecovery: { wallet, minLamports: 10_000n } } });
  const buy = await pumpBuyIx(s.U);
  let out = await ok(s, [buy]);
  assert.equal(out.code, "fee_recovery");
  assert.equal(out.status, 402);
  assert.equal((await ok(s, [buy, systemTransfer(s.U, wallet, 9_999n)])).code, "fee_recovery");
  assert.equal((await ok(s, [buy, systemTransfer(s.U, elsewhere, 50_000n)])).code, "fee_recovery");
  out = await ok(s, [buy, systemTransfer(s.U, wallet, 10_000n)]);
  assert.equal(out.ok, true, out.code);
  await assert.rejects(async () => new Sponsor(fakeRpc(), s.payerSigner, { policy: { feeRecovery: { wallet: s.F, minLamports: 1n } } }));
});

test("other refusals: wrong fee payer, no user signer, too many signers, lookup tables", async () => {
  const s = await setup();
  let wire = await build({ feePayer: s.U, instructions: [await pumpBuyIx(s.U)], signers: [s.user] });
  assert.equal((await s.sponsor.sponsor(wire, "c")).code, "fee_payer");
  wire = await build({ feePayer: s.F, instructions: [cuPrice(1n)], signers: [] });
  assert.equal((await s.sponsor.sponsor(wire, "c")).code, "no_signer");
  const extra = await Promise.all(Array.from({ length: 4 }, () => generateKeyPairSigner()));
  const ix = { programAddress: P.pump, accounts: [meta(s.U, WS), ...extra.map((e) => meta(e.address, RS))], data: new Uint8Array([0]) };
  assert.equal((await ok(s, [ix])).code, "too_many_signers");

  const [table, acct] = await someAddrs(2);
  const buy = await pumpBuyIx(s.U);
  const lookups = { [table]: buy.accounts.slice(0, 3).map((a) => a.address).concat(acct) };
  wire = await build({ feePayer: s.F, instructions: [buy], signers: [s.user], lookups });
  assert.equal((await s.sponsor.sponsor(wire, "c")).code, "lookup_tables");
  const withAlt = new Sponsor(fakeRpc(), s.payerSigner, { disabled: () => false, resolveLookupTables: async () => lookups });
  assert.equal((await withAlt.sponsor(wire, "c")).ok, true);
});

test("HTTP server: /health and /sponsor with structured refusals", async () => {
  const s = await setup();
  const server = createSponsorServer(s.sponsor).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.disabled, false);
    assert.equal(health.feePayer, s.F);
    let res = await fetch(`${base}/sponsor`, { method: "POST", body: JSON.stringify({ transaction: await build({ feePayer: s.F, instructions: [await pumpBuyIx(s.U)], signers: [s.user] }) }) });
    assert.equal(res.status, 200);
    assert.match((await res.json()).signature, /^FakeSig/);
    res = await fetch(`${base}/sponsor`, { method: "POST", body: JSON.stringify({ transaction: await build({ feePayer: s.F, instructions: [systemTransfer(s.F, s.U, 1n), await pumpBuyIx(s.U)], signers: [s.user] }) }) });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.deepEqual([body.ok, body.code, body.instruction], [false, "fee_payer_transfer_source", 0]);
    assert.equal(typeof body.message, "string");
    res = await fetch(`${base}/sponsor`, { method: "POST", body: "nope" });
    assert.equal((await res.json()).code, "bad_json");
    res = await fetch(`${base}/sponsor`, { method: "POST", body: "x".repeat(20_000) });
    assert.equal(res.status, 413);
  } finally {
    server.close();
  }
});

test("keypair loader never echoes file contents", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sponsor-"));
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "SECRETSECRET not json");
  chmodSync(bad, 0o600);
  assert.throws(() => loadKeypairFile(bad), (e) => !String(e.message).includes("SECRET"));
  const good = join(dir, "id.json");
  writeFileSync(good, JSON.stringify(Array(64).fill(7)));
  chmodSync(good, 0o600);
  assert.equal(loadKeypairFile(good).length, 64);
});
