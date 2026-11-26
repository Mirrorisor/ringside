// Jupiter trade layer tests, against a fake fetch. No network.
// Run: npx tsc --outDir dist && node --test test/jupiter.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signatureBytes,
  verifySignature,
} from "@solana/kit";
import { Jupiter, JupiterError, netReferralBps, inspectTransaction, checkAndSign, checkTransaction, associatedTokenAddress, TX_PROGRAMS } from "../dist/trade/jupiter.js";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const KEY = "test-key-not-real";

/** Unsigned v0 tx with `feePayer` paying and every address in `signers` as a required signer. */
function unsignedTx(feePayer, signers = []) {
  const ix = { programAddress: PROGRAM, accounts: signers.map((address) => ({ address, role: AccountRole.READONLY_SIGNER })), data: new Uint8Array([1]) };
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k", lastValidBlockHeight: 100n }, m),
    (m) => appendTransactionMessageInstructions([ix], m),
  );
  return getBase64EncodedWireTransaction(compileTransaction(msg));
}

/** fetch mock: routes keyed "METHOD /path" → (url, init) => [status, body]. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method ?? "GET"} ${u.pathname}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ key, url: u, headers: init.headers ?? {}, body });
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ error: `no route ${key}` }), { status: 404 });
    const [status, out] = await route(u, body, init);
    return new Response(JSON.stringify(out), { status, headers: { "content-type": "application/json" } });
  };
  fn.calls = calls;
  return fn;
}

const signedBy = (wire, a) => getTransactionDecoder().decode(Buffer.from(wire, "base64")).signatures[a] != null;

async function setup(routes, opts = {}) {
  const taker = await generateKeyPairSigner();
  const referral = (await generateKeyPairSigner()).address;
  const f = fakeFetch(typeof routes === "function" ? routes(taker) : routes);
  const jup = new Jupiter({ apiKey: KEY, fetch: f, referralAccount: referral, ...opts });
  return { jup, f, taker, referral };
}

const orderFor = (taker, tx, extra = {}) => ({
  inputMint: SOL, outputMint: USDC, inAmount: "1000000000", outAmount: "150000000", otherAmountThreshold: "149000000",
  slippageBps: 50, router: "metis", transaction: tx, requestId: "req-1", taker, ...extra,
});

// ---------------------------------------------------------------------------

test("netReferralBps keeps 80% and rejects out-of-range fees", () => {
  assert.equal(netReferralBps(50), 40);
  assert.equal(netReferralBps(100), 80);
  assert.equal(netReferralBps(255), 204);
  assert.equal(netReferralBps(51), 40); // 40.8 floored
  for (let b = 50; b <= 255; b++) assert.ok(Number.isInteger(netReferralBps(b)));
  for (const bad of [0, 49, 256, 50.5, NaN]) assert.throws(() => netReferralBps(bad), { code: "referral_fee" });
});

test("getOrder sends the documented query, the api key and the default 50 bps referral fee", async () => {
  const { jup, f, taker, referral } = await setup({ "GET /swap/v2/order": async () => [200, { requestId: "r", transaction: null }] });
  await jup.getOrder({ inputMint: SOL, outputMint: USDC, amount: 1_000_000_000n, taker: taker.address, slippageBps: 75, excludeRouters: ["dflow", "okx"] });
  const { url, headers } = f.calls[0];
  assert.equal(url.origin, "https://api.jup.ag");
  assert.equal(headers["x-api-key"], KEY);
  const q = Object.fromEntries(url.searchParams);
  assert.deepEqual(q, { inputMint: SOL, outputMint: USDC, amount: "1000000000", taker: taker.address, slippageBps: "75", referralAccount: referral, referralFee: "50", excludeRouters: "dflow,okx" });
});

test("getOrder rejects referral fees outside 50–255 before calling Jupiter", async () => {
  const { jup, f } = await setup({});
  for (const referralFeeBps of [49, 256, 10]) {
    await assert.rejects(jup.getOrder({ inputMint: SOL, outputMint: USDC, amount: "1", referralFeeBps }), { code: "referral_fee" });
  }
  assert.throws(() => new Jupiter({ apiKey: KEY, referralFeeBps: 300 }), { code: "referral_fee" });
  await assert.rejects(jup.getOrder({ inputMint: SOL, outputMint: USDC, amount: "1", referralAccount: null, referralFeeBps: 60 }), { code: "referral_account" });
  await assert.rejects(jup.getOrder({ inputMint: SOL, outputMint: SOL, amount: "1" }), { code: "same_mint" });
  await assert.rejects(jup.getOrder({ inputMint: SOL, outputMint: USDC, amount: "0" }), { code: "bad_amount" });
  await assert.rejects(jup.getOrder({ inputMint: "nope", outputMint: USDC, amount: "1" }), { code: "bad_address" });
  assert.equal(f.calls.length, 0);
});

test("referral fee can be set per order or turned off", async () => {
  const { jup, f } = await setup({ "GET /swap/v2/order": async () => [200, { requestId: "r", transaction: null }] });
  await jup.getOrder({ inputMint: SOL, outputMint: USDC, amount: "5", referralFeeBps: 255 });
  assert.equal(f.calls[0].url.searchParams.get("referralFee"), "255");
  await jup.getOrder({ inputMint: SOL, outputMint: USDC, amount: "5", referralAccount: null });
  assert.equal(f.calls[1].url.searchParams.has("referralAccount"), false);
  assert.equal(f.calls[1].url.searchParams.has("referralFee"), false);
});

test("missing API key fails without a request; key never appears in errors", async () => {
  const saved = process.env.JUPITER_API_KEY;
  delete process.env.JUPITER_API_KEY;
  try {
    const f = fakeFetch({});
    await assert.rejects(new Jupiter({ fetch: f }).getPrices([SOL]), { code: "no_api_key" });
    assert.equal(f.calls.length, 0);
  } finally {
    if (saved !== undefined) process.env.JUPITER_API_KEY = saved;
  }
  const { jup } = await setup({ "GET /swap/v2/order": async () => [400, { requestId: "r", error: "Invalid inputMint" }] });
  const err = await jup.getOrder({ inputMint: SOL, outputMint: USDC, amount: "1" }).catch((e) => e);
  assert.ok(err instanceof JupiterError);
  assert.equal(err.status, 400);
  assert.match(err.message, /Invalid inputMint/);
  assert.ok(!JSON.stringify({ m: err.message, d: err.details, c: err.code }).includes(KEY));
});

test("signOrder signs as taker when the taker is the fee payer", async () => {
  const { jup, taker } = await setup({});
  const order = orderFor(taker.address, unsignedTx(taker.address));
  const wire = await jup.signOrder(order, { taker, expect: { inputMint: SOL, outputMint: USDC, amount: 1_000_000_000n } });
  assert.ok(signedBy(wire, taker.address));
  const tx = getTransactionDecoder().decode(Buffer.from(wire, "base64"));
  assert.ok(await verifySignature(taker.keyPair.publicKey, tx.signatures[taker.address], tx.messageBytes));
});

test("signOrder refuses an unexpected fee payer, taker or amount", async () => {
  const { jup, taker } = await setup({});
  const stranger = (await generateKeyPairSigner()).address;
  // Someone else pays but we never asked for a payer.
  await assert.rejects(jup.signOrder(orderFor(taker.address, unsignedTx(stranger, [taker.address])), { taker }), { code: "fee_payer" });
  // The response says it's for another taker.
  await assert.rejects(jup.signOrder(orderFor(stranger, unsignedTx(taker.address)), { taker }), { code: "taker" });
  // Our taker isn't a signer of the transaction at all.
  await assert.rejects(jup.signOrder(orderFor(taker.address, unsignedTx(stranger)), { taker, payer: stranger }), { code: "not_a_signer" });
  // Echo mismatch.
  await assert.rejects(jup.signOrder(orderFor(taker.address, unsignedTx(taker.address)), { taker, expect: { inputMint: SOL, outputMint: USDC, amount: 7n } }), { code: "order_mismatch" });
  // Build failure (200 with empty transaction).
  await assert.rejects(jup.signOrder(orderFor(taker.address, "", { errorCode: 2, errorMessage: "Insufficient SOL" }), { taker }), (e) => e.code === "no_transaction" && /errorCode 2/.test(e.message));
  await assert.rejects(jup.signOrder(orderFor(taker.address, "AAAA"), { taker }), { code: "malformed_tx" });
});

test("gasless: sponsor payer must be the fee payer; we sign only as the taker", async () => {
  const { jup, taker } = await setup({});
  const payer = await generateKeyPairSigner();
  const wire = await jup.signOrder(orderFor(taker.address, unsignedTx(payer.address, [taker.address])), { taker, payer: payer.address });
  assert.ok(signedBy(wire, taker.address) && !signedBy(wire, payer.address)); // the sponsor service co-signs, not us
  // With a payer set, the taker paying is not what we asked for.
  await assert.rejects(jup.signOrder(orderFor(taker.address, unsignedTx(taker.address)), { taker, payer: payer.address }), { code: "fee_payer" });
  // Handing us the sponsor's key is refused outright.
  await assert.rejects(jup.signOrder(orderFor(taker.address, unsignedTx(payer.address, [taker.address])), { taker, payer }), { code: "server_signer" });
});

test("swap() with a sponsor payer returns the taker-signed transaction and does not execute", async () => {
  const payer = (await generateKeyPairSigner()).address;
  const { jup, f, taker } = await setup((t) => ({ "GET /swap/v2/order": async () => [200, orderFor(t.address, unsignedTx(payer, [t.address]))] }));
  const out = await jup.swap({ inputMint: SOL, outputMint: USDC, amount: "1000000000", taker, payer });
  assert.ok(signedBy(out.sponsorTransaction, taker.address) && !signedBy(out.sponsorTransaction, payer));
  assert.equal(out.result, undefined);
  assert.deepEqual(f.calls.map((c) => c.key), ["GET /swap/v2/order"]);
});

test("JupiterZ: an allowlisted market maker may be fee payer", async () => {
  const maker = (await generateKeyPairSigner()).address;
  const { jup, taker } = await setup({}, { jupiterZMakers: [maker] });
  const payer = (await generateKeyPairSigner()).address;
  const tx = unsignedTx(maker, [taker.address]);
  const wire = await jup.signOrder(orderFor(taker.address, tx, { router: "jupiterz", maker }), { taker, payer });
  assert.ok(signedBy(wire, taker.address));
  assert.equal(inspectTransaction(wire).feePayer, maker);
  // The maker exception is only for jupiterz routes.
  await assert.rejects(jup.signOrder(orderFor(taker.address, tx, { router: "metis", maker }), { taker }), { code: "fee_payer" });
});

test("JupiterZ: a maker not on the allowlist is refused", async () => {
  const known = (await generateKeyPairSigner()).address;
  const rogue = (await generateKeyPairSigner()).address;
  for (const opts of [{}, { jupiterZMakers: [known] }]) {
    const { jup, taker } = await setup({}, opts);
    await assert.rejects(jup.signOrder(orderFor(taker.address, unsignedTx(rogue, [taker.address]), { router: "jupiterz", maker: rogue }), { taker }), { code: "maker_not_allowed" });
    await assert.rejects(jup.signOrder(orderFor(taker.address, unsignedTx(taker.address), { router: "jupiterz" }), { taker }), { code: "maker_not_allowed" });
  }
});

test("swap(): order → check → sign → execute", async () => {
  let executed;
  const { jup, f, taker } = await setup((t) => ({
    "GET /swap/v2/order": async () => [200, orderFor(t.address, unsignedTx(t.address))],
    "POST /swap/v2/execute": async (_u, body) => {
      executed = body;
      return [200, { status: "Success", signature: "5ig", slot: "1", code: 0, totalInputAmount: "1000000000", totalOutputAmount: "150000000" }];
    },
  }));
  const { result } = await jup.swap({ inputMint: SOL, outputMint: USDC, amount: "1000000000", taker });
  assert.equal(result.status, "Success");
  assert.equal(executed.requestId, "req-1");
  assert.ok(signedBy(executed.signedTransaction, taker.address));
  assert.equal(f.calls[1].headers["content-type"], "application/json");
  assert.equal(f.calls[1].headers["x-api-key"], KEY);
});

test("execute returns Failed results and throws on HTTP errors", async () => {
  const { jup } = await setup({ "POST /swap/v2/execute": async (_u, b) => (b.requestId === "bad" ? [400, { error: "invalid signed tx", code: -2 }] : [200, { status: "Failed", code: -1005, error: "expired" }]) });
  assert.equal((await jup.execute("AAAA", "ok")).code, -1005);
  await assert.rejects(jup.execute("AAAA", "bad"), (e) => e.status === 400 && e.code === "-2");
  await assert.rejects(jup.execute("", "x"), { code: "bad_param" });
});

// ---------------------------------------------------------------------------
// Tokens and Price

test("searchTokens passes query, joins mints and filters on organic score", async () => {
  const tokens = [{ id: SOL, symbol: "SOL", organicScore: 98 }, { id: USDC, symbol: "USDC", organicScore: 40 }];
  const { jup, f } = await setup({ "GET /tokens/v2/search": async () => [200, tokens] });
  assert.equal((await jup.searchTokens("sol")).length, 2);
  assert.equal(f.calls[0].url.searchParams.get("query"), "sol");
  assert.deepEqual((await jup.searchTokens([SOL, USDC, SOL], { minOrganicScore: 50 })).map((t) => t.id), [SOL]);
  assert.equal(f.calls[1].url.searchParams.get("query"), `${SOL},${USDC}`);
  await assert.rejects(jup.searchTokens(""), { code: "bad_param" });
});

test("getPrices accepts up to 50 mints and returns the keyed map", async () => {
  const { jup, f } = await setup({ "GET /price/v3/": async () => [200, { [SOL]: { usdPrice: 150, blockId: 1, decimals: 9, priceChange24h: 1.2, liquidity: 1e9, createdAt: "2024-01-01T00:00:00Z" } }] });
  const p = await jup.getPrices([SOL, USDC]);
  assert.equal(p[SOL].usdPrice, 150);
  assert.equal(p[USDC], undefined);
  assert.equal(f.calls[0].url.searchParams.get("ids"), `${SOL},${USDC}`);
  const many = await Promise.all(Array.from({ length: 51 }, async () => (await generateKeyPairSigner()).address));
  await assert.rejects(jup.getPrices(many), { code: "bad_param" });
  await jup.getPrices(many.slice(0, 50));
  await assert.rejects(jup.getPrices([]), { code: "bad_param" });
});

// ---------------------------------------------------------------------------
// Trigger V2

function triggerRoutes(wallet, state) {
  state.challenges = 0;
  return {
    "POST /trigger/v2/auth/challenge": async (_u, b) => {
      assert.deepEqual(b, { walletPubkey: wallet.address, type: "message" });
      return [200, { challenge: `sign-me-${++state.challenges}` }];
    },
    "POST /trigger/v2/auth/verify": async (_u, b) => {
      const ok = await verifySignature(wallet.keyPair.publicKey, signatureBytes(new Uint8Array(getBase58Encoder().encode(b.signature))), new TextEncoder().encode(`sign-me-${state.challenges}`));
      assert.ok(ok, "challenge signature must verify");
      assert.equal(b.type, "message");
      return [200, { token: `jwt-${state.challenges}` }];
    },
    "GET /trigger/v2/vault": async () => (state.vault ? [200, { vault: "V" }] : [404, { error: "no vault" }]),
    "GET /trigger/v2/vault/register": async () => ((state.vault = true), [200, { vault: "V" }]),
    "POST /trigger/v2/deposit/craft": async (_u, b) => ((state.craft = b), [200, { requestId: "dep-1", transaction: state.depositTx ?? unsignedTx(state.depositFeePayer ?? wallet.address) }]),
    "POST /trigger/v2/orders/price": async (_u, b) => ((state.created = b), [200, { id: "ord-1", txSignature: "dsig", depositConfirmed: true }]),
    "PATCH /trigger/v2/orders/price/ord-1": async (_u, b) => ((state.patched = b), [200, { id: "ord-1" }]),
    "POST /trigger/v2/orders/price/cancel/ord-1": async () => [200, { id: "ord-1", transaction: unsignedTx(wallet.address), requestId: "can-1" }],
    "POST /trigger/v2/orders/price/confirm-cancel/ord-1": async (_u, b) => ((state.confirmed = b), [200, { id: "ord-1", txSignature: "wsig" }]),
    "POST /trigger/v2/orders/dca": async (_u, b) => ((state.dca = b), [200, { id: "dca-1", txSignature: "dsig" }]),
    "POST /trigger/v2/orders/dca/cancel/dca-1": async () => [200, { id: "dca-1", transaction: unsignedTx(wallet.address), requestId: "can-2" }],
    "POST /trigger/v2/orders/dca/confirm-cancel/dca-1": async (_u, b) => ((state.dcaConfirmed = b), [200, { id: "dca-1", txSignature: "wsig2" }]),
    "GET /trigger/v2/orders/history": async (u, _b, init) => {
      if (state.expireNext) {
        state.expireNext = false;
        return [401, { error: "jwt expired" }];
      }
      state.historyAuth = init.headers.authorization;
      return [200, { orders: [], pagination: { total: 0, limit: Number(u.searchParams.get("limit") ?? 20), offset: 0 } }];
    },
  };
}

async function triggerSetup() {
  const wallet = await generateKeyPairSigner();
  const state = {};
  const f = fakeFetch(triggerRoutes(wallet, state));
  return { jup: new Jupiter({ apiKey: KEY, fetch: f }), f, wallet, state };
}

const future = () => Date.now() + 86_400_000;

test("trigger: auth, vault register, deposit and a single limit order", async () => {
  const { jup, f, wallet, state } = await triggerSetup();
  const out = await jup.trigger.createPriceOrder(wallet, {
    orderType: "single", inputMint: USDC, outputMint: SOL, inputAmount: 50_000_000n, triggerMint: SOL, triggerCondition: "below", triggerPriceUsd: 120, expiresAt: future(),
  });
  assert.equal(out.id, "ord-1");
  assert.deepEqual(state.craft, { inputMint: USDC, outputMint: SOL, userAddress: wallet.address, amount: "50000000", orderType: "price", orderSubType: "single" });
  assert.equal(state.created.depositRequestId, "dep-1");
  assert.ok(signedBy(state.created.depositSignedTx, wallet.address));
  assert.equal(state.created.userPubkey, wallet.address);
  assert.equal(state.created.triggerPriceUsd, 120);
  assert.equal("trailingBps" in state.created, false);
  const order = f.calls.map((c) => c.key);
  assert.deepEqual(order, [
    "POST /trigger/v2/auth/challenge", "POST /trigger/v2/auth/verify", "GET /trigger/v2/vault", "GET /trigger/v2/vault/register",
    "POST /trigger/v2/deposit/craft", "POST /trigger/v2/orders/price",
  ]);
  assert.equal(f.calls.at(-1).headers.authorization, "Bearer jwt-1");
  assert.equal(f.calls.at(-1).headers["x-api-key"], KEY);
});

test("trigger: OCO and OTOCO bodies, and validation before any request", async () => {
  const { jup, f, wallet, state } = await triggerSetup();
  const base = { inputMint: SOL, outputMint: USDC, inputAmount: "1000000000", triggerMint: SOL, expiresAt: future() };
  await jup.trigger.createPriceOrder(wallet, { ...base, orderType: "oco", tpPriceUsd: 200, slPriceUsd: 100, slSlippageBps: 2000 });
  assert.equal(state.craft.orderSubType, "oco");
  assert.deepEqual([state.created.orderType, state.created.tpPriceUsd, state.created.slPriceUsd, state.created.slSlippageBps], ["oco", 200, 100, 2000]);
  await jup.trigger.createPriceOrder(wallet, { ...base, orderType: "otoco", triggerCondition: "below", triggerPriceUsd: 140, tpPriceUsd: 200, slPriceUsd: 100 });
  assert.equal(state.craft.orderSubType, "otoco");
  assert.equal(state.created.triggerCondition, "below");

  const n = f.calls.length;
  await assert.rejects(jup.trigger.createPriceOrder(wallet, { ...base, orderType: "oco", tpPriceUsd: 100, slPriceUsd: 100 }), { code: "bad_param" });
  await assert.rejects(jup.trigger.createPriceOrder(wallet, { ...base, orderType: "single", triggerCondition: "above" }), { code: "bad_param" });
  await assert.rejects(jup.trigger.createPriceOrder(wallet, { ...base, orderType: "single", triggerCondition: "above", triggerPriceUsd: 1, trailingBps: 100 }), { code: "bad_param" });
  await assert.rejects(jup.trigger.createPriceOrder(wallet, { ...base, orderType: "single", triggerCondition: "above", trailingBps: 100 }), /outputMint/); // trailing above must watch outputMint
  await assert.rejects(jup.trigger.createPriceOrder(wallet, { ...base, orderType: "single", triggerCondition: "below", trailingBps: 20 }), { code: "bad_param" });
  await assert.rejects(jup.trigger.createPriceOrder(wallet, { ...base, expiresAt: Date.now() - 1, orderType: "oco", tpPriceUsd: 2, slPriceUsd: 1 }), { code: "bad_param" });
  assert.equal(f.calls.length, n);
});

test("trigger: refuses to sign a deposit someone else pays for", async () => {
  const { jup, wallet, state } = await triggerSetup();
  state.depositFeePayer = (await generateKeyPairSigner()).address;
  await assert.rejects(
    jup.trigger.createPriceOrder(wallet, { orderType: "oco", inputMint: SOL, outputMint: USDC, inputAmount: "1", triggerMint: SOL, tpPriceUsd: 2, slPriceUsd: 1, expiresAt: future() }),
    { code: "fee_payer" },
  );
  assert.equal(state.created, undefined);
});

test("trigger: update, two-step cancel and history with re-auth on 401", async () => {
  const { jup, wallet, state } = await triggerSetup();
  assert.deepEqual(await jup.trigger.updatePriceOrder(wallet, "ord-1", { orderType: "single", triggerPriceUsd: 130 }), { id: "ord-1" });
  assert.deepEqual(state.patched, { orderType: "single", triggerPriceUsd: 130 });
  const c = await jup.trigger.cancelPriceOrder(wallet, "ord-1");
  assert.equal(c.txSignature, "wsig");
  assert.equal(state.confirmed.cancelRequestId, "can-1");
  assert.ok(signedBy(state.confirmed.signedTransaction, wallet.address));
  await assert.rejects(jup.trigger.cancelPriceOrder(wallet, "../vault"), { code: "bad_param" });

  state.expireNext = true;
  const h = await jup.trigger.listPriceOrders(wallet, { state: "active", limit: 5 });
  assert.equal(h.pagination.limit, 5);
  assert.equal(state.historyAuth, "Bearer jwt-2"); // re-authenticated once
  assert.equal(state.challenges, 2);
  await assert.rejects(jup.trigger.listPriceOrders(wallet, { limit: 101 }), { code: "bad_param" });
});

test("trigger: DCA create (time-based and price-conditional), validation and cancel", async () => {
  const { jup, f, wallet, state } = await triggerSetup();
  const base = { inputMint: USDC, outputMint: SOL, inputAmount: 100_000_000n, orderCount: 4, intervalSeconds: 86_400 };
  assert.equal((await jup.trigger.createDcaOrder(wallet, base)).id, "dca-1");
  assert.deepEqual(state.craft, { inputMint: USDC, outputMint: SOL, userAddress: wallet.address, amount: "100000000", orderType: "dca" });
  assert.equal(state.dca.orderType, "time_based");
  assert.equal(state.dca.depositRequestId, "dep-1");
  await jup.trigger.createDcaOrder(wallet, { ...base, orderType: "price_conditional", triggerMint: SOL, minPriceUsd: 100, maxPriceUsd: 150 });
  assert.deepEqual([state.dca.orderType, state.dca.triggerMint, state.dca.minPriceUsd, state.dca.maxPriceUsd], ["price_conditional", SOL, 100, 150]);

  const n = f.calls.length;
  for (const bad of [
    { orderCount: 1 },
    { intervalSeconds: 59 },
    { intervalSeconds: 31_536_001 },
    { orderType: "price_conditional", triggerMint: SOL },
    { orderType: "price_conditional", triggerMint: PROGRAM, minPriceUsd: 1 },
    { minPriceUsd: 1 },
    { orderType: "price_conditional", triggerMint: SOL, jlEnabled: true, jlMint: SOL, minPriceUsd: 1 },
  ]) {
    await assert.rejects(jup.trigger.createDcaOrder(wallet, { ...base, ...bad }), { code: "bad_param" }, JSON.stringify(bad));
  }
  assert.equal(f.calls.length, n);

  const c = await jup.trigger.cancelDcaOrder(wallet, "dca-1");
  assert.equal(c.txSignature, "wsig2");
  assert.equal(state.dcaConfirmed.cancelRequestId, "can-2");
});

// ---------------------------------------------------------------------------
// Transaction policy (review finding H1)

const W = AccountRole.WRITABLE, WS = AccountRole.WRITABLE_SIGNER, R = AccountRole.READONLY, RS = AccountRole.READONLY_SIGNER;
const le = (n, bytes) => { const b = Buffer.alloc(bytes); bytes === 4 ? b.writeUInt32LE(Number(n)) : b.writeBigUInt64LE(BigInt(n)); return [...b]; };
const P = TX_PROGRAMS;
const ixs = {
  transfer: (from, to, l) => ({ programAddress: P.system, accounts: [{ address: from, role: WS }, { address: to, role: W }], data: new Uint8Array([...le(2, 4), ...le(l, 8)]) }),
  createAccount: (from, to, l) => ({ programAddress: P.system, accounts: [{ address: from, role: WS }, { address: to, role: WS }], data: new Uint8Array([...le(0, 4), ...le(l, 8), ...le(0, 8), ...new Uint8Array(32)]) }),
  assign: (who) => ({ programAddress: P.system, accounts: [{ address: who, role: WS }], data: new Uint8Array([...le(1, 4), ...new Uint8Array(32)]) }),
  advanceNonce: (nonce, auth) => ({ programAddress: P.system, accounts: [{ address: nonce, role: W }, { address: "SysvarRecentB1ockHashes11111111111111111111", role: R }, { address: auth, role: RS }], data: new Uint8Array(le(4, 4)) }),
  cuLimit: (n) => ({ programAddress: P.computeBudget, data: new Uint8Array([2, ...le(n, 4)]) }),
  cuPrice: (n) => ({ programAddress: P.computeBudget, data: new Uint8Array([3, ...le(n, 8)]) }),
  approve: (src, delegate, owner) => ({ programAddress: P.token, accounts: [{ address: src, role: W }, { address: delegate, role: R }, { address: owner, role: RS }], data: new Uint8Array([4, ...le(1_000_000, 8)]) }),
  setAuthority: (acct, cur, next) => ({ programAddress: P.token, accounts: [{ address: acct, role: W }, { address: cur, role: RS }], data: new Uint8Array([6, 2, 1, ...getBase58Encoder().encode(next)]) }),
  close: (acct, dest, owner) => ({ programAddress: P.token, accounts: [{ address: acct, role: W }, { address: dest, role: W }, { address: owner, role: RS }], data: new Uint8Array([9]) }),
  tokenTransfer: (src, dest, owner, n) => ({ programAddress: P.token, accounts: [{ address: src, role: W }, { address: dest, role: W }, { address: owner, role: RS }], data: new Uint8Array([3, ...le(n, 8)]) }),
  syncNative: (acct) => ({ programAddress: P.token, accounts: [{ address: acct, role: W }], data: new Uint8Array([17]) }),
  ataCreate: (funder, ata, owner, mint) => ({ programAddress: P.ata, accounts: [{ address: funder, role: WS }, { address: ata, role: W }, { address: owner, role: R }, { address: mint, role: R }, { address: P.system, role: R }, { address: P.token, role: R }], data: new Uint8Array([1]) }),
  jup: (taker) => ({ programAddress: PROGRAM, accounts: [{ address: taker, role: WS }], data: new Uint8Array([1]) }),
};
function txOf(feePayer, list) {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k", lastValidBlockHeight: 100n }, m),
    (m) => appendTransactionMessageInstructions(list, m),
  );
  return getBase64EncodedWireTransaction(compileTransaction(msg));
}
const addrs = async (n) => Promise.all(Array.from({ length: n }, async () => (await generateKeyPairSigner()).address));

test("H1: the reviewer's 50 SOL payer drain is refused and nothing is signed", async () => {
  const payer = await generateKeyPairSigner(); const taker = await generateKeyPairSigner(); const [attacker] = await addrs(1);
  const wire = txOf(payer.address, [ixs.transfer(payer.address, attacker, 50_000_000_000n), ixs.transfer(taker.address, attacker, 1)]);
  // The reviewer's exact call (server key in `signers`) is refused before anything else.
  await assert.rejects(checkAndSign(wire, { feePayers: [payer.address], mustSign: [taker.address], signers: [taker, payer] }), { code: "server_signer" });
  // Signing as the user only: the transfer out of the payer is still refused.
  await assert.rejects(checkAndSign(wire, { user: taker, feePayers: [payer.address] }), { code: "foreign_transfer" });
  // Through the client with a sponsor payer.
  let signed = false;
  const spy = { address: taker.address, signTransactions: async (t) => ((signed = true), taker.signTransactions(t)) };
  const { jup } = await setup({});
  await assert.rejects(jup.signOrder(orderFor(taker.address, wire), { taker: spy, payer: payer.address }), { code: "foreign_transfer" });
  assert.equal(signed, false);
});

test("H1: an extra System transfer of the user's SOL is refused", async () => {
  const { jup, taker } = await setup({});
  const [stranger] = await addrs(1);
  const wire = txOf(taker.address, [ixs.jup(taker.address), ixs.transfer(taker.address, stranger, 1)]);
  await assert.rejects(jup.signOrder(orderFor(taker.address, wire), { taker }), { code: "user_transfer" });
});

test("H1: Token Approve / SetAuthority / CloseAccount to a stranger are refused", async () => {
  const { jup, taker } = await setup({});
  const [stranger, acct] = await addrs(2);
  const cases = [
    [ixs.approve(acct, stranger, taker.address), "token_approve"],
    [ixs.setAuthority(acct, taker.address, stranger), "token_set_authority"],
    [ixs.close(acct, stranger, taker.address), "token_close"],
    [ixs.tokenTransfer(acct, stranger, taker.address, 5), "token_transfer"],
  ];
  for (const [ix, code] of cases) {
    await assert.rejects(jup.signOrder(orderFor(taker.address, txOf(taker.address, [ixs.jup(taker.address), ix])), { taker }), { code }, code);
  }
});

test("H1: priority fee over the cap is refused; the cap is configurable", async () => {
  const { jup, taker } = await setup({});
  // 1.4M CU at 10 lamports/CU = 14M lamports, over the 5M default.
  const wire = txOf(taker.address, [ixs.cuLimit(1_400_000), ixs.cuPrice(10_000_000), ixs.jup(taker.address)]);
  await assert.rejects(jup.signOrder(orderFor(taker.address, wire), { taker }), { code: "priority_fee_too_high" });
  const loose = (await setup({}, { txPolicy: { maxPriorityFeeLamports: 20_000_000n } })).jup;
  assert.ok(signedBy(await loose.signOrder(orderFor(taker.address, wire), { taker }), taker.address));
});

test("H1: unknown programs, Assign, AdvanceNonce and rent over the cap are refused", async () => {
  const { jup, taker } = await setup({});
  const [stranger, nonce, fresh] = await addrs(3);
  const cases = [
    [{ programAddress: stranger, accounts: [{ address: taker.address, role: WS }], data: new Uint8Array([0]) }, "program_not_allowed"],
    [ixs.assign(taker.address), "system_assign"],
    [ixs.advanceNonce(nonce, taker.address), "system_nonce"],
    [ixs.createAccount(taker.address, fresh, 1_000_000_000n), "rent_too_high"],
  ];
  for (const [ix, code] of cases) {
    await assert.rejects(jup.signOrder(orderFor(taker.address, txOf(taker.address, [ix, ixs.jup(taker.address)])), { taker }), { code }, code);
  }
});

test("H1: a normal SOL→token swap shape passes", async () => {
  const { jup, taker } = await setup({});
  const wsol = await associatedTokenAddress(taker.address, SOL);
  const usdcAta = await associatedTokenAddress(taker.address, USDC);
  const wire = txOf(taker.address, [
    ixs.cuLimit(400_000), ixs.cuPrice(100_000),
    ixs.ataCreate(taker.address, wsol, taker.address, SOL), ixs.ataCreate(taker.address, usdcAta, taker.address, USDC),
    ixs.transfer(taker.address, wsol, 1_000_000_000n), ixs.syncNative(wsol),
    ixs.jup(taker.address),
    ixs.close(wsol, taker.address, taker.address),
  ]);
  const c = await checkTransaction(wire, { user: taker.address, feePayers: [taker.address] });
  assert.equal(c.priorityFeeLamports, 40_000n);
  assert.equal(c.rentLamports, 4_078_560n);
  assert.ok(signedBy(await jup.signOrder(orderFor(taker.address, wire), { taker }), taker.address));
});

test("H1: Trigger deposits may move at most the amount, and only into the vault", async () => {
  const wallet = await generateKeyPairSigner();
  const state = {};
  const [vault, stranger, src] = await addrs(3);
  const vaultAta = await associatedTokenAddress(vault, USDC);
  // Serve a real vault pubkey.
  const routes = triggerRoutes(wallet, state);
  routes["GET /trigger/v2/vault"] = async () => [200, { userPubkey: wallet.address, vaultPubkey: vault }];
  const jup2 = new Jupiter({ apiKey: KEY, fetch: fakeFetch(routes) });
  const order = { orderType: "oco", inputMint: USDC, outputMint: SOL, inputAmount: "50", triggerMint: SOL, tpPriceUsd: 2, slPriceUsd: 1, expiresAt: future() };
  for (const [ixList, code] of [
    [[ixs.tokenTransfer(src, vaultAta, wallet.address, 50)], null],
    [[ixs.tokenTransfer(src, vaultAta, wallet.address, 51)], "outflow_too_high"],
    [[ixs.tokenTransfer(src, stranger, wallet.address, 50)], "token_transfer"],
  ]) {
    state.depositTx = txOf(wallet.address, ixList);
    const p = jup2.trigger.createPriceOrder(wallet, order);
    if (code) await assert.rejects(p, { code }); else assert.equal((await p).id, "ord-1");
  }
});

test("baseUrl is pinned to api.jup.ag unless opted out, and must be https", async () => {
  assert.throws(() => new Jupiter({ apiKey: KEY, baseUrl: "https://evil.example" }), { code: "custom_base_url" });
  assert.throws(() => new Jupiter({ apiKey: KEY, baseUrl: "https://api.jup.ag.evil.example" }), { code: "custom_base_url" });
  assert.throws(() => new Jupiter({ apiKey: KEY, baseUrl: "http://api.jup.ag" }), { code: "insecure_base_url" });
  assert.throws(() => new Jupiter({ apiKey: KEY, baseUrl: "http://localhost:8080", allowCustomBaseUrl: true }), { code: "insecure_base_url" });
  assert.throws(() => new Jupiter({ apiKey: KEY, baseUrl: "not a url", allowCustomBaseUrl: true }), { code: "insecure_base_url" });
  new Jupiter({ apiKey: KEY, baseUrl: "https://api.jup.ag/" });
  const f = fakeFetch({ "GET /price/v3/": async () => [200, {}] });
  await new Jupiter({ apiKey: KEY, fetch: f, baseUrl: "https://jup-proxy.example", allowCustomBaseUrl: true }).getPrices([SOL]);
  assert.equal(f.calls[0].url.origin, "https://jup-proxy.example");
});
