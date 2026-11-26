# Creator fee lock (DRAFT, needs founder approval before audit)

## Change
`claim_creator_fees` (launch program) now requires `curve.complete` OR
`now >= curve.created_ts + CREATOR_FEE_LOCK_SECONDS`. Otherwise it fails with the new
error `CreatorFeesLocked`. `CREATOR_FEE_LOCK_SECONDS = 7 * 24 * 3600` is a plain constant.
No curve fees accrue after graduation: `buy` and `sell` refuse a complete curve.

## Rationale
Creator fees accrue on every curve trade. Until now a creator could claim them at
any time, including on launch day while dumping. The lock removes that early payout.
Nothing is forfeited: the fees stay in `creator_fees_owed` and become claimable on
graduation or after 7 days, whichever comes first. This mirrors the existing
7-day dev-token lock (`DEV_LOCK_SECONDS`).

A constant, not a `Global` param: `Global` has no spare space, so a param would change its layout.

## Account layout impact: none
`Curve` already stores `created_ts` (set from `Clock` in `create_token`), so the
lock reuses it. No field added, none reordered, no realloc, no migration. No new
event: `claim_creator_fees` emits none, and the unlock time is derivable as
`created_ts + 7d` (the client can show "claimable from <date>" without a program change).

## Upgrade path for deployed devnet curves
Upgrade the program in place (`scripts/upgrade.sh`). Existing curves carry a valid
`created_ts`, so the rule applies to them immediately: curves older than 7 days or
already complete are unaffected; younger ones lock until `created_ts + 7d`. No
per-account action is needed. Note that `treasury.ts` already uses `trySend`
for the launch claim, so a locked claim logs a failure rather than aborting.

## Audit notes
- `complete` is set when the curve sells out, before `migrate`, so claims are
  allowed between sell-out and migration. Intended ("coin graduates").
- Perps `claim_creator_fees` is a separate instruction and is NOT changed here. It pays
  the creator's 10% share of perp trading fees at any time, including launch day, so
  "no early payout" holds for curve fees only. It is not a bypass (wash-trading perps
  costs the full fee to earn back 10%). Founder decision: leave it, or apply the same
  rule in perps using the launch `Curve` it already reads.
- Buying out your own curve unlocks fees early; that is the graduation case. Cost from
  zero at 100 bps total fees: about 88 SOL on mainnet (30 virtual SOL), about 1.5 SOL
  on devnet, and the tokens can only be sold into the new pool.
- `target/idl/ringside_launch.json` was already stale relative to lib.rs (it lacks
  several errors and instructions); regenerate it with `anchor build` (adds error 6014, `CreatorFeesLocked`).
- Tests: `creator_fees_locked_for_seven_days`, `creator_fees_claimable_right_after_graduation`
  in `tests/tests/flow.rs`.
