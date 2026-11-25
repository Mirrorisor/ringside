//! Ringside perps program.
//!
//! Peer-to-pool perpetuals on every Ringside token from the moment it launches.
//! One USDC vault is the counterparty to all markets. Each market's mark price
//! is the TWAP from the token's own bonding curve, clamped to a band, and each
//! market has a hard loss budget after which it becomes reduce-only and
//! profitable positions can be auto-deleveraged.
//!
//! Contracts are quanto: PnL = notional x (mark / entry - 1), where prices are
//! in SOL per token, paid in USDC. A SOL/USD price is only used to size the
//! Tier 0 open-interest cap from the curve's SOL reserve.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use ringside_launch::{raydium, Curve};

declare_id!("DsZ69w3q25nRmAzJCRBMLbwZWN6NyVbYipTWsCAUsg1F");

pub const BPS: u128 = 10_000;
pub const TWAP_WINDOW_SLOTS: u64 = 750; // ~5 minutes
pub const BAND_BPS: u128 = 1_500; // mark moves at most 15% per window
pub const FILL_DELAY_SLOTS: u64 = 2;
pub const ORDER_EXPIRY_SLOTS: u64 = 150;
pub const FUNDING_SCALE: i128 = 1_000_000_000_000; // 1e12
pub const FUNDING_BASE_PER_HOUR: i128 = 500_000_000; // 0.05% at full skew
pub const FUNDING_MAX_PER_HOUR: i128 = 5_000_000_000; // 0.5%
pub const LIQ_REWARD_BPS: u128 = 100; // 1% of notional
pub const LIQ_REWARD_MAX: u64 = 500_000_000; // $500 (6 dp)
pub const MAX_ACCOUNT_SHARE_BPS: u128 = 2_000; // one account <= 20% of OI cap
pub const SOL_PRICE_MAX_AGE: i64 = 120;
/// Default Tier 0 OI cap per side as bps of virtual curve SOL: 1 x the 1% curve
/// fee. The risk model (sim/) found 3x already pays a patient attacker in a
/// quiet market. Governance can raise it with `set_risk_params`.
pub const DEFAULT_TIER0_CAP_BPS: u16 = 100;
/// The vault's net exposure (long OI - short OI) is held to 25% of the cap.
pub const DEFAULT_SKEW_CAP_BPS: u16 = 2_500;
/// Upper bound for `set_risk_params`. Devnet curves are 60x smaller (0.5
/// virtual SOL), so the devnet build allows a proportionally larger share.
#[cfg(not(feature = "devnet"))]
pub const MAX_TIER0_CAP_BPS: u16 = 1_000;
#[cfg(feature = "devnet")]
pub const MAX_TIER0_CAP_BPS: u16 = 60_000;
/// TWAP window for graduated markets, read from Raydium's observations.
pub const POOL_TWAP_SECONDS: u64 = 300;

/// Pyth pull-oracle price account for SOL/USD (sponsored feed, shard 0).
pub mod pyth {
    use anchor_lang::prelude::*;
    pub const RECEIVER: Pubkey = pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
    /// 0xef0d8b6f…b56d, from pyth.network/developers/price-feed-ids
    pub const SOL_USD_FEED_ID: [u8; 32] = [
        0xef, 0x0d, 0x8b, 0x6f, 0xda, 0x2c, 0xeb, 0xa4, 0x1d, 0xa1, 0x5d, 0x40, 0x95, 0xd1, 0xda, 0x39,
        0x2a, 0x0d, 0x2f, 0x8e, 0xd0, 0xc6, 0xc7, 0xbc, 0x0f, 0x4c, 0xfa, 0xc8, 0xc2, 0x80, 0xb5, 0x6d,
    ];
    pub const PRICE_UPDATE_V2_DISC: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];
    /// Accept any update the vault would still treat as fresh. Pyth's sponsored
    /// Solana feeds push on a 1-minute heartbeat, so 60 s rejected late pushes.
    pub const MAX_AGE_SECONDS: i64 = super::SOL_PRICE_MAX_AGE;
    /// Refuse a price whose confidence interval is wider than 2% of it.
    pub const MAX_CONF_BPS: u128 = 200;

    /// Parses a PriceUpdateV2 and returns (SOL/USD with 6 decimals, publish time).
    /// Layout: disc(8) write_authority(32) verification(1, Full=1) feed_id(32)
    /// price i64, conf u64, exponent i32, publish_time i64, …
    pub fn read_sol_usd(data: &[u8], now: i64) -> Result<(u64, i64)> {
        require!(data.len() >= 101 && data[..8] == PRICE_UPDATE_V2_DISC, super::PerpsError::BadOracle);
        // Partial verification (variant 0) carries an extra byte; only Full is accepted.
        require!(data[40] == 1, super::PerpsError::BadOracle);
        let o = 41;
        require!(data[o..o + 32] == SOL_USD_FEED_ID, super::PerpsError::BadOracle);
        let rd = |a: usize, n: usize| -> [u8; 8] { let mut b = [0u8; 8]; b[..n].copy_from_slice(&data[a..a + n]); b };
        let price = i64::from_le_bytes(rd(o + 32, 8));
        let conf = u64::from_le_bytes(rd(o + 40, 8));
        let expo = i32::from_le_bytes(data[o + 48..o + 52].try_into().unwrap());
        let publish_time = i64::from_le_bytes(rd(o + 52, 8));
        require!(price > 0, super::PerpsError::BadOracle);
        require!(now - publish_time <= MAX_AGE_SECONDS && publish_time <= now + 5, super::PerpsError::StaleSolPrice);
        require!((conf as u128) * 10_000 <= (price as u128) * MAX_CONF_BPS, super::PerpsError::BadOracle);
        let shift = 6 + expo;
        let e6 = if shift >= 0 { (price as u128) * 10u128.pow(shift as u32) } else { (price as u128) / 10u128.pow((-shift) as u32) };
        require!(e6 > 0 && e6 < u64::MAX as u128, super::PerpsError::BadOracle);
        Ok((e6 as u64, publish_time))
    }
}

pub const SEED_VAULT: &[u8] = b"vault";
pub const SEED_VAULT_USDC: &[u8] = b"vault_usdc";
pub const SEED_MARKET: &[u8] = b"market";
pub const SEED_POSITION: &[u8] = b"position";
pub const SEED_ORDER: &[u8] = b"order";
pub const SEED_LP: &[u8] = b"lp";
pub const SEED_WITHDRAWAL: &[u8] = b"withdrawal";
pub const SEED_REGISTRY: &[u8] = b"registry";
pub const SEED_RETIRED: &[u8] = b"retired";
pub const SEED_TREASURY: &[u8] = b"treasury";
/// LP withdrawals wait this long after the request, still sharing the vault's
/// PnL, so an LP can't exit ahead of losses that are about to be realised.
#[cfg(not(feature = "devnet"))]
pub const WITHDRAW_DELAY_SECONDS: i64 = 24 * 3_600;
#[cfg(feature = "devnet")]
pub const WITHDRAW_DELAY_SECONDS: i64 = 120;
/// At most this many Tier 0 markets live at once: 40 x 0.25% budget = 10% of the vault.
pub const DEFAULT_MAX_LIVE_TIER0: u32 = 40;
/// A Tier 0 market whose curve hasn't traded for this long (~7 days) can be retired.
pub const RETIRE_IDLE_SLOTS: u64 = 7 * 24 * 3_600 * 1_000 / 400;

#[derive(Clone, Copy)]
pub struct TierParams {
    pub max_leverage: u128,
    pub maintenance_bps: u128,
    pub fee_bps: u128,
    pub budget_bps: u128,
}

pub fn tier_params(tier: u8) -> TierParams {
    match tier {
        0 => TierParams { max_leverage: 2, maintenance_bps: 2_000, fee_bps: 30, budget_bps: 25 },
        1 => TierParams { max_leverage: 5, maintenance_bps: 800, fee_bps: 15, budget_bps: 100 },
        _ => TierParams { max_leverage: 10, maintenance_bps: 400, fee_bps: 8, budget_bps: 300 },
    }
}

#[program]
pub mod ringside_perps {
    use super::*;

