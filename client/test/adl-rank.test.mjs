// Keeper ADL ordering: highest profit ratio (PnL / collateral) first, losers excluded. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rankForAdl } from "../dist/keeper.js";

const Q = 1n << 64n;
const pos = (key, o) => ({ key, owner: "o", market: "m", side: 0, collateral: 1_000_000n, sizeUsd: 2_000_000n, entryQ64: Q, ...o });

test("ranks by profit per unit of collateral, not by absolute profit", () => {
  const price = Q * 2n; // +100% for longs
  const big = pos("big", { sizeUsd: 10_000_000n, collateral: 10_000_000n }); // pnl 10, ratio 1.0
  const lev = pos("lev", { sizeUsd: 4_000_000n, collateral: 1_000_000n }); // pnl 4, ratio 4.0
  assert.deepEqual(rankForAdl([big, lev], price).map((p) => p.key), ["lev", "big"]);
});

test("positions that are not in profit are left out", () => {
  const price = Q * 2n;
  const short = pos("short", { side: 1 }); // loses when the price rises
  const flat = pos("flat", { entryQ64: price });
  assert.deepEqual(rankForAdl([short, flat], price), []);
});
