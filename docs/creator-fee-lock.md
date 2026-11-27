# Creator fee model: 20% now, 80% at graduation, forfeited after 30 days (APPROVED by the founder on 2026-11-27)

This replaces the 7-day lock (commit 71e8a7a on main, adb222a on the perps branch) in BOTH programs.
`CREATOR_FEE_LOCK_SECONDS` and the time-based unlock are gone.

## Rules
For every creator fee, as it accrues:

    early  = fee * CREATOR_FEE_EARLY_BPS / BPS      (floor)
    locked = fee - early                            (so early + locked == fee exactly)

| Bucket | Launch (`Curve`, SOL) | Perps (`Market`, USDC) | Claimable |
|---|---|---|---|
| early (20%, rounded down) | `creator_fees_owed` | `creator_fees` | at any time |
| locked (80%, gets the rounding remainder) | `creator_fees_locked` (new, last field) | `creator_fees_locked` (new, last field) | only once `curve.complete` (graduation) |

- Claim (`claim_creator_fees`, both programs) pays the early bucket always, plus the locked bucket if
  `curve.complete`. The total must be > 0, else `ZeroAmount`. Perps lowers `vault.reserved` by the amount paid.
- Forfeit (`forfeit_creator_fees`, both programs, permissionless): once
  `now >= curve.created_ts + CREATOR_FEE_FORFEIT_SECONDS` and `!curve.complete`, anyone can move the
  locked bucket to the ecosystem and zero it. Before 30 days, or on a graduated curve, it fails with
  `NotForfeitable`. With nothing locked it fails with `ZeroAmount` (so a second call does nothing). The early
  bucket is never forfeited. Fees keep accruing after a forfeit and lock again.
  - Launch: `curve.creator_fees_locked` lamports go from the curve PDA to `global.fee_recipient`.
  - Perps: `market.creator_fees_locked` is added to `vault.protocol_fees`. No USDC moves.
- Event `CreatorFeesForfeited { mint, amount }` in each program.
- No fee accrues after graduation: `buy`/`sell` refuse a complete curve. A curve that never graduates
  and is never forfeited simply keeps its locked fees in the account.

## Constants (`ringside_launch`, reused by perps)
- `CREATOR_FEE_EARLY_BPS: u64 = 2_000`
- `CREATOR_FEE_FORFEIT_SECONDS: i64 = 30 * 24 * 3600`
- `split_creator_fee(fee) -> (early, locked)` is the single implementation, used by launch `buy`/`sell`
  (through `Curve::add_creator_fee`) and perps `distribute_fee`.

## Where fees accrue (all places)
- Launch `apply_buy` (used by `buy` and by the dev buy inside `create_token`) and `sell`: both call
  `Curve::add_creator_fee`.
- Perps `distribute_fee` (every open, close, liquidation and ADL fee goes through it): the 10% creator share
  is split with `split_creator_fee`.

## Accounting
- Launch: curve lamports = rent + `real_sol` + `creator_fees_owed` + `creator_fees_locked`. Buy sends
  `net_in + creator_fee` into the curve; sell pays out `gross - creator_fee` while `real_sol` drops by `gross`, so
  the creator fee stays behind; claim and forfeit subtract exactly what they zero. `migrate` takes only the
  graduation fee, the pool reserve and the pool SOL out of `real_sol`, so both buckets survive migration
  (asserted in `tests-graduation`: after migrate the curve holds rent + owed + locked, and the creator's claim
  pays both).
- Perps: `vault.reserved` already includes the whole creator share, so splitting it changes nothing there.
  Claim lowers `reserved` by what it pays. Forfeit moves an amount between two buckets that are both inside
  `reserved` (`creator_fees_locked` to `protocol_fees`), so `reserved` is unchanged and no token moves.
  `compound_protocol_fees` then lowers `protocol_fees` and `reserved` together and mints treasury LP shares,
  exactly as for any protocol fee. Tests check `reserved == protocol_fees + creator_fees +
  creator_fees_locked + insurance` after each step.

