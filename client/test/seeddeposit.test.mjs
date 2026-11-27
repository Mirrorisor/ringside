import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSeedAmount, decideSeed, formatUsdc } from "../dist/seeddeposit.js";

test("parseSeedAmount: default, decimals, rejects junk", () => {
  assert.equal(parseSeedAmount(undefined), 1_000_000_000n);
  assert.equal(parseSeedAmount("  "), 1_000_000_000n);
  assert.equal(parseSeedAmount("250.5"), 250_500_000n);
  assert.equal(parseSeedAmount("0.000001"), 1n);
  assert.equal(parseSeedAmount("1"), 1_000_000n);
  for (const bad of ["0", "0.0", "-5", "1e3", "1,000", "1.0000001", "abc", ".5", "18446744073709.551616"]) {
    assert.throws(() => parseSeedAmount(bad), undefined, bad);
  }
});

test("decideSeed: skip when shares exist, refuse when short, else deposit", () => {
  const need = 1_000_000_000n;
  assert.equal(decideSeed(5n, 0n, need).action, "skip");
  assert.equal(decideSeed(null, need, need).action, "deposit");
  assert.equal(decideSeed(0n, need, need).action, "deposit");
  const short = decideSeed(null, need - 1n, need);
  assert.deepEqual(short, { action: "insufficient", have: need - 1n, need });
});

test("formatUsdc", () => {
  assert.equal(formatUsdc(1_000_000_000n), "1000");
  assert.equal(formatUsdc(250_500_000n), "250.5");
  assert.equal(formatUsdc(1n), "0.000001");
});
