// Forfeited creator fees -> POL: event decoding and accounting. Pure, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  FORFEIT_EVENT_DISC, PROCESSED_CAP, applyScan, base58, decodeForfeitEvent, emptyState, parseForfeitEvents, parseState,
  pendingLamports, planConversion, recordDeposit, recordSwap, summaryLine,
  NO_START_MESSAGE, limitToSlot, parseStart, seedState,
} from "../dist/forfeits.js";

const LAUNCH = "AfZWCTaDQEC9CVTwXkH7pFtDXs4RtLWCK5godexWQDVH";
const PERPS = "DsZ69w3q25nRmAzJCRBMLbwZWN6NyVbYipTWsCAUsg1F";
const SOL = 1_000_000_000n;
const mintBytes = (n) => Buffer.alloc(32, n);
const eventLine = (mint, amount, disc = FORFEIT_EVENT_DISC) => {
  const a = Buffer.alloc(8); a.writeBigUInt64LE(amount);
  return `Program data: ${Buffer.concat([disc, mintBytes(mint), a]).toString("base64")}`;
};
const okLogs = (mint, amount, program = LAUNCH) => [
  `Program ${program} invoke [1]`, "Program log: Instruction: ForfeitCreatorFees", eventLine(mint, amount),
  `Program ${program} consumed 9000 of 200000 compute units`, `Program ${program} success`,
];
const tx = (signature, logs, err = null) => ({ signature, err, logs });

test("discriminator is sha256('event:CreatorFeesForfeited')[..8]", () => {
  assert.deepEqual(FORFEIT_EVENT_DISC, createHash("sha256").update("event:CreatorFeesForfeited").digest().subarray(0, 8));
});

test("decodes mint and amount from a real-format Program data line", () => {
  const ev = decodeForfeitEvent(eventLine(7, 123_456_789n).slice("Program data: ".length));
  assert.equal(ev.lamports, 123_456_789n);
  assert.equal(ev.mint, base58(mintBytes(7)));
  assert.equal(decodeForfeitEvent(eventLine(7, 1n, Buffer.alloc(8, 1)).slice(14)), null, "other event");
  assert.equal(decodeForfeitEvent(Buffer.alloc(10).toString("base64")), null, "wrong length");
  const max = decodeForfeitEvent(eventLine(1, 2n ** 64n - 1n).slice(14));
  assert.equal(max.lamports, 2n ** 64n - 1n);
});

test("base58 matches the known system program address", () => {
  assert.equal(base58(new Uint8Array(32)), "11111111111111111111111111111111");
});

test("only the launch program's event counts, including inside a CPI", () => {
  const { events } = parseForfeitEvents(okLogs(1, 5n), LAUNCH);
  assert.equal(events.length, 1);
  assert.equal(parseForfeitEvents(okLogs(1, 5n, PERPS), LAUNCH).events.length, 0, "same-named perps event (USDC) is ignored");
  const mixed = [
    ...okLogs(1, 5n, PERPS),
    `Program ${LAUNCH} invoke [1]`, `Program ${PERPS} invoke [2]`, eventLine(2, 99n), `Program ${PERPS} success`, eventLine(3, 7n), `Program ${LAUNCH} success`,
  ];
  assert.deepEqual(parseForfeitEvents(mixed, LAUNCH).events.map((e) => e.lamports), [7n]);
  assert.equal(parseForfeitEvents(["Log truncated"], LAUNCH).truncated, true);
});

test("a failed transaction is ignored and still moves the cursor", () => {
  const r = applyScan(emptyState(), [tx("sigB", okLogs(1, 9n), { InstructionError: [0, "Custom"] }), tx("sigA", okLogs(1, 4n))], LAUNCH);
  assert.equal(r.state.totalForfeited, "4");
  assert.equal(r.state.cursor, "sigB");
  assert.equal(r.events.length, 1);
});

