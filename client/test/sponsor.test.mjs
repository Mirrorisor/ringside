// Policy, attack and server tests for the gas sponsor, against a fake RPC (no network).
// Run: npx tsc --outDir dist && node --test test/sponsor.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
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
import { Sponsor, SPONSOR_PROGRAMS, DEFAULT_POLICY, createSponsorServer, loadKeypairFile } from "../dist/sponsor.js";
import { createSessionToken, verifySessionToken, hmacSessionAuth } from "../dist/session.js";
import { FileBudget, MemoryBudget } from "../dist/budget.js";

const P = SPONSOR_PROGRAMS;
const W = AccountRole.WRITABLE, WS = AccountRole.WRITABLE_SIGNER, R = AccountRole.READONLY, RS = AccountRole.READONLY_SIGNER;
const meta = (address, role) => ({ address, role });
const someAddrs = async (n) => Promise.all(Array.from({ length: n }, async () => (await generateKeyPairSigner()).address));
const le = (n, bytes) => { const b = Buffer.alloc(bytes); bytes === 4 ? b.writeUInt32LE(Number(n)) : b.writeBigUInt64LE(BigInt(n)); return [...b]; };

const FEE = 5_000n;
const WORST = DEFAULT_POLICY.maxFeeLamports; // reserved per request against daily budgets
function fakeRpc({ spend = FEE, fee = FEE, simErr = null, chainErr = null, blockhashValid = true } = {}) {
  const calls = { sent: 0, simulated: 0, blockhash: 0, statuses: 0 };
  const balance = 1_000_000_000n;
  return {
    calls,
    getBalance: () => ({ send: async () => ({ value: balance }) }),
    getFeeForMessage: () => ({ send: async () => ({ value: fee }) }),
    simulateTransaction: () => ({ send: async () => { calls.simulated++; return { value: { err: simErr, accounts: [{ lamports: balance - spend }], logs: [] } }; } }),
    sendTransaction: () => ({ send: async () => { calls.sent++; return "FakeSig" + calls.sent; } }),
    isBlockhashValid: () => ({ send: async () => { calls.blockhash++; return { value: blockhashValid }; } }),
    getSignatureStatuses: () => ({ send: async () => { calls.statuses++; return { value: [{ err: chainErr, confirmationStatus: "confirmed" }] }; } }),
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
  const sponsor = new Sponsor(rpc, payerSigner, { disabled: () => false, confirm: { pollMs: 1, timeoutMs: 1_000 }, ...opts });
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
  assert.equal((await ok(s, [cuLimit(500_000), cuPrice(150_000n), buy])).code, "priority_fee_too_high");
  assert.equal((await ok(s, [cuLimit(800_000), buy])).code, "compute_units_too_high");
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
  // Each request reserves its worst case (the fee cap) against the cap before simulating.
  const s2 = await setup({ policy: { perUserDailyLamports: WORST + 10_000n }, rpc: { spend: 20_000n, fee: 20_000n } });
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

  const g = await setup({ policy: { globalDailyLamports: WORST + 50_000n }, rpc: { spend: 60_000n, fee: 60_000n } });
  const other = await generateKeyPairSigner();
  assert.equal((await ok(g, [await pumpBuyIx(g.U)], "c:x")).ok, true);
  const wire = await build({ feePayer: g.F, instructions: [await pumpBuyIx(other.address)], signers: [other] });
  assert.equal((await g.sponsor.sponsor(wire, "c:y")).code, "global_budget");
});

test("attack: concurrent requests cannot overspend the global budget", async () => {
  const s = await setup({ policy: { globalDailyLamports: 2n * WORST } });
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
  const withAlt = new Sponsor(fakeRpc(), s.payerSigner, { disabled: () => false, confirm: { pollMs: 1 }, resolveLookupTables: async () => lookups });
  assert.equal((await withAlt.sponsor(wire, "c")).ok, true);
});

const SECRET = "test-session-secret-0123456789abcdef"; // 36 bytes
const authed = (userId = "user-1") => ({ authorization: `Bearer ${createSessionToken(SECRET, userId)}` });

