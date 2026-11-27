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
/// Each side's open interest may reach this multiple of the market cap. The
/// vault only carries the long-short imbalance, which the skew cap still limits
/// to 25% of the cap, so balanced markets can trade twice as much at the same
/// vault risk. Replay on real launches (sim/gross_check.py): 2x doubles fees with
/// unchanged tail losses; 3x worsened the worst case under heavy one-sided demand.
pub const GROSS_CAP_MULT: u64 = 2;
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
/// An unlocked withdrawal request can be completed only this long after it
/// unlocks. After that it has expired: it must be requested again (which
/// restarts the delay), so an LP can't keep an always-open exit.
#[cfg(not(feature = "devnet"))]
pub const WITHDRAWAL_WINDOW_SECONDS: i64 = 24 * 3_600;
#[cfg(feature = "devnet")]
pub const WITHDRAWAL_WINDOW_SECONDS: i64 = 600;
/// Virtual shares and assets in every share/asset conversion (ERC-4626 style
/// offset): the first share is never worth more than a sliver, so donating USDC
/// to an empty or tiny vault cannot make later deposits round to nothing.
pub const VIRTUAL_SHARES: u128 = 1_000;
pub const VIRTUAL_ASSETS: u128 = 1;
/// A market in ADL mode leaves it once its net trader profit is back under this
/// share of its budget (the budget itself flips it on, so this is hysteresis).
pub const ADL_CLEAR_BPS: i128 = 8_000;
/// At most this many Tier 0 markets live at once: 40 x 0.25% budget = 10% of the vault.
pub const DEFAULT_MAX_LIVE_TIER0: u32 = 40;
/// Length of the volume window (~7 days) a Tier 0 market must stay quiet for to be retired.
pub const RETIRE_IDLE_SLOTS: u64 = 7 * 24 * 3_600 * 1_000 / 400;
/// A Tier 0 market can be retired when the curve's volume over the window is below
/// this, measured in growth of `Curve.creator_fees_locked` (the 80% of the creator
/// fee, which every curve trade adds to and nothing but a forfeit or a post-sellout
/// claim lowers). At the 30 bps creator fee that is 5 SOL of gross curve volume
/// (5e9 x 30 / 10_000 x 80% = 12e6). Devnet curves are 60x smaller (0.5 virtual SOL).
#[cfg(not(feature = "devnet"))]
pub const RETIRE_MAX_VOLUME_FEES: u64 = 12_000_000;
#[cfg(feature = "devnet")]
pub const RETIRE_MAX_VOLUME_FEES: u64 = 200_000;

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

    /// Admin: pauses or resumes new risk. While paused: no new or larger
    /// positions (`request_order` increase, and `execute_order` refunds queued
    /// increases), no LP deposits (`deposit_liquidity`, `deposit_to_treasury`).
    /// Still allowed: close and reduce orders, cancel_order, liquidations, ADL,
    /// every LP withdrawal step, funding and band cranks, price refreshes,
    /// fee claims and compounding, market admin and graduation.
    pub fn set_paused(ctx: Context<AdminVault>, paused: bool) -> Result<()> {
        ctx.accounts.vault.paused = paused;
        emit!(PausedSet { paused });
        Ok(())
    }

    pub fn deposit_liquidity(ctx: Context<Liquidity>, amount: u64) -> Result<()> {
        require!(!ctx.accounts.vault.paused, PerpsError::Paused);
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
    /// Adding to an open request, or requesting again after one expired,
    /// restarts its timer and re-records the share price: the whole request is
    /// then paid at the lower of that price and the price at completion.
    pub fn request_withdrawal(ctx: Context<RequestWithdrawal>, shares: u64) -> Result<()> {
        require!(shares > 0 && shares <= ctx.accounts.lp.shares, PerpsError::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        let assets = lp_assets(&ctx.accounts.vault, ctx.accounts.vault_usdc.amount);
        let total_shares = ctx.accounts.vault.total_shares;
        ctx.accounts.lp.shares -= shares;
        let r = &mut ctx.accounts.request;
        r.owner = ctx.accounts.owner.key();
        r.shares += shares;
        r.unlock_ts = now + WITHDRAW_DELAY_SECONDS;
        r.request_assets = assets;
        r.request_total_shares = total_shares;
        r.bump = ctx.bumps.request;
        emit!(WithdrawalRequested { owner: r.owner, shares: r.shares, unlock_ts: r.unlock_ts });
        Ok(())
    }

    /// Puts a pending request's shares back in the LP account.
    pub fn cancel_withdrawal(ctx: Context<CancelWithdrawal>) -> Result<()> {
        ctx.accounts.lp.shares += ctx.accounts.request.shares;
        Ok(())
    }

    /// Step 2: once unlocked, and for WITHDRAWAL_WINDOW_SECONDS after that,
    /// pays the request's shares at the LOWER of the vault's value per share
    /// when requested and now. A later gain stays with the remaining LPs, a
    /// later loss is borne by the leaver. Requests resized from the old layout
    /// have no recorded price and are paid at the current one.
    pub fn withdraw_liquidity(ctx: Context<CompleteWithdrawal>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let r = &ctx.accounts.request;
        let shares = r.shares;
        require!(now >= r.unlock_ts, PerpsError::WithdrawalLocked);
        require!(now <= r.unlock_ts.saturating_add(WITHDRAWAL_WINDOW_SECONDS), PerpsError::WithdrawalExpired);
        require!(shares > 0, PerpsError::ZeroAmount);
        let assets = lp_assets(&ctx.accounts.vault, ctx.accounts.vault_usdc.amount);
        let mut amount = assets_for_shares(shares, assets, ctx.accounts.vault.total_shares)?;
        if r.request_total_shares > 0 {
            amount = amount.min(assets_for_shares(shares, r.request_assets, r.request_total_shares)?);
        }
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
        // The curve's TWAP, not its instantaneous price: whoever calls first can't
        // pump, create and sell back to park the band anchor far from fair value.
        m.band_anchor_q64 = curve.twap_q64(clock.slot, TWAP_WINDOW_SLOTS);
        m.band_anchor_slot = clock.slot;
        m.trader_net_pnl = 0;
        m.insurance = 0;
        m.creator_fees = 0;
        m.creator_fees_locked = 0;
        m.pool = Pubkey::default();
        m.grad_price_q64 = 0;
        m.vol_snap_slot = clock.slot;
        m.vol_snap_fees = curve.creator_fees_locked;
        m.reduce_only = false;
        m.adl_mode = false;
        m.bump = ctx.bumps.market;
        emit!(MarketCreated { mint: m.mint, slot: clock.slot });
        Ok(())
    }

    /// Step 1 of a trade: escrow collateral and record the request.
    /// A keeper fills it at the first mark at least FILL_DELAY_SLOTS later.
    pub fn request_order(ctx: Context<RequestOrder>, args: OrderArgs) -> Result<()> {
        require!(args.side <= 1 && args.kind <= 1, PerpsError::BadArgs);
        // Every order carries a price bound: an unbounded order could be filled
        // by anyone at whatever price the market shows at that moment.
        require!(args.acceptable_price_q64 > 0, PerpsError::AcceptablePriceRequired);
        let slot = Clock::get()?.slot;

        if args.kind == ORDER_INCREASE {
            require!(!ctx.accounts.vault.paused, PerpsError::Paused);
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
        if clock.slot >= order.request_slot + ORDER_EXPIRY_SLOTS {
            // An expired order is never filled: the price it was placed against is
            // stale, and a late fill would let anyone choose the moment. Anyone may
            // clear it, and the escrow always goes back to the owner (cancel_order
            // is the owner's own route to the same refund).
            let vault = &mut ctx.accounts.vault;
            refund_order(vault, order, &ctx.accounts.vault_usdc, &ctx.accounts.owner_usdc, &ctx.accounts.token_program, REJECT_EXPIRED)?;
            return Ok(());
        }
        let vault_balance = ctx.accounts.vault_usdc.amount;
        let lp_value = lp_assets(&ctx.accounts.vault, vault_balance);

        // Paused (after the expiry check above, so an expired order still reports as
        // expired): an increase queued before the pause is refunded, not filled.
        if order.kind == ORDER_INCREASE && ctx.accounts.vault.paused {
            let vault = &mut ctx.accounts.vault;
            refund_order(vault, order, &ctx.accounts.vault_usdc, &ctx.accounts.owner_usdc, &ctx.accounts.token_program, REJECT_PAUSED)?;
            return Ok(());
        }

        let market = &mut ctx.accounts.market;
        let view = price_view(market, &ctx.accounts.curve, ctx.remaining_accounts, clock.slot, clock.unix_timestamp)?;
        accrue_funding(market, &ctx.accounts.vault, view.sol_reserve, clock.unix_timestamp)?;
        let (mark, clamped) = mark_price(market, &view, clock.slot);
        let tp = tier_params(market.tier);
        let pos = &mut ctx.accounts.position;
        let vault = &mut ctx.accounts.vault;
        let is_long = order.side == SIDE_LONG;
        let px = execution_price(mark, view.spot, is_long, order.kind == ORDER_INCREASE);

        // Always bounded: request_order refuses a zero price.
        let within = if (order.kind == ORDER_INCREASE) == is_long {
            px <= order.acceptable_price_q64
        } else {
            px >= order.acceptable_price_q64
        };
        if !within {
            // Refund instead of failing so the keeper can always clear the queue.
            refund_order(vault, order, &ctx.accounts.vault_usdc, &ctx.accounts.owner_usdc, &ctx.accounts.token_program, REJECT_PRICE)?;
            return Ok(());
        }
        // A graduated pool has no price history yet: it is priced at the curve's
        // final price, which is fine for closing but not for taking on new risk.
        if order.kind == ORDER_INCREASE && view.warming {
            refund_order(vault, order, &ctx.accounts.vault_usdc, &ctx.accounts.owner_usdc, &ctx.accounts.token_program, REJECT_WARMUP)?;
            return Ok(());
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
            require!(side_oi + order.size_usd <= cap.saturating_mul(GROSS_CAP_MULT), PerpsError::OiCap);
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

        cover_with_insurance(vault, market);
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
        cover_with_insurance(vault, market);
        check_budget(market, lp_value);
        Ok(())
    }

    /// Auto-deleverage a profitable position at the mark, with no fee, while the
    /// market is in ADL mode. Anyone may call it, and the program cannot list a
    /// market's positions, so it cannot force the most profitable one first.
    /// What it enforces: the call first re-checks the budget (a recovered market
    /// leaves ADL mode and the call returns without closing anything), and any
    /// other positions the caller passes after the price accounts (remaining
    /// accounts; Tier 1+ markets put the 4 pool accounts first) must have a
    /// profit ratio (PnL net of funding / collateral) no higher than the target's.
    /// The keeper passes the next-ranked positions. A caller who omits them is
    /// still limited to profitable positions, at the mark, in ADL mode only.
    pub fn auto_deleverage(ctx: Context<Liquidate>) -> Result<()> {
        let clock = Clock::get()?;
        let lp_value = lp_assets(&ctx.accounts.vault, ctx.accounts.vault_usdc.amount);
        let market = &mut ctx.accounts.market;
        require!(market.adl_mode, PerpsError::NotAdl);
        let vault = &mut ctx.accounts.vault;
        cover_with_insurance(vault, market);
        check_budget(market, lp_value);
        if !market.adl_mode {
            return Ok(()); // recovered: mode cleared, nobody is deleveraged
        }
        let view = price_view(market, &ctx.accounts.curve, ctx.remaining_accounts, clock.slot, clock.unix_timestamp)?;
        accrue_funding(market, vault, view.sol_reserve, clock.unix_timestamp)?;
        let (mark, _) = mark_price(market, &view, clock.slot);
        let pos = &mut ctx.accounts.position;
        require!(pos.size_usd > 0 && pnl(pos, mark) > 0, PerpsError::NotProfitable);

        let target = profit_ratio(pos, mark, market.funding_index);
        let skip = if market.tier == 0 { 0 } else { 4 };
        for info in ctx.remaining_accounts.iter().skip(skip) {
            require_keys_eq!(*info.owner, crate::ID, PerpsError::AdlWrongTarget);
            let other = Position::try_deserialize(&mut &info.try_borrow_data()?[..])?;
            require!(other.market == market.key(), PerpsError::AdlWrongTarget);
            if other.size_usd > 0 {
                require!(profit_ratio(&other, mark, market.funding_index) <= target, PerpsError::AdlWrongTarget);
            }
        }

        let (payout, realized) = settle_close(pos, market, mark, 0)?;
        vault.trader_collateral -= pos.collateral;
        market.trader_net_pnl += realized;
        if pos.side == SIDE_LONG { market.oi_long -= pos.size_usd } else { market.oi_short -= pos.size_usd }
        pay_from_vault(vault, &ctx.accounts.vault_usdc, &ctx.accounts.owner_usdc, &ctx.accounts.token_program, payout)?;
        emit!(PositionClosed { owner: pos.owner, market: pos.market, side: pos.side, realized_pnl: realized as i64, payout, mark_q64: mark, reason: 2 });
        reset_position(pos);
        cover_with_insurance(vault, market);
        Ok(())
    }

    /// Permissionless crank: accrues funding and rolls the band anchor.
    pub fn crank_funding(ctx: Context<CrankFunding>) -> Result<()> {
        let clock = Clock::get()?;
        let view = price_view(&ctx.accounts.market, &ctx.accounts.curve, ctx.remaining_accounts, clock.slot, clock.unix_timestamp)?;
        accrue_funding(&mut ctx.accounts.market, &ctx.accounts.vault, view.sol_reserve, clock.unix_timestamp)?;
        mark_price(&mut ctx.accounts.market, &view, clock.slot);
        if ctx.accounts.market.tier == 0 {
            roll_volume_window(&mut ctx.accounts.market, &ctx.accounts.curve, clock.slot);
        }
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
        let was_retired = !ctx.accounts.retired.data_is_empty();
        let m = &mut ctx.accounts.market;
        m.tier = 1;
        // The curve's final price: where the pool opens, and what the market is
        // priced at (opens blocked) until the pool has a full TWAP window of history.
        let c = &ctx.accounts.curve;
        m.grad_price_q64 = ((c.virtual_sol as u128) << 64) / c.virtual_tokens as u128;
        // Fix the pool once. Curves migrate into ringside_launch's own pool PDA.
        // The one exception is a curve that migrated before that change: its
        // pool is Raydium's canonical one, accepted only while the launch PDA
        // holds no pool (remaining account 4, a system-owned or empty account).
        let mint = ctx.accounts.curve.mint;
        let launch_pool = ringside_launch::launch_pool_address(&mint);
        let first = ctx.remaining_accounts.first().ok_or(PerpsError::BadPool)?;
        m.pool = if *first.key == launch_pool {
            launch_pool
        } else {
            let legacy = ctx.remaining_accounts.get(4).ok_or(PerpsError::BadPool)?;
            require!(
                *first.key == raydium::canonical_pool_address(mint)
                    && *legacy.key == launch_pool
                    && *legacy.owner != raydium::CPMM_PROGRAM,
                PerpsError::BadPool
            );
            *first.key
        };
        // Validates the pool accounts.
        let view = price_view(m, &ctx.accounts.curve, ctx.remaining_accounts, clock.slot, clock.unix_timestamp)?;
        // The band restarts at the curve's final price. It's fixed by the
        // sellout itself (nobody can push it), and migrate opens the pool at
        // exactly that price. Any pool trading since is then followed at most
        // 15% per window.
        m.band_anchor_q64 = m.grad_price_q64;
        m.band_anchor_slot = clock.slot;
        // Keep an admin's reduce-only setting. Retirement also sets the flag, and
        // that one ends here: the market is live again at Tier 1.
        m.reduce_only = m.adl_mode || (m.reduce_only && !was_retired);
        emit!(MarketGraduated { mint: m.mint, pool: ctx.remaining_accounts[0].key(), price_q64: view.twap });
        Ok(())
    }

    /// Permissionless: frees the Tier 0 slot of a dead launch. Allowed when the
    /// curve hasn't sold out, the market has no open interest and the curve has
    /// been quiet: either no trade at all for ~7 days, or less than
    /// RETIRE_MAX_VOLUME_FEES of volume (creator-fee growth, see `roll_volume_window`)
    /// over a window of at least ~7 days. Dust trades therefore don't keep a slot
    /// alive. The market becomes reduce-only (it can still graduate later).
    pub fn retire_market(ctx: Context<RetireMarket>) -> Result<()> {
        let slot = Clock::get()?.slot;
        let m = &mut ctx.accounts.market;
        let c = &ctx.accounts.curve;
        require!(
            m.tier == 0 && !c.complete && m.oi_long == 0 && m.oi_short == 0 && (slot.saturating_sub(c.last_slot) >= RETIRE_IDLE_SLOTS || volume_window_quiet(m, c, slot)),
            PerpsError::NotRetirable
        );
        m.reduce_only = true;
        let reg = &mut ctx.accounts.registry;
        reg.live_tier0 = reg.live_tier0.saturating_sub(1);
        ctx.accounts.retired.market = m.key();
        ctx.accounts.retired.bump = ctx.bumps.retired;
        Ok(())
    }

    /// Admin: retires any Tier 0 market with no open interest at once, whatever
    /// its volume or the state of its curve (spam, or a market the admin wants
    /// off). Same effects as `retire_market`.
    pub fn admin_retire_market(ctx: Context<AdminRetireMarket>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.tier == 0 && m.oi_long == 0 && m.oi_short == 0, PerpsError::NotRetirable);
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
        require!(!ctx.accounts.vault.paused, PerpsError::Paused);
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

    /// Pays the creator `creator_fees` (the early 20%) at any time, plus
    /// `creator_fees_locked` once the market's curve has graduated.
    pub fn claim_creator_fees(ctx: Context<ClaimCreator>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        let mut amount = m.creator_fees;
        m.creator_fees = 0;
        if ctx.accounts.curve.complete {
            amount = amount.checked_add(m.creator_fees_locked).ok_or(ProgramError::ArithmeticOverflow)?;
            m.creator_fees_locked = 0;
        }
        require!(amount > 0, PerpsError::ZeroAmount);
        ctx.accounts.vault.reserved -= amount;
        pay_from_vault(&ctx.accounts.vault, &ctx.accounts.vault_usdc, &ctx.accounts.creator_usdc, &ctx.accounts.token_program, amount)
    }

    /// Permissionless. Once the market's curve is `CREATOR_FEE_FORFEIT_SECONDS`
    /// old and has not graduated, moves the market's locked creator fees into
    /// `vault.protocol_fees` (compoundable into treasury LP shares). No USDC
    /// moves and `vault.reserved` is unchanged: both buckets are part of it.
    pub fn forfeit_creator_fees(ctx: Context<ForfeitCreator>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let curve = &ctx.accounts.curve;
        let forfeit_ts = curve.created_ts.checked_add(ringside_launch::CREATOR_FEE_FORFEIT_SECONDS).ok_or(ProgramError::ArithmeticOverflow)?;
        require!(!curve.complete && now >= forfeit_ts, PerpsError::NotForfeitable);
        let m = &mut ctx.accounts.market;
        let amount = m.creator_fees_locked;
        require!(amount > 0, PerpsError::ZeroAmount);
        m.creator_fees_locked = 0;
        ctx.accounts.vault.protocol_fees += amount;
        emit!(CreatorFeesForfeited { mint: m.mint, amount });
        Ok(())
    }

    /// Permissionless migration helper: grows a `Market` created before
    /// `creator_fees_locked` existed to the current size (the payer funds the
    /// extra rent; new bytes are zero). No-op if already large enough.
    pub fn resize_market(ctx: Context<ResizeMarket>) -> Result<()> {
        let info = ctx.accounts.market.to_account_info();
        require_keys_eq!(*info.owner, crate::ID, anchor_lang::error::ErrorCode::AccountOwnedByWrongProgram);
        let mint = {
            let data = info.try_borrow_data()?;
            require!(data.len() >= 8 + 32, anchor_lang::error::ErrorCode::AccountDiscriminatorNotFound);
            require!(data[..8] == *Market::DISCRIMINATOR, anchor_lang::error::ErrorCode::AccountDiscriminatorMismatch);
            Pubkey::new_from_array(data[8..40].try_into().unwrap())
        };
        let (expected, _) = Pubkey::find_program_address(&[SEED_MARKET, mint.as_ref()], &crate::ID);
        require_keys_eq!(expected, info.key(), anchor_lang::error::ErrorCode::ConstraintSeeds);
        let new_len = 8 + Market::INIT_SPACE;
        if info.data_len() >= new_len {
            return Ok(());
        }
        // Rent for the extra bytes only: the account also holds real SOL / fee balances,
        // so comparing the new minimum with its total lamports would charge nothing.
        let rent = Rent::get()?;
        let needed = rent.minimum_balance(new_len).saturating_sub(rent.minimum_balance(info.data_len()));
        if needed > 0 {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer { from: ctx.accounts.payer.to_account_info(), to: info.clone() },
                ),
                needed,
            )?;
        }
        info.resize(new_len)?;
        Ok(())
    }

    /// Permissionless migration helper: grows a `WithdrawalRequest` made before
    /// the request-time price fields existed. New bytes are zero, which reads as
    /// "no recorded price" (paid at the current one). No-op if already large enough.
    pub fn resize_withdrawal(ctx: Context<ResizeWithdrawal>) -> Result<()> {
        let info = ctx.accounts.request.to_account_info();
        require_keys_eq!(*info.owner, crate::ID, anchor_lang::error::ErrorCode::AccountOwnedByWrongProgram);
        let owner = {
            let data = info.try_borrow_data()?;
            require!(data.len() >= 8 + 32, anchor_lang::error::ErrorCode::AccountDiscriminatorNotFound);
            require!(data[..8] == *WithdrawalRequest::DISCRIMINATOR, anchor_lang::error::ErrorCode::AccountDiscriminatorMismatch);
            Pubkey::new_from_array(data[8..40].try_into().unwrap())
        };
        let (expected, _) = Pubkey::find_program_address(&[SEED_WITHDRAWAL, owner.as_ref()], &crate::ID);
        require_keys_eq!(expected, info.key(), anchor_lang::error::ErrorCode::ConstraintSeeds);
        let new_len = 8 + WithdrawalRequest::INIT_SPACE;
        if info.data_len() >= new_len {
            return Ok(());
        }
        let rent = Rent::get()?;
        let needed = rent.minimum_balance(new_len).saturating_sub(rent.minimum_balance(info.data_len()));
        if needed > 0 {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer { from: ctx.accounts.payer.to_account_info(), to: info.clone() },
                ),
                needed,
            )?;
        }
        info.resize(new_len)?;
        Ok(())
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
    /// True while a graduated market's pool has no observation history covering
    /// the TWAP window: `twap` is then the fixed fallback price, not the pool's.
    pub warming: bool,
}

