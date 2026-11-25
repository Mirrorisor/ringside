// Relayer hardening: shared Redis budgets, fee recovery, screening.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import {
  AccountRole, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, generateKeyPairSigner,
  getBase64EncodedWireTransaction, partiallySignTransaction, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { Relayer, PROGRAMS, amountTo, httpScreen } from "../dist/relayer.js";
import { RespClient, RedisBudget } from "../dist/budget.js";

// --- a tiny in-process Redis stand-in for the commands RedisBudget uses -------
function fakeRedis({ password } = {}) {
  const z = new Map(), kv = new Map();
  const enc = (v) => v === null ? "$-1\r\n" : typeof v === "number" ? `:${v}\r\n` : `$${Buffer.byteLength(v)}\r\n${v}\r\n`;
  const server = createServer((sock) => {
    let authed = !password, buf = Buffer.alloc(0);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const p = RespClient.parse(buf, 0);
        if (!p) return;
        buf = buf.subarray(p[1]);
        const [cmd, ...a] = p[0];
        const C = cmd.toUpperCase();
        if (C === "AUTH") { authed = a.at(-1) === password; sock.write(authed ? "+OK\r\n" : "-WRONGPASS\r\n"); continue; }
        if (!authed) { sock.write("-NOAUTH\r\n"); continue; }
        if (C === "ZADD") { (z.get(a[0]) ?? z.set(a[0], new Map()).get(a[0])).set(a[2], Number(a[1])); sock.write(enc(1)); }
        else if (C === "ZREMRANGEBYSCORE") { const m = z.get(a[0]) ?? new Map(); let n = 0; for (const [k, s] of m) if (s <= Number(a[2])) { m.delete(k); n++; } sock.write(enc(n)); }
        else if (C === "ZCARD") sock.write(enc((z.get(a[0]) ?? new Map()).size));
        else if (C === "INCRBY") { const v = BigInt(kv.get(a[0]) ?? "0") + BigInt(a[1]); kv.set(a[0], String(v)); sock.write(enc(Number(v))); }
        else if (C === "GET") sock.write(enc(kv.get(a[0]) ?? null));
        else if (C === "PEXPIRE") sock.write(enc(1));
        else sock.write(`-ERR unknown ${C}\r\n`);
      }
    });
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, url: `redis://:${password ?? ""}@127.0.0.1:${server.address().port}` })));
}

test("RESP parser handles split and nested replies", () => {
  assert.equal(RespClient.parse(Buffer.from("$5\r\nhel"), 0), null, "incomplete bulk waits");
  assert.deepEqual(RespClient.parse(Buffer.from("$5\r\nhello\r\n"), 0), ["hello", 11]);
  assert.deepEqual(RespClient.parse(Buffer.from("*2\r\n:1\r\n$-1\r\n"), 0)[0], [1, null]);
  assert.ok(RespClient.parse(Buffer.from("-ERR x\r\n"), 0)[0] instanceof Error);
});

test("two relayer instances share one Redis budget", async () => {
  const { server, url } = await fakeRedis({ password: "s3cret" });
  const ca = new RespClient(url), cb = new RespClient(url);
  const a = new RedisBudget(ca), b = new RedisBudget(cb);
  await a.record(["a:X", "global"], 1500n);
  await b.record(["a:X", "global"], 2500n);
  assert.equal(await a.countLastHour("a:X"), 2, "instance A sees B's request");
  assert.equal(await b.spentToday("global"), 4000n);
  assert.equal(await a.spentToday("a:unknown"), 0n);
  ca.close(); cb.close();
  server.close();
});

test("a dropped Redis connection reconnects on the next command", async () => {
  const { server, url } = await fakeRedis();
  const c = new RespClient(url);
  const b = new RedisBudget(c);
  await b.record(["k"], 1n);
  for (const s of [...(server._conns ?? [])]) s.destroy();
  await new Promise((r) => server.getConnections(() => r()));
  // kill the client's socket from the server side
  await new Promise((r) => { server.once("connection", () => {}); r(); });
  c["sock"].destroy();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await b.spentToday("k"), 1n, "reconnected and read the same store");
  c.close();
  server.close();
});

test("a wrong Redis password fails loudly", async () => {
  const { server, url } = await fakeRedis({ password: "right" });
  const client = new RespClient(url.replace(":right@", ":wrong@"));
  const bad = new RedisBudget(client);
  await assert.rejects(() => bad.countLastHour("k"));
  client.close();
  server.close();
});

