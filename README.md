# Ringside

A Solana token launchpad that gives every token a perpetual futures market from its first block. Tokens graduate to Raydium when their curve sells out, and Helius Solana Privacy Rings handle private funding and payouts.

**Status: running end to end on devnet, not audited.** Don't deploy to mainnet with real funds until the launch checklist in the spec (Roadmap → Mainnet launch checklist) is complete.

## Security

This code is public and **unaudited**. Treat it as a reference for review, not something to deploy.

- **Report vulnerabilities privately.** Use GitHub's private vulnerability reporting on this repo (Security → Report a vulnerability). Please don't open public issues for security bugs. A paid bounty will run on Immunefi before mainnet deposits open.
- **Scope that matters most:** the graduation CPI into Raydium (lamport accounting, SBF stack frames), mark pricing (curve price, pool TWAP, the price band), Pyth parsing, LP share pricing and the withdrawal delay, per-market loss budgets and ADL, and the admin handover.
- **Mainnet keys:** upgrade authority, admin and treasury go to a Squads multisig; the manual SOL price authority goes to a key nobody holds. `initialize_global` and `initialize_vault` accept only the program's upgrade authority, so initialize first (deployer key) and then hand the upgrade authority to the multisig; `init-mainnet.ts` checks every field of anything already initialized. Fixes from the pre-audit review are listed in [docs/security-fixes.md](docs/security-fixes.md).
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
| `client/src/keeper.ts` | Fills orders, liquidates, cranks funding and the band, runs ADL, refreshes Pyth, migrates sold-out curves and graduates their markets, forfeits non-graduated creator fees after 30 days |
| `client/src/relayer.ts` | Fee relayer: co-signs for trading accounts after policy checks and a simulated spend cap |
| `client/src/rings.ts` | Rings privacy rails: shield in, fund a trading account, shield out, private payouts |
| `client/src/graduation.ts`, `client/src/pyth.ts` | Raydium addresses and migrate/graduate instructions; Pyth poster |
| `client/app` | Devnet web app (Vite): launch, spot (curve or Raydium), perps via the relayer, positions, faucet |
| `tests/tests/flow.rs` | End-to-end test: launch, buy, LP deposit, market, caps, open, close, skew cap, crash and liquidation |
| `tests-graduation/` | Graduation tests (including the pool pre-creation and pre-funding cases) against Raydium's real CPMM program (vendored at b0b2a08) and byte copies of the live devnet config and fee accounts |
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
- `bash scripts/services.sh` / `scripts/app.sh` — keeper and relayer, then the web app on :5173. `services.sh start|stop|status indexer|social|sponsor` manages the backend services (see Services).
- On Windows, run these in WSL (Ubuntu) from a copy in the Linux home; the `.bat` launchers in Documents do that.

## Mainnet

`bash scripts/mainnet.sh` builds without the devnet feature, stops on stack warnings, and prints the deploy and configuration steps. `client/scripts/init-mainnet.ts` sets the launch fees, creates the vault, sets the OI cap to 1.5% (the program's default is 1%, so the script's 1.5% is what runs on mainnet) and the 25% skew limit, and hands the manual SOL price authority to a key nobody holds. It must be run by the programs' upgrade authority (the deployer key, before the handover to the multisig), refuses to run against a devnet RPC, and aborts if Global or the vault already exist with any different field. Run it only after the audits.

## Operations

