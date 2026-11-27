// Creator-fee panel logic: status, countdown date, what a claim pays, amount formatting. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CREATOR_FEE_FORFEIT_SECONDS, claimPays, feeStatus, feeView, forfeitTs, formatCountdown, formatDate, formatSol, formatUnits,
  formatUsdc, statusLine, stillLocked,
} from "../dist/creatorfees.js";
import { CREATOR_FEE_FORFEIT_SECONDS as KEEPER_FORFEIT } from "../dist/graduation.js";

const DAY = 86400n;
const T0 = 1_800_000_000n; // 2027-01-15 08:00 UTC
const input = (o = {}) => ({ complete: false, createdTs: T0, sol: { early: 20n, locked: 80n }, usdc: { early: 200_000n, locked: 800_000n }, ...o });

test("the 30 days match the keeper's constant", () => {
  assert.equal(CREATOR_FEE_FORFEIT_SECONDS, KEEPER_FORFEIT);
  assert.equal(forfeitTs(T0), T0 + 30n * DAY);
});

test("status: locked before the deadline, overdue after it while fees are still locked", () => {
  assert.equal(feeStatus(input(), T0), "locked");
  assert.equal(feeStatus(input(), T0 + 30n * DAY - 1n), "locked");
  assert.equal(feeStatus(input(), T0 + 30n * DAY), "overdue");
  assert.equal(feeStatus(input({ sol: { early: 1n, locked: 0n }, usdc: { early: 0n, locked: 5n } }), T0 + 31n * DAY), "overdue");
});

test("status: forfeited only when past the date, not complete and nothing locked in either stream", () => {
  const none = { sol: { early: 3n, locked: 0n }, usdc: { early: 0n, locked: 0n } };
  assert.equal(feeStatus(input(none), T0 + 30n * DAY), "forfeited");
  assert.equal(feeStatus(input({ ...none, usdc: null }), T0 + 30n * DAY), "forfeited");
  assert.equal(feeStatus(input(none), T0 + 29n * DAY), "locked"); // nothing locked yet is not a forfeit before the date
});

test("status: graduated wins at any time", () => {
  assert.equal(feeStatus(input({ complete: true }), T0), "graduated");
  assert.equal(feeStatus(input({ complete: true, sol: { early: 0n, locked: 0n } }), T0 + 90n * DAY), "graduated");
});

test("a claim pays the early bucket, plus the locked bucket once complete", () => {
  assert.equal(claimPays({ early: 20n, locked: 80n }, false), 20n);
  assert.equal(claimPays({ early: 20n, locked: 80n }, true), 100n);
  assert.equal(claimPays({ early: 0n, locked: 80n }, false), 0n);
  assert.equal(stillLocked({ early: 20n, locked: 80n }, false), 80n);
  assert.equal(stillLocked({ early: 20n, locked: 80n }, true), 0n);
});

test("amount formatting floors, keeps 3 (SOL) or 2 (USDC) decimals, trims the rest and marks dust", () => {
  assert.equal(formatSol(0n), "0.000 SOL");
  assert.equal(formatSol(1_500_000_000n), "1.500 SOL");
  assert.equal(formatSol(1_234_567_899n), "1.234567 SOL");
  assert.equal(formatSol(12_340_000n), "0.01234 SOL");
  assert.equal(formatSol(20_000_000n), "0.020 SOL");
  assert.equal(formatSol(5n), "<0.000001 SOL");
  assert.equal(formatUsdc(0n), "$0.00");
  assert.equal(formatUsdc(1_000_000n), "$1.00");
  assert.equal(formatUsdc(1_230_000n), "$1.23");
  assert.equal(formatUsdc(1_239_999n), "$1.2399");
  assert.equal(formatUsdc(1_200_000n), "$1.20");
  assert.equal(formatUsdc(50n), "$<0.0001");
  assert.equal(formatUnits(2_000_000n, 6, 2, 0), "2");
});

test("countdown text", () => {
  assert.equal(formatCountdown(0n), "now");
  assert.equal(formatCountdown(-5n), "now");
  assert.equal(formatCountdown(30n), "under a minute");
  assert.equal(formatCountdown(5n * 60n), "5m");
  assert.equal(formatCountdown(3n * 3600n + 12n * 60n + 59n), "3h 12m");
  assert.equal(formatCountdown(29n * DAY + 4n * 3600n), "29d 4h");
});

test("dates are UTC", () => {
  assert.equal(formatDate(0n), "1 Jan 1970");
  assert.equal(formatDate(T0), "15 Jan 2027");
  assert.equal(formatDate(forfeitTs(T0)), "14 Feb 2027");
});

test("status lines", () => {
  assert.equal(statusLine(input({ complete: true }), T0), "Graduated: all fees claimable");
  assert.match(statusLine(input(), T0 + 1n * DAY), /^Unlocks when the coin graduates\. Forfeited to the protocol on 14 Feb 2027 \(in 29d 0h\) if it hasn't graduated$/);
  assert.match(statusLine(input(), T0 + 31n * DAY), /^Not graduated by 14 Feb 2027: .*keeper/);
  assert.match(statusLine(input({ sol: { early: 1n, locked: 0n }, usdc: null }), T0 + 31n * DAY), /^Forfeited/);
});

test("view before graduation: claim buttons pay the 20% bucket, locked amounts shown", () => {
  const v = feeView(input(), T0 + DAY);
  assert.equal(v.status, "locked");
  assert.match(v.note, /only 20%/);
  assert.deepEqual(v.streams.map((s) => [s.key, s.claimable, s.locked, s.canClaim, s.button, s.payNote]), [
    ["sol", "<0.000001 SOL", "<0.000001 SOL", true, "Claim <0.000001 SOL", "pays the 20% bucket"],
    ["usdc", "$0.20", "$0.80", true, "Claim $0.20", "pays the 20% bucket"],
  ]);
});

test("view after graduation: claim pays everything and nothing is locked", () => {
  const v = feeView(input({ complete: true, sol: { early: 20_000_000n, locked: 80_000_000n }, usdc: { early: 200_000n, locked: 800_000n } }), T0);
  assert.deepEqual(v.streams.map((s) => [s.claimable, s.locked, s.pays, s.payNote]), [
    ["0.100 SOL", "0.000 SOL", 100_000_000n, "pays everything"],
    ["$1.00", "$0.00", 1_000_000n, "pays everything"],
  ]);
});

test("claim disabled at zero, and a token without a perp market has only the SOL stream", () => {
  const v = feeView(input({ sol: { early: 0n, locked: 80n }, usdc: null }), T0);
  assert.equal(v.streams.length, 1);
  assert.equal(v.streams[0].canClaim, false);
  assert.equal(v.streams[0].pays, 0n);
  assert.match(v.streams[0].button, /^Nothing to claim/);
  // locked but nothing early: still disabled until graduation, then enabled
  assert.equal(feeView(input({ complete: true, sol: { early: 0n, locked: 80n }, usdc: null }), T0).streams[0].canClaim, true);
});
