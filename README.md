# Ringside

A Solana token launchpad that gives every token a perpetual futures market from its first block. Tokens graduate to Raydium when their curve sells out, and Helius Solana Privacy Rings handle private funding and payouts.

**Status: running end to end on devnet, not audited.** Don't deploy to mainnet with real funds until the launch checklist in the spec (Roadmap → Mainnet launch checklist) is complete.

## Security

This code is public and **unaudited**. Treat it as a reference for review, not something to deploy.

- **Report vulnerabilities privately.** Use GitHub's private vulnerability reporting on this repo (Security → Report a vulnerability). Please don't open public issues for security bugs. A paid bounty will run on Immunefi before mainnet deposits open.
- **Scope that matters most:** the graduation CPI into Raydium (lamport accounting, SBF stack frames), mark pricing (curve price, pool TWAP, the price band), Pyth parsing, LP share pricing and the withdrawal delay, per-market loss budgets and ADL, and the admin handover.
- **Mainnet keys:** upgrade authority, admin and treasury go to a Squads multisig; the manual SOL price authority goes to a key nobody holds. `init-mainnet.ts` refuses a single-key upgrade authority.
- **Privacy:** Helius Rings' first mainnet ring hides amounts, not who sent to whom. Don't rely on Ringside's private funding to unlink wallets until that's verified on chain.
- **No licence.** All rights reserved; you may read the code, not reuse it.

## What works on devnet today