pub fn price_view(m: &Market, curve: &Curve, rem: &[AccountInfo], slot: u64, now: i64) -> Result<PriceView> {
    if m.tier == 0 {
        return Ok(PriceView { twap: curve.twap_q64(slot, TWAP_WINDOW_SLOTS), spot: curve.last_price_q64, sol_reserve: curve.virtual_sol_lamports(), warming: false });
    }
    pool_view(curve.mint, expected_pool(m, curve.mint), warmup_price(m), rem, now)
}

/// The price a graduated market keeps until its pool has TWAP history: the
/// curve's final price stored at `graduate_market`. Markets that graduated
/// before it was stored use their band anchor, the last banded mark.
pub fn warmup_price(m: &Market) -> u128 {
    if m.grad_price_q64 > 0 { m.grad_price_q64 } else { m.band_anchor_q64 }
}

/// The pool a Tier 1+ market must price from: the key stored at graduation or,
/// for markets that graduated before one was stored, Raydium's canonical pool
/// (where those curves migrated). New markets always store a key, so the
/// canonical address (which anyone can create) is never accepted for them.
pub fn expected_pool(m: &Market, mint: Pubkey) -> Pubkey {
    if m.pool == Pubkey::default() { raydium::canonical_pool_address(mint) } else { m.pool }
}