    pub fn initialize_vault(ctx: Context<InitializeVault>, price_authority: Pubkey) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        v.authority = ctx.accounts.authority.key();
        v.price_authority = price_authority;
        v.usdc_mint = ctx.accounts.usdc_mint.key();
        v.total_shares = 0;
        v.trader_collateral = 0;
        v.reserved = 0;
        v.protocol_fees = 0;
        v.sol_usd_e6 = 0;
        v.sol_usd_ts = 0;
        v.tier0_cap_bps = DEFAULT_TIER0_CAP_BPS;
        v.skew_cap_bps = DEFAULT_SKEW_CAP_BPS;
        v.paused = false;
        v.bump = ctx.bumps.vault;
        Ok(())
    }

    pub fn set_risk_params(ctx: Context<AdminVault>, tier0_cap_bps: u16, skew_cap_bps: u16) -> Result<()> {
        require!(tier0_cap_bps > 0 && tier0_cap_bps <= MAX_TIER0_CAP_BPS && skew_cap_bps > 0 && skew_cap_bps <= 10_000, PerpsError::BadArgs);
        ctx.accounts.vault.tier0_cap_bps = tier0_cap_bps;
        ctx.accounts.vault.skew_cap_bps = skew_cap_bps;
        Ok(())
    }

    /// Permissionless: copies Pyth's SOL/USD into the vault after checking the
    /// account owner, feed id, full verification, age (120 s, the vault's own limit) and confidence (2%).
    /// Older prices than the stored one are ignored.
    pub fn refresh_sol_price(ctx: Context<RefreshSolPrice>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let (price_e6, ts) = pyth::read_sol_usd(&ctx.accounts.price_update.try_borrow_data()?, now)?;
        let v = &mut ctx.accounts.vault;
        if ts > v.sol_usd_ts {
            v.sol_usd_e6 = price_e6;
            v.sol_usd_ts = ts;
        }
        Ok(())
    }

    /// Admin: who may push a SOL price by hand. On mainnet set this to a key
    /// nobody holds, so only Pyth can move the price.
    /// Admin handover, step 1: the current authority names its successor
    /// (on mainnet, the Squads multisig vault). Nothing changes until step 2.
    pub fn propose_authority(ctx: Context<ProposeAuthority>, new_authority: Pubkey) -> Result<()> {
        let p = &mut ctx.accounts.pending;
        p.new_authority = new_authority;
        p.bump = ctx.bumps.pending;
        emit!(AuthorityProposed { new_authority });
        Ok(())
    }

    /// Step 2: the successor signs to accept, so a typo can't hand the
    /// protocol to a key nobody holds.
    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        require_keys_eq!(ctx.accounts.pending.new_authority, ctx.accounts.new_authority.key(), PerpsError::NotPendingAuthority);
        ctx.accounts.vault.authority = ctx.accounts.new_authority.key();
        emit!(AuthorityAccepted { authority: ctx.accounts.new_authority.key() });
        Ok(())
    }

    pub fn set_price_authority(ctx: Context<AdminVault>, price_authority: Pubkey) -> Result<()> {
        ctx.accounts.vault.price_authority = price_authority;
        Ok(())
    }

    /// Fallback price push by the price authority (devnet; disabled on mainnet
    /// by setting the authority to an unheld key).
    pub fn set_sol_price(ctx: Context<SetSolPrice>, price_e6: u64) -> Result<()> {
        require!(price_e6 > 0, PerpsError::BadPrice);
        let v = &mut ctx.accounts.vault;
        v.sol_usd_e6 = price_e6;
        v.sol_usd_ts = Clock::get()?.unix_timestamp;
        Ok(())
    }

    pub fn deposit_liquidity(ctx: Context<Liquidity>, amount: u64) -> Result<()> {
        require!(amount > 0, PerpsError::ZeroAmount);
        let assets = lp_assets(&ctx.accounts.vault, ctx.accounts.vault_usdc.amount);
        let v = &mut ctx.accounts.vault;
        let shares = shares_for(v, assets, amount)?;
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.owner_usdc.to_account_info(),
                    to: ctx.accounts.vault_usdc.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )?;
        v.total_shares += shares;
        let lp = &mut ctx.accounts.lp;
        lp.owner = ctx.accounts.owner.key();
        lp.shares += shares;
        lp.bump = ctx.bumps.lp;
        Ok(())
    }

    /// Step 1 of a withdrawal: moves shares out of the LP account into a
    /// request that unlocks after WITHDRAW_DELAY_SECONDS. The shares stay in
    /// total_shares, so they keep sharing the vault's PnL until paid out.
    /// Adding to an open request restarts its timer.
    pub fn request_withdrawal(ctx: Context<RequestWithdrawal>, shares: u64) -> Result<()> {
        require!(shares > 0 && shares <= ctx.accounts.lp.shares, PerpsError::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        ctx.accounts.lp.shares -= shares;
        let r = &mut ctx.accounts.request;
        r.owner = ctx.accounts.owner.key();
        r.shares += shares;
        r.unlock_ts = now + WITHDRAW_DELAY_SECONDS;
        r.bump = ctx.bumps.request;
        emit!(WithdrawalRequested { owner: r.owner, shares: r.shares, unlock_ts: r.unlock_ts });
        Ok(())
    }

    /// Puts a pending request's shares back in the LP account.
    pub fn cancel_withdrawal(ctx: Context<CancelWithdrawal>) -> Result<()> {
        ctx.accounts.lp.shares += ctx.accounts.request.shares;
        Ok(())
    }

    /// Step 2: once unlocked, pays the request's shares at the vault's value now.
    pub fn withdraw_liquidity(ctx: Context<CompleteWithdrawal>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let shares = ctx.accounts.request.shares;
        require!(now >= ctx.accounts.request.unlock_ts, PerpsError::WithdrawalLocked);
        require!(shares > 0, PerpsError::ZeroAmount);
        let assets = lp_assets(&ctx.accounts.vault, ctx.accounts.vault_usdc.amount);
        let amount = ((shares as u128) * (assets as u128) / (ctx.accounts.vault.total_shares as u128)) as u64;
        ctx.accounts.vault.total_shares -= shares;
        pay_from_vault(&ctx.accounts.vault, &ctx.accounts.vault_usdc, &ctx.accounts.owner_usdc, &ctx.accounts.token_program, amount)?;
        Ok(())
    }

    /// Permissionless: opens a Tier 0 market for any Ringside curve.
    pub fn create_market(ctx: Context<CreateMarket>) -> Result<()> {
        let clock = Clock::get()?;
        let curve = &ctx.accounts.curve;
        require!(!curve.complete, PerpsError::CurveGraduated);
        let reg = &mut ctx.accounts.registry;
        if reg.max_live_tier0 == 0 {
            reg.max_live_tier0 = DEFAULT_MAX_LIVE_TIER0;
            reg.bump = ctx.bumps.registry;
        }
        require!(reg.live_tier0 < reg.max_live_tier0, PerpsError::MarketLimit);
        reg.live_tier0 += 1;
        let m = &mut ctx.accounts.market;
        m.mint = curve.mint;
        m.curve = curve.key();
        m.creator = curve.creator;
        m.tier = 0;
        m.created_slot = clock.slot;
        m.oi_long = 0;
        m.oi_short = 0;
        m.oi_cap_override = 0;
        m.funding_index = 0;
        m.last_funding_ts = clock.unix_timestamp;
        m.band_anchor_q64 = curve.last_price_q64;
        m.band_anchor_slot = clock.slot;
        m.trader_net_pnl = 0;
        m.insurance = 0;
        m.creator_fees = 0;
        m.reduce_only = false;
        m.adl_mode = false;
        m.bump = ctx.bumps.market;
        emit!(MarketCreated { mint: m.mint, slot: clock.slot });
        Ok(())
    }

    /// Step 1 of a trade: escrow collateral and record the request.
    /// A keeper fills it at the first mark at least FILL_DELAY_SLOTS later.
    pub fn request_order(ctx: Context<RequestOrder>, args: OrderArgs) -> Result<()> {
        require!(!ctx.accounts.vault.paused, PerpsError::Paused);
        require!(args.side <= 1 && args.kind <= 1, PerpsError::BadArgs);
        let slot = Clock::get()?.slot;

        if args.kind == ORDER_INCREASE {
            require!(args.size_usd > 0 && args.collateral > 0, PerpsError::ZeroAmount);
            require!(!ctx.accounts.market.reduce_only, PerpsError::ReduceOnly);
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.owner_usdc.to_account_info(),
                        to: ctx.accounts.vault_usdc.to_account_info(),
                        authority: ctx.accounts.owner.to_account_info(),
                    },
                ),
                args.collateral,
            )?;
            ctx.accounts.vault.trader_collateral += args.collateral;
        } else {
            require!(ctx.accounts.position.size_usd > 0, PerpsError::NoPosition);
        }

        let p = &mut ctx.accounts.position;
        if p.owner == Pubkey::default() {
            p.owner = ctx.accounts.owner.key();
            p.market = ctx.accounts.market.key();
            p.side = args.side;
            p.bump = ctx.bumps.position;
        }

        let o = &mut ctx.accounts.order;
        o.owner = ctx.accounts.owner.key();
        o.market = ctx.accounts.market.key();
        o.side = args.side;
        o.kind = args.kind;
        o.collateral = if args.kind == ORDER_INCREASE { args.collateral } else { 0 };
        o.size_usd = args.size_usd;
        o.acceptable_price_q64 = args.acceptable_price_q64;
        o.request_slot = slot;
        o.bump = ctx.bumps.order;
        o.rent_payer = ctx.accounts.payer.key();
        Ok(())
    }

    /// Owner can reclaim escrowed collateral from an order no keeper filled.
    pub fn cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
        let slot = Clock::get()?.slot;
        require!(slot >= ctx.accounts.order.request_slot + ORDER_EXPIRY_SLOTS, PerpsError::NotExpired);
        let amount = ctx.accounts.order.collateral;
        if amount > 0 {
            ctx.accounts.vault.trader_collateral -= amount;
            pay_from_vault(&ctx.accounts.vault, &ctx.accounts.vault_usdc, &ctx.accounts.owner_usdc, &ctx.accounts.token_program, amount)?;
        }
        Ok(())
    }

    /// Step 2: keeper fills an order at the delayed, banded TWAP mark.
    pub fn execute_order(ctx: Context<ExecuteOrder>) -> Result<()> {
        let clock = Clock::get()?;
        let order = &ctx.accounts.order;
        require!(clock.slot >= order.request_slot + FILL_DELAY_SLOTS, PerpsError::TooEarly);
        let vault_balance = ctx.accounts.vault_usdc.amount;
        let lp_value = lp_assets(&ctx.accounts.vault, vault_balance);

        let market = &mut ctx.accounts.market;
        let view = price_view(market, &ctx.accounts.curve, ctx.remaining_accounts, clock.slot, clock.unix_timestamp)?;
        accrue_funding(market, &ctx.accounts.vault, view.sol_reserve, clock.unix_timestamp)?;
        let (mark, clamped) = mark_price(market, &view, clock.slot);
        let tp = tier_params(market.tier);
        let pos = &mut ctx.accounts.position;
        let vault = &mut ctx.accounts.vault;
        let is_long = order.side == SIDE_LONG;
        let px = execution_price(mark, view.spot, is_long, order.kind == ORDER_INCREASE);

        if order.acceptable_price_q64 > 0 {
            let ok = if (order.kind == ORDER_INCREASE) == is_long {
                px <= order.acceptable_price_q64
            } else {
                px >= order.acceptable_price_q64
            };
            if !ok {
                // Refund instead of failing so the keeper can always clear the queue.
                if order.collateral > 0 {
                    vault.trader_collateral -= order.collateral;
                    pay_from_vault(vault, &ctx.accounts.vault_usdc, &ctx.accounts.owner_usdc, &ctx.accounts.token_program, order.collateral)?;
                }
                emit!(OrderRejected { owner: order.owner, market: order.market, reason: 0 });
                return Ok(());
            }
        }

        if order.kind == ORDER_INCREASE {
            // A sold-out curve trades again once its market has graduated to the pool price.
            require!(!market.reduce_only && !clamped && (market.tier >= 1 || !ctx.accounts.curve.complete), PerpsError::ReduceOnly);
            let fee = mul_bps(order.size_usd, tp.fee_bps);
            // Realise funding into collateral before changing size.
            if pos.size_usd > 0 {
                let owed = funding_owed(pos, market.funding_index);
                pos.collateral = apply_signed(pos.collateral, -owed)?;
                vault.trader_collateral = apply_signed(vault.trader_collateral, -owed)?;
            }
            let new_collateral = pos.collateral + order.collateral - fee;
            let new_size = pos.size_usd + order.size_usd;
            require!((new_collateral as u128) * tp.max_leverage >= new_size as u128, PerpsError::Leverage);

            let cap = oi_cap(market, vault, view.sol_reserve, clock.unix_timestamp)?;
            let side_oi = if is_long { market.oi_long } else { market.oi_short };
            require!(side_oi + order.size_usd <= cap, PerpsError::OiCap);
            require!((new_size as u128) * BPS <= (cap as u128) * MAX_ACCOUNT_SHARE_BPS, PerpsError::AccountCap);
            let delta = if is_long { order.size_usd as i128 } else { -(order.size_usd as i128) };
            let net_after = market.oi_long as i128 - market.oi_short as i128 + delta;
            require!(net_after.unsigned_abs() * BPS <= (cap as u128) * vault.skew_cap_bps as u128, PerpsError::SkewCap);

            pos.entry_price_q64 = if pos.size_usd == 0 {
                px
            } else {
                let units = ((pos.size_usd as u128) << 64) / pos.entry_price_q64 + ((order.size_usd as u128) << 64) / px;
                ((new_size as u128) << 64) / units
            };
            pos.size_usd = new_size;
            pos.collateral = new_collateral;
            pos.funding_snapshot = market.funding_index;
            pos.opened_slot = clock.slot;
            if is_long { market.oi_long += order.size_usd } else { market.oi_short += order.size_usd }

            vault.trader_collateral -= fee;
            distribute_fee(vault, market, fee, &ctx.accounts.vault_usdc, &ctx.accounts.keeper_usdc, &ctx.accounts.token_program)?;
            emit!(PositionChanged { owner: pos.owner, market: pos.market, side: pos.side, size_usd: pos.size_usd, collateral: pos.collateral, mark_q64: px });
        } else {
            // Full close.
            let fee = mul_bps(pos.size_usd, tp.fee_bps);
            let (payout, realized) = settle_close(pos, market, px, fee)?;
            vault.trader_collateral -= pos.collateral;
            market.trader_net_pnl += realized;
            if is_long { market.oi_long -= pos.size_usd } else { market.oi_short -= pos.size_usd }
            let fee_taken = fee.min(apply_signed(pos.collateral, realized).unwrap_or(0));
            distribute_fee(vault, market, fee_taken, &ctx.accounts.vault_usdc, &ctx.accounts.keeper_usdc, &ctx.accounts.token_program)?;
            pay_from_vault(vault, &ctx.accounts.vault_usdc, &ctx.accounts.owner_usdc, &ctx.accounts.token_program, payout)?;
            emit!(PositionClosed { owner: pos.owner, market: pos.market, side: pos.side, realized_pnl: realized as i64, payout, mark_q64: px, reason: 0 });
            reset_position(pos);
        }

        check_budget(market, lp_value);
        Ok(())
    }

    /// Permissionless liquidation of an under-margined position.
    pub fn liquidate(ctx: Context<Liquidate>) -> Result<()> {
        let clock = Clock::get()?;
        let lp_value = lp_assets(&ctx.accounts.vault, ctx.accounts.vault_usdc.amount);
        let market = &mut ctx.accounts.market;
        let view = price_view(market, &ctx.accounts.curve, ctx.remaining_accounts, clock.slot, clock.unix_timestamp)?;
        accrue_funding(market, &ctx.accounts.vault, view.sol_reserve, clock.unix_timestamp)?;
        let (mark, _) = mark_price(market, &view, clock.slot);
        let tp = tier_params(market.tier);
        let pos = &mut ctx.accounts.position;
        require!(pos.size_usd > 0, PerpsError::NoPosition);

        let equity = (pos.collateral as i128) + pnl(pos, mark) - funding_owed(pos, market.funding_index);
        let maintenance = (mul_bps(pos.size_usd, tp.maintenance_bps)) as i128;
        require!(equity < maintenance, PerpsError::Healthy);

        let equity_left = equity.max(0) as u64;
        let reward = (mul_bps(pos.size_usd, LIQ_REWARD_BPS)).min(LIQ_REWARD_MAX).min(equity_left);
        let to_insurance = equity_left - reward;
        // The trader keeps nothing. Remaining equity goes to the keeper and the
        // market's insurance; the vault keeps the rest of the collateral.
        let vault = &mut ctx.accounts.vault;
        vault.trader_collateral -= pos.collateral;
        market.trader_net_pnl += (equity_left as i128) - (pos.collateral as i128);
        market.insurance += to_insurance;
        vault.reserved += to_insurance;
        if pos.side == SIDE_LONG { market.oi_long -= pos.size_usd } else { market.oi_short -= pos.size_usd }
        pay_from_vault(vault, &ctx.accounts.vault_usdc, &ctx.accounts.keeper_usdc, &ctx.accounts.token_program, reward)?;
        emit!(PositionClosed { owner: pos.owner, market: pos.market, side: pos.side, realized_pnl: -(pos.collateral as i64), payout: 0, mark_q64: mark, reason: 1 });
        reset_position(pos);
        check_budget(market, lp_value);
        Ok(())
    }

    /// Auto-deleverage a profitable position once the market's budget is spent.
    /// Keepers rank by unrealised PnL off-chain and close the most profitable first.
    pub fn auto_deleverage(ctx: Context<Liquidate>) -> Result<()> {
        let clock = Clock::get()?;
        let market = &mut ctx.accounts.market;
        require!(market.adl_mode, PerpsError::NotAdl);
        let view = price_view(market, &ctx.accounts.curve, ctx.remaining_accounts, clock.slot, clock.unix_timestamp)?;
        accrue_funding(market, &ctx.accounts.vault, view.sol_reserve, clock.unix_timestamp)?;
        let (mark, _) = mark_price(market, &view, clock.slot);
        let pos = &mut ctx.accounts.position;
        require!(pos.size_usd > 0 && pnl(pos, mark) > 0, PerpsError::NotProfitable);

        let (payout, realized) = settle_close(pos, market, mark, 0)?;
        let vault = &mut ctx.accounts.vault;
        vault.trader_collateral -= pos.collateral;
        market.trader_net_pnl += realized;
        if pos.side == SIDE_LONG { market.oi_long -= pos.size_usd } else { market.oi_short -= pos.size_usd }
        pay_from_vault(vault, &ctx.accounts.vault_usdc, &ctx.accounts.owner_usdc, &ctx.accounts.token_program, payout)?;
        emit!(PositionClosed { owner: pos.owner, market: pos.market, side: pos.side, realized_pnl: realized as i64, payout, mark_q64: mark, reason: 2 });
        reset_position(pos);
        Ok(())
    }

    /// Permissionless crank: accrues funding and rolls the band anchor.
    pub fn crank_funding(ctx: Context<CrankFunding>) -> Result<()> {
        let clock = Clock::get()?;
        let view = price_view(&ctx.accounts.market, &ctx.accounts.curve, ctx.remaining_accounts, clock.slot, clock.unix_timestamp)?;
        accrue_funding(&mut ctx.accounts.market, &ctx.accounts.vault, view.sol_reserve, clock.unix_timestamp)?;
        mark_price(&mut ctx.accounts.market, &view, clock.slot);
        Ok(())
    }

    /// Permissionless: once the token's curve has migrated to Raydium, move its
    /// market to Tier 1. Prices then come from the pool's TWAP (remaining
    /// accounts: pool state, observation, token vault, wSOL vault).
    pub fn graduate_market(ctx: Context<GraduateMarket>) -> Result<()> {
        let clock = Clock::get()?;
        require!(ctx.accounts.curve.migrated && ctx.accounts.market.tier == 0, PerpsError::NotGraduated);
        if ctx.accounts.retired.data_is_empty() {
            let reg = &mut ctx.accounts.registry;
            reg.live_tier0 = reg.live_tier0.saturating_sub(1);
        }
        let m = &mut ctx.accounts.market;
        m.tier = 1;
        // Validates the pool accounts.
        let view = price_view(m, &ctx.accounts.curve, ctx.remaining_accounts, clock.slot, clock.unix_timestamp)?;
        // The band restarts at the curve's final price. It's fixed by the
        // sellout itself (nobody can push it), and migrate opens the pool at
        // exactly that price. Any pool trading since is then followed at most
        // 15% per window.
        let c = &ctx.accounts.curve;
        m.band_anchor_q64 = ((c.virtual_sol as u128) << 64) / c.virtual_tokens as u128;
        m.band_anchor_slot = clock.slot;
        m.reduce_only = m.adl_mode;
        emit!(MarketGraduated { mint: m.mint, pool: ctx.remaining_accounts[0].key(), price_q64: view.twap });
        Ok(())
    }

    /// Permissionless: frees the Tier 0 slot of a dead launch. Allowed when the
    /// curve hasn't sold out, hasn't traded for ~7 days and the market has no
    /// open interest. The market becomes reduce-only (it can still graduate later).
    pub fn retire_market(ctx: Context<RetireMarket>) -> Result<()> {
        let slot = Clock::get()?.slot;
        let m = &mut ctx.accounts.market;
        let c = &ctx.accounts.curve;
        require!(
            m.tier == 0 && !c.complete && m.oi_long == 0 && m.oi_short == 0 && slot.saturating_sub(c.last_slot) >= RETIRE_IDLE_SLOTS,
            PerpsError::NotRetirable
        );
        m.reduce_only = true;
        let reg = &mut ctx.accounts.registry;
        reg.live_tier0 = reg.live_tier0.saturating_sub(1);
        ctx.accounts.retired.market = m.key();
        ctx.accounts.retired.bump = ctx.bumps.retired;
        Ok(())
    }

    /// Admin: how many Tier 0 markets may be live at once.
    pub fn set_market_limit(ctx: Context<SetMarketLimit>, max_live_tier0: u32) -> Result<()> {
        require!(max_live_tier0 > 0, PerpsError::BadArgs);
        ctx.accounts.registry.max_live_tier0 = max_live_tier0;
        Ok(())
    }

    /// Admin: lower any market's OI cap (0 = no override) or make it reduce-only,
    /// e.g. to keep perps off the protocol's own token. Takes effect on new
    /// opens; existing positions can always close.
    pub fn set_market_limits(ctx: Context<AdminMarket>, oi_cap_override: u64, reduce_only: bool) -> Result<()> {
        let m = &mut ctx.accounts.market;
        m.oi_cap_override = oi_cap_override;
        m.reduce_only = reduce_only || m.adl_mode;
        emit!(MarketLimitsSet { market: m.key(), oi_cap_override, reduce_only: m.reduce_only });
        Ok(())
    }

    /// Permissionless (the keeper runs it): turns ALL accrued protocol fees into
    /// vault liquidity owned by the treasury's LP account (set_treasury),
    /// at the vault's current share price. Nothing moves: the fees stop being
    /// reserved and start backing trades. The treasury takes fees as cash by
    /// claiming them first (claim_protocol_fees, admin only).
    pub fn compound_protocol_fees(ctx: Context<CompoundProtocolFees>) -> Result<()> {
        let assets = lp_assets(&ctx.accounts.vault, ctx.accounts.vault_usdc.amount);
        let v = &mut ctx.accounts.vault;
        let amount = v.protocol_fees;
        require!(amount > 0, PerpsError::ZeroAmount);
        let shares = shares_for(v, assets, amount)?;
        v.protocol_fees -= amount;
        v.reserved -= amount;
        v.total_shares += shares;
        let lp = &mut ctx.accounts.treasury_lp;
        lp.owner = ctx.accounts.treasury_config.treasury;
        lp.shares += shares;
        lp.bump = ctx.bumps.treasury_lp;
        emit!(ProtocolFeesCompounded { amount, shares });
        Ok(())
    }

    /// Admin: names the treasury, the owner of protocol-owned LP shares. Set it
    /// to the multisig vault, so withdrawing the treasury's liquidity needs a
    /// multisig vote while deposits (below) can come from a hot key.
    pub fn set_treasury(ctx: Context<SetTreasury>, treasury: Pubkey) -> Result<()> {
        let c = &mut ctx.accounts.treasury_config;
        c.treasury = treasury;
        c.bump = ctx.bumps.treasury_config;
        emit!(TreasurySet { treasury });
        Ok(())
    }

    /// Anyone (the treasury sweep's hot key) deposits USDC whose shares go to
    /// the treasury's LP account, never the depositor's.
    pub fn deposit_to_treasury(ctx: Context<DepositToTreasury>, amount: u64) -> Result<()> {
        require!(amount > 0, PerpsError::ZeroAmount);
        let assets = lp_assets(&ctx.accounts.vault, ctx.accounts.vault_usdc.amount);
        let v = &mut ctx.accounts.vault;
        let shares = shares_for(v, assets, amount)?;
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.depositor_usdc.to_account_info(),
                    to: ctx.accounts.vault_usdc.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            amount,
        )?;
        v.total_shares += shares;
        let lp = &mut ctx.accounts.treasury_lp;
        lp.owner = ctx.accounts.treasury_config.treasury;
        lp.shares += shares;
        lp.bump = ctx.bumps.treasury_lp;
        emit!(TreasuryDeposit { depositor: ctx.accounts.depositor.key(), amount, shares });
        Ok(())
    }

    /// Admin: pays accumulated protocol fees out to the treasury.
    pub fn claim_protocol_fees(ctx: Context<ClaimProtocolFees>, amount: u64) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        require!(amount > 0 && amount <= v.protocol_fees, PerpsError::ZeroAmount);
        v.protocol_fees -= amount;
        v.reserved -= amount;
        pay_from_vault(&ctx.accounts.vault, &ctx.accounts.vault_usdc, &ctx.accounts.treasury_usdc, &ctx.accounts.token_program, amount)
    }

    /// Admin: promote a graduated market to Tier 2 and optionally cap its OI.
    pub fn set_market_tier(ctx: Context<AdminMarket>, tier: u8, oi_cap_override: u64) -> Result<()> {
        require!(tier >= 1 && tier <= 2 && ctx.accounts.market.tier >= 1, PerpsError::BadArgs);
        let m = &mut ctx.accounts.market;
        m.tier = tier;
        m.oi_cap_override = oi_cap_override;
        Ok(())
    }

    pub fn claim_creator_fees(ctx: Context<ClaimCreator>) -> Result<()> {
        let amount = ctx.accounts.market.creator_fees;
        require!(amount > 0, PerpsError::ZeroAmount);
        ctx.accounts.market.creator_fees = 0;
        ctx.accounts.vault.reserved -= amount;
        pay_from_vault(&ctx.accounts.vault, &ctx.accounts.vault_usdc, &ctx.accounts.creator_usdc, &ctx.accounts.token_program, amount)
    }
}