- **Alerts.** The keeper posts to `ALERT_WEBHOOK_URL` (Slack or Discord) when the SOL price is over 90 s old, an order sits 30+ slots past its fill delay, a market goes reduce-only or into ADL, the keeper or relayer drops below 0.2 SOL, the loop fails 5 times in a row, a forfeit, migrate or graduate_market send for one account fails 3 times in a row, or a migrated curve's market is still tier 0 more than 10 minutes after the migration. Each alert fires once and again when it clears (repeated hourly while open). `GET :8789/health` returns 503 when the loop hasn't succeeded for a minute.
- **Creator-fee forfeit.** The keeper forfeits the locked 80% of creator fees on curves that have not graduated 30 days after launch (every 10 minutes at most, `FORFEIT_EVERY_MS`; `FORFEIT_CRANK=0` turns it off).
- **Forfeited SOL becomes protocol-owned liquidity.** `npx tsx scripts/treasury.ts forfeits [--dry-run]` (also the first step of `sweep`) scans the launch program's finalized transactions for `CreatorFeesForfeited`, and when the running wallet is the `fee_recipient` swaps exactly the forfeited-but-unconverted SOL to USDC (mainnet, Jupiter, keeping `SOL_RESERVE`) and calls `deposit_to_treasury`. Cursor, running totals and processed signatures live in `FORFEIT_STATE_FILE` (default `./forfeit-state.json`; keep it between runs, it is the audit trail). `--dry-run` / `FORFEIT_DRY_RUN=1` reports without sending or writing. **First run:** with no state file it refuses to read the launch program's whole history; set `FORFEIT_START_SIGNATURE` (any launch-program transaction signature from before the first forfeit, which can only happen 30 days after the 20/80 upgrade; it becomes the cursor) or `FORFEIT_START_SLOT` (older transactions are ignored). Both are ignored once the state file exists.
- **Sponsorship fee.** With `FEE_RECOVERY_TREASURY` set, the relayer requires a small USDC transfer to that treasury in each sponsored order; the app adds it automatically from `/v1/info`.
- **Protocol-owned liquidity ($RING).** The keeper compounds protocol fees into treasury LP shares hourly (`COMPOUND_PROTOCOL_FEES=0` turns it off). `npx tsx scripts/treasury.ts sweep` (treasury key as `ANCHOR_WALLET`, `RING_MINT` set) claims $RING's creator fees and deposits them; `treasury.ts limits <mint> 0 1` keeps $RING's market reduce-only. See the spec's $RING section.

## Services

The backend for the social trading app lives in `client/src`. Build once with `cd client && npm run build`, then run each service from `client/` with `node dist/<entry>.js`, or use `bash scripts/services.sh start|stop|status <service>...` (pid files and logs in `$LOG_DIR`, default `Documents/ringside-logs`). The script sets ports 8790 (indexer), 8791 (social), 8792 (sponsor) and 8793 (copy); the services' own defaults differ where noted, because 8787 is the relayer and 8788 the devnet faucet. Secrets come from the environment and are never printed by the script. "Required" means the process refuses to start without it.

**Safety defaults**

- **Session secret:** at least 32 bytes (`MIN_SECRET_BYTES` in `session.ts`); a shorter one stops the service at startup.
- **Token audiences:** the social backend mints three tokens per sign-in, with `aud` set to `social`, `copy` and `sponsor`. Each service accepts only its own audience, so a token for one service is useless at another. Tokens live 12 h (`SOCIAL_SESSION_TTL_SECONDS`) and `verifySessionToken` refuses any claiming more than 7 days.
- **Anonymous sponsor:** `SPONSOR_ALLOW_ANON=1` is for devnet only. It takes effect only when no session secret is set, and is refused when `RPC_URL` contains `mainnet`. Without a secret and without it, the sponsor will not start.
- **Copy perps:** `RINGSIDE_COPY_PERPS` is off unless it is exactly `1`. Even on, building a perp copy is refused when the copy RPC URL contains `mainnet` (devnet only).
- **CORS:** the sponsor and copy services take one exact origin; copy refuses `*`, the sponsor only warns. Social takes a comma-separated list of exact origins, no `*`.
- **Revocation gap:** logout is enforced only where the social store is injected; the sponsor and a separate copy process cannot see it, so the token lifetime bounds the exposure.

### Indexer (`client/src/indexer/main.ts`)

Receives Helius webhooks, stores trades, SOL transfers and launches in SQLite, and serves the feed, wallet stats, token risk flags and leaderboard. Payloads in Helius's enhanced-transaction format and in the newer parsed-events format are both parsed. Sponsor, relayer and fee wallets (`INDEXER_SPONSOR_ADDRESSES`) are never taken as the trader.

Run: `HELIUS_WEBHOOK_SECRET=... node dist/indexer/main.js`. Routes: `POST /webhooks/helius`, `GET /feed`, `/wallet/:addr`, `/token/:mint/flags`, `/leaderboard`, `/health`.

| Variable | Default | Required | Purpose |
| --- | --- | --- | --- |
| `HELIUS_WEBHOOK_SECRET` | none | yes (16+ characters) | Compared with the webhook's `Authorization` header |
| `INDEXER_PORT` | `8787` (`services.sh`: `8790`) | no | HTTP port |
| `INDEXER_DB` | `./indexer.db` | no | SQLite file |
| `INDEXER_SPONSOR_ADDRESSES` | empty (warns) | no | Comma-separated wallets never taken as traders; SOL transfers to or from them are not stored |
| `INDEXER_RATE_LIMIT_MAX` | `120` | no | Read requests per client IP per window; `0` disables |
| `INDEXER_RATE_LIMIT_WINDOW_MS` | `60000` | no | Rate-limit window |
| `INDEXER_REQUEST_TIMEOUT_MS` | `10000` | no | Whole-request timeout |
| `INDEXER_TRUST_PROXY` | off | no | `1` keys clients by the last `X-Forwarded-For` entry (one trusted proxy) |

