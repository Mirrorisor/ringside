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

## F8 (medium): the launch admin could set any graduation fee

**What.** `set_fees` accepted any launch and graduation fee. `migrate` is permissionless and pays the graduation fee out of the SOL the curve raised, so a fee close to the raise would divert it, and a slightly higher one would make every migration fail. There was also no setter for the recipients or rates, and `migration_authority` was stored but never read.

**Fix.**
- Hard caps in the launch program, enforced by `set_fees` and `initialize_global`: launch fee at most `MAX_LAUNCH_FEE_LAMPORTS` (0.5 SOL); graduation fee at most `MAX_GRADUATION_FEE_LAMPORTS` (2 SOL, 0.1 SOL with the `devnet` feature) and at most `MAX_GRADUATION_FEE_BPS_OF_RAISED` (10%) of the SOL a sold-out curve raises (`graduation_raised_lamports()`, about 87.9 SOL mainnet, 1.46 SOL devnet). The caps sit above the values in use (mainnet 0.02 and 1.5 SOL, devnet 0.05 SOL). Trade fees stay capped at 5% in total (`MAX_TOTAL_TRADE_FEE_BPS`, the sum is now computed in u64).
- `migrate` also clamps the stored fee to the same bound (`graduation_split`), so a value stored before the caps cannot drain a curve.
- Recipients and fee rates have no setter and are fixed at `initialize_global`; a timelocked change was left out as not small enough to add safely. `init-mainnet.ts` now refuses the deployer key or the system address as a recipient, checks its own fees against the caps and prints that the recipients are final. `migration_authority` is kept for layout compatibility and documented as unused.
- New errors, appended at the end of `LaunchError`: `GraduationFeeAboveCap`, `LaunchFeeAboveCap`. No account layout change.

**Tests.** `tests/tests/flow.rs`: fees above the caps (including "raise minus 0.2 SOL" and `u64::MAX`) fail and change nothing, the caps themselves succeed, a stranger cannot call `set_fees`, `initialize_global` refuses an over-cap fee. Unit tests: the caps for both feature sets, and `migrate`'s split leaves the pool funded at the maximum fee on a real sell-out.

## F12 (low): the Raydium create-pool fee was assumed to fit the 0.2 SOL reserve

**What.** `migrate` keeps `POOL_CREATION_RESERVE` (0.2 SOL) for Raydium's create-pool fee (0.15 SOL) and rents. If Raydium raised the fee, the pool creation would fail with an opaque Raydium error.

**Fix.** `migrate` reads `create_pool_fee` from Raydium's AmmConfig and fails first with `PoolReserveTooSmall` if the fee plus `RAYDIUM_RENT_ALLOWANCE` (0.05 SOL) no longer fits the reserve. The constants are documented where they are defined, and the README says to upgrade the program with a larger reserve if that happens. New error `PoolReserveTooSmall`, appended last. No other behaviour change.

**Tests.** Unit: the fee is read correctly from the bytes of the live devnet config (0.15 SOL), a short account is rejected, the boundary of the check.

## Info items

- **Last buy off by one lamport.** On the buy that sells out the curve, `quote_buy` rounded the gross amount up and could charge 1 lamport more than the buyer offered. It is now capped at the offered amount (the surplus is fee). Unit test sweeps offers around the finishing price on five curve states.
- **Docs aligned with code.** SOL/USD may be up to 120 s old (`SOL_PRICE_MAX_AGE`, the README said 60 s); the OI cap default on chain is 1% and `init-mainnet.ts` sets 1.5%. `docs/creator-fee-lock.md` is marked as approved by the founder (2026-11-27).

## Ops: forfeit scan starting point

**What.** The first `treasury.ts forfeits` run with no state file read the launch program's entire signature history.

**Fix.** With no state file the scan now refuses unless `FORFEIT_START_SIGNATURE` (becomes the cursor) or `FORFEIT_START_SLOT` (older transactions are ignored, remembered in the state file as `startSlot`) is set; setting both, or a malformed value, is an error. An existing state file always wins. Logic in `client/src/forfeits.ts` (`parseStart`, `seedState`, `limitToSlot`).

**Tests.** `client/test/forfeits.test.mjs`: refusal message, signature and slot seeding (also surviving an empty scan), existing state wins, input validation, slot trimming.

## F7 (medium): anyone could fill an order at any later time, and the app set no price limit

**What.** `execute_order` is open to any signer and only had a minimum age; the 150-slot expiry gated only the owner's cancel. The app sent an acceptable price of 0, which the program read as "no limit".