// ---------------------------------------------------------------------------
// Pricing, funding, risk
// ---------------------------------------------------------------------------

pub const SIDE_LONG: u8 = 0;
pub const SIDE_SHORT: u8 = 1;
pub const ORDER_INCREASE: u8 = 0;
pub const ORDER_CLOSE: u8 = 1;

/// Worst-of execution. The TWAP mark lags spot, so filling at the mark alone
/// lets anyone who watches spot trade against a price they already know is
/// stale. The risk model found that this lag alone made the vault lose money at
/// every cap. Opening fills at the worse of mark and spot for the trader,
/// closing too. Liquidations and ADL still use the mark, so a spot wick cannot
/// liquidate anyone.
pub fn execution_price(mark: u128, spot: u128, is_long: bool, opening: bool) -> u128 {
    if is_long == opening { mark.max(spot) } else { mark.min(spot) }
}

/// Where a market's prices come from: its own bonding curve (Tier 0) or,
/// after graduation, its Raydium CPMM pool.
pub struct PriceView {
    pub twap: u128,
    pub spot: u128,
    /// SOL backing the price (virtual curve SOL, or the pool's SOL), sizing OI caps.
    pub sol_reserve: u64,
}

pub fn price_view(m: &Market, curve: &Curve, rem: &[AccountInfo], slot: u64, now: i64) -> Result<PriceView> {
    if m.tier == 0 {
        return Ok(PriceView { twap: curve.twap_q64(slot, TWAP_WINDOW_SLOTS), spot: curve.last_price_q64, sol_reserve: curve.virtual_sol_lamports() });
    }
    pool_view(curve.mint, rem, now)
}