### Social backend (`client/src/social/main.ts`)

Sign-in with a Solana wallet (SIWS), profiles, follows, per-leader copy settings and notifications (including a stream). It mints the per-service session tokens and implements the copy engine's `SocialPort`.

Run: `SESSION_SECRET=... SOCIAL_DOMAIN=... node dist/social/main.js`. Binds to `127.0.0.1`; `GET /health` is unauthenticated.

| Variable | Default | Required | Purpose |
| --- | --- | --- | --- |
| `SESSION_SECRET` | none | yes (32+ bytes) | HMAC key for all session tokens; shared with the sponsor and copy services |
| `SOCIAL_DOMAIN` | none | yes | Domain named in the sign-in message |
| `SOCIAL_PORT` | `8791` | no | HTTP port |
| `SOCIAL_HOST` | `127.0.0.1` | no | Bind address |
| `SOCIAL_DB` | `./social.db` | no | SQLite file |
| `SOCIAL_CORS_ORIGIN` | empty | no | Comma-separated exact origins |
| `SOCIAL_MAX_FOLLOWS` | `500` | no | Follows per user |
| `SOCIAL_MAX_TRADE_SOL` | `5` | no | Server cap on a copy's per-trade size, in SOL |
| `SOCIAL_MAX_BODY_BYTES` | `16384` | no | JSON body limit |
| `SOCIAL_RATE_LIMIT_IP` / `_USER` / `_AUTH` | `300` / `120` / `20` | no | Requests per minute; `0` disables |
| `SOCIAL_SESSION_TTL_SECONDS` | `43200` | no | Token lifetime (12 h) |
| `SOCIAL_NONCE_BIND_IP` | on | no | `0` stops binding sign-in nonces to the requesting IP |
| `SOCIAL_MAX_STREAMS` / `SOCIAL_MAX_STREAMS_PER_IP` | `2000` / `20` | no | Open notification streams, total and per IP |
| `SOCIAL_TRUST_PROXY` | off | no | `1` keys clients by the last `X-Forwarded-For` entry |
| `SOCIAL_INTERNAL_SECRET` | unset (routes answer 404) | for the copy service (32+ bytes) | Enables `/internal/copy/*` for the separate copy process: loopback peers only, bearer secret, no CORS, refused with `Origin` or `X-Forwarded-For` |

### Gas sponsor (`client/src/sponsor.ts`)

Pays the network fee for app users who hold no SOL. The app builds a transaction with the sponsor as fee payer, the user signs, and the sponsor co-signs only if it passes the checks (program allowlist, no sponsor key in any instruction, compute and fee caps, per-user, per-wallet and global daily budgets, simulation) and then sends it. It never pays rent. Per-user budget is 0.005 SOL a day and the global default is 2 SOL a day. The account must be at least `SPONSOR_MIN_ACCOUNT_AGE_SEC` old.

Run: `RPC_URL=... SPONSOR_KEYPAIR_PATH=... SPONSOR_SESSION_SECRET=... node dist/sponsor.js`. `GET /health` is unauthenticated.