test("no double counting across runs, overlapping scans or a lost cursor", () => {
  const first = applyScan(emptyState(), [tx("s2", okLogs(1, 3n * SOL)), tx("s1", okLogs(2, 2n * SOL))], LAUNCH).state;
  assert.equal(first.totalForfeited, (5n * SOL).toString());
  assert.equal(first.cursor, "s2");
  const again = applyScan(first, [], LAUNCH).state;
  assert.deepEqual(again, first, "empty re-run changes nothing");
  const overlap = applyScan(first, [tx("s3", okLogs(1, SOL)), tx("s2", okLogs(1, 3n * SOL)), tx("s1", okLogs(2, 2n * SOL))], LAUNCH).state;
  assert.equal(overlap.totalForfeited, (6n * SOL).toString(), "only s3 is new even if the cursor was lost");
  assert.equal(overlap.cursor, "s3");
  assert.deepEqual(overlap.processed.slice(0, 3), ["s3", "s2", "s1"]);
});

test("processed list is capped, newest kept", () => {
  const many = Array.from({ length: PROCESSED_CAP + 10 }, (_, i) => tx(`n${PROCESSED_CAP + 9 - i}`, []));
  const st = applyScan(emptyState(), many, LAUNCH).state;
  assert.equal(st.processed.length, PROCESSED_CAP);
  assert.equal(st.processed[0], `n${PROCESSED_CAP + 9}`);
});

test("truncated logs of a successful tx stop the scan instead of guessing", () => {
  assert.throws(() => applyScan(emptyState(), [tx("s", [`Program ${LAUNCH} invoke [1]`, "Log truncated"])], LAUNCH), /truncated/);
});

test("conversion is bounded by pending, by balance above the reserve, and by the minimum; the remainder carries over", () => {
  let st = applyScan(emptyState(), [tx("s1", okLogs(1, 10n * SOL))], LAUNCH).state;
  const reserve = SOL / 2n, min = SOL / 20n;
  assert.equal(planConversion(st, 100n * SOL, reserve, min), 10n * SOL, "never more than forfeited, even with a rich wallet");
  assert.equal(planConversion(st, 4n * SOL, reserve, min), 7n * SOL / 2n, "bounded by balance - reserve");
  assert.equal(planConversion(st, reserve, reserve, min), 0n, "nothing above the reserve");
  assert.equal(planConversion(st, reserve + min - 1n, reserve, min), 0n, "below the minimum swap");
  st = recordSwap(st, 7n * SOL / 2n, 500_000_000n);
  assert.equal(pendingLamports(st), 13n * SOL / 2n);
  assert.equal(st.usdcPendingDeposit, "500000000");
  assert.equal(planConversion(st, 100n * SOL, reserve, min), 13n * SOL / 2n, "partial conversion carries over");
  st = recordSwap(st, 13n * SOL / 2n, 1n);
  assert.equal(pendingLamports(st), 0n);
  assert.equal(planConversion(st, 100n * SOL, reserve, min), 0n, "nothing left to convert");
  const more = applyScan(st, [tx("s2", okLogs(1, SOL))], LAUNCH).state;
  assert.equal(pendingLamports(more), SOL, "a later forfeit adds only its own amount");
});

test("recordSwap refuses to convert more than was forfeited", () => {
  const st = applyScan(emptyState(), [tx("s1", okLogs(1, SOL))], LAUNCH).state;
  assert.throws(() => recordSwap(st, SOL + 1n, 1n), /more than was forfeited/);
});

test("deposits reduce the pending USDC and add to the total", () => {
  let st = recordSwap(applyScan(emptyState(), [tx("s", okLogs(1, SOL))], LAUNCH).state, SOL, 150_000_000n);
  st = recordDeposit(st, 100_000_000n);
  assert.equal(st.usdcPendingDeposit, "50000000");
  st = recordDeposit(st, 50_000_000n);
  assert.equal(st.usdcPendingDeposit, "0");
  assert.equal(st.totalDepositedUsdc, "150000000");
});