fn token_amount(a: &AccountInfo) -> Result<u64> {
    let d = a.try_borrow_data()?;
    require!(d.len() >= 72, PerpsError::BadPool);
    Ok(u64::from_le_bytes(d[64..72].try_into().unwrap()))
}

/// Reads a graduated token's price from its Raydium CPMM pool. remaining
/// accounts: [pool_state, observation_state, token vault, wSOL vault], each
/// checked against the PDAs derived from the mint.
pub fn pool_view(mint: Pubkey, rem: &[AccountInfo], now: i64) -> Result<PriceView> {
    require!(rem.len() >= 4, PerpsError::BadPool);
    let (pool, obs, tok_vault, sol_vault) = (&rem[0], &rem[1], &rem[2], &rem[3]);
    let wsol = anchor_spl::token::spl_token::native_mint::ID;
    let vault_pda = |m: &Pubkey| Pubkey::find_program_address(&[raydium::POOL_VAULT_SEED, pool.key.as_ref(), m.as_ref()], &raydium::CPMM_PROGRAM).0;
    require!(*pool.key == raydium::pool_address(mint) && *pool.owner == raydium::CPMM_PROGRAM, PerpsError::BadPool);
    require!(*obs.key == raydium::observation_address(*pool.key) && *obs.owner == raydium::CPMM_PROGRAM, PerpsError::BadPool);
    require!(*tok_vault.key == vault_pda(&mint) && *sol_vault.key == vault_pda(&wsol), PerpsError::BadPool);
    let tokens = token_amount(tok_vault)?;
    let sol = token_amount(sol_vault)?;
    require!(tokens > 0 && sol > 0, PerpsError::BadPool);
    let spot_x32 = ((sol as u128) << 32) / tokens as u128;
    let twap_x32 = pool_twap_x32(&obs.try_borrow_data()?, mint < wsol, spot_x32, now as u64);
    Ok(PriceView { twap: twap_x32 << 32, spot: spot_x32 << 32, sol_reserve: sol })
}