// Changed: this test used to start the server with no authenticator (an open
// gas service, finding H2). It now signs requests with a session token.
test("HTTP server: /health and /sponsor with structured refusals", async () => {
  const s = await setup();
  const server = createSponsorServer(s.sponsor, { authenticate: hmacSessionAuth(SECRET) }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.disabled, false);
    assert.equal(health.feePayer, s.F);
    let res = await fetch(`${base}/sponsor`, { method: "POST", headers: authed(), body: JSON.stringify({ transaction: await build({ feePayer: s.F, instructions: [await pumpBuyIx(s.U)], signers: [s.user] }) }) });
    assert.equal(res.status, 200);
    assert.match((await res.json()).signature, /^FakeSig/);
    res = await fetch(`${base}/sponsor`, { method: "POST", headers: authed(), body: JSON.stringify({ transaction: await build({ feePayer: s.F, instructions: [systemTransfer(s.F, s.U, 1n), await pumpBuyIx(s.U)], signers: [s.user] }) }) });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.deepEqual([body.ok, body.code, body.instruction], [false, "fee_payer_transfer_source", 0]);
    assert.equal(typeof body.message, "string");
    res = await fetch(`${base}/sponsor`, { method: "POST", headers: authed(), body: "nope" });
    assert.equal((await res.json()).code, "bad_json");
    res = await fetch(`${base}/sponsor`, { method: "POST", headers: authed(), body: "x".repeat(20_000) });
    assert.equal(res.status, 413);
  } finally {
    server.close();
    await s.sponsor.settled();
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

// ---------------------------------------------------------------------------
// Regression tests for the security review (/tmp/review/poc.test.mjs)
// ---------------------------------------------------------------------------

async function withServer(sponsor, opts, fn) {
  const server = createSponsorServer(sponsor, opts).listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    await sponsor.settled();
  }
}
const post = (base, tx, headers = {}) =>
  fetch(`${base}/sponsor`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ transaction: tx }) });

test("H2 regression: Sybil wallets get no free max-priority gas for plain transfers", async () => {
  const s = await setup();
  const codes = new Set();
  for (let i = 0; i < 10; i++) {
    const u = await generateKeyPairSigner();
    const [v] = await someAddrs(1);
    const wire = await build({ feePayer: s.F, instructions: [cuLimit(500_000), cuPrice(1_000_000), systemTransfer(u.address, v, 1)], signers: [u] });
    codes.add((await s.sponsor.sponsor(wire, "c:" + i)).code);
    const plain = await build({ feePayer: s.F, instructions: [systemTransfer(u.address, v, 1)], signers: [u] });
    codes.add((await s.sponsor.sponsor(plain, "c:" + i)).code);
    // And with an app instruction, the PoC's priority fee is over the lowered caps.
    const maxed = await build({ feePayer: s.F, instructions: [cuLimit(500_000), cuPrice(1_000_000), await pumpBuyIx(u.address)], signers: [u] });
    codes.add((await s.sponsor.sponsor(maxed, "c:" + i)).code);
  }
  assert.deepEqual([...codes].sort(), ["no_app_instruction", "priority_fee_too_high"]);
  assert.equal(s.rpc.calls.simulated, 0);
  assert.equal(s.rpc.calls.blockhash, 0);
});

test("H2: the server refuses to start without an authenticator unless anonymous mode is explicit", async () => {
  const s = await setup();
  assert.throws(() => createSponsorServer(s.sponsor), /authenticator/);
  createSponsorServer(s.sponsor, { allowAnonymous: true }).close();
});

test("H2: requests need a valid, unexpired session token", async () => {
  const s = await setup();
  const tx = await build({ feePayer: s.F, instructions: [await pumpBuyIx(s.U)], signers: [s.user] });
  await withServer(s.sponsor, { authenticate: hmacSessionAuth(SECRET) }, async (base) => {
    assert.equal((await post(base, tx)).status, 401);
    assert.equal((await post(base, tx, { authorization: "Bearer junk" })).status, 401);
    const forged = createSessionToken("another-secret-of-at-least-32-bytes!!", "user-1");
    assert.equal((await post(base, tx, { authorization: `Bearer ${forged}` })).status, 401);
    const expired = createSessionToken(SECRET, "user-1", 60, Date.now() - 120_000);
    assert.equal((await post(base, tx, { authorization: `Bearer ${expired}` })).status, 401);
    assert.equal(s.rpc.calls.simulated, 0);
    assert.equal((await post(base, tx, authed())).status, 200);
  });
});

