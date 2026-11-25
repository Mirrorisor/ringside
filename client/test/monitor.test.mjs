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