/// TWAP of the token's price in lamports per base unit (x32) over
/// POOL_TWAP_SECONDS, from Raydium's ObservationState (packed, zero-copy):
/// disc 8 | initialized u8 | observation_index u16 | pool 32 |
/// 100 x (block_timestamp u64, cum_token_0_price_x32 u128, cum_token_1_price_x32 u128) | padding.
/// Observation k holds the cumulative price up to its own timestamp (written
/// at most every 15 s, on swaps, with the pre-swap price). The cumulative is
/// extended to `now` at the current spot, then differenced against the newest
/// observation at least POOL_TWAP_SECONDS old (or the oldest one, while the
/// pool is younger). No history yet means spot.
pub fn pool_twap_x32(d: &[u8], token_is_0: bool, spot_x32: u128, now: u64) -> u128 {
    const N: usize = 100;
    const BASE: usize = 8 + 1 + 2 + 32;
    if d.len() < BASE + N * 40 || d[8] == 0 {
        return spot_x32;
    }
    let latest = u16::from_le_bytes([d[9], d[10]]) as usize % N;
    let ts = |k: usize| u64::from_le_bytes(d[BASE + k * 40..BASE + k * 40 + 8].try_into().unwrap());
    let cum = |k: usize| {
        let o = BASE + k * 40 + 8 + if token_is_0 { 0 } else { 16 };
        u128::from_le_bytes(d[o..o + 16].try_into().unwrap())
    };
    let t_latest = ts(latest);
    if t_latest == 0 || t_latest > now {
        return spot_x32;
    }
    let cum_now = cum(latest).wrapping_add(spot_x32.wrapping_mul((now - t_latest) as u128));
    let cutoff = now.saturating_sub(POOL_TWAP_SECONDS);
    let (mut best, mut oldest): (Option<(u64, u128)>, Option<(u64, u128)>) = (None, None);
    for k in 0..N {
        let t = ts(k);
        if t == 0 || t > now {
            continue; // unused slot
        }
        if t <= cutoff && best.map_or(true, |b| t > b.0) {
            best = Some((t, cum(k)));
        }
        if oldest.map_or(true, |o| t < o.0) {
            oldest = Some((t, cum(k)));
        }
    }
    match best.or(oldest) {
        Some((t, c)) if now > t => cum_now.wrapping_sub(c) / (now - t) as u128,
        _ => spot_x32,
    }
}

/// TWAP clamped to +/-15% of the band anchor. The anchor moves at most 15%
/// per elapsed window, catching up over every window since it was last
/// touched, so a quiet market is never stuck. Returns (mark, was_clamped).
pub fn mark_price(m: &mut Market, view: &PriceView, slot: u64) -> (u128, bool) {
    let twap = view.twap;
    let elapsed = slot.saturating_sub(m.band_anchor_slot) / TWAP_WINDOW_SLOTS;
    let mut anchor = m.band_anchor_q64;
    for _ in 1..elapsed.min(64) {
        anchor = clamp_band(twap, anchor);
    }
    let mark = clamp_band(twap, anchor);
    if elapsed > 0 {
        m.band_anchor_q64 = mark;
        m.band_anchor_slot += elapsed * TWAP_WINDOW_SLOTS;
    }
    (mark, mark != twap)
}

fn clamp_band(price: u128, anchor: u128) -> u128 {
    price.clamp(anchor * (BPS - BAND_BPS) / BPS, anchor * (BPS + BAND_BPS) / BPS)
}

/// Quanto PnL in USDC (6 dp): notional x (mark / entry - 1), sign by side.
pub fn pnl(p: &Position, mark: u128) -> i128 {
    if p.size_usd == 0 {
        return 0;
    }
    let size = p.size_usd as i128;
    let change = (mark as i128 - p.entry_price_q64 as i128) * size / p.entry_price_q64 as i128;
    if p.side == SIDE_LONG { change } else { -change }
}

pub fn funding_owed(p: &Position, index: i128) -> i128 {
    let owed = (p.size_usd as i128) * (index - p.funding_snapshot) / FUNDING_SCALE;
    if p.side == SIDE_LONG { owed } else { -owed }
}

fn accrue_funding(m: &mut Market, v: &Vault, sol_reserve: u64, now: i64) -> Result<()> {
    let dt = now - m.last_funding_ts;
    if dt <= 0 {
        return Ok(());
    }
    // If the SOL price is stale, fall back to the larger side so funding stays bounded.
    let cap = oi_cap(m, v, sol_reserve, now).unwrap_or(0).max(m.oi_long.max(m.oi_short)).max(1) as i128;
    let skew = m.oi_long as i128 - m.oi_short as i128;
    let rate = (FUNDING_BASE_PER_HOUR * skew / cap).clamp(-FUNDING_MAX_PER_HOUR, FUNDING_MAX_PER_HOUR);
    m.funding_index += rate * dt as i128 / 3_600;
    m.last_funding_ts = now;
    Ok(())
}

/// Per-side OI cap in USDC (6 dp): a share of the SOL behind the price
/// (virtual curve SOL at Tier 0, the pool's SOL after graduation), valued in
/// USD, optionally lowered by the market's override.
pub fn oi_cap(m: &Market, v: &Vault, sol_reserve: u64, now: i64) -> Result<u64> {
    require!(v.sol_usd_e6 > 0 && now - v.sol_usd_ts <= SOL_PRICE_MAX_AGE, PerpsError::StaleSolPrice);
    // lamports (1e9) x usd_e6 / 1e9 = usd_e6.
    let reserve_usd = (sol_reserve as u128) * (v.sol_usd_e6 as u128) / 1_000_000_000;
    let cap = (reserve_usd * v.tier0_cap_bps as u128 / BPS) as u64;
    Ok(if m.oi_cap_override > 0 { cap.min(m.oi_cap_override) } else { cap })
}

fn check_budget(m: &mut Market, lp_value: u64) {
    let budget = (lp_value as u128 * tier_params(m.tier).budget_bps / BPS) as i128;
    if m.trader_net_pnl - m.insurance as i128 > budget {
        m.reduce_only = true;
        m.adl_mode = true;
        emit!(BudgetExhausted { mint: m.mint, trader_net_pnl: m.trader_net_pnl as i64 });
    }
}

/// Returns (payout to trader, realised PnL to trader net of funding, floored
/// at losing all collateral). Fee is deducted from the payout.
fn settle_close(p: &Position, m: &Market, mark: u128, fee: u64) -> Result<(u64, i128)> {
    let gross = pnl(p, mark) - funding_owed(p, m.funding_index);
    let realized = gross.max(-(p.collateral as i128));
    let equity = (p.collateral as i128 + realized - fee as i128).max(0);
    Ok((equity as u64, realized))
}