## Errors (codes are 6000 + index; no existing code moved)
| Program | Error | Code | Status |
|---|---|---|---|
| launch | `CreatorFeesLocked` | 6014 | unused now; kept in place. Message changed to say so |
| launch | `NotForfeitable` | 6015 | new, appended: forfeit before 30 days, or on a graduated curve |
| perps | `CreatorFeesLocked` | 6025 | unused now; kept in place |
| perps | `NotForfeitable` | 6026 | new, appended |

`resize_*` reuses Anchor's own errors: `AccountOwnedByWrongProgram` (3007), `AccountDiscriminatorMismatch`
(3002), `ConstraintSeeds` (2006).

## Instructions
- launch `claim_creator_fees`: accounts unchanged (`creator` signer+mut, `curve` mut, `has_one = creator`).
- launch `forfeit_creator_fees`: `global`, `curve` (mut, PDA seeds), `fee_recipient` (mut, `address = global.fee_recipient`).
  No signer.
- launch `resize_curve`: `payer` (signer, mut), `curve` (unchecked, mut), `system_program`.
- perps `claim_creator_fees`: accounts unchanged from the branch (`curve` is the last, read-only account,
  constrained to `market.curve` and the launch PDA seeds).
- perps `forfeit_creator_fees`: `vault` (mut), `market` (mut, `has_one = curve`), `curve` (PDA seeds of the launch
  program, address = `market.curve`). No signer.
- perps `resize_market`: `payer` (signer, mut), `market` (unchecked, mut), `system_program`.

## Layout change and migration
`Curve` and `Market` each gain `creator_fees_locked: u64` as the LAST field (after `bump`). Both grow by 8 bytes
(`Curve` 1211 -> 1219, `Market` 220 -> 228 total bytes).
- `Market` had no slack: an old market no longer deserializes after the upgrade. `Curve` contains
  `max_len` strings, so most old curves have slack and still read (the new field reads as 0), but
  a curve with maximum-length name, symbol and uri does not. Treat every old account as needing resize.
- Perps also deserializes the launch `Curve` (oracle, create_market, orders), so old curves must be resized
  for perps to work too.
