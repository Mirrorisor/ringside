// Every hardcoded program/mint address must match the official libraries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, ComputeBudgetProgram, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { SHIELDED_POOL_PROGRAM_ID, USER_REGISTRY_PROGRAM_ID } from "@heliuslabs/spr";
import { address } from "@solana/kit";
import { ata, TOKEN_PROGRAM, ATA_PROGRAM } from "../dist/keeper.js";
import { PROGRAMS } from "../dist/relayer.js";
import { USDC_MINT } from "../dist/rings.js";

test("keeper and relayer program IDs match the libraries", () => {
  assert.equal(TOKEN_PROGRAM, TOKEN_PROGRAM_ID.toBase58());
  assert.equal(ATA_PROGRAM, ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
  assert.equal(PROGRAMS.token, TOKEN_PROGRAM_ID.toBase58());
  assert.equal(PROGRAMS.ata, ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
  assert.equal(PROGRAMS.computeBudget, ComputeBudgetProgram.programId.toBase58());
  assert.equal(PROGRAMS.shieldedPool, String(SHIELDED_POOL_PROGRAM_ID));
  assert.equal(PROGRAMS.userRegistry, String(USER_REGISTRY_PROGRAM_ID));
  assert.notEqual(SystemProgram.programId.toBase58(), PROGRAMS.ata);
});

test("keeper derives the same token account address as SPL Token", async () => {
  for (let i = 0; i < 5; i++) {
    const owner = Keypair.generate().publicKey, mint = Keypair.generate().publicKey;
    assert.equal(await ata(address(owner.toBase58()), address(mint.toBase58())), getAssociatedTokenAddressSync(mint, owner).toBase58());
  }
});

test("mainnet USDC mint is Circle's", () => {
  assert.equal(USDC_MINT, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
});