fn reset_position(p: &mut Position) {
    p.size_usd = 0;
    p.collateral = 0;
    p.entry_price_q64 = 0;
    p.funding_snapshot = 0;
}

/// Splits a trading fee: 60% stays with LPs, 20% protocol (half of that to
/// the executing keeper), 10% creator, 10% market insurance.
fn distribute_fee<'info>(
    v: &mut Account<'info, Vault>,
    m: &mut Market,
    fee: u64,
    vault_usdc: &Account<'info, TokenAccount>,
    keeper_usdc: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
) -> Result<()> {
    let protocol = fee * 20 / 100;
    let keeper = protocol / 2;
    let creator = fee / 10;
    let insurance = fee / 10;
    v.protocol_fees += protocol - keeper;
    m.creator_fees += creator;
    m.insurance += insurance;
    v.reserved += protocol - keeper + creator + insurance;
    pay_from_vault(v, vault_usdc, keeper_usdc, token_program, keeper)
}

/// Shares minted for `amount` USDC at the vault's current share price.
fn shares_for(v: &Vault, assets: u64, amount: u64) -> Result<u64> {
    let shares = if v.total_shares == 0 || assets == 0 {
        amount
    } else {
        ((amount as u128) * (v.total_shares as u128) / (assets as u128)) as u64
    };
    require!(shares > 0, PerpsError::ZeroAmount);
    Ok(shares)
}

/// USDC that belongs to LPs: balance minus trader collateral and reserved
/// fees/insurance. Unrealised trader PnL is not marked into NAV in v0.
pub fn lp_assets(v: &Vault, balance: u64) -> u64 {
    balance.saturating_sub(v.trader_collateral).saturating_sub(v.reserved)
}

fn pay_from_vault<'info>(
    v: &Account<'info, Vault>,
    from: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let seeds: &[&[&[u8]]] = &[&[SEED_VAULT, &[v.bump]]];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer { from: from.to_account_info(), to: to.to_account_info(), authority: v.to_account_info() },
            seeds,
        ),
        amount,
    )
}

fn mul_bps(amount: u64, bps: u128) -> u64 {
    ((amount as u128) * bps / BPS) as u64
}

fn apply_signed(value: u64, delta: i128) -> Result<u64> {
    let r = value as i128 + delta;
    require!(r >= 0, PerpsError::Insolvent);
    Ok(r as u64)
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub authority: Pubkey,
    pub price_authority: Pubkey,
    pub usdc_mint: Pubkey,
    pub total_shares: u64,
    /// USDC posted by traders (open positions and pending orders).
    pub trader_collateral: u64,
    /// Protocol fees, creator fees and insurance not yet paid out.
    pub reserved: u64,
    pub protocol_fees: u64,
    pub sol_usd_e6: u64,
    pub sol_usd_ts: i64,
    pub tier0_cap_bps: u16,
    pub skew_cap_bps: u16,
    pub paused: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct WithdrawalRequest {
    pub owner: Pubkey,
    pub shares: u64,
    pub unlock_ts: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Registry {
    pub live_tier0: u32,
    pub max_live_tier0: u32,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Retired {
    pub market: Pubkey,
    pub bump: u8,
}

/// Who owns protocol-owned liquidity (set by the vault authority).
#[account]
#[derive(InitSpace)]
pub struct TreasuryConfig {
    pub treasury: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct LpAccount {
    pub owner: Pubkey,
    pub shares: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub mint: Pubkey,
    pub curve: Pubkey,
    pub creator: Pubkey,
    pub tier: u8,
    pub created_slot: u64,
    pub oi_long: u64,
    pub oi_short: u64,
    pub oi_cap_override: u64,
    pub funding_index: i128,
    pub last_funding_ts: i64,
    pub band_anchor_q64: u128,
    pub band_anchor_slot: u64,
    /// Realised PnL paid to traders net of losses (positive = vault lost).
    pub trader_net_pnl: i128,
    pub insurance: u64,
    pub creator_fees: u64,
    pub reduce_only: bool,
    pub adl_mode: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub side: u8,
    pub collateral: u64,
    pub size_usd: u64,
    pub entry_price_q64: u128,
    pub funding_snapshot: i128,
    pub opened_slot: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct OrderRequest {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub side: u8,
    pub kind: u8,
    pub collateral: u64,
    pub size_usd: u64,
    pub acceptable_price_q64: u128,
    pub request_slot: u64,
    pub bump: u8,
    pub rent_payer: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct OrderArgs {
    pub side: u8,
    pub kind: u8,
    pub collateral: u64,
    pub size_usd: u64,
    pub acceptable_price_q64: u128,
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Vault::INIT_SPACE, seeds = [SEED_VAULT], bump)]
    pub vault: Box<Account<'info, Vault>>,
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(init, payer = authority, seeds = [SEED_VAULT_USDC], bump, token::mint = usdc_mint, token::authority = vault)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminVault<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump, has_one = authority)]
    pub vault: Account<'info, Vault>,
}

pub const SEED_PENDING_AUTHORITY: &[u8] = b"pending_authority";

/// A proposed admin handover, waiting for the successor to accept.
#[account]
#[derive(InitSpace)]
pub struct PendingAuthority {
    pub new_authority: Pubkey,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct ProposeAuthority<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [SEED_VAULT], bump = vault.bump, has_one = authority)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(init_if_needed, payer = authority, space = 8 + PendingAuthority::INIT_SPACE, seeds = [SEED_PENDING_AUTHORITY], bump)]
    pub pending: Box<Account<'info, PendingAuthority>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    #[account(mut)]
    pub new_authority: Signer<'info>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds = [SEED_PENDING_AUTHORITY], bump = pending.bump, close = new_authority)]
    pub pending: Box<Account<'info, PendingAuthority>>,
}

#[derive(Accounts)]
pub struct RefreshSolPrice<'info> {
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    /// CHECK: Pyth PriceUpdateV2, owner checked here and contents in pyth::read_sol_usd.
    #[account(owner = pyth::RECEIVER)]
    pub price_update: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct GraduateMarket<'info> {
    #[account(mut, has_one = curve)]
    pub market: Box<Account<'info, Market>>,
    pub curve: Box<Account<'info, Curve>>,
    #[account(mut, seeds = [SEED_REGISTRY], bump = registry.bump)]
    pub registry: Box<Account<'info, Registry>>,
    /// CHECK: exists only if the market was retired (its slot already freed).
    #[account(seeds = [SEED_RETIRED, market.key().as_ref()], bump)]
    pub retired: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RetireMarket<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, has_one = curve)]
    pub market: Box<Account<'info, Market>>,
    pub curve: Box<Account<'info, Curve>>,
    #[account(mut, seeds = [SEED_REGISTRY], bump = registry.bump)]
    pub registry: Box<Account<'info, Registry>>,
    #[account(init, payer = payer, space = 8 + Retired::INIT_SPACE, seeds = [SEED_RETIRED, market.key().as_ref()], bump)]
    pub retired: Box<Account<'info, Retired>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetMarketLimit<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [SEED_VAULT], bump = vault.bump, has_one = authority)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds = [SEED_REGISTRY], bump = registry.bump)]
    pub registry: Box<Account<'info, Registry>>,
}

#[derive(Accounts)]
pub struct RequestWithdrawal<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [SEED_LP, owner.key().as_ref()], bump = lp.bump, has_one = owner)]
    pub lp: Box<Account<'info, LpAccount>>,
    #[account(init_if_needed, payer = owner, space = 8 + WithdrawalRequest::INIT_SPACE, seeds = [SEED_WITHDRAWAL, owner.key().as_ref()], bump)]
    pub request: Box<Account<'info, WithdrawalRequest>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelWithdrawal<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [SEED_LP, owner.key().as_ref()], bump = lp.bump, has_one = owner)]
    pub lp: Box<Account<'info, LpAccount>>,
    #[account(mut, close = owner, seeds = [SEED_WITHDRAWAL, owner.key().as_ref()], bump = request.bump, has_one = owner)]
    pub request: Box<Account<'info, WithdrawalRequest>>,
}

#[derive(Accounts)]
pub struct CompleteWithdrawal<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds = [SEED_VAULT_USDC], bump)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, close = owner, seeds = [SEED_WITHDRAWAL, owner.key().as_ref()], bump = request.bump, has_one = owner)]
    pub request: Box<Account<'info, WithdrawalRequest>>,
    #[account(mut, token::mint = vault.usdc_mint, token::authority = owner)]
    pub owner_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SetSolPrice<'info> {
    pub price_authority: Signer<'info>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump, has_one = price_authority)]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct Liquidity<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds = [SEED_VAULT_USDC], bump)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = owner, space = 8 + LpAccount::INIT_SPACE, seeds = [SEED_LP, owner.key().as_ref()], bump)]
    pub lp: Box<Account<'info, LpAccount>>,
    #[account(mut, token::mint = vault.usdc_mint, token::authority = owner)]
    pub owner_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [ringside_launch::SEED_CURVE, curve.mint.as_ref()], bump = curve.bump, seeds::program = ringside_launch::ID)]
    pub curve: Box<Account<'info, Curve>>,
    #[account(init, payer = payer, space = 8 + Market::INIT_SPACE, seeds = [SEED_MARKET, curve.mint.as_ref()], bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(init_if_needed, payer = payer, space = 8 + Registry::INIT_SPACE, seeds = [SEED_REGISTRY], bump)]
    pub registry: Box<Account<'info, Registry>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: OrderArgs)]