| Flow | Verified |
| --- | --- |
| Launch a token on the bonding curve, buy and sell | App click-through and smoke test |
| Perp market from launch: open and close through the relayer (trading account holds 0 SOL), keeper fills | App click-through, sponsored-order test |
| Private funding with Rings: shield in, fund a fresh trading account, trade, shield out | `rings-devnet.ts` |
| Graduation: curve sells out → keeper migrates to a Raydium CPMM pool at the curve's final price, LP burned → perp market moves to Tier 1 and prices from the pool | `graduation-devnet.ts`, plus buy/sell on Raydium and a perp round trip on a graduated token in the app |
| SOL/USD from Pyth (sponsored feed, or the keeper's own verified update) | `graduation-devnet.ts` step 2 |

## Layout

| Path | What it is |
| --- | --- |
| `programs/ringside_launch` | Token creation, 800M-token constant-product bonding curve, TWAP accumulator, 7-day dev-buy lock, permissionless `migrate` into Raydium CPMM |
| `programs/ringside_perps` | USDC vault, per-token markets, two-step orders, funding, liquidation, risk budget, ADL, `graduate_market` (pool TWAP pricing), `refresh_sol_price` (Pyth) |
| `client/src/keeper.ts` | Fills orders, liquidates, cranks funding and the band, runs ADL, refreshes Pyth, migrates sold-out curves and graduates their markets |
| `client/src/relayer.ts` | Fee relayer: co-signs for trading accounts after policy checks and a simulated spend cap |
| `client/src/rings.ts` | Rings privacy rails: shield in, fund a trading account, shield out, private payouts |
| `client/src/graduation.ts`, `client/src/pyth.ts` | Raydium addresses and migrate/graduate instructions; Pyth poster |
| `client/app` | Devnet web app (Vite): launch, spot (curve or Raydium), perps via the relayer, positions, faucet |
| `tests/tests/flow.rs` | End-to-end test: launch, buy, LP deposit, market, caps, open, close, skew cap, crash and liquidation |
| `tests-graduation/` | Graduation test against Raydium's real CPMM program (vendored at b0b2a08) and byte copies of the live devnet config and fee accounts |
| `sim/` | `risk_sim.py` (synthetic model, manipulation study) and `replay.py` (replay of the program's rules on real pump.fun price paths) |

## Build and test

```sh
cargo test -p ringside_perps -p ringside_launch     # unit tests, incl. Pyth parsing on live account bytes and pool TWAP
(cd tests && cargo test)                           # end-to-end perps flow
(cd tests-graduation && cargo test)                # migrate into real Raydium CPMM, graduate_market, pool dump vs band
(cd client && npm i && npm test)                   # relayer policy, server and address tests (16)
python3 sim/replay.py sim/data/launch-data.json    # risk replay on real launch data, ~10 s
anchor build -- --features devnet                  # SBF build (Anchor 0.31.1); check for stack-frame warnings
```

The `devnet` feature gives curves 0.5 virtual SOL (so a curve sells out for ~1.5 SOL), uses Raydium's devnet program and config, and allows larger caps for testing. Build without it for mainnet.

## Devnet

- `bash scripts/devnet.sh` — first-time setup: toolchain, wallet, build, deploy, smoke test.
- `bash scripts/upgrade.sh` — rebuilds with the devnet feature, **refuses to deploy if any function overflows the 4 KB SBF stack frame**, upgrades only programs that changed, restarts the keeper and relayer, and runs the graduation and Pyth test.
- `bash scripts/services.sh` / `scripts/app.sh` — keeper and relayer, then the web app on :5173.
- On Windows, run these in WSL (Ubuntu) from a copy in the Linux home; the `.bat` launchers in Documents do that.

## Mainnet

`bash scripts/mainnet.sh` builds without the devnet feature, stops on stack warnings, and prints the deploy and configuration steps. `client/scripts/init-mainnet.ts` sets the launch fees, creates the vault, sets the 1.5% cap and 25% skew limit, and hands the manual SOL price authority to a key nobody holds. It refuses to run against a devnet RPC or with a program whose upgrade authority is a single key, unless told otherwise. Run it only after the audits.

## Operations

- **Alerts.** The keeper posts to `ALERT_WEBHOOK_URL` (Slack or Discord) when the SOL price is over 90 s old, an order sits 30+ slots past its fill delay, a market goes reduce-only or into ADL, the keeper or relayer drops below 0.2 SOL, or the loop fails 5 times in a row. Each alert fires once and again when it clears (repeated hourly while open). `GET :8789/health` returns 503 when the loop hasn't succeeded for a minute.
- **Sponsorship fee.** With `FEE_RECOVERY_TREASURY` set, the relayer requires a small USDC transfer to that treasury in each sponsored order; the app adds it automatically from `/v1/info`.
- **Protocol-owned liquidity ($RING).** The keeper compounds protocol fees into treasury LP shares hourly (`COMPOUND_PROTOCOL_FEES=0` turns it off). `npx tsx scripts/treasury.ts sweep` (treasury key as `ANCHOR_WALLET`, `RING_MINT` set) claims $RING's creator fees and deposits them; `treasury.ts limits <mint> 0 1` keeps $RING's market reduce-only. See the spec's $RING section.

## Key design choices

- **Quanto contracts.** PnL = notional × (mark / entry − 1). The mark is the token's SOL price; PnL is paid in USDC. No external oracle is needed for a token that exists nowhere else.
- **Mark = 5-minute TWAP, clamped to ±15% per window** — the curve's TWAP before graduation, Raydium's observation TWAP after. Graduation restarts the band at the curve's final price, which the pool opens at exactly.
- **Worst-of fills.** Opening pays the worse of mark and spot; closing gets the worse too. Liquidation uses the mark alone.
- **OI cap = 1.5% of the SOL behind the price** (virtual curve SOL, or pool SOL after graduation), the vault's net exposure capped at 25% of that. Set from the real-data replay: at 2% a patient attacker pumping a quiet curve roughly breaks even. Each side may hold up to **2x the cap** (`GROSS_CAP_MULT`), because the vault only carries the imbalance: in the replay (`sim/gross_check.py`, `sim/results-gross.json`) that doubled fees with unchanged tail losses, while 3x worsened the worst case under heavy one-sided demand.
- **Risk budget per market** (0.25% of LP value at Tier 0, 1% at Tier 1). Past it the market goes reduce-only and keepers ADL profitable positions.
- **SOL/USD only sizes caps.** It comes from Pyth: fully verified, under 60 s old, confidence within 2%.
- **Graduation is permissionless.** Anyone can call `migrate` and `graduate_market`; every Raydium account is checked against addresses derived from the token.
- **Rings for unlinkability, not hidden positions.** Positions are public; Rings break the link between a trader's identity wallet and their trading account.

## Lessons from devnet (kept here so they aren't relearned)

- The SBF runtime checks lamport sums across the accounts of each CPI: an account whose lamports a program changes by hand must ride along on the next CPI. The system program accepts extra accounts; the token program does not.
- SBF gives each function a 4 KB stack frame and only warns at build time when one overflows. An 8-byte overflow in Anchor's account loading corrupted an account pointer at runtime. Keep big accounts boxed or out of `try_accounts`, and keep `upgrade.sh`'s stack check.
- Pyth's Hermes needs an API key since Aug 2026; devnet's sponsored SOL/USD feed updates in bursts.