| Variable | Default | Required | Purpose |
| --- | --- | --- | --- |
| `RPC_URL` | none | yes | Solana RPC |
| `SPONSOR_KEYPAIR_PATH` | none | yes | Fee payer, a Solana CLI keypair file (`chmod 600`); contents are never logged |
| `SPONSOR_SESSION_SECRET` | falls back to `SESSION_SECRET` | yes, unless `SESSION_SECRET` is set (32+ bytes) | Verifies `sponsor`-audience tokens |
| `SESSION_SECRET` | none | no | Fallback for the above |
| `SPONSOR_ALLOW_ANON` | off | no | `1` runs with no authentication: devnet only, see above |
| `SPONSOR_PORT` | `8788` (`services.sh`: `8792`) | no | HTTP port |
| `SPONSOR_CORS_ORIGIN` | unset (warns) | no | The app's origin; `*` is allowed but warns |
| `TRUST_PROXY`, `TRUST_PROXY_HOPS` | off, `1` | no | Trust `X-Forwarded-For` through that many proxies |
| `SPONSOR_REDIS_URL` | unset | no | Shared limits across instances |
| `SPONSOR_STATE_FILE` | `sponsor-state.json` | no | Single-instance limits file, used when no Redis URL is set |
| `SPONSOR_DAILY_LAMPORTS` | `2000000000` | no | Global daily budget |
| `SPONSOR_MAX_FAILURES` | `3` | no | On-chain failures per hour before a block |
| `SPONSOR_FEE_WALLET`, `SPONSOR_FEE_LAMPORTS` | unset, `10000` | no | Require a fee-recovery transfer to this wallet of at least this many lamports; the amount applies only with a wallet |
| `SPONSOR_LOOKUP_TABLES` | off | no | `1` resolves address lookup tables |
| `SPONSOR_MIN_ACCOUNT_AGE_SEC` | `3600` | no | Minimum account age, from the token's `firstSeen` claim |
| `SPONSOR_DISABLED` | off | no | `1` kill switch, read on every request |

### Session tokens (`client/src/session.ts`)

A library, not a process. `createSessionToken` mints `v1.<payload>.<mac>`, an HMAC-SHA256 over `{sub, iat, exp, aud, firstSeen}`; `verifySessionToken` and `hmacSessionAuth` check the MAC in constant time, the expiry and the exact audience. Tokens are sent as `Authorization: Bearer`. The social backend mints them; the sponsor and copy service verify them. It reads no environment itself: the secret is passed in by each service.

| Variable | Default | Required | Purpose |
| --- | --- | --- | --- |
| `SESSION_SECRET` | none | yes, for social and copy (32+ bytes) | Read by `social/main.ts`, `copy/main.ts` and, as a fallback, `sponsor.ts` |
| `SPONSOR_SESSION_SECRET` | none | no | Sponsor-only override of `SESSION_SECRET` |

### Copy engine (`client/src/copy/main.ts`)

Turns a leader's indexed trade into one-tap copy intents for followers: it checks their settings and risk flags, then builds the unsigned transaction on the right venue (Pump.fun, Meteora, Jupiter, or Ringside perps) for the follower to sign. The indexer reports trades to `POST /ingest/trade`. Follower routes need a `copy` token; `GET /health` is unauthenticated.

Run (its own process, `127.0.0.1:8793`): `bash scripts/services.sh start indexer social copy`, or by hand `SESSION_SECRET=... COPY_INGEST_SECRET=... SOCIAL_INTERNAL_SECRET=... COPY_RPC_URL=... COPY_FEE_WALLET=... node dist/copy/main.js`. Start the indexer first (the copy process opens its database) and give the social service the same `SOCIAL_INTERNAL_SECRET`.

How it reaches the other two: the **social port** is HTTP to the social backend's loopback-only `/internal/copy/settings` and `/internal/copy/notify` routes (`copy/socialport.ts`), authenticated with `SOCIAL_INTERNAL_SECRET` (32+ bytes, different from `SESSION_SECRET`, never sent with CORS headers, a session token is not accepted). The copy process never opens the social database, so it cannot see nonces or revocations, and notifications still reach the live streams because the social process does the write. The **indexer** is its SQLite file (`INDEXER_DB`), opened read-only; the indexer runs in WAL mode, so the two processes do not block each other.