pub struct RequestOrder<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// Pays rent for the order (refunded to it on fill or cancel) and, the
    /// first time, for the position. The relayer signs here so a fresh trading
    /// account needs no SOL. Can be the owner.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds = [SEED_VAULT_USDC], bump)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    pub market: Box<Account<'info, Market>>,
    #[account(
        init_if_needed, payer = payer, space = 8 + Position::INIT_SPACE,
        seeds = [SEED_POSITION, owner.key().as_ref(), market.key().as_ref(), &[args.side]], bump
    )]
    pub position: Box<Account<'info, Position>>,
    #[account(
        init, payer = payer, space = 8 + OrderRequest::INIT_SPACE,
        seeds = [SEED_ORDER, owner.key().as_ref(), market.key().as_ref(), &[args.side]], bump
    )]
    pub order: Box<Account<'info, OrderRequest>>,
    #[account(mut, token::mint = vault.usdc_mint, token::authority = owner)]
    pub owner_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds = [SEED_VAULT_USDC], bump)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    /// CHECK: receives the order's rent back.
    #[account(mut, address = order.rent_payer)]
    pub rent_payer: UncheckedAccount<'info>,
    #[account(mut, close = rent_payer, has_one = owner)]
    pub order: Box<Account<'info, OrderRequest>>,
    #[account(mut, token::mint = vault.usdc_mint, token::authority = owner)]
    pub owner_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ExecuteOrder<'info> {
    pub keeper: Signer<'info>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds = [SEED_VAULT_USDC], bump)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, has_one = curve)]
    pub market: Box<Account<'info, Market>>,
    pub curve: Box<Account<'info, Curve>>,
    /// CHECK: rent from the closed order goes back to whoever paid it.
    #[account(mut, address = order.rent_payer)]
    pub rent_payer: UncheckedAccount<'info>,
    #[account(mut, close = rent_payer, has_one = market)]
    pub order: Box<Account<'info, OrderRequest>>,
    #[account(
        mut,
        seeds = [SEED_POSITION, order.owner.as_ref(), market.key().as_ref(), &[order.side]], bump = position.bump
    )]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, token::mint = vault.usdc_mint, token::authority = order.owner)]
    pub owner_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = vault.usdc_mint)]
    pub keeper_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Liquidate<'info> {
    pub keeper: Signer<'info>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds = [SEED_VAULT_USDC], bump)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, has_one = curve)]
    pub market: Box<Account<'info, Market>>,
    pub curve: Box<Account<'info, Curve>>,
    #[account(mut, has_one = market)]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, token::mint = vault.usdc_mint, token::authority = position.owner)]
    pub owner_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = vault.usdc_mint)]
    pub keeper_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CrankFunding<'info> {
    #[account(seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, has_one = curve)]
    pub market: Box<Account<'info, Market>>,
    pub curve: Box<Account<'info, Curve>>,
}

#[derive(Accounts)]
pub struct AdminMarket<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [SEED_VAULT], bump = vault.bump, has_one = authority)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, has_one = curve)]
    pub market: Box<Account<'info, Market>>,
    pub curve: Box<Account<'info, Curve>>,
}

#[derive(Accounts)]
pub struct CompoundProtocolFees<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(seeds = [SEED_VAULT_USDC], bump)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    #[account(seeds = [SEED_TREASURY], bump = treasury_config.bump)]
    pub treasury_config: Box<Account<'info, TreasuryConfig>>,
    /// The treasury's LP account, whoever pays for the call.
    #[account(init_if_needed, payer = payer, space = 8 + LpAccount::INIT_SPACE, seeds = [SEED_LP, treasury_config.treasury.as_ref()], bump)]
    pub treasury_lp: Box<Account<'info, LpAccount>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetTreasury<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [SEED_VAULT], bump = vault.bump, has_one = authority)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(init_if_needed, payer = authority, space = 8 + TreasuryConfig::INIT_SPACE, seeds = [SEED_TREASURY], bump)]
    pub treasury_config: Box<Account<'info, TreasuryConfig>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositToTreasury<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds = [SEED_VAULT_USDC], bump)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    #[account(seeds = [SEED_TREASURY], bump = treasury_config.bump)]
    pub treasury_config: Box<Account<'info, TreasuryConfig>>,
    #[account(init_if_needed, payer = depositor, space = 8 + LpAccount::INIT_SPACE, seeds = [SEED_LP, treasury_config.treasury.as_ref()], bump)]
    pub treasury_lp: Box<Account<'info, LpAccount>>,
    #[account(mut, token::mint = vault.usdc_mint, token::authority = depositor)]
    pub depositor_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimProtocolFees<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump, has_one = authority)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds = [SEED_VAULT_USDC], bump)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = vault.usdc_mint)]
    pub treasury_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimCreator<'info> {
    pub creator: Signer<'info>,
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, seeds = [SEED_VAULT_USDC], bump)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, has_one = creator)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, token::mint = vault.usdc_mint, token::authority = creator)]
    pub creator_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

// ---------------------------------------------------------------------------
// Events and errors
// ---------------------------------------------------------------------------

#[event]
pub struct AuthorityProposed {
    pub new_authority: Pubkey,
}

#[event]
pub struct AuthorityAccepted {
    pub authority: Pubkey,
}

#[event]
pub struct TreasurySet {
    pub treasury: Pubkey,
}

#[event]
pub struct TreasuryDeposit {
    pub depositor: Pubkey,
    pub amount: u64,
    pub shares: u64,
}

#[event]
pub struct MarketCreated {
    pub mint: Pubkey,
    pub slot: u64,
}

#[event]
pub struct PositionChanged {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub side: u8,
    pub size_usd: u64,
    pub collateral: u64,
    pub mark_q64: u128,
}

#[event]
pub struct PositionClosed {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub side: u8,
    pub realized_pnl: i64,
    pub payout: u64,
    pub mark_q64: u128,
    /// 0 = close, 1 = liquidation, 2 = ADL
    pub reason: u8,
}

#[event]
pub struct OrderRejected {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub reason: u8,
}

#[event]
pub struct MarketLimitsSet {
    pub market: Pubkey,
    pub oi_cap_override: u64,
    pub reduce_only: bool,
}

#[event]
pub struct ProtocolFeesCompounded {
    pub amount: u64,
    pub shares: u64,
}

#[event]
pub struct WithdrawalRequested {
    pub owner: Pubkey,
    pub shares: u64,
    pub unlock_ts: i64,
}

#[event]
pub struct MarketGraduated {
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub price_q64: u128,
}

#[event]
pub struct BudgetExhausted {
    pub mint: Pubkey,
    pub trader_net_pnl: i64,
}

#[error_code]
pub enum PerpsError {
    #[msg("Only the proposed new authority can accept")]
    NotPendingAuthority,
    #[msg("Program is paused")]
    Paused,
    #[msg("Invalid arguments")]
    BadArgs,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Price must be positive")]
    BadPrice,
    #[msg("SOL/USD price is stale")]
    StaleSolPrice,
    #[msg("Market is reduce-only")]
    ReduceOnly,
    #[msg("Curve has graduated; use the AMM oracle")]
    CurveGraduated,
    #[msg("Order cannot be filled yet")]
    TooEarly,
    #[msg("Order has not expired")]
    NotExpired,
    #[msg("Leverage above the tier maximum")]
    Leverage,
    #[msg("Open interest cap reached")]
    OiCap,
    #[msg("Position above the per-account cap")]
    AccountCap,
    #[msg("Vault net exposure would exceed the skew cap")]
    SkewCap,
    #[msg("No open position")]
    NoPosition,
    #[msg("Position is above maintenance margin")]
    Healthy,
    #[msg("Market is not in ADL mode")]
    NotAdl,
    #[msg("Position is not profitable")]
    NotProfitable,
    #[msg("Collateral would go negative")]
    Insolvent,
    #[msg("Pyth price account is invalid, unverified or too uncertain")]
    BadOracle,
    #[msg("Raydium pool accounts are missing or don't match this token")]
    BadPool,
    #[msg("Curve has not migrated, or the market already graduated")]
    NotGraduated,
    #[msg("Withdrawal is still in its waiting period")]
    WithdrawalLocked,
    #[msg("Too many Tier 0 markets are live; retire idle ones or wait for graduations")]
    MarketLimit,
    #[msg("Market can't be retired: it has open interest, its curve sold out, or it traded in the last 7 days")]
    NotRetirable,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pos(side: u8, size: u64, collateral: u64, entry: u128) -> Position {
        Position { owner: Pubkey::default(), market: Pubkey::default(), side, collateral, size_usd: size, entry_price_q64: entry, funding_snapshot: 0, opened_slot: 0, bump: 0 }
    }