- `resize_curve` / `resize_market` are permissionless. They check owner = this program, the account
  discriminator, and the PDA seeds (derived from the mint stored in the account), then grow the account to
  `8 + INIT_SPACE` with zero-filled new bytes. The payer funds the rent for the extra 8 bytes only (the
  rent difference, not the account's whole balance, which also holds real SOL and fees). They are no-ops on an
  account that is already full size.
- `client/scripts/resize-accounts.ts` finds every Curve and Market by discriminator with raw
  `getProgramAccounts`, resizes the short ones, re-counts, and exits 1 if any remain. `scripts/upgrade.sh` runs it
  right after both programs are upgraded and before the keeper and relayer restart, logging to
  `$LOG/resize.log` with api keys redacted. It costs about 0.00006 SOL per account. A failure stops the upgrade
  script before the services restart; re-run it.
- Order of an upgrade: both programs, then the resize, then the services. Between the upgrade and the resize,
  instructions that read an unresized account can fail.
- The two sizes are hard-coded in the script and pinned by Rust unit tests
  (`curve_account_size_matches_resize_script`, `market_account_size_matches_resize_script`).

## IDLs
`target/idl/*.json` were regenerated by CI (programs workflow, mainnet build) in 690d971 and include
`creator_fees_locked`, `forfeit_creator_fees`, `resize_*`, `CreatorFeesForfeited` and `NotForfeitable`.
The committed IDLs are the mainnet build: the devnet feature puts Raydium's devnet addresses into the launch
IDL. CI fails if they drift from the source; a manual run of the workflow prints regenerated ones.

## Where the forfeited value goes (read this before relying on it)
- Perps: on chain. `protocol_fees` becomes treasury-owned LP shares through the existing
  `compound_protocol_fees` (permissionless; the keeper runs it hourly).
- Launch: the forfeited SOL is paid to `global.fee_recipient`, mixed with ordinary protocol revenue. The treasury
  sweep (`client/scripts/treasury.ts sweep`, or `treasury.ts forfeits` alone) now turns it into protocol-owned
  liquidity automatically, but still OFF chain: no program does it, and it needs a running job, the fee_recipient
  key and Jupiter (mainnet).
  - It scans the launch program's finalized transactions (newest to the stored cursor), keeps the successful ones,
    and reads `CreatorFeesForfeited` from the logs (`Program data:` written by the launch program itself; the
    perps event has the same name and is ignored).
  - It converts exactly `total forfeited - total converted` lamports (never more than the balance above
    `SOL_RESERVE`, nothing below 0.05 SOL; the remainder carries over) to USDC, then `deposit_to_treasury` with the
    USDC received. Only the fee_recipient wallet does this; any other wallet just prints what is pending.
  - `FORFEIT_STATE_FILE` (default `./forfeit-state.json`) holds the cursor, total forfeited, total converted,
    USDC awaiting deposit, total USDC deposited and the last 2000 processed signatures, so re-runs never count a
    transaction twice and an auditor can match the totals to `CreatorFeesForfeited` events and to the vault's
    treasury LP shares. `--dry-run` / `FORFEIT_DRY_RUN=1` reports without sending or writing.
  - Keeper alerts (`ALERT_WEBHOOK_URL`): a forfeit send failing 3 times in a row for an account, and, for the
    graduation steps, migrate or graduate_market failing 3 times in a row or a migrated curve's market still at
    tier 0 after 10 minutes.
- The keeper calls `forfeit_creator_fees` automatically (`forfeit()` in `client/src/keeper.ts`, at most every
  `FORFEIT_EVERY_MS`, default 10 minutes; `FORFEIT_CRANK=0` turns it off). It scans all curves and markets and
  sends the launch forfeit for each curve that is not complete, is past `created_ts` + 30 days (plus a 60 s margin on
  the keeper's own clock) and holds locked lamports, and the perps forfeit for each market with locked USDC whose
  curve meets the same condition. The 30 days are mirrored in `client/src/graduation.ts`
  (`CREATOR_FEE_FORFEIT_SECONDS`). The program still decides; a refusal is logged and retried later.

## Audit notes
- Rounding: early is floored, so the creator never gets more than 20% and the remainder is locked; a fee of 0..4
  has early = 0.
- A creator can graduate their own curve to unlock everything (buying out the curve costs about 88 SOL
  on mainnet, about 1.5 SOL on devnet at 100 bps total fees), as before.
- `complete` is set when the curve sells out, before `migrate`: claims of the locked bucket are allowed from
  sell-out. Forfeit is blocked from that moment too.
- Forfeit can be front-run by a graduation, and graduation by a forfeit: both are decided by `curve.complete`
  at execution time.
- Live curves older than 30 days that never graduated can be forfeited immediately after the upgrade, because
  the rule uses `created_ts`. For existing devnet curves the 80% bucket starts at 0 (the new field is zeroed)
  and only fills from new trades, so the forfeit can only take fees accrued after the upgrade. Fees accrued
  before it stay in `creator_fees_owed`, 100% claimable, exactly as the old rule had them (the 7-day lock is
  removed, so they are claimable now).
- Perps `ClaimCreator` and `ForfeitCreator` read the launch curve through the address constraint on
  `market.curve`, so another token's curve is rejected (`perps_claim_rejects_another_tokens_curve`,
  `perps_forfeit_rejects_wrong_curve`).

## Tests
`tests/tests/flow.rs` (replaces the 7-day tests): `creator_fee_split_is_20_80_floor_and_exact`,
`creator_early_share_claimable_right_after_launch_locked_not_paid`, `creator_claim_after_graduation_pays_everything`,
`forfeit_after_30_days_moves_exactly_the_locked_amount`, `forfeit_on_graduated_curve_fails`,
`forfeit_rejects_wrong_fee_recipient_and_wrong_curve`, `resize_curve_grows_old_account_and_is_noop_on_new_one`,
and the perps equivalents (`perps_creator_fee_split_is_20_80`, `perps_early_share_claimable_right_after_launch_locked_not_paid`,
`perps_claim_after_graduation_pays_everything`, `perps_forfeit_after_30_days_moves_locked_into_protocol_fees_then_compounds`,
`perps_forfeit_on_graduated_curve_fails`, `perps_forfeit_rejects_wrong_curve`,
`resize_market_grows_old_account_and_is_noop_on_new_one`, `perps_claim_rejects_another_tokens_curve`).
`tests-graduation` checks the fee buckets survive `migrate`. Unit test `creator_fee_split_floors_early_and_sums_exactly`
in the launch crate.
