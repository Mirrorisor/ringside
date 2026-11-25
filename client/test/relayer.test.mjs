// Policy and server tests for the fee relayer, against a fake RPC.
// Run: npx tsc --outDir dist && node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { Relayer, PROGRAMS, createRelayerServer } from "../dist/relayer.js";

const SYSTEM = "11111111111111111111111111111111";
const disc = (n) => new Uint8Array(createHash("sha256").update(`global:${n}`).digest().subarray(0, 8));
const W = AccountRole.WRITABLE, WS = AccountRole.WRITABLE_SIGNER, R = AccountRole.READONLY;
const meta = (address, role) => ({ address, role });
const someAddrs = async (n) => Promise.all(Array.from({ length: n }, async () => (await generateKeyPairSigner()).address));

function fakeRpc({ spend = 2_100_000n, fee = 5_000n, simErr = null } = {}) {
  const calls = { sent: 0 };
  const balance = 1_000_000_000n;
  return {
    calls,
    getBalance: () => ({ send: async () => ({ value: balance }) }),
    getFeeForMessage: () => ({ send: async () => ({ value: fee }) }),
    simulateTransaction: () => ({ send: async () => ({ value: { err: simErr, accounts: [{ lamports: balance - spend }], logs: [] } }) }),
    sendTransaction: () => ({ send: async () => { calls.sent++; return "FakeSig" + calls.sent; } }),
  };
}

async function build({ feePayer, instructions, signers }) {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k", lastValidBlockHeight: 100n }, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const tx = compileTransaction(msg);
  const signed = signers.length ? await partiallySignTransaction(signers.map((s) => s.keyPair), tx) : tx;
  return getBase64EncodedWireTransaction(signed);
}

async function requestOrderIx(owner, payer) {
  const rest = await someAddrs(8);
  return {
    programAddress: PROGRAMS.perps,
    accounts: [meta(owner, WS), meta(payer, WS), ...rest.map((a) => meta(a, W))],
    data: new Uint8Array([...disc("request_order"), ...new Uint8Array(41)]),
  };
}

async function setup(rpcOpts) {
  const relayerSigner = await generateKeyPairSigner();
  const trader = await generateKeyPairSigner();
  const rpc = fakeRpc(rpcOpts);
  const relayer = new Relayer(rpc, relayerSigner);
  return { relayer, relayerSigner, trader, rpc, R: relayerSigner.address, T: trader.address };
}

test("sponsors a request_order where the relayer pays rent", async () => {
  const { relayer, trader, rpc, R, T } = await setup();
  const wire = await build({ feePayer: R, instructions: [await requestOrderIx(T, R)], signers: [trader] });
  const out = await relayer.sponsor(wire, "c:test");
  assert.equal(out.ok, true, out.code);
  assert.equal(out.spentLamports, 2_100_000n);
  assert.equal(rpc.calls.sent, 1);
});

test("refuses when the relayer is not the fee payer", async () => {
  const { relayer, trader, T, R } = await setup();
  const wire = await build({ feePayer: T, instructions: [await requestOrderIx(T, R)], signers: [trader] });
  assert.equal((await relayer.sponsor(wire, "c")).code, "fee_payer");
});

test("refuses a system transfer out of the relayer", async () => {
  const { relayer, trader, R, T } = await setup();
  const ix = { programAddress: SYSTEM, accounts: [meta(R, WS), meta(T, W)], data: new Uint8Array([2, 0, 0, 0, 0, 202, 154, 59, 0, 0, 0, 0]) };
  const wire = await build({ feePayer: R, instructions: [await requestOrderIx(T, R), ix], signers: [trader] });
  const out = await relayer.sponsor(wire, "c");
  assert.equal(out.code, "program");
});

test("refuses the relayer as a token transfer authority", async () => {
  const { relayer, trader, R, T } = await setup();
  const [src, dst] = await someAddrs(2);
  const ix = { programAddress: PROGRAMS.token, accounts: [meta(src, W), meta(dst, W), meta(R, WS)], data: new Uint8Array([3, 1, 0, 0, 0, 0, 0, 0, 0]) };
  const wire = await build({ feePayer: R, instructions: [ix, await requestOrderIx(T, T)], signers: [trader] });
  assert.equal((await relayer.sponsor(wire, "c")).code, "relayer_authority");
});

test("refuses the relayer in the owner slot of request_order", async () => {
  const { relayer, R } = await setup();
  const wire = await build({ feePayer: R, instructions: [await requestOrderIx(R, R)], signers: [] });
  assert.equal((await relayer.sponsor(wire, "c")).code, "relayer_position");
});

