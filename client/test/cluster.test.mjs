import { test } from "node:test";
import assert from "node:assert/strict";
import { clusterOf, detectCluster, resolveNetwork, MAINNET_GENESIS_HASH, DEVNET_GENESIS_HASH } from "../dist/cluster.js";
import { DEVNET_GENESIS_HASH as COPY_DEVNET } from "../dist/copy/build.js";

test("clusterOf maps genesis hashes, anything else is unknown", () => {
  assert.equal(clusterOf(MAINNET_GENESIS_HASH), "mainnet");
  assert.equal(clusterOf(DEVNET_GENESIS_HASH), "devnet");
  assert.equal(clusterOf("4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY"), "unknown"); // testnet
  assert.equal(clusterOf(undefined), "unknown");
  assert.equal(COPY_DEVNET, DEVNET_GENESIS_HASH, "copy engine and cluster helper agree on devnet");
});

test("detectCluster fails closed: a lookup error is unknown, never devnet", async () => {
  assert.equal(await detectCluster(async () => DEVNET_GENESIS_HASH), "devnet");
  assert.equal(await detectCluster(async () => { throw new Error("fetch failed"); }), "unknown");
});

test("resolveNetwork: the RPC's cluster wins over NETWORK", () => {
  assert.deepEqual(resolveNetwork(undefined, "mainnet"), { network: "mainnet" });
  assert.deepEqual(resolveNetwork(undefined, "devnet"), { network: "devnet" });
  assert.deepEqual(resolveNetwork("MAINNET", "mainnet"), { network: "mainnet" });
  // The bug this guards: NETWORK unset (or devnet) on a mainnet RPC used to turn mainnet safeguards off.
  assert.match(resolveNetwork("devnet", "mainnet").error ?? "", /serves mainnet/);
  assert.match(resolveNetwork("mainnet", "devnet").error ?? "", /serves devnet/);
  assert.match(resolveNetwork("testnet", "devnet").error ?? "", /must be/);
});

test("resolveNetwork: unidentified cluster keeps mainnet safeguards unless told devnet", () => {
  const r = resolveNetwork(undefined, "unknown");
  assert.equal(r.network, "mainnet");
  assert.ok(r.warning);
  assert.equal(resolveNetwork("devnet", "unknown").network, "devnet");
  assert.equal(resolveNetwork("mainnet", "unknown").network, "mainnet");
});