fn token_amount(a: &AccountInfo) -> Result<u64> {
    let d = a.try_borrow_data()?;
    require!(d.len() >= 72, PerpsError::BadPool);
    Ok(u64::from_le_bytes(d[64..72].try_into().unwrap()))
}

/// Raydium PoolState offsets (8-byte discriminator, then packed): the fee fields
/// that sit in the vaults but are not pool liquidity. protocol and fund fees are
/// u64 pairs at 349/365 (token 0, token 1 each); the creator fees are the pair at
/// 397. Older pool accounts hold zeros at 397 (padding there).
const POOL_FEES_END: usize = 413;
pub fn pool_fee_total(d: &[u8], token_1: bool) -> u64 {
    let at = |o: usize| u64::from_le_bytes(d[o + if token_1 { 8 } else { 0 }..o + if token_1 { 16 } else { 8 }].try_into().unwrap());
    at(341).saturating_add(at(357)).saturating_add(at(397))
}

/// Reads a graduated token's price from its Raydium CPMM pool. remaining
/// accounts: [pool_state, observation_state, token vault, wSOL vault]; the pool
/// must be `pool_key` and the rest are PDAs of Raydium derived from it.
/// Vault balances are net of the pool's accrued protocol, fund and creator fees,
/// as Raydium itself prices. The mark never takes the pool's instantaneous
/// price: `twap` comes from the observation history only, or is `warm_price`
/// (flagged `warming`) while that history does not yet cover the window.
pub fn pool_view(mint: Pubkey, pool_key: Pubkey, warm_price: u128, rem: &[AccountInfo], now: i64) -> Result<PriceView> {
    require!(rem.len() >= 4, PerpsError::BadPool);
    let (pool, obs, tok_vault, sol_vault) = (&rem[0], &rem[1], &rem[2], &rem[3]);
    let wsol = anchor_spl::token::spl_token::native_mint::ID;
    let vault_pda = |m: &Pubkey| Pubkey::find_program_address(&[raydium::POOL_VAULT_SEED, pool.key.as_ref(), m.as_ref()], &raydium::CPMM_PROGRAM).0;
    require!(*pool.key == pool_key && *pool.owner == raydium::CPMM_PROGRAM, PerpsError::BadPool);
    require!(*obs.key == raydium::observation_address(*pool.key) && *obs.owner == raydium::CPMM_PROGRAM, PerpsError::BadPool);
    require!(*tok_vault.key == vault_pda(&mint) && *sol_vault.key == vault_pda(&wsol), PerpsError::BadPool);
    let token_is_0 = mint < wsol;
    let (tok_fees, sol_fees) = {
        let d = pool.try_borrow_data()?;
        require!(d.len() >= POOL_FEES_END, PerpsError::BadPool);
        (pool_fee_total(&d, !token_is_0), pool_fee_total(&d, token_is_0))
    };
    let tokens = token_amount(tok_vault)?.saturating_sub(tok_fees);
    let sol = token_amount(sol_vault)?.saturating_sub(sol_fees);
    require!(tokens > 0 && sol > 0, PerpsError::BadPool);
    let spot_x32 = ((sol as u128) << 32) / tokens as u128;
    let twap_x32 = pool_twap_x32(&obs.try_borrow_data()?, token_is_0, now as u64);
    Ok(match twap_x32 {
        Some(t) => PriceView { twap: t << 32, spot: spot_x32 << 32, sol_reserve: sol, warming: false },
        None => PriceView { twap: warm_price, spot: spot_x32 << 32, sol_reserve: sol, warming: true },
    })
}