test("state file validation and the log line", () => {
  assert.throws(() => parseState({ cursor: null }), /malformed/);
  assert.throws(() => parseState({ ...emptyState(), totalConverted: "5" }), /exceeds/);
  const st = parseState(JSON.parse(JSON.stringify(recordSwap(applyScan(emptyState(), [tx("s", okLogs(1, 3n * SOL))], LAUNCH).state, SOL, 1n))));
  assert.equal(summaryLine(st, 140_000_000n, "5xTx"), "forfeited SOL: 3 total, 1 converted, 2 pending → deposited 140 USDC as treasury-owned liquidity (tx 5xTx)");
});

const SIG = "5".repeat(88);
const SIG2 = "4".repeat(87);

test("first run with no state file and no start refuses with a clear message", () => {
  assert.throws(() => seedState(emptyState(), false, parseStart({})), (e) => e.message === NO_START_MESSAGE && /FORFEIT_START_SIGNATURE/.test(e.message) && /FORFEIT_START_SLOT/.test(e.message));
  assert.throws(() => seedState(emptyState(), false, parseStart({ FORFEIT_START_SIGNATURE: "  ", FORFEIT_START_SLOT: "" })), /refusing/);
});

test("a start signature seeds the cursor; a start slot seeds the slot floor", () => {
  const a = seedState(emptyState(), false, parseStart({ FORFEIT_START_SIGNATURE: SIG }));
  assert.equal(a.seeded, true);
  assert.equal(a.state.cursor, SIG);
  const b = seedState(emptyState(), false, parseStart({ FORFEIT_START_SLOT: "400000000" }));
  assert.equal(b.state.cursor, null);
  assert.equal(b.state.startSlot, 400_000_000);
  // the seeded cursor survives a scan that finds nothing, so the next run does not go back to the beginning
  assert.equal(applyScan(a.state, [], LAUNCH).state.cursor, SIG);
  assert.equal(applyScan(b.state, [], LAUNCH).state.startSlot, 400_000_000);
  assert.equal(parseState(JSON.parse(JSON.stringify(b.state))).startSlot, 400_000_000);
});

test("an existing state file wins: the start is ignored and the cursor is never overwritten", () => {
  const saved = { ...emptyState(), cursor: SIG2, totalForfeited: "7", processed: ["x"] };
  const r = seedState(saved, true, parseStart({ FORFEIT_START_SIGNATURE: SIG, FORFEIT_START_SLOT: undefined }));
  assert.equal(r.seeded, false);
  assert.deepEqual(r.state, saved);
  // and an existing file needs no start at all
  assert.equal(seedState(saved, true, parseStart({})).state.cursor, SIG2);
});

test("start values are validated", () => {
  assert.throws(() => parseStart({ FORFEIT_START_SIGNATURE: "not-a-signature" }), /base58/);
  assert.throws(() => parseStart({ FORFEIT_START_SIGNATURE: "0".repeat(88) }), /base58/);
  for (const bad of ["0", "-5", "1.5", "abc", "12e3"]) assert.throws(() => parseStart({ FORFEIT_START_SLOT: bad }), /slot/, bad);
  assert.throws(() => parseStart({ FORFEIT_START_SIGNATURE: SIG, FORFEIT_START_SLOT: "5" }), /only one/);
  assert.deepEqual(parseStart({ FORFEIT_START_SLOT: " 42 " }), { signature: null, slot: 42 });
  assert.throws(() => parseState({ ...emptyState(), startSlot: -1 }), /startSlot/);
});

test("slot floor trims a page newest-first and says when to stop paging", () => {
  const page = [{ signature: "a", slot: 120 }, { signature: "b", slot: 100 }, { signature: "c", slot: 99 }, { signature: "d", slot: 50 }];
  const r = limitToSlot(page, 100);
  assert.deepEqual(r.kept.map((p) => p.signature), ["a", "b"]);
  assert.equal(r.done, true);
  assert.deepEqual(limitToSlot(page.slice(0, 2), 100), { kept: page.slice(0, 2), done: false });
  assert.deepEqual(limitToSlot(page, null), { kept: page, done: false });
});