**Fix.**
- `request_order` refuses a zero `acceptable_price_q64` for every order, open or close (new error `AcceptablePriceRequired`). `execute_order` always checks the bound; the fill logic is unchanged (worst of mark and spot, caps for an increase long or a close short, floors for the others).
- `execute_order` never fills an order at or after `request_slot + ORDER_EXPIRY_SLOTS`. It refunds the escrow to the owner and closes the order instead (`OrderRejected`, reason 1), so anyone can clear an expired order and the keeper's queue cannot stick. `cancel_order` (owner, same slot threshold) still works. `OrderRejected.reason`: 0 price outside the bound, 1 expired, 2 new open on a pool with no history (F6), 3 increase queued before a pause (F5).
- App: the order ticket has a slippage setting (default 1%, at most 5%, `DEFAULT_SLIPPAGE_BPS` / `MAX_SLIPPAGE_BPS` in `client/src/perps/math.ts`). The acceptable price is the current fill price (worse of mark and spot) moved by it, for opens and closes, and the ticket shows the limit. `buildOrderInstruction` refuses an order with no non-zero bound and slippage above 5%. The copy engine bounds perp orders the same way (slippage capped at 5%) and refuses to build one with no reference price. The devnet scripts bound at 50% around the market's band anchor.

**Upgrade.** None. An order placed before the upgrade with a zero bound is refunded at fill if it is an open, and is filled as a close with no floor only inside its 150 slots.