/// TWAP of the token's price in lamports per base unit (x32) over
/// POOL_TWAP_SECONDS, from Raydium's ObservationState (packed, zero-copy):
/// disc 8 | initialized u8 | observation_index u16 | pool 32 |
/// 100 x (block_timestamp u64, cum_token_0_price_x32 u128, cum_token_1_price_x32 u128) | padding.
/// Observation k holds the cumulative price up to its own timestamp (written
/// at most every 15 s, on swaps, with the pre-swap price; the first swap only
/// stamps a zero cumulative). The cumulative is extended from the newest
/// observation to `now` at the last observed price, the average over the newest
/// observed interval, never at the live pool price, so a stale newest
/// observation or a donation to the vaults cannot move it. It is then
/// differenced against the newest observation at least POOL_TWAP_SECONDS old.
/// Returns None while the history cannot do that: no such observation (the
/// history does not cover the window yet) or no interval to take a price from.
pub fn pool_twap_x32(d: &[u8], token_is_0: bool, now: u64) -> Option<u128> {
    const N: usize = 100;
    const BASE: usize = 8 + 1 + 2 + 32;
    if d.len() < BASE + N * 40 || d[8] == 0 {
        return None;
    }
    let latest = u16::from_le_bytes([d[9], d[10]]) as usize % N;
    let ts = |k: usize| u64::from_le_bytes(d[BASE + k * 40..BASE + k * 40 + 8].try_into().unwrap());
    let cum = |k: usize| {
        let o = BASE + k * 40 + 8 + if token_is_0 { 0 } else { 16 };
        u128::from_le_bytes(d[o..o + 16].try_into().unwrap())
    };
    let t_latest = ts(latest);
    let prev = (latest + N - 1) % N;
    let t_prev = ts(prev);
    if t_latest == 0 || t_latest > now || t_prev == 0 || t_prev >= t_latest {
        return None;
    }
    let last_price = cum(latest).wrapping_sub(cum(prev)) / (t_latest - t_prev) as u128;
    let cum_now = cum(latest).wrapping_add(last_price.wrapping_mul((now - t_latest) as u128));
    let cutoff = now.saturating_sub(POOL_TWAP_SECONDS);
    let mut start: Option<(u64, u128)> = None;
    for k in 0..N {
        let t = ts(k);
        if t != 0 && t <= cutoff && t <= t_latest && start.map_or(true, |b| t > b.0) {
            start = Some((t, cum(k)));
        }
    }
    let (t, c) = start?;
    Some(cum_now.wrapping_sub(c) / (now - t) as u128)
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

/// The curve's volume proxy: `creator_fees_locked` grows with every curve trade
/// (80% of the creator fee) and only falls on a forfeit or a post-sellout claim.
/// Cheap to read, no per-trade hook needed in the launch program, and wash
/// volume costs its fees.
///
/// A Tier 0 market keeps a window start (slot and proxy value). It is retirable
/// once the window is at least RETIRE_IDLE_SLOTS old and the proxy grew by less
/// than RETIRE_MAX_VOLUME_FEES. A proxy that fell (forfeit) is never "quiet".
pub fn volume_window_quiet(m: &Market, c: &Curve, slot: u64) -> bool {
    m.vol_snap_slot > 0
        && slot.saturating_sub(m.vol_snap_slot) >= RETIRE_IDLE_SLOTS
        && c.creator_fees_locked >= m.vol_snap_fees
        && c.creator_fees_locked - m.vol_snap_fees < RETIRE_MAX_VOLUME_FEES
}

/// Run by `crank_funding`: starts the window if there is none (markets created
/// before it existed), restarts it after the proxy fell, and rolls it forward
/// when a full window has passed with enough volume (a quiet window is left
/// alone so the market stays retirable).
pub fn roll_volume_window(m: &mut Market, c: &Curve, slot: u64) {
    let f = c.creator_fees_locked;
    let restart = m.vol_snap_slot == 0
        || f < m.vol_snap_fees
        || (slot.saturating_sub(m.vol_snap_slot) >= RETIRE_IDLE_SLOTS && f - m.vol_snap_fees >= RETIRE_MAX_VOLUME_FEES);
    if restart {
        m.vol_snap_slot = slot;
        m.vol_snap_fees = f;
    }
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

/// Insurance is spent as soon as the market has a net loss to cover: after every
/// settlement (close, liquidation, ADL) the market's insurance is applied to its
/// net trader profit (`trader_net_pnl`, what LPs have lost on this market), and
/// that profit falls by the same amount. The USDC stays in the vault but leaves
/// `reserved`, so it becomes LP assets: LPs bear a payout, or a bad-debt gap,
/// only once the market's insurance is used up. Afterwards a market has either no
/// insurance or no net trader profit, so `trader_net_pnl` is net of insurance
/// and `check_budget` never counts money that has not been spent.
fn cover_with_insurance(v: &mut Vault, m: &mut Market) {
    if m.trader_net_pnl <= 0 || m.insurance == 0 {
        return;
    }
    let spend = (m.insurance as u128).min(m.trader_net_pnl as u128) as u64;
    m.insurance -= spend;
    v.reserved -= spend;
    m.trader_net_pnl -= spend as i128;
    emit!(InsuranceSpent { mint: m.mint, amount: spend });
}

/// Past its budget (a share of LP value) a market goes reduce-only and into ADL.
/// ADL mode ends when net trader profit is back under ADL_CLEAR_BPS of the budget
/// (checked wherever the budget is: fills, liquidations and ADL calls). The
/// reduce-only flag stays until the admin lifts it with `set_market_limits`,
/// because it may also have been set by hand.
fn check_budget(m: &mut Market, lp_value: u64) {
    let budget = (lp_value as u128 * tier_params(m.tier).budget_bps / BPS) as i128;
    if m.trader_net_pnl > budget {
        m.reduce_only = true;
        if !m.adl_mode {
            m.adl_mode = true;
            emit!(BudgetExhausted { mint: m.mint, trader_net_pnl: m.trader_net_pnl as i64 });
        }
    } else if m.adl_mode && m.trader_net_pnl * (BPS as i128) <= budget * ADL_CLEAR_BPS {
        m.adl_mode = false;
        emit!(AdlCleared { mint: m.mint, trader_net_pnl: m.trader_net_pnl as i64 });
    }
}

/// Unrealised profit net of funding per unit of collateral (x1e6), for ADL ordering.
fn profit_ratio(p: &Position, mark: u128, funding_index: i128) -> i128 {
    (pnl(p, mark) - funding_owed(p, funding_index)) * 1_000_000 / (p.collateral.max(1) as i128)
}

/// Returns (payout to trader, realised PnL to trader net of funding, floored
/// at losing all collateral). Fee is deducted from the payout.
fn settle_close(p: &Position, m: &Market, mark: u128, fee: u64) -> Result<(u64, i128)> {
    let gross = pnl(p, mark) - funding_owed(p, m.funding_index);
    let realized = gross.max(-(p.collateral as i128));
    let equity = (p.collateral as i128 + realized - fee as i128).max(0);
    Ok((equity as u64, realized))
}

/// `OrderRejected.reason`: the fill price was outside the order's bound.
pub const REJECT_PRICE: u8 = 0;
/// The order had expired.
pub const REJECT_EXPIRED: u8 = 1;
/// A new open or increase on a pool with no price history yet.
pub const REJECT_WARMUP: u8 = 2;
/// An increase queued before the vault was paused.
pub const REJECT_PAUSED: u8 = 3;

/// Returns an order's escrowed collateral to its owner and reports the rejection.
fn refund_order<'info>(
    vault: &mut Account<'info, Vault>,
    order: &OrderRequest,
    vault_usdc: &Account<'info, TokenAccount>,
    owner_usdc: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    reason: u8,
) -> Result<()> {
    if order.collateral > 0 {
        vault.trader_collateral -= order.collateral;
        pay_from_vault(vault, vault_usdc, owner_usdc, token_program, order.collateral)?;
    }
    emit!(OrderRejected { owner: order.owner, market: order.market, reason });
    Ok(())
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
    // The creator's share is split 20/80: early (claimable now) and locked
    // (claimable at graduation, forfeited to protocol_fees after 30 days). Both
    // stay in `reserved`, so the total added to it is unchanged.
    let (creator_early, creator_locked) = ringside_launch::split_creator_fee(creator);
    v.protocol_fees += protocol - keeper;
    m.creator_fees += creator_early;
    m.creator_fees_locked += creator_locked;
    m.insurance += insurance;
    v.reserved += protocol - keeper + creator + insurance;
    pay_from_vault(v, vault_usdc, keeper_usdc, token_program, keeper)
}

/// Shares minted for `amount` USDC at the vault's current share price, with
/// VIRTUAL_SHARES / VIRTUAL_ASSETS added to the pool (rounds down: the vault
/// keeps the remainder). Refused while shares exist but no assets back them:
/// a new depositor would be minted against worthless old shares.
fn shares_for(v: &Vault, assets: u64, amount: u64) -> Result<u64> {
    require!(v.total_shares == 0 || assets > 0, PerpsError::VaultHasNoAssets);
    let shares = (amount as u128) * (v.total_shares as u128 + VIRTUAL_SHARES) / (assets as u128 + VIRTUAL_ASSETS);
    let shares = u64::try_from(shares).map_err(|_| ProgramError::ArithmeticOverflow)?;
    require!(shares > 0, PerpsError::ZeroAmount);
    Ok(shares)
}

/// USDC paid for `shares` out of a pool of `assets` and `total_shares`, with the
/// same virtual offset as `shares_for` (rounds down: the vault keeps the remainder).
pub fn assets_for_shares(shares: u64, assets: u64, total_shares: u64) -> Result<u64> {
    let amount = (shares as u128) * (assets as u128 + VIRTUAL_ASSETS) / (total_shares as u128 + VIRTUAL_SHARES);
    Ok(u64::try_from(amount).map_err(|_| ProgramError::ArithmeticOverflow)?)
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
    /// LP assets and total shares when the request was made (the share price it
    /// can't be paid above). APPENDED after `bump`: requests made before these
    /// existed need `resize_withdrawal`, and read as zero = no recorded price.
    pub request_assets: u64,
    pub request_total_shares: u64,
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
    /// Locked 80% of creator fees. APPENDED after `bump`: markets created
    /// before this field existed need `resize_market`.
    pub creator_fees_locked: u64,
    /// The Raydium pool this market prices from, fixed once at `graduate_market`.
    /// APPENDED after `creator_fees_locked` (`resize_market` grows older
    /// markets). All zero = no stored pool: a Tier 0 market, or one that
    /// graduated before this field existed, whose pool is Raydium's
    /// canonical address for the mint (see `expected_pool`).
    pub pool: Pubkey,
    /// The curve's final price (Q64.64), set at `graduate_market`: what a
    /// graduated market is priced at until its pool has TWAP history. APPENDED
    /// after `pool`. Zero for Tier 0 markets and for markets that graduated before
    /// it existed (they fall back to the band anchor, see `warmup_price`).
    pub grad_price_q64: u128,
    /// Start of the retirement volume window: slot and the curve's
    /// `creator_fees_locked` then. APPENDED after `grad_price_q64`. Zero slot =
    /// not started (the keeper's `crank_funding` starts it).
    pub vol_snap_slot: u64,
    pub vol_snap_fees: u64,
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
    /// This program's ProgramData account, which the upgradeable loader keeps at
    /// the PDA of the program id and which names the upgrade authority. Only that
    /// authority may initialize: whoever calls first becomes vault admin and
    /// picks the USDC mint.
    #[account(
        seeds = [crate::ID.as_ref()], bump, seeds::program = anchor_lang::solana_program::bpf_loader_upgradeable::ID,
        constraint = program_data.upgrade_authority_address == Some(authority.key()) @ PerpsError::NotUpgradeAuthority
    )]
    pub program_data: Account<'info, ProgramData>,
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
pub struct AdminRetireMarket<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [SEED_VAULT], bump = vault.bump, has_one = authority)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, seeds = [SEED_REGISTRY], bump = registry.bump)]
    pub registry: Box<Account<'info, Registry>>,
    #[account(init, payer = authority, space = 8 + Retired::INIT_SPACE, seeds = [SEED_RETIRED, market.key().as_ref()], bump)]
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
    #[account(seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(seeds = [SEED_VAULT_USDC], bump)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
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
    /// The market's launch curve; read for graduation. Appended last.
    #[account(address = market.curve, seeds = [ringside_launch::SEED_CURVE, curve.mint.as_ref()], bump = curve.bump, seeds::program = ringside_launch::ID)]
    pub curve: Box<Account<'info, Curve>>,
}

