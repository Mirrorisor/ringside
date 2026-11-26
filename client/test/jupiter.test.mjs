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

// ---------------------------------------------------------------------------
// /swap/v2/build with a platform fee
// ---------------------------------------------------------------------------
import { parseFeeAccounts, checkPlatformFee, instructionsOf } from "../dist/trade/jupiter.js";

const DISC = { route: [229, 23, 203, 151, 122, 227, 173, 42], shared: [193, 32, 155, 51, 65, 214, 156, 129], ledger: [150, 86, 71, 116, 167, 93, 14, 104] };
const FEE_SLOT = { route: 6, shared: 9, ledger: 6 };
const b64 = (a) => Buffer.from(a).toString("base64");
const BH = { blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k", lastValidBlockHeight: 777n };
const ixJson = (programId, accounts, data) => ({ programId, accounts, data: b64(data) });
const acct = (pubkey, isWritable = true, isSigner = false) => ({ pubkey, isWritable, isSigner });

/** A Jupiter swap instruction in the route / sharedAccountsRoute layout; `feeSlot` fills the platformFeeAccount position (null = the program id = None). */
function swapJson(taker, filler, feeSlot, kind = "shared") {
  const accounts = Array.from({ length: 13 }, (_, i) => acct(filler, true, false));
  accounts[kind === "shared" ? 2 : 1] = acct(taker, false, true);
  accounts[FEE_SLOT[kind]] = acct(feeSlot ?? PROGRAM, feeSlot !== null, false);
  return ixJson(PROGRAM, accounts, [...DISC[kind], 0, 0, 0, 0]);
}
/** A routeV2 swap instruction as /swap/v2/build returns it (layout verified against build-live.json). `o` overrides what a tampered response would change. */
async function routeV2Json(req, taker, filler, feeSlot, o = {}) {
  const ata = (m) => associatedTokenAddress(taker, m, TX_PROGRAMS.token);
  const bps = o.bps ?? (req.platformFeeBps !== undefined ? Number(req.platformFeeBps) : feeSlot ? 50 : 0);
  const data = Buffer.alloc(40);
  Buffer.from("bb64facc31c4af14", "hex").copy(data);
  data.writeBigUInt64LE(o.inAmount ?? BigInt(req.amount), 8);
  data.writeBigUInt64LE(o.quotedOut ?? 150_000_000n, 16);
  data.writeUInt16LE(o.slippage ?? Number(req.slippageBps ?? 50), 24);
  data.writeUInt16LE(bps, 26);
  const accounts = [
    acct(taker, false, true), acct(await ata(req.inputMint)), acct(o.destination ?? await ata(req.outputMint)), acct(req.inputMint, false), acct(req.outputMint, false),
    acct(TX_PROGRAMS.token, false), acct(TX_PROGRAMS.token, false), acct(o.slot7 ?? PROGRAM, false), acct(filler, false), acct(PROGRAM, false),
    acct(feeSlot ?? filler, feeSlot !== null),
  ];
  return ixJson(PROGRAM, accounts, data);
}
const thresholdFor = (req) => String((150_000_000n * BigInt(10_000 - Number(req.slippageBps ?? 50)) + 9_999n) / 10_000n);
const priceIx = ixJson(TX_PROGRAMS.computeBudget, [], [3, 100, 0, 0, 0, 0, 0, 0, 0]);

function buildBody(req, swap, extra = {}) {
  return {
    inputMint: req.inputMint, outputMint: req.outputMint, inAmount: req.amount, outAmount: "150000000", otherAmountThreshold: thresholdFor(req),
    swapMode: "ExactIn", slippageBps: Number(req.slippageBps ?? 50), priceImpactPct: "0.001", routePlan: [],
    computeBudgetInstructions: [priceIx], setupInstructions: [], swapInstruction: swap, cleanupInstruction: null, otherInstructions: [],
    tipInstruction: null, addressesByLookupTableAddress: {}, transactionVersion: 0, ...extra,
  };
}

async function buildSetup(feeAccounts, { respond, ...opts } = {}) {
  const [taker, sponsor, feeSol, feeUsdc, attacker, filler] = await Promise.all(Array.from({ length: 6 }, () => generateKeyPairSigner()));
  const accounts = feeAccounts === undefined ? { [SOL]: feeSol.address, [USDC]: feeUsdc.address } : feeAccounts(feeSol.address, feeUsdc.address);
  const q = {};
  const f = fakeFetch({
    "GET /swap/v2/build": async (u) => {
      const req = Object.fromEntries(u.searchParams);
      q.last = req;
      const o = {};
      const slot = respond ? respond(req, { attacker: attacker.address, feeSol: feeSol.address, feeUsdc: feeUsdc.address, o }) : (req.feeAccount ?? null);
      return [200, buildBody(req, await routeV2Json(req, taker.address, filler.address, slot, o))];
    },
  });
  const jup = new Jupiter({ apiKey: KEY, fetch: f, feeAccounts: accounts, latestBlockhash: async () => BH, ...opts });
  return { jup, f, q, taker: taker.address, sponsor: sponsor.address, feeSol: feeSol.address, feeUsdc: feeUsdc.address, attacker: attacker.address, filler: filler.address };
}

test("buildSwap: query, response mapping and an unsigned v0 transaction with our fee payer and blockhash", async () => {
  const c = await buildSetup();
  const out = await c.jup.buildSwap({ inputMint: SOL, outputMint: USDC, amount: 1_000_000_000n, taker: c.taker, payer: c.sponsor, slippageBps: 100 });
  assert.equal(c.f.calls.length, 1);
  assert.equal(c.f.calls[0].key, "GET /swap/v2/build");
  assert.equal(c.f.calls[0].headers["x-api-key"], KEY);
  assert.deepEqual(c.q.last, { inputMint: SOL, outputMint: USDC, amount: "1000000000", taker: c.taker, slippageBps: "100", payer: c.sponsor, platformFeeBps: "50", feeAccount: c.feeSol, transactionVersion: "0" });
  assert.equal(out.outAmount, "150000000");
  assert.equal(out.otherAmountThreshold, "148500000"); // from the instruction: 150000000 less 100 bps
  assert.equal(out.slippageBps, 100);
  assert.deepEqual(out.platformFee, { feeBps: 50, feeAccount: c.feeSol, feeMint: SOL });
  assert.equal(out.feeLamports, 5_000_000); // wSOL side 1 SOL x 50 bps
  assert.equal(out.lastValidBlockHeight, 777n);
  const ins = inspectTransaction(out.transaction);
  assert.equal(ins.version, 0);
  assert.equal(ins.feePayer, c.sponsor);
  assert.ok(ins.requiredSigners.includes(c.taker));
  assert.equal(signedBy(out.transaction, c.taker), false); // unsigned: signature slots are empty
  const { ixs } = instructionsOf(out.transaction);
  assert.equal(ixs.map((i) => i.program).join(), [TX_PROGRAMS.computeBudget, PROGRAM].join());
  // the taker pays when there is no sponsor, and no payer param is sent
  const o2 = await c.jup.buildSwap({ inputMint: SOL, outputMint: USDC, amount: "1000000000", taker: c.taker });
  assert.equal(inspectTransaction(o2.transaction).feePayer, c.taker);
  assert.equal(c.q.last.payer, undefined);
});

test("buildSwap: fee account selection prefers the output mint, falls back to the input mint, per-request override works", async () => {
  let c = await buildSetup();
  let o = await c.jup.buildSwap({ inputMint: USDC, outputMint: SOL, amount: 5_000_000, taker: c.taker });
  assert.equal(o.platformFee.feeAccount, c.feeSol); // output wSOL first
  assert.equal(o.feeLamports, Math.floor(150_000_000 * 50 / 10_000)); // wSOL side is the quoted output
  c = await buildSetup((_s, u) => ({ [USDC]: u })); // only USDC configured
  o = await c.jup.buildSwap({ inputMint: SOL, outputMint: "AbYGhAcF86iLQpQQynmZPZAyMejskVFowy2P2LBktuaH", amount: 1000, taker: c.taker });
  assert.equal(o.platformFee, null); // pair has neither wSOL nor USDC configured
  o = await c.jup.buildSwap({ inputMint: USDC, outputMint: "AbYGhAcF86iLQpQQynmZPZAyMejskVFowy2P2LBktuaH", amount: 1000, taker: c.taker, platformFeeBps: 100 });
  assert.equal(o.platformFee.feeAccount, c.feeUsdc); // input-mint fallback
  assert.equal(c.q.last.platformFeeBps, "100");
  assert.equal(o.feeLamports, 0); // no wSOL in the pair
});

test("buildSwap: no fee account for either pair mint builds with no platform fee and feeLamports 0", async () => {
  const c = await buildSetup(() => ({}));
  const o = await c.jup.buildSwap({ inputMint: SOL, outputMint: USDC, amount: 1_000_000_000n, taker: c.taker });
  assert.equal(o.platformFee, null);
  assert.equal(o.feeLamports, 0);
  assert.equal(c.q.last.platformFeeBps, undefined);
  assert.equal(c.q.last.feeAccount, undefined);
  // fee 0 bps is the same: nothing is sent
  const d = await buildSetup();
  const z = await d.jup.buildSwap({ inputMint: SOL, outputMint: USDC, amount: 1000, taker: d.taker, platformFeeBps: 0 });
  assert.equal(z.platformFee, null);
  assert.equal(d.q.last.feeAccount, undefined);
});

test("buildSwap: platform fee must be an integer 0 to 255; default is 50", async () => {
  const c = await buildSetup();
  for (const bad of [-1, 256, 50.5, NaN]) {
    await assert.rejects(c.jup.buildSwap({ inputMint: SOL, outputMint: USDC, amount: 1000, taker: c.taker, platformFeeBps: bad }), { code: "platform_fee" });
    assert.throws(() => new Jupiter({ apiKey: KEY, platformFeeBps: bad }), { code: "platform_fee" });
  }
  assert.equal(c.f.calls.length, 0);
  await c.jup.buildSwap({ inputMint: SOL, outputMint: USDC, amount: 1000, taker: c.taker, platformFeeBps: 255 });
  assert.equal(c.q.last.platformFeeBps, "255");
  await c.jup.buildSwap({ inputMint: SOL, outputMint: USDC, amount: 1000, taker: c.taker });
  assert.equal(c.q.last.platformFeeBps, "50");
});

test("buildSwap: refuses a response that routes the fee anywhere but our configured account", async () => {
  const run = async (respond, opts = {}) => {
    const c = await buildSetup(opts.accounts, { respond });
    return { c, p: c.jup.buildSwap({ inputMint: SOL, outputMint: USDC, amount: 1000, taker: c.taker }) };
  };
  // fee slot holds the attacker's account instead of ours
  let { p } = await run((_q, a) => a.attacker);
  await assert.rejects(p, { code: "fee_account_mismatch" });
  // fee slot holds our USDC account while we asked for the wSOL one
  ({ p } = await run((_q, a) => a.feeUsdc));
  await assert.rejects(p, { code: "fee_account_mismatch" });
  // fee requested but the response drops the fee (slot empty)
  ({ p } = await run(() => null));
  await assert.rejects(p, { code: "fee_account_mismatch" });
  // no fee requested (no account configured) but the response takes one anyway
  ({ p } = await run((_q, a) => a.attacker, { accounts: () => ({}) }));
  await assert.rejects(p, { code: "fee_account_mismatch" });
  // an instruction layout we cannot read is refused, not trusted
  const c = await buildSetup(undefined, {});
  const bad = swapJson(c.taker, c.filler, c.feeUsdc, "ledger");
  assert.throws(() => checkPlatformFee([{ program: PROGRAM, accounts: bad.accounts.map((a) => a.pubkey), data: Buffer.from(bad.data, "base64") }], { expected: c.feeUsdc }), { code: "fee_account_unverified" });
  // both layouts we do read accept our account
  for (const kind of ["route", "shared"]) {
    const s = swapJson(c.taker, c.filler, c.feeUsdc, kind);
    checkPlatformFee([{ program: PROGRAM, accounts: s.accounts.map((a) => a.pubkey), data: Buffer.from(s.data, "base64") }], { expected: c.feeUsdc });
  }
});

test("buildSwap: other Jupiter responses are refused before anything reaches the user", async () => {
  const mk = (patch) => async () => {
    const [taker, filler, feeAcc, thief] = await Promise.all(Array.from({ length: 4 }, () => generateKeyPairSigner()));
    const f = fakeFetch({ "GET /swap/v2/build": (u) => { const req = Object.fromEntries(u.searchParams); return [200, buildBody(req, swapJson(taker.address, filler.address, feeAcc.address), patch(req, { thief: thief.address, taker: taker.address })) ]; } });
    const jup = new Jupiter({ apiKey: KEY, fetch: f, feeAccounts: { [USDC]: feeAcc.address }, latestBlockhash: async () => BH });
    return jup.buildSwap({ inputMint: SOL, outputMint: USDC, amount: 1000, taker: taker.address });
  };
  await assert.rejects(mk(() => ({ outputMint: SOL }))(), { code: "order_mismatch" });
  await assert.rejects(mk(() => ({ inAmount: "999" }))(), { code: "order_mismatch" });
  await assert.rejects(mk(() => ({ transactionVersion: 1 }))(), { code: "bad_response" });
  await assert.rejects(mk(() => ({ outAmount: "-5" }))(), { code: "bad_response" });
  await assert.rejects(mk((_r, a) => ({ tipInstruction: ixJson(TX_PROGRAMS.system, [acct(a.taker, true, true), acct(a.thief)], Buffer.concat([Buffer.from([2, 0, 0, 0]), Buffer.alloc(8, 1)])) }))(), { code: "unexpected_tip" });
  // a System transfer of the taker's SOL to a stranger, slipped into otherInstructions
  const drain = (_r, a) => ({ otherInstructions: [ixJson(TX_PROGRAMS.system, [acct(a.taker, true, true), acct(a.thief)], Buffer.concat([Buffer.from([2, 0, 0, 0]), Buffer.from([0, 202, 154, 59, 0, 0, 0, 0])]))] });
  await assert.rejects(mk(drain)(), { code: "user_transfer" });
  // a program that is not allowlisted
  await assert.rejects(mk((_r, a) => ({ otherInstructions: [ixJson(a.thief, [], [1])] }))(), { code: "program_not_allowed" });
  // lookup tables with no port of ours: not taken on the response's word
  await assert.rejects(mk(() => ({ addressesByLookupTableAddress: { [SOL]: [USDC] } }))(), { code: "no_lookup_tables" });
});

test("parseFeeAccounts reads JSON or mint:account lists and validates addresses", () => {
  const A = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  assert.deepEqual(parseFeeAccounts(undefined), {});
  assert.deepEqual(parseFeeAccounts(""), {});
  assert.deepEqual(parseFeeAccounts(JSON.stringify({ [SOL]: A })), { [SOL]: A });
  assert.deepEqual(parseFeeAccounts(`${SOL}:${A}, ${USDC}:${A}`), { [SOL]: A, [USDC]: A });
  for (const bad of ["{nope", "[]", `${SOL}`, `${SOL}:x`, `${SOL}:${A}:extra`]) assert.throws(() => parseFeeAccounts(bad), (e) => e instanceof JupiterError && ["fee_accounts", "bad_address"].includes(e.code));
});

test("routeV2 from live /build responses: fee slot read from the data, our account accepted, others refused", async () => {
  const { readFileSync } = await import("node:fs");
  const live = JSON.parse(readFileSync(new URL("./fixtures/jupiter/build-live.json", import.meta.url), "utf8")).cases;
  const ix = (c) => [{ program: c.swapInstruction.programId, accounts: c.swapInstruction.accounts.map((a) => a.pubkey), data: Buffer.from(c.swapInstruction.data, "base64") }];
  const FEE_USDC = "8iHT9Q9BH3vvhrJHE8pK7tpWueueJokBEw8Kb6F2rZNK", FEE_WSOL = "BhPk4nEvu26LFouQpr9Q391JJrxxxJWhrBkZy9xxhr7Q";
  checkPlatformFee(ix(live.sol_to_usdc_fee_usdc), { expected: FEE_USDC });
  checkPlatformFee(ix(live.sol_to_usdc_fee_wsol), { expected: FEE_WSOL });
  checkPlatformFee(ix(live.usdc_to_sol_fee_wsol), { expected: FEE_WSOL });
  checkPlatformFee(ix(live.sol_to_usdc_no_fee), { expected: null });
  checkPlatformFee(ix(live.sol_to_usdc_fee_wsol), { ours: [FEE_USDC, FEE_WSOL] });
  // Someone else's fee account, or a fee where none was asked for, or none where one was.
  assert.throws(() => checkPlatformFee(ix(live.sol_to_usdc_fee_usdc), { expected: FEE_WSOL }), { code: "fee_account_mismatch" });
  assert.throws(() => checkPlatformFee(ix(live.sol_to_usdc_fee_usdc), { expected: null }), { code: "fee_account_mismatch" });
  assert.throws(() => checkPlatformFee(ix(live.sol_to_usdc_no_fee), { expected: FEE_USDC }), { code: "fee_account_mismatch" });
  assert.throws(() => checkPlatformFee(ix(live.sol_to_usdc_fee_usdc), { ours: [FEE_WSOL] }), { code: "fee_account_mismatch" });
  // A tampered response that keeps the fee bps but swaps the account at slot 10.
  const t = structuredClone(live.sol_to_usdc_fee_usdc);
  t.swapInstruction.accounts[10].pubkey = "9iFER3bpjf1PTTCQCfTRu17EJgvsxo9pVyA9QWwEuX4x";
  assert.throws(() => checkPlatformFee(ix(t), { expected: FEE_USDC }), { code: "fee_account_mismatch" });
  // Net of fee: the fee quote returns less than the no-fee quote.
  assert.ok(BigInt(live.sol_to_usdc_fee_wsol.outAmount) < BigInt(live.sol_to_usdc_no_fee.outAmount));
});

test("fee account choice prefers wrapped SOL when either side is SOL", () => {
  const j = new Jupiter({ feeAccounts: { So11111111111111111111111111111111111111112: "BhPk4nEvu26LFouQpr9Q391JJrxxxJWhrBkZy9xxhr7Q", EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "8iHT9Q9BH3vvhrJHE8pK7tpWueueJokBEw8Kb6F2rZNK" } });
  assert.equal(j.pickFeeAccount("So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").feeAccount, "BhPk4nEvu26LFouQpr9Q391JJrxxxJWhrBkZy9xxhr7Q");
  assert.equal(j.pickFeeAccount("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "So11111111111111111111111111111111111111112").feeAccount, "BhPk4nEvu26LFouQpr9Q391JJrxxxJWhrBkZy9xxhr7Q");
});

// ---- checkSwapIntent: the swap instruction must be the swap we show ---------------------------

import { checkSwapIntent, checkMeteoraSwap } from "../dist/trade/jupiter.js";

test("buildSwap: a tampered routeV2 (output to the attacker, in_amount, slippage, fee bps) is refused; the honest one passes", async () => {
  const run = (respond, req = {}) => buildSetup(undefined, { respond }).then((c) => ({ c, p: c.jup.buildSwap({ inputMint: SOL, outputMint: USDC, amount: 10_000_000n, taker: c.taker, slippageBps: 50, ...req }) }));
  const bad = async (tamper, code) => { const { p } = await run((q, a) => { tamper(a); return q.feeAccount ?? null; }); await assert.rejects(p, { code }); };
  const ok = await run((q) => q.feeAccount ?? null);
  const out = await ok.p;
  assert.equal(out.otherAmountThreshold, "149250000");
  await bad((a) => { a.o.destination = a.attacker; }, "swap_destination");
  await bad((a) => { a.o.slot7 = a.attacker; }, "swap_destination");
  await bad((a) => { a.o.inAmount = 10_000_000_000n; }, "swap_amount_mismatch");
  await bad((a) => { a.o.quotedOut = 1n; a.o.slippage = 10_000; }, "swap_slippage"); // the reviewer's PoC
  await bad((a) => { a.o.slippage = 10_000; }, "swap_slippage");
  await bad((a) => { a.o.quotedOut = 1n; }, "swap_slippage");
  await bad((a) => { a.o.bps = 255; }, "swap_fee_bps");
  await bad((a) => { a.o.bps = 0; }, "fee_account_mismatch"); // fee dropped: refused by the fee check first
});

test("checkSwapIntent: live routeV2 fixtures pass; tampered copies and unknown layouts are refused", async () => {
  const { readFileSync } = await import("node:fs");
  const live = JSON.parse(readFileSync(new URL("./fixtures/jupiter/build-live.json", import.meta.url), "utf8")).cases;
  const TAKER = "Gh4sC2HFUH8ZvAuxRcoAtiz5QEQzq1yBra7haXMDPkrZ";
  const ix = (c, patch) => { const x = structuredClone(c.swapInstruction); patch?.(x); return [{ program: x.programId, accounts: x.accounts.map((a) => a.pubkey), data: Buffer.from(x.data, "base64") }]; };
  const exp = (c, inMint, outMint, amt, fee) => ({ taker: TAKER, inputMint: inMint, outputMint: outMint, amount: amt, minOut: c.otherAmountThreshold, maxSlippageBps: 100, platformFeeBps: fee });
  for (const [k, i, o, amt, fee] of [["sol_to_usdc_fee_usdc", SOL, USDC, "10000000", 50], ["sol_to_usdc_fee_wsol", SOL, USDC, "10000000", 50], ["sol_to_usdc_no_fee", SOL, USDC, "10000000", 0], ["usdc_to_sol_fee_wsol", USDC, SOL, "1000000", 50]]) {
    const d = await checkSwapIntent(ix(live[k]), exp(live[k], i, o, amt, fee));
    assert.equal(d.quotedOut.toString(), live[k].outAmount);
    assert.equal(d.minOut.toString(), live[k].otherAmountThreshold);
  }
  const c = live.sol_to_usdc_fee_wsol, e = exp(c, SOL, USDC, "10000000", 50);
  const thief = "9iFER3bpjf1PTTCQCfTRu17EJgvsxo9pVyA9QWwEuX4x";
  await assert.rejects(checkSwapIntent(ix(c, (x) => { x.accounts[2].pubkey = thief; }), e), { code: "swap_destination" });
  await assert.rejects(checkSwapIntent(ix(c, (x) => { x.accounts[7].pubkey = thief; }), e), { code: "swap_destination" });
  await assert.rejects(checkSwapIntent(ix(c, (x) => { x.accounts[0].pubkey = thief; }), e), { code: "swap_destination" });
  await assert.rejects(checkSwapIntent(ix(c, (x) => { x.accounts[4].pubkey = SOL; }), e), { code: "swap_mint" });
  await assert.rejects(checkSwapIntent(ix(c), { ...e, platformFeeBps: 0 }), { code: "swap_fee_bps" });
  await assert.rejects(checkSwapIntent(ix(c), { ...e, amount: "9999999" }), { code: "swap_amount_mismatch" });
  await assert.rejects(checkSwapIntent(ix(c), { ...e, maxSlippageBps: 99 }), { code: "swap_slippage" });
  await assert.rejects(checkSwapIntent(ix(c), { ...e, minOut: "707575" }), { code: "swap_slippage" });
  await assert.rejects(checkSwapIntent(ix(c, (x) => { x.data = Buffer.from([229, 23, 203, 151, 122, 227, 173, 42, 0, 0, 0, 0]).toString("base64"); }), e), { code: "swap_unverified" });
  await assert.rejects(checkSwapIntent([...ix(c), ...ix(c)], e), { code: "swap_unverified" });
});

test("checkMeteoraSwap: output to the user's own account passes; a stranger's account or referral is refused", async () => {
  const [user, thief, filler] = ["99cnRnduE5KdqhuJmYN5YH3WcnSiPQ152bF3hbxSfvKU", "s7KMacZHd83q5bUtXhVkPPwRsxut1ipy93wfxmWpnn8", "8y5FVi7aTTSjwvLQkXFyRojbDrL8w9svysX8mZcEgmyK"];
  const MINT = "AbYGhAcF86iLQpQQynmZPZAyMejskVFowy2P2LBktuaH", DBC = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
  const tok = TX_PROGRAMS.token;
  const [baseAta, wsolAta] = [await associatedTokenAddress(user, MINT, tok), await associatedTokenAddress(user, SOL, tok)];
  const mk = (o = {}) => [{ program: DBC, data: Buffer.concat([Buffer.from("414b3f4ceb5b5b88", "hex"), Buffer.alloc(17)]),
    accounts: [filler, filler, filler, o.input ?? wsolAta, o.output ?? baseAta, filler, filler, MINT, SOL, user, tok, tok, o.referral ?? DBC, filler, DBC] }];
  await checkMeteoraSwap(mk(), { user, mint: MINT });
  await checkMeteoraSwap(mk({ input: baseAta, output: wsolAta }), { user, mint: MINT }); // a sell
  await assert.rejects(checkMeteoraSwap(mk({ output: await associatedTokenAddress(thief, MINT, tok) }), { user, mint: MINT }), { code: "swap_destination" });
  await assert.rejects(checkMeteoraSwap(mk({ output: await associatedTokenAddress(thief, SOL, tok), input: baseAta }), { user, mint: MINT }), { code: "swap_destination" });
  await assert.rejects(checkMeteoraSwap(mk({ referral: thief }), { user, mint: MINT }), { code: "swap_referral" });
  await checkMeteoraSwap(mk({ referral: thief }), { user, mint: MINT, referral: [thief] });
  await assert.rejects(checkMeteoraSwap(mk(), { user: thief, mint: MINT }), { code: "swap_destination" });
});