test("H2: session tokens: tamper, expiry, secret length", () => {
  const t = createSessionToken(SECRET, "alice", 60);
  assert.deepEqual(verifySessionToken(SECRET, t), { userId: "alice" });
  const [v, p, m] = t.split(".");
  const evil = Buffer.from(JSON.stringify({ sub: "bob", exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");
  assert.equal(verifySessionToken(SECRET, `${v}.${evil}.${m}`), null);
  assert.equal(verifySessionToken(SECRET, `${v}.${p}.${m.slice(0, -2)}`), null);
  assert.equal(verifySessionToken(SECRET, t, Date.now() + 61_000), null);
  assert.equal(verifySessionToken(SECRET, createSessionToken(SECRET, "alice", 365 * 86400)), null); // over the max TTL
  assert.throws(() => hmacSessionAuth("too-short"), /32 bytes/);
});

test("H2: per-user limits follow the authenticated user across fresh wallets and IPs", async () => {
  const s = await setup({ policy: { perUserPerHour: 2 } });
  const codes = [];
  for (let i = 0; i < 4; i++) {
    const u = await generateKeyPairSigner();
    const wire = await build({ feePayer: s.F, instructions: [await pumpBuyIx(u.address)], signers: [u] });
    const out = await s.sponsor.sponsor(wire, "c:" + i, "user-1");
    codes.push(out.ok ? "ok" : out.code);
  }
  assert.deepEqual(codes, ["ok", "ok", "user_rate", "user_rate"]);
  await s.sponsor.settled();
});

test("H2 regression: a spoofed X-Forwarded-For does not give a fresh client key (rightmost hop)", async () => {
  const s = await setup({ policy: { perClientPerHour: 2 } });
  await withServer(s.sponsor, { allowAnonymous: true, trustProxy: true }, async (base) => {
    let okCount = 0;
    for (let i = 0; i < 6; i++) {
      const u = await generateKeyPairSigner();
      const tx = await build({ feePayer: s.F, instructions: [await pumpBuyIx(u.address)], signers: [u] });
      const res = await post(base, tx, { "x-forwarded-for": `10.0.0.${i}, 1.2.3.4` });
      if (res.status === 200) okCount++;
    }
    assert.equal(okCount, 2);
  });
  // Two trusted hops: the second entry from the right is the client.
  const t = await setup({ policy: { perClientPerHour: 1 } });
  await withServer(t.sponsor, { allowAnonymous: true, trustProxy: 2 }, async (base) => {
    const statuses = [];
    for (const xff of ["9.9.9.9, 5.5.5.5, 10.0.0.1", "8.8.8.8, 5.5.5.5, 10.0.0.2", "6.6.6.6, 10.0.0.3"]) {
      const u = await generateKeyPairSigner();
      statuses.push((await post(base, await build({ feePayer: t.F, instructions: [await pumpBuyIx(u.address)], signers: [u] }), { "x-forwarded-for": xff })).status);
    }
    assert.deepEqual(statuses, [200, 429, 200]);
  });
});

test("H2: daily budget persists across restarts in the state file, and a second instance is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sponsor-state-"));
  const file = join(dir, "state.json");
  const a = new FileBudget(file);
  assert.throws(() => new FileBudget(file), /holds/);
  await a.record(["global", "u:x"], 123_456n);
  a.close();
  assert.equal(existsSync(file + ".lock"), false);
  assert.match(readFileSync(file, "utf8"), /123456/);
  const b = new FileBudget(file);
  assert.equal(await b.spentToday("global"), 123_456n);
  assert.equal(await b.countLastHour("u:x"), 1);
  b.close();
  // A lock left by a dead process is taken over.
  writeFileSync(file + ".lock", "999999999");
  const c = new FileBudget(file);
  assert.equal(await c.spentToday("global"), 123_456n);
  c.close();
});

test("M1: on-chain failures are counted and block the user, client and wallet", async () => {
  const s = await setup({ rpc: { chainErr: { InstructionError: [1, { Custom: 1 }] } }, policy: { maxFailuresPerHour: 2 } });
  const buy = await pumpBuyIx(s.U);
  assert.equal((await ok(s, [buy], "c:a")).ok, true);
  assert.equal((await ok(s, [buy], "c:a")).ok, true);
  await s.sponsor.settled();
  // The wallet is blocked even from a new client.
  assert.equal((await ok(s, [buy], "c:c")).code, "too_many_failures");
  // The client is blocked even for a new wallet.
  const other = await generateKeyPairSigner();
  const w = await build({ feePayer: s.F, instructions: [await pumpBuyIx(other.address)], signers: [other] });
  assert.equal((await s.sponsor.sponsor(w, "c:a")).code, "too_many_failures");
  assert.equal(s.rpc.calls.sent, 2);

  // The authenticated user is blocked whatever wallet or client they use.
  const t = await setup({ rpc: { chainErr: { InstructionError: [0, "Custom"] } }, policy: { maxFailuresPerHour: 1 }, confirm: { pollMs: 1, wait: true } });
  const out = await t.sponsor.sponsor(await build({ feePayer: t.F, instructions: [await pumpBuyIx(t.U)], signers: [t.user] }), "c:1", "mallory");
  assert.equal(out.status, "failed");
  const fresh = await generateKeyPairSigner();
  const again = await t.sponsor.sponsor(await build({ feePayer: t.F, instructions: [await pumpBuyIx(fresh.address)], signers: [fresh] }), "c:2", "mallory");
  assert.equal(again.code, "too_many_failures");
});