#[derive(Accounts)]
pub struct ForfeitCreator<'info> {
    #[account(mut, seeds = [SEED_VAULT], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,
    #[account(mut, has_one = curve)]
    pub market: Box<Account<'info, Market>>,
    #[account(seeds = [ringside_launch::SEED_CURVE, curve.mint.as_ref()], bump = curve.bump, seeds::program = ringside_launch::ID)]
    pub curve: Box<Account<'info, Curve>>,
}

#[derive(Accounts)]
pub struct ResizeWithdrawal<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: owner, discriminator and PDA seeds are verified in the handler,
    /// because an account too small for `WithdrawalRequest` cannot be deserialized.
    #[account(mut)]
    pub request: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ResizeMarket<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: owner, discriminator and PDA seeds are verified in the handler,
    /// because an account too small for `Market` cannot be deserialized.
    #[account(mut)]
    pub market: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
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
pub struct CreatorFeesForfeited {
    pub mint: Pubkey,
    pub amount: u64,
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
pub struct PausedSet {
    pub paused: bool,
}

#[event]
pub struct InsuranceSpent {
    pub mint: Pubkey,
    pub amount: u64,
}

#[event]
pub struct AdlCleared {
    pub mint: Pubkey,
    pub trader_net_pnl: i64,
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
    #[msg("Market can't be retired: it has open interest, its curve sold out, or its curve volume over the last 7 days is above the threshold")]
    NotRetirable,
    #[msg("Deprecated, unused: the 7-day creator fee lock was replaced by the 20/80 split")]
    CreatorFeesLocked,
    #[msg("Creator fees can be forfeited only 30 days after launch, if the curve has not graduated")]
    NotForfeitable,
    #[msg("Only the program's upgrade authority can initialize it")]
    NotUpgradeAuthority,
    #[msg("Every order needs a non-zero acceptable price")]
    AcceptablePriceRequired,
    #[msg("The withdrawal request expired; request again")]
    WithdrawalExpired,
    #[msg("The vault has shares but no LP assets; deposits are refused")]
    VaultHasNoAssets,
    #[msg("A passed position has a higher profit ratio than the ADL target")]
    AdlWrongTarget,
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
            reduce_only: false, adl_mode: false, bump: 0, creator_fees_locked: 0, pool: Pubkey::default(),
            grad_price_q64: 0, vol_snap_slot: 0, vol_snap_fees: 0,
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