test("refuses other perps instructions and unknown programs", async () => {
  const { relayer, trader, R, T } = await setup();
  const liq = { programAddress: PROGRAMS.perps, accounts: [meta(T, WS)], data: disc("liquidate") };
  let wire = await build({ feePayer: R, instructions: [liq], signers: [trader] });
  assert.equal((await relayer.sponsor(wire, "c")).code, "perps_instruction");
  const [other] = await someAddrs(1);
  wire = await build({ feePayer: R, instructions: [{ programAddress: other, accounts: [meta(T, WS)], data: new Uint8Array([0]) }], signers: [trader] });
  assert.equal((await relayer.sponsor(wire, "c")).code, "program");
});

test("only CreateIdempotent is sponsored on the ATA program", async () => {
  const { relayer, trader, R, T } = await setup();
  const [ata, mint] = await someAddrs(2);
  const ix = (data) => ({ programAddress: PROGRAMS.ata, accounts: [meta(R, WS), meta(ata, W), meta(T, R), meta(mint, R), meta(SYSTEM, R), meta(PROGRAMS.token, R)], data: new Uint8Array(data) });
  let wire = await build({ feePayer: R, instructions: [ix([0]), await requestOrderIx(T, R)], signers: [trader] });
  assert.equal((await relayer.sponsor(wire, "c")).code, "ata_instruction");
  wire = await build({ feePayer: R, instructions: [ix([1]), await requestOrderIx(T, R)], signers: [trader] });
  assert.equal((await relayer.sponsor(wire, "c")).ok, true);
});

test("refuses when the trading account has not signed", async () => {
  const { relayer, R, T } = await setup();
  const wire = await build({ feePayer: R, instructions: [await requestOrderIx(T, R)], signers: [] });
  assert.equal((await relayer.sponsor(wire, "c")).code, "missing_signature");
});

test("refuses when simulation shows too much spent", async () => {
  const { relayer, trader, R, T, rpc } = await setup({ spend: 10_000_000n });
  const wire = await build({ feePayer: R, instructions: [await requestOrderIx(T, R)], signers: [trader] });
  assert.equal((await relayer.sponsor(wire, "c")).code, "spend_too_high");
  assert.equal(rpc.calls.sent, 0);
});

test("refuses a failing simulation and a high fee", async () => {
  let s = await setup({ simErr: { InstructionError: [0, { Custom: 6005 }] } });
  let wire = await build({ feePayer: s.R, instructions: [await requestOrderIx(s.T, s.R)], signers: [s.trader] });
  assert.equal((await s.relayer.sponsor(wire, "c")).code, "simulation_failed");
  s = await setup({ fee: 1_000_000n });
  wire = await build({ feePayer: s.R, instructions: [await requestOrderIx(s.T, s.R)], signers: [s.trader] });
  assert.equal((await s.relayer.sponsor(wire, "c")).code, "fee_too_high");
});

test("rate-limits one trading account and its daily budget", async () => {
  const { relayer, trader, R, T } = await setup({ spend: 1_000n });
  const wire = await build({ feePayer: R, instructions: [await requestOrderIx(T, R)], signers: [trader] });
  for (let i = 0; i < 20; i++) assert.equal((await relayer.sponsor(wire, `c:${i}`)).ok, true);
  assert.equal((await relayer.sponsor(wire, "c:new")).code, "account_rate");
  const s2 = await setup({ spend: 4_000_000n });
  const w2 = await build({ feePayer: s2.R, instructions: [await requestOrderIx(s2.T, s2.R)], signers: [s2.trader] });
  for (let i = 0; i < 4; i++) assert.equal((await s2.relayer.sponsor(w2, `c:${i}`)).ok, true);
  assert.equal((await s2.relayer.sponsor(w2, "c:x")).code, "account_budget");
});

test("client keys are salted hashes, not IPs", async () => {
  const { relayer } = await setup();
  const k = relayer.clientKey("203.0.113.7");
  assert.ok(k.startsWith("c:") && !k.includes("203"));
  assert.equal(k, relayer.clientKey("203.0.113.7"));
});

test("HTTP server sponsors and refuses", async () => {
  const { relayer, trader, R, T } = await setup();
  const server = createRelayerServer(relayer).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const info = await (await fetch(`${base}/v1/info`)).json();
    assert.equal(info.relayer, R);
    const wire = await build({ feePayer: R, instructions: [await requestOrderIx(T, R)], signers: [trader] });
    let res = await fetch(`${base}/v1/sponsor`, { method: "POST", body: JSON.stringify({ transaction: wire }) });
    assert.equal(res.status, 200);
    assert.match((await res.json()).signature, /^FakeSig/);
    res = await fetch(`${base}/v1/sponsor`, { method: "POST", body: "not json" });
    assert.equal(res.status, 400);
    res = await fetch(`${base}/v1/sponsor`, { method: "POST", body: "x".repeat(20_000) });
    assert.equal(res.status, 413);
  } finally {
    server.close();
  }
});