**Tests.** `tests/tests/flow.rs`: `orders_need_a_non_zero_acceptable_price`, `a_price_outside_the_bound_refunds_the_order`, `an_expired_order_is_never_filled_and_always_refundable` (refund by execute, by the owner's cancel, and a fill just inside the expiry). `client/test/perps.test.mjs`: builder and slippage rules.

## F6 (medium): the pool TWAP fell back to the live pool price

**What.** `pool_twap_x32` returned the instantaneous pool price when there was no observation history, only Raydium's first observation, or the newest observation was over 300 s old, and it extended the cumulative to now at the live price. It also read raw vault balances, which include Raydium's accrued fees and any donation.

**Fix.**
- The mark never uses the live pool price. `pool_twap_x32` now returns a TWAP only when an observation at least 300 s old exists and the newest observation has a predecessor to take a price from; the cumulative is extended from the newest observation to now at the last observed price (the average over the newest observed interval), so a stale newest observation or a donation cannot move it.
- Until then (a fresh graduation) the market is priced at the curve's final price, stored at `graduate_market` in `Market.grad_price_q64` (markets that graduated before it existed use their band anchor). `PriceView.warming` is set, closes work at that price with the band applied, and an open or increase is refunded at fill (`OrderRejected`, reason 2).
- Vault balances are net of the pool's accrued protocol, fund and creator fees (PoolState offsets 341, 357, 397; older pool accounts hold zero at 397) wherever they are used: spot, the OI cap's SOL reserve. Spot still takes part in the worst-of fill, which can only make a fill worse for the trader.
- `Market` grows by `grad_price_q64`, `vol_snap_slot`, `vol_snap_fees` (see F4), 292 bytes in all. The app and `client/src/perps/pool.ts` mirror the rules.

**Upgrade.** Run `resize_market` on every market (`client/scripts/resize-accounts.ts`, run by `scripts/upgrade.sh`; `MARKET_LEN` is now 292) before the keeper and relayer restart. The new fields read as zero. Pools that are already graduated need observation history to open again: any swap, then 5 minutes.

**Tests.** `tests-graduation/tests/pool_twap.rs`: a swap and crank in one transaction on a fresh pool do not move the mark; opens are refused until the pool has history, then fill, and a position opened before graduation closes with no history; the mark follows the TWAP once history exists; a donation to both vaults does not move the mark; the fee offsets match Raydium's real `PoolState`. `graduation.rs` follows the mark through a dump with the extra observation. Unit tests in `lib.rs` cover the TWAP edge cases.

## F4 (high): the Tier 0 market cap could be filled cheaply

**What.** `create_market` is permissionless and a slot freed only on graduation or after 7 days with no curve trade at all, so a dust trade kept a slot alive.

**Fix.**
- Volume based retirement. A Tier 0 market keeps a window start (`vol_snap_slot`, `vol_snap_fees`: the slot and the curve's `creator_fees_locked` then). That counter grows with every curve trade and only falls on a forfeit or a post-sellout claim, so it is a cheap volume proxy that needs nothing from the launch program. `retire_market` is allowed with no open interest when the window is at least `RETIRE_IDLE_SLOTS` (~7 days) old and the counter grew by less than `RETIRE_MAX_VOLUME_FEES` (12,000,000 lamports on mainnet, about 5 SOL of volume at the 30 bps creator fee; 200,000 on devnet), or, as before, when the curve has had no trade for that long. A fall in the counter is never quiet. `crank_funding` starts the window when there is none and rolls it forward after a full window with enough volume.
- New `admin_retire_market`: the vault authority retires any Tier 0 market with no open interest at any time.
- Not done: a minimum curve depth at `create_market`. The launch flow creates the token and the market back to back, and a depth check at creation would not stop an attacker from buying in and selling out afterwards. The volume rule is what makes holding a slot cost money.

**Upgrade.** `resize_market` (above). A market created before the upgrade starts its window at the keeper's next `crank_funding`; the old no-trade-for-7-days rule still applies to it meanwhile.

**Tests.** `tests/tests/flow.rs`: `retire_by_volume_dust_does_not_keep_a_slot_alive`, `retire_by_volume_real_volume_keeps_the_market`, `retire_requires_no_open_interest_and_admin_retires_any_flat_market`; unit test `retirement_windows`.

## F11 (low): `graduate_market` wiped an admin's reduce-only setting

**What.** `graduate_market` set `reduce_only = adl_mode`.

**Fix.** It now keeps the flag: `reduce_only = adl_mode || (reduce_only && market was not retired)`. Retirement also sets the flag and ends at graduation, because the market is live again at Tier 1.

**Tests.** `tests-graduation/tests/pool_twap.rs`: `graduation_keeps_an_admin_reduce_only_setting`, `graduation_clears_only_the_retirement_flag`.

## F13 (low): the first `create_market` caller set the band anchor from the instantaneous curve price

**What.** The anchor was `curve.last_price_q64`, so pumping the curve, creating the market and selling back parked the band far from fair value.

**Fix.** The anchor is the curve's TWAP over the 750-slot window (`curve.twap_q64`, the same read Tier 0 pricing uses).

**Tests.** `tests/tests/flow.rs`: `market_anchor_is_the_curve_twap_not_its_instantaneous_price`.

## F2 (high): an unlocked LP withdrawal request was a permanent, free exit

**What.** `withdraw_liquidity` only required `now >= unlock_ts`. A request never expired, its shares kept earning, and cancelling was free, so after one request and the 24 h wait an LP could leave instantly at any later moment, for example ahead of a large trader profit or ADL (LP assets exclude unrealised trader PnL).

**Fix.**
- Claim window: a request can be completed from `unlock_ts` to `unlock_ts + WITHDRAWAL_WINDOW_SECONDS` (24 h; 600 s with the `devnet` feature). After that it is expired: completing fails with `WithdrawalExpired`, and requesting again restarts the delay (the shares stay in the request until completed or cancelled).
- Lower-of price: `request_withdrawal` records the vault's LP assets and total shares (`request_assets`, `request_total_shares`, appended to `WithdrawalRequest`). `withdraw_liquidity` pays the lower of the value of the shares at that recorded price and at the current one. A gain after the request stays with the remaining LPs; a loss is borne by the leaver. Any later `request_withdrawal` on the same request refreshes the recorded price and restarts the delay, so it can only be re-recorded at a cost of another wait.
- `request_withdrawal` now takes `vault` and `vault_usdc` (read-only) to read the price.

**Upgrade.** `WithdrawalRequest` grew by 16 bytes (73 bytes with the discriminator). Existing requests must be grown with the permissionless `resize_withdrawal` (`client/scripts/resize-accounts.ts` does it, run by `scripts/upgrade.sh`); a stored `request_total_shares` of zero means "no recorded price" and is paid at the current price. Requests made before the upgrade have normally passed their window and need a new request anyway; they can be cancelled after the resize.

**Tests.** `tests/tests/flow.rs`: `f2_expired_withdrawal_cannot_complete_and_re_request_restarts_the_delay` (last second of the window pays, the next is refused, re-request is locked again and burns exactly the request's shares) and `f2_withdrawal_pays_the_lower_of_request_and_completion_price` (price up and price down).

## F9 (medium): first-depositor and empty-vault share inflation

**What.** `shares_for` minted 1:1 into an empty vault and whenever LP assets were zero. An attacker could deposit one unit, donate USDC straight to the vault's token account, and leave the next depositor with about one share; and a vault with shares but no assets minted new deposits against worthless old shares.

**Fix.** Every share/asset conversion adds `VIRTUAL_SHARES = 1_000` and `VIRTUAL_ASSETS = 1` to the pool (`shares_for` on deposit, `assets_for_shares` on redeem), both rounding down so the vault keeps the remainder. Donated USDC is mostly absorbed by the virtual shares, so the attack loses money and a victim's rounding loss is under one share. Deposits (`deposit_liquidity`, `deposit_to_treasury`) and `compound_protocol_fees` are refused with `VaultHasNoAssets` while shares exist but LP assets are zero. Share counts are `u64`, so a vault's shares are checked against overflow (about 18 billion USDC at the initial price of 1 unit per thousand shares).

**Upgrade.** None for accounts. On a vault whose shares were minted 1:1, the virtual shares own `VIRTUAL_SHARES / (total_shares + VIRTUAL_SHARES)` of the pool (0.0001% of a $1,000 vault), so share values drop by that much on upgrade.

**Tests.** Unit: donation attack, zero-asset refusal, rounding in the vault's favour (`programs/ringside_perps`). `tests/tests/flow.rs`: `f9_donation_to_an_empty_vault_does_not_steal_the_next_deposit`, `f9_vault_with_shares_but_no_assets_refuses_deposits`.

## F5 (medium): perps could never be paused, and insurance was never spent

**What.** `vault.paused` was only ever written to false. `market.insurance` only grew, was excluded from LP assets, yet `check_budget` counted it as offsetting trader profit.

**Fix.**
- `set_paused(paused)` (vault admin). While paused: `request_order` increases and `deposit_liquidity` / `deposit_to_treasury` fail with `Paused`, and `execute_order` refunds an increase queued before the pause (`OrderRejected`, reason 3). Still allowed: close and reduce orders (request and fill), `cancel_order`, `liquidate`, `auto_deleverage`, all three LP withdrawal steps, `crank_funding`, `refresh_sol_price`, `compound_protocol_fees`, fee claims, market admin calls and `graduate_market`. (`request_order` used to refuse closes too once paused.)
- Insurance rule: after every settlement (close, liquidation, ADL) the market's insurance is applied to its net trader profit `trader_net_pnl` (what LPs have lost on that market, including losses beyond a trader's collateral): `spend = min(insurance, trader_net_pnl)` leaves `market.insurance` and `vault.reserved` and reduces `trader_net_pnl` by the same amount. The USDC stays in the vault and becomes LP assets, so LPs bear a payout only after the market's insurance is used up. Afterwards a market has no insurance or no net profit, so `trader_net_pnl` is net of insurance, `check_budget` compares it directly with the budget, and unspent insurance never offsets anything. `vault.reserved` stays equal to protocol fees + creator fees + insurance. New events `PausedSet`, `InsuranceSpent`.

**Upgrade.** No layout change. Existing markets' `trader_net_pnl` is gross of insurance until their next settlement, when the rule applies to all of it.

**Tests.** `f5_pause_is_admin_only_blocks_opens_and_deposits_but_not_exits` (non-admin refused; opens, deposits blocked; queued increase refunded; close, withdrawal, liquidation allowed; resume) and `f5_insurance_pays_a_profitable_close_before_lps_do` (LP assets change by exactly the insurance spent, with and without insurance). Unit tests cover the sweep and budget.

## F10 (low): ADL mode never cleared, and anyone could ADL any winner

**What.** The budget compares lifetime net trader profit with the current LP value, so LP withdrawals alone could tip a market into ADL for good, and in ADL anyone could force-close any profitable position at the mark.

**Fix.**
- `check_budget` clears `adl_mode` when `trader_net_pnl` is at or under 80% of the budget (`ADL_CLEAR_BPS`), wherever it runs (fills, liquidations) and at the start of `auto_deleverage`, which then returns without closing anything. `reduce_only` stays set (it can also be set by hand); the admin lifts it with `set_market_limits(…, false)`.
- ADL ordering cannot be enforced on chain: the program cannot list a market's positions, and a caller can always omit a better one. What is enforced: remaining accounts after the price accounts (Tier 1+: after the 4 pool accounts) are other positions of the same market, and each must have a profit ratio (PnL net of funding / collateral) no higher than the target's, else `AdlWrongTarget`. The keeper passes the next-ranked positions and retries without them if its estimate disagrees with the real mark. There is no keeper role on chain to restrict the call to. ADL still pays at the mark (better than the worst-of fill of a voluntary close) and charges no fee, so a forced close costs the target only its future upside.

**Tests.** `f10_adl_mode_clears_once_the_market_recovers_and_not_before` (hysteresis, clearing call closes nobody, admin reopens) and `f10_adl_rejects_a_target_when_a_higher_profit_ratio_position_is_passed`. Unit test for the budget and hysteresis. `client/test/adl-rank.test.mjs` for the keeper's order.