    fn vault(total_shares: u64) -> Vault {
        Vault {
            authority: Pubkey::default(), price_authority: Pubkey::default(), usdc_mint: Pubkey::default(), total_shares,
            trader_collateral: 0, reserved: 0, protocol_fees: 0, sol_usd_e6: 0, sol_usd_ts: 0, tier0_cap_bps: 0, skew_cap_bps: 0,
            paused: false, bump: 0,
        }
    }

    fn market(tier: u8) -> Market {
        Market {
            mint: Pubkey::default(), curve: Pubkey::default(), creator: Pubkey::default(), tier, created_slot: 0,
            oi_long: 0, oi_short: 0, oi_cap_override: 0, funding_index: 0, last_funding_ts: 0,
            band_anchor_q64: 0, band_anchor_slot: 0, trader_net_pnl: 0, insurance: 0, creator_fees: 0,
            reduce_only: false, adl_mode: false, bump: 0, creator_fees_locked: 0, pool: Pubkey::default(), grad_price_q64: 0, vol_snap_slot: 0, vol_snap_fees: 0,
        }
    }

    #[test]
    fn donation_to_a_tiny_vault_cannot_round_a_victim_to_nothing() {
        // Attacker: 1 unit in, then $1,000,000 donated straight to the vault.
        let mut v = vault(0);
        let attacker = shares_for(&v, 0, 1).unwrap();
        v.total_shares = attacker;
        let donated_assets = 1 + 1_000_000 * 1_000_000;
        // Victim deposits $1,000. Their rounding loss is at most one share's worth
        // (the donation is huge, so a share is too), never the whole deposit...
        let victim = shares_for(&v, donated_assets, 1_000 * 1_000_000).unwrap();
        let one_share = assets_for_shares(1, donated_assets, v.total_shares).unwrap() + 1;
        v.total_shares += victim;
        let after = donated_assets + 1_000 * 1_000_000;
        let victim_value = assets_for_shares(victim, after, v.total_shares).unwrap();
        let victim_loss = 1_000 * 1_000_000 - victim_value;
        assert!(victim_loss <= 2 * one_share, "victim lost {victim_loss}, a share is {one_share}");
        // ...and the attack costs the attacker far more than it takes: the virtual
        // shares absorb about half of the donation (a factor of about VIRTUAL_SHARES).
        let cost = 1 + 1_000_000 * 1_000_000u64;
        let attacker_value = assets_for_shares(attacker, after, v.total_shares).unwrap();
        let attacker_loss = cost.saturating_sub(attacker_value);
        assert!(attacker_loss > 500 * victim_loss, "attacker loses {attacker_loss} to cost the victim {victim_loss}");
    }