| Variable | Default | Required | Purpose |
| --- | --- | --- | --- |
| `SESSION_SECRET` | none | yes (32+ bytes) | Verifies `copy`-audience tokens |
| `COPY_INGEST_SECRET` | none | yes | Secret for `POST /ingest/trade` |
| `COPY_RPC_URL` | none | yes | Solana RPC for building and confirming |
| `COPY_FEE_WALLET` | none | yes | Receives the Pump.fun and Meteora trade fee |
| `SOCIAL_INTERNAL_SECRET` | none | yes (32+ bytes) | Shared with the social service; authenticates the copy process to its internal routes |
| `SOCIAL_INTERNAL_URL` | `http://127.0.0.1:$SOCIAL_PORT` (8791) | no | Social backend base URL; must be http on a loopback host |
| `INDEXER_DB` | `./indexer.db` | no | Indexer SQLite file, opened read-only; must already exist |
| `COPY_PORT` | `8793` | no | HTTP port |
| `COPY_HOST` | `127.0.0.1` | no | Bind address |
| `COPY_DB` | `copy.sqlite` | no | SQLite file |
| `COPY_CORS_ORIGIN` | unset | no | One exact origin; `*` is refused |
| `COPY_TRUST_PROXY` | off | no | `1` keys clients by the last `X-Forwarded-For` entry |
| `SPONSOR_ADDRESS` | unset | no | Gas sponsor address, used as fee payer when set |
| `JUPITER_API_KEY` | none | needed for Jupiter routes | See the Jupiter layer |
| `JUPITER_FEE_ACCOUNTS` | none | no (no fee without it) | Our fee token accounts by mint, JSON `{"<mint>":"<account>"}` or `mint:account,...`; at least wSOL and USDC. A swap whose pair has none is built with no platform fee |
| `RINGSIDE_COPY_PERPS` | off | no | `1` turns on perp copying (devnet only, see above) |
| `RINGSIDE_PERPS_IDL` | none | with perps | Path to `target/idl/ringside_perps.json` |
| `COPY_MIN_LEADER_LAMPORTS` | `50000000` | no | Smallest leader buy that is copied (0.05 SOL) |
| `COPY_MIN_LEADER_RATIO` | `0.5` | no | In fixed mode, the leader's trade must also be at least this fraction of the follower's copy size |
| `COPY_MAX_PRICE_DRIFT_BPS` | `1000` | no | Largest price move from the leader's fill before a build is refused |

### Trade layers (`client/src/trade/`)

Libraries, not processes: each builds quotes and unsigned instructions for the user to sign and hands them to the gas sponsor or the user's wallet. None signs with a server key. Run their tests with `cd client && npm test` (`jupiter.test.mjs`, `pumpfun.test.mjs`, `meteora.test.mjs`).

- **Jupiter** (`jupiter.ts`): Swap V2 `/build` (copy trading) and `/order` plus execute, Trigger V2 (price and DCA orders), Tokens V2 and Price V3 against `https://api.jup.ag`. Every returned transaction is decoded and refused unless the fee payer, programs, transfers and fees are expected (`checkTransaction`). Copy trading uses `buildSwap` (`GET /swap/v2/build`): Jupiter takes no fee there, ours is `platformFeeBps` (default 50, allowed 0 to 255) paid to a token account we own for a mint of the pair, chosen from `feeAccounts` (output mint first); no Referral Program account is needed. `buildSwap` compiles the returned instructions into an unsigned v0 transaction with our fee payer and blockhash, resolves lookup tables through our own RPC, and refuses it unless it passes `checkTransaction` and the platform fee goes only to our configured account (`checkPlatformFee`). `/order` with a referral fee (50 to 255 bps, Jupiter keeps 20%, no RFQ) is still supported but unused for copy trading.
- **Pump.fun** (`pumpfun.ts`): buys and sells on a live bonding curve, or on the coin's PumpSwap pool once it has graduated, with a 50 bps SOL fee to Ringside by default and 100 bps default slippage. SOL-quoted coins only.
- **Meteora** (`meteora.ts`): buys and sells on a Dynamic Bonding Curve (Bags, Believe, Jupiter Studio launches) using the SDK's offline quote, with the same fee model. Graduated pools, non-SOL quotes and transfer-hook mints are refused.

| Variable | Default | Required | Purpose |
| --- | --- | --- | --- |
| `JUPITER_API_KEY` | none | yes, for any Jupiter call (or pass `apiKey`) | Sent as `x-api-key`; without one calls fail with `no_api_key` |
| `JUPITER_FEE_ACCOUNTS` | none | no | `buildSwap` fee accounts by mint, JSON or `mint:account,...` (or pass `feeAccounts`); none for the pair means no fee |
| `JUPITER_REFERRAL_ACCOUNT` | none | no | `/order` only (`getOrder`), not used for copy trading: referral account (or pass `referralAccount`; `null` turns fees off) |

Pump.fun and Meteora read no environment variables: the RPC, fee wallet, `feeBps` and slippage are passed in by the caller (the copy service passes `COPY_RPC_URL` and `COPY_FEE_WALLET`).

### Perps module (`client/src/perps/`)

The shared Ringside perps client, used by the copy engine and the app: PDA derivation, tier and cap maths, account decoding from the IDL, the `request_order` builder for open, increase and close, and decoding of `PositionChanged` and `PositionClosed` events from logs. A library with no process of its own; it needs `target/idl/ringside_perps.json` and reads no environment variables (the copy service passes the IDL path from `RINGSIDE_PERPS_IDL`). Test: `node --test test/perps.test.mjs` after a build.