// --- fee recovery -------------------------------------------------------------
const W = AccountRole.WRITABLE, WS = AccountRole.WRITABLE_SIGNER, RS = AccountRole.READONLY_SIGNER, R = AccountRole.READONLY;
const disc = (n) => new Uint8Array(createHash("sha256").update(`global:${n}`).digest().subarray(0, 8));
const addrs = async (n) => Promise.all(Array.from({ length: n }, async () => (await generateKeyPairSigner()).address));
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return [...b]; };
const transfer = (src, dst, auth, amount) => ({ programAddress: PROGRAMS.token, accounts: [{ address: src, role: W }, { address: dst, role: W }, { address: auth, role: RS }], data: new Uint8Array([3, ...u64(amount)]) });
const transferChecked = (src, mint, dst, auth, amount) => ({ programAddress: PROGRAMS.token, accounts: [{ address: src, role: W }, { address: mint, role: R }, { address: dst, role: W }, { address: auth, role: RS }], data: new Uint8Array([12, ...u64(amount), 6]) });

async function wire(feePayer, instructions, signers) {
  const msg = pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k", lastValidBlockHeight: 100n }, m),
    (m) => appendTransactionMessageInstructions(instructions, m));
  return getBase64EncodedWireTransaction(await partiallySignTransaction(signers.map((s) => s.keyPair), compileTransaction(msg)));
}
const rpc = () => ({
  getBalance: () => ({ send: async () => ({ value: 1_000_000_000n }) }),
  getFeeForMessage: () => ({ send: async () => ({ value: 5_000n }) }),
  simulateTransaction: () => ({ send: async () => ({ value: { err: null, accounts: [{ lamports: 1_000_000_000n - 2_000_000n }], logs: [] } }) }),
  sendTransaction: () => ({ send: async () => "Sig" }),
});

test("amountTo reads Transfer and TransferChecked to the treasury only", async () => {
  const [src, dst, other, auth, mint] = await addrs(5);
  assert.equal(amountTo(transfer(src, dst, auth, 777n), dst), 777n);
  assert.equal(amountTo(transferChecked(src, mint, dst, auth, 555n), dst), 555n);
  assert.equal(amountTo(transfer(src, other, auth, 777n), dst), 0n);
});

test("fee recovery: refuses without the treasury transfer, sponsors with it", async () => {
  const relayerSigner = await generateKeyPairSigner(), trader = await generateKeyPairSigner();
  const [treasury, traderUsdc, rest1] = await addrs(3);
  const relayer = new Relayer(rpc(), relayerSigner, { feeRecovery: { treasury, minAmount: 10_000n } });
  const order = { programAddress: PROGRAMS.perps, accounts: [{ address: trader.address, role: WS }, { address: relayerSigner.address, role: WS }, ...(await addrs(8)).map((a) => ({ address: a, role: W }))], data: new Uint8Array([...disc("request_order"), ...new Uint8Array(41)]) };
  const noFee = await relayer.sponsor(await wire(relayerSigner.address, [order], [trader]), "c1");
  assert.equal(noFee.code, "fee_recovery");
  const short = await relayer.sponsor(await wire(relayerSigner.address, [order, transfer(traderUsdc, treasury, trader.address, 9_999n)], [trader]), "c2");
  assert.equal(short.code, "fee_recovery", "underpaying is refused");
  const paid = await relayer.sponsor(await wire(relayerSigner.address, [order, transfer(traderUsdc, treasury, trader.address, 10_000n)], [trader]), "c3");
  assert.equal(paid.ok, true, paid.code);
  void rest1;
});

// --- screening ----------------------------------------------------------------
test("screening fails closed and caches answers", async () => {
  let calls = 0;
  const ok = httpScreen("https://screen.test", "k", async (_u, init) => { calls++; assert.equal(init.headers.authorization, "Bearer k"); return { ok: true, json: async () => ({ allowed: true }) }; });
  assert.equal(await ok(["A"]), true);
  assert.equal(await ok(["A"]), true);
  assert.equal(calls, 1, "second answer from cache");
  const down = httpScreen("https://screen.test", undefined, async () => { throw new Error("timeout"); });
  assert.equal(await down(["A"]), false, "service down → refuse");
  const weird = httpScreen("https://screen.test", undefined, async () => ({ ok: true, json: async () => ({ allowed: "yes" }) }));
  assert.equal(await weird(["A"]), false, "anything but allowed:true → refuse");
});