    #[test]
    fn a_realistic_donation_costs_the_victim_nothing_visible() {
        // Donating $1,000 to a vault holding one unit: the victim's $1,000 deposit keeps its value to the cent.
        let mut v = vault(0);
        v.total_shares = shares_for(&v, 0, 1).unwrap();
        let donated = 1 + 1_000 * 1_000_000;
        let victim = shares_for(&v, donated, 1_000 * 1_000_000).unwrap();
        let after_assets = donated + 1_000 * 1_000_000;
        let value = assets_for_shares(victim, after_assets, v.total_shares + victim).unwrap();
        assert!(value + 1_000_000 >= 1_000 * 1_000_000, "victim got {value}");
    }

    #[test]
    fn deposits_are_refused_when_shares_have_no_assets_behind_them() {
        assert!(shares_for(&vault(5_000), 0, 1_000_000).is_err());
        assert!(shares_for(&vault(0), 0, 1_000_000).is_ok(), "an empty vault takes its first deposit");
    }

    #[test]
    fn share_conversions_round_in_the_vaults_favour() {
        let v = vault(1_234_567);
        let (assets, amount) = (7_654_321u64, 333_333u64);
        let shares = shares_for(&v, assets, amount).unwrap();
        // Redeeming what a deposit minted never returns more than was put in.
        let back = assets_for_shares(shares, assets + amount, v.total_shares + shares).unwrap();
        assert!(back <= amount, "{back} > {amount}");
        // A full redemption leaves a remainder behind rather than overdrawing.
        assert!(assets_for_shares(1_234_567, assets, 1_234_567).unwrap() <= assets);
    }

    #[test]
    fn insurance_is_spent_on_net_profit_before_lps_and_budget_ignores_unspent_cash() {
        let mut v = vault(0);
        let mut m = market(0);
        m.insurance = 300;
        v.reserved = 300;
        m.trader_net_pnl = 1_000;
        cover_with_insurance(&mut v, &mut m);
        assert_eq!((m.insurance, v.reserved, m.trader_net_pnl), (0, 0, 700), "all 300 spent, LPs bear the other 700");
        // Insurance larger than the loss: only the loss is covered.
        m.insurance = 900;
        v.reserved = 900;
        m.trader_net_pnl = 200;
        cover_with_insurance(&mut v, &mut m);
        assert_eq!((m.insurance, v.reserved, m.trader_net_pnl), (700, 700, 0));
        // Nothing to cover when traders are net losers: insurance stays.
        m.trader_net_pnl = -50;
        cover_with_insurance(&mut v, &mut m);
        assert_eq!((m.insurance, m.trader_net_pnl), (700, -50));
    }

    #[test]
    fn adl_mode_sets_at_the_budget_and_clears_below_eighty_percent_of_it() {
        let mut m = market(0); // budget 0.25% of LP value
        let lp = 1_000_000_000u64; // budget 2_500_000
        m.trader_net_pnl = 2_500_001;
        check_budget(&mut m, lp);
        assert!(m.adl_mode && m.reduce_only);
        m.trader_net_pnl = 2_400_000; // under budget, above 80%
        check_budget(&mut m, lp);
        assert!(m.adl_mode, "hysteresis: still in ADL");
        m.trader_net_pnl = 2_000_000; // exactly 80%
        check_budget(&mut m, lp);
        assert!(!m.adl_mode, "cleared");
        assert!(m.reduce_only, "the market stays reduce-only until the admin lifts it");
        // LPs leaving can push a market over its budget again; refilling clears it.
        check_budget(&mut m, lp / 2);
        assert!(m.adl_mode);
        check_budget(&mut m, lp * 2);
        assert!(!m.adl_mode);
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
        // Steps are (time, price from then on); each observation closes the previous step's
        // interval. The newest interval (2140..2200) was at 100, so the extension to 2260 is at 100.
        let steps: Vec<(u64, u128)> = (0..20).map(|k| (1_000 + k * 60, 100)).chain([(2_200, 200)]).collect();
        let d = observations(&steps);
        assert_eq!(pool_twap_x32(&d, true, 2_260), Some(100));
        // One more observation: the price was 200 over 2200..2230. The TWAP over
        // the last 300 s (start obs 1960) mixes the 100 and 200 intervals, and the
        // extension to 2260 uses the last observed price (200), not the live one.
        let mut steps2 = steps.clone();
        steps2.push((2_230, 100));
        let d = observations(&steps2);
        // cum(2230) - cum(1960) = 100*(2200-1960) + 200*30 = 30_000; + 30 s at 200 = 36_000; / 300
        assert_eq!(pool_twap_x32(&d, true, 2_260), Some(120));
    }