## Key design choices

- **Quanto contracts.** PnL = notional × (mark / entry − 1). The mark is the token's SOL price; PnL is paid in USDC. No external oracle is needed for a token that exists nowhere else.
- **Mark = 5-minute TWAP, clamped to ±15% per window** — the curve's TWAP before graduation, Raydium's observation TWAP after. Graduation restarts the band at the curve's final price, which the pool opens at exactly. The mark never uses the pool's live price: until the pool has a full TWAP window of observations the market stays priced at the curve's final price and refuses new opens (closes work), and vault balances are read net of the pool's accrued fees.
- **Worst-of fills.** Opening pays the worse of mark and spot; closing gets the worse too. Liquidation uses the mark alone. Every order carries a non-zero acceptable price (the app offers 1% slippage by default, 5% at most) and is never filled after its 150-slot expiry: the keeper's fill instead refunds it.
- **OI cap = 1.5% of the SOL behind the price** (the on-chain default is 1%; `init-mainnet.ts` sets 1.5%) (virtual curve SOL, or pool SOL after graduation), the vault's net exposure capped at 25% of that. Set from the real-data replay: at 2% a patient attacker pumping a quiet curve roughly breaks even. Each side may hold up to **2x the cap** (`GROSS_CAP_MULT`), because the vault only carries the imbalance: in the replay (`sim/gross_check.py`, `sim/results-gross.json`) that doubled fees with unchanged tail losses, while 3x worsened the worst case under heavy one-sided demand.
- **Risk budget per market** (0.25% of LP value at Tier 0, 1% at Tier 1). Past it the market goes reduce-only and keepers ADL profitable positions.
- **SOL/USD only sizes caps.** It comes from Pyth: fully verified, at most 120 s old (`SOL_PRICE_MAX_AGE`, the vault's limit; the keeper refreshes well inside it), confidence within 2%.
- **Graduation is permissionless and cannot be pre-empted.** Anyone can call `migrate` and `graduate_market`. The pool is created at a PDA of the launch program (`[raydium_pool, mint]`) that signs Raydium's `initialize`, so creating Raydium's canonical pool first does not block it; perps stores the pool in the market at `graduate_market` and checks every Raydium account against it. Markets that graduated earlier keep the canonical pool.
- **Fee caps, fixed recipients (launch program).** `set_fees` and `initialize_global` refuse a launch fee above 0.5 SOL or a graduation fee above 2 SOL (0.1 SOL with the `devnet` feature), and never above 10% of what a curve raises, so the pool is always funded; `migrate` clamps a stored fee to the same bound. Mainnet uses 0.02 SOL and 1.5 SOL, devnet 0.05 SOL. The trade fee rates (0.5% protocol, 0.3% creator, 0.2% insurance) and both recipients are set once at `initialize_global` (total capped at 5%) and have no setter: the recipients must be the treasury / multisig from the start (`init-mainnet.ts` refuses the deployer key and the system address). `migration_authority` is stored but unused; it grants no power. Changing any of these needs a program upgrade, which the multisig controls.
- **Graduation reserve.** `migrate` keeps 0.2 SOL (`POOL_CREATION_RESERVE`) out of the raised SOL for Raydium's create-pool fee (0.15 SOL today, read from Raydium's AmmConfig) plus about 0.045 SOL of rent; whatever is left is swept to the fee recipient. If Raydium raises the fee so that fee + 0.05 SOL (`RAYDIUM_RENT_ALLOWANCE`) no longer fits, `migrate` fails up front with `PoolReserveTooSmall` and moves nothing. The fix is a program upgrade that raises `POOL_CREATION_RESERVE`; curves that already sold out stay migratable afterwards.
- **Rings for unlinkability, not hidden positions.** Positions are public; Rings break the link between a trader's identity wallet and their trading account.

## Lessons from devnet (kept here so they aren't relearned)

- The SBF runtime checks lamport sums across the accounts of each CPI: an account whose lamports a program changes by hand must ride along on the next CPI. The system program accepts extra accounts; the token program does not.
- SBF gives each function a 4 KB stack frame and only warns at build time when one overflows. An 8-byte overflow in Anchor's account loading corrupted an account pointer at runtime. Keep big accounts boxed or out of `try_accounts`, and keep `upgrade.sh`'s stack check.
- Pyth's Hermes needs an API key since Aug 2026; devnet's sponsored SOL/USD feed updates in bursts.
