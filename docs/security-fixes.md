# Security fixes

Findings from the pre-audit review and what changed. Each entry: what, fix, test.

## F1 (critical): the token's Raydium pool could be taken before `migrate`

**What.** `migrate` created the pool at Raydium's canonical pool address for the token. Raydium's `initialize` is permissionless, so anyone could occupy that address first and `migrate` would then fail for that token.

**Fix.**
- The pool now lives at a PDA of the launch program: seeds `[b"raydium_pool", mint]` (`SEED_RAYDIUM_POOL`, `launch_pool_address(mint)`). `migrate` signs Raydium's `initialize` with the pool-creator seeds and the pool seeds together, so `pool_state` signs. Raydium accepts a non-canonical pool account only when it signs, and only the launch program can sign for this address. Raydium also handles an address that was pre-funded with lamports.
- Everything Raydium derives from the pool (LP mint, token vaults, observation account) is seeded from the pool address and follows it.
- `raydium::pool_address` is renamed `raydium::canonical_pool_address`; new graduations never use it.
- perps stores the pool in `Market.pool` (appended after `creator_fees_locked`, 32 bytes, `Market` is now 260 bytes) at `graduate_market`, and every later price read must use that key. `graduate_market` accepts the launch pool, or the canonical pool only for a curve that migrated before this change: it requires the launch pool address to be passed as a fifth account and to hold no Raydium pool. Markets whose `pool` is all zero (graduated before the field existed) read the canonical pool, as before.
- Clients (keeper, app, `graduation.ts`, `graduation-devnet.ts`) take the pool from `Market.pool`, falling back to the launch pool and then the canonical pool.

**Upgrade.** Existing `Market` accounts need `resize_market` (permissionless, `client/scripts/resize-accounts.ts`, run by `scripts/upgrade.sh`) before the upgraded keeper and relayer start. No re-initialization is needed.

**Tests.** `tests-graduation/tests/pool_address.rs`: migrate succeeds into the launch pool when the canonical pool already exists; migrate succeeds with the pool address and Raydium's derived addresses pre-funded; an outsider cannot create a pool at the launch address; a market that graduated before `pool` was stored keeps the canonical pool; the canonical fallback is refused once a launch pool exists. `graduation.rs` runs the full flow on the new address. `tests/` covers `resize_market` for the new size.

## F3 (high): anyone could initialize the programs first

**What.** `initialize_global` (launch) and `initialize_vault` (perps) could be called by any signer. The first caller became admin, set the fee and insurance recipients, and chose the vault's USDC mint.

**Fix.** Both instructions now take the program's ProgramData account (the upgradeable loader's account at the PDA of the program id, `seeds = [program_id]` under `BPFLoaderUpgradeab1e...`) and require its `upgrade_authority_address` to equal the signing `authority`. This is the same check as the usual `Program` plus `ProgramData` pattern, without the extra `Program` account. A frozen program (no upgrade authority) cannot be initialized. New error `NotUpgradeAuthority` in both programs.

**Scripts.** `init-mainnet.ts` and `bootstrap-devnet.ts` pass the ProgramData account. Because the deployer key is the upgrade authority until it is handed over, initialize first and then move the upgrade authority to the multisig (`scripts/mainnet.sh` lists the new order). When Global or the vault already exist, `init-mainnet.ts` compares every identifying field (admin, fee recipient, insurance recipient, migration authority, fees, USDC mint, price authority, paused) and aborts on any difference.

**Tests.** `tests/tests/flow.rs`: a stranger, the wrong program's ProgramData, a made-up account, an unsigned authority and a frozen program are all refused and nothing is created; the upgrade authority succeeds. The programs run natively in program-test, so the tests write a ProgramData account in the loader's real layout; the program code is unchanged.