    #[test]
    fn quanto_pnl_tracks_percentage_move() {
        let entry = 100u128 << 56;
        let long = pos(SIDE_LONG, 1_000_000_000, 500_000_000, entry); // $1,000 at 2x
        let short = pos(SIDE_SHORT, 1_000_000_000, 500_000_000, entry);
        let up10 = entry * 110 / 100;
        assert_eq!(pnl(&long, up10), 100_000_000);
        assert_eq!(pnl(&short, up10), -100_000_000);
    }

    #[test]
    fn close_never_pays_below_zero() {
        let entry = 1u128 << 64;
        let p = pos(SIDE_LONG, 1_000_000_000, 500_000_000, entry);
        let m = Market {
            mint: Pubkey::default(), curve: Pubkey::default(), creator: Pubkey::default(), tier: 0, created_slot: 0,
            oi_long: 0, oi_short: 0, oi_cap_override: 0, funding_index: 0, last_funding_ts: 0,
            band_anchor_q64: entry, band_anchor_slot: 0, trader_net_pnl: 0, insurance: 0, creator_fees: 0,
            reduce_only: false, adl_mode: false, bump: 0,
        };
        let (payout, realized) = settle_close(&p, &m, entry / 10, 3_000_000).unwrap();
        assert_eq!(payout, 0);
        assert_eq!(realized, -500_000_000);
    }

    #[test]
    fn tier0_cap_is_one_percent_of_virtual_sol() {
        // 30 virtual SOL at $150 = $4,500 -> 1% = $45.
        let vsol_usd: u128 = 30_000_000_000u128 * 150_000_000 / 1_000_000_000;
        assert_eq!((vsol_usd * DEFAULT_TIER0_CAP_BPS as u128 / BPS) as u64, 45_000_000);
    }

    #[test]
    fn worst_of_execution_never_favours_the_trader() {
        let (mark, spot) = (100u128, 120u128);
        assert_eq!(execution_price(mark, spot, true, true), 120); // open long: pay the higher
        assert_eq!(execution_price(mark, spot, true, false), 100); // close long: get the lower
        assert_eq!(execution_price(mark, spot, false, true), 100); // open short: sell at the lower
        assert_eq!(execution_price(mark, spot, false, false), 120); // close short: buy back at the higher
    }
}

#[cfg(test)]
mod oracle_tests {
    use super::*;

    /// Live devnet SOL/USD PriceUpdateV2 (7UVim…), fetched 2026-11-25.
    const LIVE: &str = "IvEjY51+9M1gMUcENA3t3zcf1CRyFI8kjp0abRpesqw6zYt/1dayQwHvDYtv2izrpB2hXUCV0do5Kg0vjtDGx7wPTPrIwoC1beSQlZkBAAAA6KlZAAAAAAD4////SU8GawAAAABITwZrAAAAAIhIKZsBAAAAAHpOAAAAAAAePlofAAAAAAA=";
    const PUBLISHED: i64 = 1_795_575_625;

    fn b64(s: &str) -> Vec<u8> {
        const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let (mut out, mut buf, mut bits) = (Vec::new(), 0u32, 0u32);
        for c in s.bytes().filter(|c| *c != b'=') {
            buf = (buf << 6) | T.iter().position(|x| *x == c).unwrap() as u32;
            bits += 6;
            if bits >= 8 { bits -= 8; out.push((buf >> bits) as u8); buf &= (1 << bits) - 1; }
        }
        out
    }

    #[test]
    fn reads_live_pyth_account() {
        let d = b64(LIVE);
        let (px, ts) = pyth::read_sol_usd(&d, PUBLISHED + 10).unwrap();
        assert_eq!(px, 68_716_833); // $68.716833 (price 6871683300, expo -8)
        assert_eq!(ts, PUBLISHED);
    }

    #[test]
    fn refuses_stale_wrong_feed_partial_and_wide() {
        let d = b64(LIVE);
        assert!(pyth::read_sol_usd(&d, PUBLISHED + 90).is_ok(), "a late sponsored push (90 s) still counts");
        assert!(pyth::read_sol_usd(&d, PUBLISHED + 121).is_err(), "stale");
        let mut f = d.clone(); f[41] ^= 1;
        assert!(pyth::read_sol_usd(&f, PUBLISHED).is_err(), "other feed");
        let mut p = d.clone(); p[40] = 0;
        assert!(pyth::read_sol_usd(&p, PUBLISHED).is_err(), "partial verification");
        let mut w = d.clone(); w[81..89].copy_from_slice(&(200_000_000u64).to_le_bytes());
        assert!(pyth::read_sol_usd(&w, PUBLISHED).is_err(), "conf 3%");
        let mut z = d; z[0] = 0;
        assert!(pyth::read_sol_usd(&z, PUBLISHED).is_err(), "not a PriceUpdateV2");
    }

    /// Builds an ObservationState the way Raydium writes it: `steps` are
    /// (time, price from then on); observation i is stamped at step i with the
    /// cumulative up to that moment.
    fn observations(steps: &[(u64, u128)]) -> Vec<u8> {
        let mut d = vec![0u8; 8 + 1 + 2 + 32 + 100 * 40 + 32];
        d[8] = 1;
        let mut cum = 0u128;
        for (i, (t, _)) in steps.iter().enumerate() {
            if i > 0 {
                cum += steps[i - 1].1 * (t - steps[i - 1].0) as u128;
            }
            let o = 43 + i * 40;
            d[o..o + 8].copy_from_slice(&t.to_le_bytes());
            d[o + 8..o + 24].copy_from_slice(&cum.to_le_bytes());
        }
        d[9..11].copy_from_slice(&((steps.len() - 1) as u16).to_le_bytes());
        d
    }

    #[test]
    fn pool_twap_averages_the_last_five_minutes() {
        // Price 100 for a long time, then 200 for the last 60 s: TWAP over 300 s
        // is (240*100 + 60*200)/300 = 120.
        let steps: Vec<(u64, u128)> = (0..20).map(|k| (1_000 + k * 60, 100)).chain([(2_200, 200)]).collect();
        let d = observations(&steps);
        let twap = pool_twap_x32(&d, true, 200, 2_260);
        assert!((119..=121).contains(&twap), "twap {twap}");
    }

    #[test]
    fn a_pump_held_for_one_observation_is_averaged_then_banded() {
        let mut steps: Vec<(u64, u128)> = (0..20).map(|k| (1_000 + k * 60, 100)).collect();
        steps.push((2_200, 10_000)); // 100x pump...
        steps.push((2_215, 100)); // ...back by the next observation (15 s)
        let d = observations(&steps);
        let twap = pool_twap_x32(&d, true, 100, 2_260);
        // (240*100 + 15*10_000 + 45*100) / 300
        assert_eq!(twap, 595);
        // The TWAP alone moves ~6x; the band is what holds the mark to +15%.
        let mark = clamp_band(twap << 32, 100u128 << 32);
        assert!(mark <= (115u128 << 32), "mark {}", mark >> 32);
    }

    #[test]
    fn no_history_falls_back_to_spot() {
        let mut d = vec![0u8; 8 + 1 + 2 + 32 + 100 * 40 + 32];
        assert_eq!(pool_twap_x32(&d, true, 77, 5_000), 77);
        d[8] = 1;
        assert_eq!(pool_twap_x32(&d, true, 77, 5_000), 77);
    }
}

#[cfg(test)]
mod layout_fixture {
    use super::*;
    use anchor_lang::AccountSerialize;

    /// Prints serialized accounts so the TypeScript keeper's decoders can be
    /// checked against the real layout (client/test/layout.mjs).
    #[test]
    fn print_fixtures() {
        let k = |b: u8| Pubkey::new_from_array([b; 32]);
        let mut out = Vec::new();
        Market {
            mint: k(1), curve: k(2), creator: k(3), tier: 1, created_slot: 9, oi_long: 10, oi_short: 11, oi_cap_override: 12,
            funding_index: -13, last_funding_ts: 14, band_anchor_q64: 15u128 << 64, band_anchor_slot: 16, trader_net_pnl: -17,
            insurance: 18, creator_fees: 19, reduce_only: true, adl_mode: true, bump: 254,
        }.try_serialize(&mut out).unwrap();
        println!("MARKET {}", out.iter().map(|b| format!("{b:02x}")).collect::<String>());
        let mut out = Vec::new();
        Position { owner: k(4), market: k(5), side: 1, collateral: 6, size_usd: 7, entry_price_q64: (8u128 << 64) + 3, funding_snapshot: -9, opened_slot: 10, bump: 255 }
            .try_serialize(&mut out).unwrap();
        println!("POSITION {}", out.iter().map(|b| format!("{b:02x}")).collect::<String>());
        let mut out = Vec::new();
        OrderRequest { owner: k(6), market: k(7), side: 0, kind: 1, collateral: 2, size_usd: 3, acceptable_price_q64: 4, request_slot: 12345, bump: 1, rent_payer: k(8) }
            .try_serialize(&mut out).unwrap();
        println!("ORDER {}", out.iter().map(|b| format!("{b:02x}")).collect::<String>());
    }
}