test("M2 regression: failed simulations count toward the hourly limits", async () => {
  const s = await setup({ rpc: { simErr: { InstructionError: [0, "Custom"] } } });
  const wire = await build({ feePayer: s.F, instructions: [await pumpBuyIx(s.U)], signers: [s.user] });
  const codes = new Set();
  for (let i = 0; i < 100; i++) codes.add((await s.sponsor.sponsor(wire, "c:same")).code);
  assert.deepEqual([...codes], ["simulation_failed", "user_rate"]);
  assert.equal(s.rpc.calls.simulated, DEFAULT_POLICY.perUserPerHour);

  // Fresh wallets from one client: the client limit holds, and static refusals count too.
  const c = await setup({ policy: { perClientPerHour: 5 } });
  const seen = [];
  for (let i = 0; i < 10; i++) {
    const u = await generateKeyPairSigner();
    const [v] = await someAddrs(1);
    seen.push((await c.sponsor.sponsor(await build({ feePayer: c.F, instructions: [systemTransfer(u.address, v, 1)], signers: [u] }), "c:one")).code);
  }
  assert.deepEqual(seen, [...Array(5).fill("no_app_instruction"), ...Array(5).fill("client_rate")]);
  assert.equal(c.rpc.calls.simulated, 0);
});

test("M2: lookup-table resolution happens only after the request is counted", async () => {
  const s = await setup();
  const [table, acct] = await someAddrs(2);
  const buy = await pumpBuyIx(s.U);
  const lookups = { [table]: buy.accounts.slice(0, 3).map((a) => a.address).concat(acct) };
  let resolved = 0;
  const sp = new Sponsor(s.rpc, s.payerSigner, {
    disabled: () => false,
    policy: { perUserPerHour: 3 },
    resolveLookupTables: async () => { resolved++; throw new Error("rpc down at 10.1.2.3"); },
  });
  const wire = await build({ feePayer: s.F, instructions: [buy], signers: [s.user], lookups });
  const outs = [];
  for (let i = 0; i < 6; i++) outs.push(await sp.sponsor(wire, "c:" + i));
  assert.deepEqual(outs.map((o) => o.code), ["lookup_tables", "lookup_tables", "lookup_tables", "user_rate", "user_rate", "user_rate"]);
  assert.equal(resolved, 3);
  assert.ok(!outs[0].message.includes("10.1.2.3"));
});

test("M3 regression: durable-nonce AdvanceNonceAccount refused anywhere in the transaction", async () => {
  const s = await setup();
  const nonce = await generateKeyPairSigner();
  const adv = { programAddress: P.system, accounts: [meta(nonce.address, W), meta("SysvarRecentB1ockHashes11111111111111111111", R), meta(s.U, WS)], data: new Uint8Array(le(4, 4)) };
  const buy = await pumpBuyIx(s.U);
  let out = await s.sponsor.inspect(await build({ feePayer: s.F, instructions: [adv, buy], signers: [s.user] }));
  assert.equal(out.code, "durable_nonce");
  assert.equal(out.instruction, 0);
  out = await s.sponsor.inspect(await build({ feePayer: s.F, instructions: [buy, adv], signers: [s.user] }));
  assert.equal(out.code, "durable_nonce");
  assert.equal(out.instruction, 1);
});

test("M3: the blockhash must be a recent one", async () => {
  const s = await setup({ rpc: { blockhashValid: false } });
  const out = await ok(s, [await pumpBuyIx(s.U)]);
  assert.equal(out.code, "stale_blockhash");
  assert.equal(s.rpc.calls.blockhash, 1);
  assert.equal(s.rpc.calls.simulated, 0);
  assert.equal(s.rpc.calls.sent, 0);
});

test("L3: decoder errors are not returned; CORS defaults to no origin", async () => {
  const s = await setup();
  await withServer(s.sponsor, { authenticate: hmacSessionAuth(SECRET) }, async (base) => {
    const res = await post(base, Buffer.from([1, 2, 3, 4, 5]).toString("base64"), authed());
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
    const body = await res.json();
    assert.deepEqual(body, { ok: false, code: "malformed", message: "Could not decode the transaction." });
  });
  await withServer(s.sponsor, { authenticate: hmacSessionAuth(SECRET), allowOrigin: "https://app.ringside.example" }, async (base) => {
    const res = await fetch(`${base}/sponsor`, { method: "OPTIONS" });
    assert.equal(res.headers.get("access-control-allow-origin"), "https://app.ringside.example");
    assert.match(res.headers.get("access-control-allow-headers"), /authorization/);
  });
});
