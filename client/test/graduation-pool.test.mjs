// Graduation pool addresses: migrate creates the pool at a PDA of the launch program (nobody can create it
// first); markets that graduated earlier keep Raydium's canonical pool. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import {
  AMM_CONFIG, CPMM_PROGRAM, LAUNCH_PROGRAM, WSOL_MINT, canonicalPoolAddress, graduateMarketIx, launchPoolAddress,
  marketPoolAddress, migrateIx, orderMints, poolAccounts, priceAccounts,
} from "../dist/graduation.js";

const MINT = "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj";
const K = (s) => new PublicKey(s);
const find = (seeds, program) => PublicKey.findProgramAddressSync(seeds, K(program))[0].toBase58();

test("the launch pool is the launch program's PDA [raydium_pool, mint]", async () => {
  assert.equal(await launchPoolAddress(MINT), find([Buffer.from("raydium_pool"), K(MINT).toBuffer()], LAUNCH_PROGRAM));
});

test("the canonical pool is Raydium's [pool, config, token0, token1] and differs from the launch pool", async () => {
  const [t0, t1] = orderMints(MINT, WSOL_MINT);
  const want = find([Buffer.from("pool"), K(AMM_CONFIG).toBuffer(), K(t0).toBuffer(), K(t1).toBuffer()], CPMM_PROGRAM);
  assert.equal(await canonicalPoolAddress(MINT), want);
  assert.notEqual(await launchPoolAddress(MINT), want);
});

test("a market without a stored pool reads the canonical one; a stored pool wins", async () => {
  assert.equal(await marketPoolAddress(MINT, null), await canonicalPoolAddress(MINT));
  const stored = await launchPoolAddress(MINT);
  assert.equal(await marketPoolAddress(MINT, stored), stored);
});

test("poolAccounts derives everything from the pool address it is given (launch pool by default)", async () => {
  const ours = await poolAccounts(MINT);
  assert.equal(ours.pool, await launchPoolAddress(MINT));
  assert.equal(ours.observation, find([Buffer.from("observation"), K(ours.pool).toBuffer()], CPMM_PROGRAM));
  assert.equal(ours.lpMint, find([Buffer.from("pool_lp_mint"), K(ours.pool).toBuffer()], CPMM_PROGRAM));
  const old = await poolAccounts(MINT, await canonicalPoolAddress(MINT));
  assert.equal(old.pool, await canonicalPoolAddress(MINT));
  assert.notEqual(old.tokenVault, ours.tokenVault);
  assert.deepEqual((await priceAccounts(MINT)).map((a) => a.address), [ours.pool, ours.observation, ours.tokenVault, ours.solVault]);
  assert.equal((await priceAccounts(MINT, old.pool))[0].address, old.pool);
});

test("migrateIx puts the launch pool (not the canonical one) in the pool slot", async () => {
  const ix = await migrateIx(WSOL_MINT, MINT, WSOL_MINT);
  const keys = ix.accounts.map((a) => a.address);
  assert.ok(keys.includes(await launchPoolAddress(MINT)));
  assert.ok(!keys.includes(await canonicalPoolAddress(MINT)));
});

test("graduateMarketIx: the launch pool normally; the canonical pool plus the launch pool as proof for a legacy curve", async () => {
  const normal = await graduateMarketIx(MINT, MINT, MINT);
  assert.equal(normal.accounts.length, 4 + 4);
  assert.equal(normal.accounts[4].address, await launchPoolAddress(MINT));
  const legacy = await graduateMarketIx(MINT, MINT, MINT, true);
  assert.equal(legacy.accounts.length, 4 + 5);
  assert.equal(legacy.accounts[4].address, await canonicalPoolAddress(MINT));
  assert.equal(legacy.accounts[8].address, await launchPoolAddress(MINT));
});
