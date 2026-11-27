// Keeper monitoring: deduplicated alerts and the health endpoint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Monitor } from "../dist/monitor.js";

test("alerts once when a condition starts, once when it clears", async () => {
  const posts = [];
  const m = new Monitor("https://hooks.test/x", async (_u, init) => { posts.push(JSON.parse(init.body).text); return { ok: true }; });
  const c = (active) => [{ key: "price", active, message: "SOL/USD is stale" }];
  assert.equal((await m.update(c(true))).length, 1);
  assert.equal((await m.update(c(true))).length, 0, "no repeat every tick");
  assert.deepEqual(await m.update(c(false)), ["✅ resolved: SOL/USD is stale"]);
  assert.equal((await m.update(c(false))).length, 0);
  assert.equal(posts.length, 2);
  assert.match(posts[0], /^\[ringside keeper\] ⚠️ SOL\/USD is stale$/);
});

test("a webhook failure never breaks the keeper", async () => {
  const m = new Monitor("https://hooks.test/x", async () => { throw new Error("down"); });
  assert.equal((await m.update([{ key: "k", active: true, message: "x" }])).length, 1);
});

test("/health is 503 until the loop succeeds, and again when it stalls", async () => {
  const m = new Monitor();
  const server = m.serve(0, 50);
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}/health`;
  assert.equal((await fetch(url)).status, 503);
  m.tickSucceeded();
  const ok = await fetch(url);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).healthy, true);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal((await fetch(url)).status, 503, "stalled loop");
  server.close();
});

// ---- forfeit / graduation crank alerts ----
import { CRANK_FAIL_THRESHOLD, MARKET_TIER0_GRACE_MS, clearGone, crankConditions, pruneCleared, recordAttempt, stuckTier0, tier0Conditions } from "../dist/monitor.js";

test("a crank alerts only on the 3rd failure in a row, and clears on success", async () => {
  const f = new Map();
  const m = new Monitor();
  assert.equal(CRANK_FAIL_THRESHOLD, 3);
  recordAttempt(f, "forfeit:curveA", false, "boom");
  recordAttempt(f, "forfeit:curveA", false, "boom");
  assert.equal((await m.update(crankConditions(f))).length, 0, "two failures: quiet");
  recordAttempt(f, "forfeit:curveA", false, "boom");
  const fired = await m.update(crankConditions(f));
  assert.equal(fired.length, 1);
  assert.match(fired[0], /forfeit_creator_fees for curveA failed 3 times in a row: boom/);
  assert.equal((await m.update(crankConditions(f))).length, 0, "not repeated every tick");
  recordAttempt(f, "forfeit:curveA", true);
  const cleared = await m.update(crankConditions(f));
  assert.equal(cleared.length, 1);
  assert.match(cleared[0], /^✅ resolved/);
  pruneCleared(f);
  assert.equal(f.size, 0);
  assert.equal((await m.update(crankConditions(f))).length, 0);
});

test("a success in the middle resets the streak; accounts are independent", () => {
  const f = new Map();
  for (const ok of [false, false, true, false, false]) recordAttempt(f, "migrate:mintX", ok, "e");
  recordAttempt(f, "graduate:mk", false, "e");
  const by = Object.fromEntries(crankConditions(f).map((c) => [c.key, c.active]));
  assert.deepEqual(by, { "crank:migrate:mintX": false, "crank:graduate:mk": false });
  recordAttempt(f, "migrate:mintX", false, "e");
  assert.equal(crankConditions(f).find((c) => c.key === "crank:migrate:mintX").active, true);
  assert.match(crankConditions(f).find((c) => c.key === "crank:migrate:mintX").message, /^migrate for mintX/);
});

test("an account that is no longer a target (forfeited by someone else) clears its alert", () => {
  const f = new Map();
  for (let i = 0; i < 3; i++) recordAttempt(f, "forfeit:gone", false, "e");
  recordAttempt(f, "forfeit:live", false, "e");
  clearGone(f, "forfeit:", new Set(["live"]));
  assert.equal(f.get("forfeit:gone").count, 0);
  assert.equal(f.get("forfeit:live").count, 1);
});

test("a migrated curve's market still at tier 0 after 10 minutes alerts; tier 1 clears it", async () => {
  const seen = new Map();
  const markets = [{ key: "mk", curve: "cv", tier: 0 }, { key: "other", curve: "unmigrated", tier: 0 }];
  const migrated = new Set(["cv"]);
  const t0 = 1_000_000;
  assert.equal(MARKET_TIER0_GRACE_MS, 600_000);
  const at = (now) => tier0Conditions(stuckTier0(markets, migrated, seen, now), now);
  assert.deepEqual(at(t0).map((c) => [c.key, c.active]), [["tier0:mk", false]], "only markets whose curve migrated are tracked");
  assert.equal(at(t0 + MARKET_TIER0_GRACE_MS)[0].active, false, "exactly 10 minutes is not yet more than 10");
  const m = new Monitor();
  const late = at(t0 + MARKET_TIER0_GRACE_MS + 1);
  assert.equal(late[0].active, true);
  assert.match(late[0].message, /market mk is still tier 0 10 min after its curve migrated/);
  assert.equal((await m.update(late)).length, 1);
  markets[0].tier = 1;
  const cleared = await m.update(at(t0 + 700_000));
  assert.equal(cleared.length, 1);
  assert.match(cleared[0], /resolved/);
});