    #[test]
    fn a_pump_held_for_one_observation_is_averaged_then_banded() {
        let mut steps: Vec<(u64, u128)> = (0..20).map(|k| (1_000 + k * 60, 100)).collect();
        steps.push((2_200, 10_000)); // 100x pump...
        steps.push((2_215, 100)); // ...back by the next observation (15 s)
        let d = observations(&steps);
        let twap = pool_twap_x32(&d, true, 2_260).unwrap();
        // cum(2215)-cum(1960): 100*240 + 10_000*15 = 174_000; the newest interval
        // (2200..2215) averaged 10_000, and the 45 s extension uses it: +450_000
        assert_eq!(twap, (174_000 + 450_000) / 300);
        // The TWAP alone moves ~20x; the band is what holds the mark to +15%.
        let mark = clamp_band(twap << 32, 100u128 << 32);
        assert!(mark <= (115u128 << 32), "mark {}", mark >> 32);
    }

    #[test]
    fn no_or_short_history_has_no_twap() {
        let mut d = vec![0u8; 8 + 1 + 2 + 32 + 100 * 40 + 32];
        assert_eq!(pool_twap_x32(&d, true, 5_000), None);
        d[8] = 1;
        assert_eq!(pool_twap_x32(&d, true, 5_000), None, "initialized but empty");
        // Raydium's first observation only (zero cumulative at the first swap).
        let d = observations(&[(1_000, 100)]);
        assert_eq!(pool_twap_x32(&d, true, 5_000), None, "no interval to price from");
        // Two observations but none old enough to cover the window.
        let d = observations(&[(4_900, 100), (4_950, 100)]);
        assert_eq!(pool_twap_x32(&d, true, 5_000), None, "history shorter than 300 s");
        // Covered once an observation is 300 s old.
        let d = observations(&[(4_600, 100), (4_650, 100)]);
        assert_eq!(pool_twap_x32(&d, true, 4_900), Some(100));
    }

    #[test]
    fn a_stale_newest_observation_extends_at_the_last_observed_price() {
        let d = observations(&[(1_000, 100), (1_100, 100), (1_200, 100)]);
        // Nothing for an hour: the TWAP is the last observed price, whatever the pool shows now.
        assert_eq!(pool_twap_x32(&d, true, 4_800), Some(100));
    }

    #[test]
    fn pool_fee_total_reads_raydium_fee_fields() {
        let mut d = vec![0u8; 637];
        let put = |d: &mut Vec<u8>, o: usize, v: u64| d[o..o + 8].copy_from_slice(&v.to_le_bytes());
        put(&mut d, 341, 1); put(&mut d, 349, 2); // protocol 0 / 1
        put(&mut d, 357, 10); put(&mut d, 365, 20); // fund 0 / 1
        put(&mut d, 397, 100); put(&mut d, 405, 200); // creator 0 / 1
        assert_eq!(pool_fee_total(&d, false), 111);
        assert_eq!(pool_fee_total(&d, true), 222);
    }

    #[test]
    fn retirement_windows() {
        let mut m = Market {
            mint: Pubkey::default(), curve: Pubkey::default(), creator: Pubkey::default(), tier: 0, created_slot: 0,
            oi_long: 0, oi_short: 0, oi_cap_override: 0, funding_index: 0, last_funding_ts: 0,
            band_anchor_q64: 1, band_anchor_slot: 0, trader_net_pnl: 0, insurance: 0, creator_fees: 0,
            reduce_only: false, adl_mode: false, bump: 0, creator_fees_locked: 0, pool: Pubkey::default(),
            grad_price_q64: 0, vol_snap_slot: 0, vol_snap_fees: 0,
        };
        use ringside_launch::{Curve, Observation, OBSERVATIONS};
        let mut c = Curve {
            mint: Pubkey::default(), creator: Pubkey::default(), name: String::new(), symbol: String::new(), uri: String::new(),
            virtual_sol: 1, virtual_tokens: 1, real_sol: 0, real_tokens: 0, creator_fees_owed: 0, dev_locked_tokens: 0, dev_unlock_ts: 0,
            complete: false, migrated: false, created_slot: 0, created_ts: 0, price_cumulative: 0, last_price_q64: 0, last_slot: 0,
            observations: [Observation::default(); OBSERVATIONS], obs_index: 0, obs_count: 1, bump: 0, creator_fees_locked: 0,
        };
        // No window started: not quiet, and a crank starts it.
        assert!(!volume_window_quiet(&m, &c, 10 * RETIRE_IDLE_SLOTS));
        roll_volume_window(&mut m, &c, 1_000);
        assert_eq!((m.vol_snap_slot, m.vol_snap_fees), (1_000, 0));
        // Not old enough.
        assert!(!volume_window_quiet(&m, &c, 1_000 + RETIRE_IDLE_SLOTS - 1));
        // Dust below the threshold keeps it quiet.
        c.creator_fees_locked = RETIRE_MAX_VOLUME_FEES - 1;
        assert!(volume_window_quiet(&m, &c, 1_000 + RETIRE_IDLE_SLOTS));
        // At the threshold it is active; a crank after a full window restarts the window.
        c.creator_fees_locked = RETIRE_MAX_VOLUME_FEES;
        assert!(!volume_window_quiet(&m, &c, 1_000 + RETIRE_IDLE_SLOTS));
        roll_volume_window(&mut m, &c, 1_000 + RETIRE_IDLE_SLOTS);
        assert_eq!((m.vol_snap_slot, m.vol_snap_fees), (1_000 + RETIRE_IDLE_SLOTS, RETIRE_MAX_VOLUME_FEES));
        // A quiet full window is left alone, so the market stays retirable.
        let (s0, f0) = (m.vol_snap_slot, m.vol_snap_fees);
        roll_volume_window(&mut m, &c, s0 + 5 * RETIRE_IDLE_SLOTS);
        assert_eq!((m.vol_snap_slot, m.vol_snap_fees), (s0, f0));
        // A fall in the proxy (forfeit) is never quiet and restarts the window.
        c.creator_fees_locked = 0;
        assert!(!volume_window_quiet(&m, &c, s0 + 5 * RETIRE_IDLE_SLOTS));
        roll_volume_window(&mut m, &c, s0 + 5 * RETIRE_IDLE_SLOTS);
        assert_eq!((m.vol_snap_slot, m.vol_snap_fees), (s0 + 5 * RETIRE_IDLE_SLOTS, 0));
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
            insurance: 18, creator_fees: 19, reduce_only: true, adl_mode: true, bump: 254, creator_fees_locked: 20, pool: k(21), grad_price_q64: (22u128 << 64) + 1, vol_snap_slot: 23, vol_snap_fees: 24,
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
    /// `client/scripts/resize-accounts.ts` hard-codes this size to find accounts that
    /// predate the `pool` field. Update both together.
    #[test]
    fn market_account_size_matches_resize_script() {
        assert_eq!(8 + Market::INIT_SPACE, 292);
    }
    /// Same for `WITHDRAWAL_LEN` in `client/scripts/resize-accounts.ts`.
    #[test]
    fn withdrawal_request_size_matches_resize_script() {
        assert_eq!(8 + WithdrawalRequest::INIT_SPACE, 73);
    }

}
