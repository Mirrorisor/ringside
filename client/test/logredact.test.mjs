import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, secretValues } from "../dist/logredact.js";

const env = {
  RPC_URL: "https://devnet.helius-rpc.com/?api-key=11111111-2222-3333-4444-555555555555",
  COPY_RPC_URL: "https://solana-mainnet.example-pool.com/abcdef0123456789abcdef0123456789",
  SESSION_SECRET: "s".repeat(40),
  RELAYER_KEY: "5Kb8kLf9zgWQnogidDA76MzPL6TsZZY36hWXMssSzNydYXYB9KF",
  REDIS_URL: "redis://user:hunter2hunter2@localhost:6379",
  PORT: "8787",
  SPONSOR_ALLOW_ANON: "1",
  INDEXER_PORT: "12345678",
};

test("masks secret env values, including key parts of URLs", () => {
  const s = secretValues(env);
  const line = [
    `fetch failed for ${env.RPC_URL}`,
    "key alone 11111111-2222-3333-4444-555555555555",
    `pool path ${env.COPY_RPC_URL}/extra and bare abcdef0123456789abcdef0123456789`,
    `secret ${env.SESSION_SECRET}`,
    `relayer ${env.RELAYER_KEY}`,
    "redis password hunter2hunter2",
  ].join("\n");
  const out = redact(line, s);
  for (const leak of ["11111111-2222", "abcdef0123456789abcdef", "s".repeat(40), env.RELAYER_KEY, "hunter2hunter2"]) {
    assert.ok(!out.includes(leak), `leaked ${leak}\n${out}`);
  }
});

test("masks api-key style params even for URLs not in the environment", () => {
  const out = redact("GET https://x.example/rpc?api-key=AAAA-BBBB&cluster=devnet and ?token=zzz9 and apikey=q1w2e3", []);
  assert.equal(out, "GET https://x.example/rpc?api-key=<redacted>&cluster=devnet and ?token=<redacted> and apikey=<redacted>");
});

test("leaves ordinary log lines and non-secret env values alone", () => {
  const s = secretValues(env);
  assert.ok(!s.includes("8787") && !s.includes("12345678") && !s.includes("1"));
  const line = "[relayer] DRU4CDU7KWrN3pA6tk79rKdJqfHBUFBeJgJ5S1FNPF1m listening on :8787";
  assert.equal(redact(line, s), line);
});
