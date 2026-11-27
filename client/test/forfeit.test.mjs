// Keeper creator-fee forfeit: which curves and markets are eligible, and the decoders' creator_fees_locked field. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { forfeitTargets, FORFEIT_SAFETY_MARGIN_S } from "../dist/keeper.js";
import { CREATOR_FEE_FORFEIT_SECONDS, decodeCurve } from "../dist/graduation.js";
import { decodeMarket } from "../dist/keeper.js";

const DAY = 24n * 3600n;
const T0 = 1_700_000_000n;
const curve = (key, o = {}) => ({ key, mint: `mint-${key}`, complete: false, migrated: false, virtualSol: 0n, virtualTokens: 0n, realSol: 0n, createdTs: T0, creatorFeesLocked: 5n, ...o });
const market = (key, c, o = {}) => ({ key, mint: `mint-${c}`, curve: c, tier: 0, reduceOnly: false, adlMode: false, bandAnchorQ64: 0n, creatorFeesLocked: 7n, ...o });
const AFTER = T0 + CREATOR_FEE_FORFEIT_SECONDS + FORFEIT_SAFETY_MARGIN_S;
const keys = (r) => ({ c: r.curves.map((x) => x.key), m: r.markets.map((x) => x.key) });

test("the forfeit constant is 30 days, the margin is 60 s", () => {
  assert.equal(CREATOR_FEE_FORFEIT_SECONDS, 30n * DAY);
  assert.equal(FORFEIT_SAFETY_MARGIN_S, 60n);
});

test("eligible once 30 days plus the margin have passed", () => {
  const r = forfeitTargets([curve("a")], [market("ma", "a")], AFTER);
  assert.deepEqual(keys(r), { c: ["a"], m: ["ma"] });
  assert.deepEqual(keys(forfeitTargets([curve("a")], [market("ma", "a")], AFTER + 10n * DAY)), { c: ["a"], m: ["ma"] });
});

test("not eligible before 30 days, including the safety margin", () => {
  for (const now of [T0, T0 + 29n * DAY, T0 + CREATOR_FEE_FORFEIT_SECONDS - 1n, T0 + CREATOR_FEE_FORFEIT_SECONDS, AFTER - 1n]) {
    assert.deepEqual(keys(forfeitTargets([curve("a")], [market("ma", "a")], now)), { c: [], m: [] }, `now=${now - T0}`);
  }
});

test("not eligible when the curve is complete (graduated), for the curve and its market", () => {
  const r = forfeitTargets([curve("a", { complete: true }), curve("b", { complete: true, migrated: true })], [market("ma", "a"), market("mb", "b")], AFTER + DAY);
  assert.deepEqual(keys(r), { c: [], m: [] });
});

test("not eligible when nothing is locked; curve and market are judged on their own amounts", () => {
  assert.deepEqual(keys(forfeitTargets([curve("a", { creatorFeesLocked: 0n })], [market("ma", "a", { creatorFeesLocked: 0n })], AFTER)), { c: [], m: [] });
  // Curve has nothing locked but its market does (and vice versa): each follows its own bucket.
  assert.deepEqual(keys(forfeitTargets([curve("a", { creatorFeesLocked: 0n })], [market("ma", "a")], AFTER)), { c: [], m: ["ma"] });
  assert.deepEqual(keys(forfeitTargets([curve("a")], [market("ma", "a", { creatorFeesLocked: 0n })], AFTER)), { c: ["a"], m: [] });
});

test("market eligibility follows its own curve's age and state", () => {
  const curves = [curve("old", { createdTs: T0 - 40n * DAY }), curve("young", { createdTs: T0 }), curve("done", { createdTs: T0 - 40n * DAY, complete: true })];
  const markets = [market("m-old", "old"), market("m-young", "young"), market("m-done", "done"), market("m-orphan", "missing")];
  const r = forfeitTargets(curves, markets, T0 + DAY);
  assert.deepEqual(keys(r), { c: ["old"], m: ["m-old"] });
});

// Fixtures serialized by the Rust programs (cargo test print_fixtures / print_curve_fixture), checked in layout.mjs too.
test("decoders read creator_fees_locked as the last field and treat missing bytes as 0", () => {
  const disc = new Uint8Array(8);
  // Curve with 3 strings: build by hand following the Rust layout.
  const strs = ["Name", "SYM", "https://x/y.json"].map((s) => Buffer.concat([Buffer.from(Uint32Array.of(s.length).buffer), Buffer.from(s)]));
  const body = Buffer.alloc(56 + 2 + 8 + 8 + 16 + 16 + 8 + 32 * 24 + 3 + 8);
  const fixed = 56;
  body[fixed] = 0; body[fixed + 1] = 0;
  body.writeBigInt64LE(T0, fixed + 10);
  body.writeBigUInt64LE(123456789n, body.length - 8);
  const full = Buffer.concat([disc, Buffer.alloc(64), ...strs, body]);
  const c = decodeCurve("k", new Uint8Array(full));
  assert.equal(c.createdTs, T0);
  assert.equal(c.creatorFeesLocked, 123456789n);
  assert.equal(c.complete, false);
  assert.equal(decodeCurve("k", new Uint8Array(full.subarray(0, full.length - 8))).creatorFeesLocked, 0n);

  const m = Buffer.alloc(228);
  m.writeBigUInt64LE(99n, 220);
  assert.equal(decodeMarket("m", new Uint8Array(m)).creatorFeesLocked, 99n);
  assert.equal(decodeMarket("m", new Uint8Array(m.subarray(0, 220))).creatorFeesLocked, 0n);
});
