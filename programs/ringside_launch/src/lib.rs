//! Ringside launch program.
//!
//! Mints a fixed-supply token, sells 800M of it on a constant-product bonding
//! curve over virtual reserves, keeps an on-chain TWAP accumulator that the
//! perps program reads as its oracle, and graduates the curve once it sells out.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, SetAuthority, Token, TokenAccount, Transfer};

declare_id!("AfZWCTaDQEC9CVTwXkH7pFtDXs4RtLWCK5godexWQDVH");

pub const DECIMALS: u8 = 6;
pub const ONE_TOKEN: u64 = 1_000_000;
pub const TOTAL_SUPPLY: u64 = 1_000_000_000 * ONE_TOKEN;
pub const CURVE_SUPPLY: u64 = 800_000_000 * ONE_TOKEN;
pub const MIGRATION_SUPPLY: u64 = TOTAL_SUPPLY - CURVE_SUPPLY;
/// 30 virtual SOL on mainnet. The `devnet` build uses 0.5 so a curve can be
/// sold out (and graduation tested) with ~1.5 devnet SOL.
#[cfg(not(feature = "devnet"))]
pub const INITIAL_VIRTUAL_SOL: u64 = 30 * 1_000_000_000;
#[cfg(feature = "devnet")]
pub const INITIAL_VIRTUAL_SOL: u64 = 500_000_000;
pub const INITIAL_VIRTUAL_TOKENS: u64 = 1_073_000_000 * ONE_TOKEN;
pub const MAX_DEV_BUY_TOKENS: u64 = 50_000_000 * ONE_TOKEN; // 5% of supply
pub const DEV_LOCK_SECONDS: i64 = 7 * 24 * 60 * 60;
pub const BPS: u64 = 10_000;
/// Share of each creator fee the creator can claim at any time (20%, floor).
/// The rest is `creator_fees_locked`: claimable only once the curve graduates.
pub const CREATOR_FEE_EARLY_BPS: u64 = 2_000;
/// If the curve has not graduated this long after launch, anyone may forfeit the
/// locked creator fees to the ecosystem (`forfeit_creator_fees`).
pub const CREATOR_FEE_FORFEIT_SECONDS: i64 = 30 * 24 * 3600;

/// Observations kept for TWAP reads. One is written at most every
/// `OBSERVATION_SPACING` slots, so 32 cover at least 800 slots (~5.3 min).
pub const OBSERVATIONS: usize = 32;
pub const OBSERVATION_SPACING: u64 = 25;

pub const SEED_GLOBAL: &[u8] = b"global";
pub const SEED_CURVE: &[u8] = b"curve";
pub const SEED_DEV_LOCK: &[u8] = b"dev_lock";
pub const SEED_POOL_CREATOR: &[u8] = b"pool_creator";
/// Lamports kept back from the raised SOL to pay Raydium's create-pool fee
/// (0.15 SOL) and the rent for the pool's accounts.
pub const POOL_CREATION_RESERVE: u64 = 200_000_000;

/// Raydium CPMM (constant-product AMM) addresses. Checked against
/// raydium-cp-swap's lib.rs and live devnet accounts.
/// Metaplex Token Metadata: every launched token gets immutable metadata, so
/// wallets and explorers show its name, symbol and image.
pub mod metaplex {
    use anchor_lang::prelude::*;
    pub const PROGRAM: Pubkey = pubkey!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
    pub const SEED: &[u8] = b"metadata";
    pub const CREATE_METADATA_V3: u8 = 33;

    pub fn metadata_address(mint: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(&[SEED, PROGRAM.as_ref(), mint.as_ref()], &PROGRAM).0
    }

    /// CreateMetadataAccountV3 data: DataV2 { name, symbol, uri,
    /// seller_fee_basis_points: 0, creators/collection/uses: None },
    /// is_mutable: false, collection_details: None (borsh).
    pub fn create_v3_data(name: &str, symbol: &str, uri: &str) -> Vec<u8> {
        let mut d = vec![CREATE_METADATA_V3];
        for s in [name, symbol, uri] {
            d.extend_from_slice(&(s.len() as u32).to_le_bytes());
            d.extend_from_slice(s.as_bytes());
        }
        d.extend_from_slice(&0u16.to_le_bytes()); // seller_fee_basis_points
        d.extend_from_slice(&[0, 0, 0]); // creators, collection, uses: None
        d.push(0); // is_mutable: false
        d.push(0); // collection_details: None
        d
    }
}

pub mod raydium {
    use anchor_lang::prelude::*;
    #[cfg(not(feature = "devnet"))]
    pub const CPMM_PROGRAM: Pubkey = pubkey!("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
    #[cfg(feature = "devnet")]
    pub const CPMM_PROGRAM: Pubkey = pubkey!("DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb");
    /// AmmConfig index 0 (0.25% trade fee).
    #[cfg(not(feature = "devnet"))]
    pub const AMM_CONFIG: Pubkey = pubkey!("D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2");
    #[cfg(feature = "devnet")]
    pub const AMM_CONFIG: Pubkey = pubkey!("5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy");
    #[cfg(not(feature = "devnet"))]
    pub const CREATE_POOL_FEE: Pubkey = pubkey!("DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8");
    #[cfg(feature = "devnet")]
    pub const CREATE_POOL_FEE: Pubkey = pubkey!("3oE58BKVt8KuYkGxx8zBojugnymWmBiyafWgMrnb6eYy");
    pub const AUTH_SEED: &[u8] = b"vault_and_lp_mint_auth_seed";
    pub const POOL_SEED: &[u8] = b"pool";
    pub const POOL_LP_MINT_SEED: &[u8] = b"pool_lp_mint";
    pub const POOL_VAULT_SEED: &[u8] = b"pool_vault";
    pub const OBSERVATION_SEED: &[u8] = b"observation";
    /// sha256("global:initialize")[..8]
    pub const INITIALIZE_IX: [u8; 8] = [175, 175, 109, 31, 13, 152, 155, 237];

    /// (token_0, token_1): Raydium requires token_0 < token_1.
    pub fn order(a: Pubkey, b: Pubkey) -> (Pubkey, Pubkey) {
        if a < b { (a, b) } else { (b, a) }
    }
    pub fn pool_address(mint: Pubkey) -> Pubkey {
        let (t0, t1) = order(mint, anchor_spl::token::spl_token::native_mint::ID);
        Pubkey::find_program_address(&[POOL_SEED, AMM_CONFIG.as_ref(), t0.as_ref(), t1.as_ref()], &CPMM_PROGRAM).0
    }
    pub fn observation_address(pool: Pubkey) -> Pubkey {
        Pubkey::find_program_address(&[OBSERVATION_SEED, pool.as_ref()], &CPMM_PROGRAM).0
    }
}

#[program]
pub mod ringside_launch {
    use super::*;

    pub fn initialize_global(ctx: Context<InitializeGlobal>, params: GlobalParams) -> Result<()> {
        require!(
            params.protocol_fee_bps + params.creator_fee_bps + params.insurance_fee_bps <= 500,
            LaunchError::FeeTooHigh
        );
        let g = &mut ctx.accounts.global;
        g.authority = ctx.accounts.authority.key();
        g.fee_recipient = params.fee_recipient;
        g.insurance_recipient = params.insurance_recipient;
        g.migration_authority = params.migration_authority;
        g.launch_fee_lamports = params.launch_fee_lamports;
        g.graduation_fee_lamports = params.graduation_fee_lamports;
        g.protocol_fee_bps = params.protocol_fee_bps;
        g.creator_fee_bps = params.creator_fee_bps;
        g.insurance_fee_bps = params.insurance_fee_bps;
        g.paused = false;
        g.bump = ctx.bumps.global;
        Ok(())
    }

    /// Creates the mint, mints the whole supply to the curve, revokes the mint
    /// authority, opens the curve and optionally performs a locked dev buy.
    pub fn create_token(ctx: Context<CreateToken>, args: CreateTokenArgs) -> Result<()> {
        let global = &ctx.accounts.global;
        require!(!global.paused, LaunchError::Paused);
        require!(args.name.len() <= 32 && args.symbol.len() <= 10 && args.uri.len() <= 200, LaunchError::MetadataTooLong);

        // Launch fee to the protocol.
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.creator.to_account_info(),
                    to: ctx.accounts.fee_recipient.to_account_info(),
                },
            ),
            global.launch_fee_lamports,
        )?;

        let mint_key = ctx.accounts.mint.key();
        let curve_bump = ctx.bumps.curve;
        let signer_seeds: &[&[&[u8]]] = &[&[SEED_CURVE, mint_key.as_ref(), &[curve_bump]]];

        // Mint the full supply to the curve's token vault.
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.curve_token_vault.to_account_info(),
                    authority: ctx.accounts.curve.to_account_info(),
                },
                signer_seeds,
            ),
            TOTAL_SUPPLY,
        )?;

        // Immutable Metaplex metadata, signed by the curve as mint authority
        // (it still is, until the next step) and as update authority.
        create_metadata(&ctx.accounts, &args.name, &args.symbol, &args.uri, signer_seeds)?;

        // No further minting, ever.
        token::set_authority(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                SetAuthority {
                    current_authority: ctx.accounts.curve.to_account_info(),
                    account_or_mint: ctx.accounts.mint.to_account_info(),
                },
                signer_seeds,
            ),
            token::spl_token::instruction::AuthorityType::MintTokens,
            None,
        )?;

        let clock = Clock::get()?;
        let curve = &mut ctx.accounts.curve;
        curve.mint = mint_key;
        curve.creator = ctx.accounts.creator.key();
        curve.name = args.name;
        curve.symbol = args.symbol;
        curve.uri = args.uri;
        curve.virtual_sol = INITIAL_VIRTUAL_SOL;
        curve.virtual_tokens = INITIAL_VIRTUAL_TOKENS;
        curve.real_sol = 0;
        curve.real_tokens = CURVE_SUPPLY;
        curve.creator_fees_owed = 0;
        curve.creator_fees_locked = 0;
        curve.complete = false;
        curve.migrated = false;
        curve.created_slot = clock.slot;
        curve.created_ts = clock.unix_timestamp;
        curve.last_slot = clock.slot;
        curve.last_price_q64 = curve.spot_price_q64();
        curve.price_cumulative = 0;
        curve.obs_index = 0;
        curve.observations[0] = Observation { slot: clock.slot, cumulative: 0 };
        curve.obs_count = 1;
        curve.bump = curve_bump;

        // Optional dev buy, held in a time-locked vault.
        if args.dev_buy_lamports > 0 {
            let (tokens_out, fees) = curve.quote_buy(args.dev_buy_lamports, global)?;
            require!(tokens_out <= MAX_DEV_BUY_TOKENS, LaunchError::DevBuyTooLarge);
            pay_buy(
                &ctx.accounts.creator.to_account_info(),
                &curve.to_account_info(),
                &ctx.accounts.fee_recipient.to_account_info(),
                &ctx.accounts.insurance_recipient.to_account_info(),
                &ctx.accounts.system_program.to_account_info(),
                args.dev_buy_lamports,
                &fees,
            )?;
            curve.apply_buy(fees.net_in, tokens_out, fees.creator, clock.slot)?;
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.curve_token_vault.to_account_info(),
                        to: ctx.accounts.dev_lock_vault.to_account_info(),
                        authority: curve.to_account_info(),
                    },
                    signer_seeds,
                ),
                tokens_out,
            )?;
            curve.dev_locked_tokens = tokens_out;
            curve.dev_unlock_ts = clock.unix_timestamp + DEV_LOCK_SECONDS;
        }

        emit!(TokenCreated {
            mint: mint_key,
            creator: curve.creator,
            dev_locked_tokens: curve.dev_locked_tokens,
            slot: clock.slot,
        });
        Ok(())
    }

    pub fn buy(ctx: Context<Trade>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
        require!(!ctx.accounts.global.paused, LaunchError::Paused);
        let clock = Clock::get()?;
        let global = &ctx.accounts.global;
        let curve = &mut ctx.accounts.curve;
        require!(!curve.complete, LaunchError::CurveComplete);

        let (tokens_out, fees) = curve.quote_buy(sol_in, global)?;
        require!(tokens_out > 0 && tokens_out >= min_tokens_out, LaunchError::Slippage);

        pay_buy(
            &ctx.accounts.trader.to_account_info(),
            &curve.to_account_info(),
            &ctx.accounts.fee_recipient.to_account_info(),
            &ctx.accounts.insurance_recipient.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            fees.gross_in,
            &fees,
        )?;
        curve.apply_buy(fees.net_in, tokens_out, fees.creator, clock.slot)?;

        let mint_key = curve.mint;
        let seeds: &[&[&[u8]]] = &[&[SEED_CURVE, mint_key.as_ref(), &[curve.bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.curve_token_vault.to_account_info(),
                    to: ctx.accounts.trader_token_account.to_account_info(),
                    authority: curve.to_account_info(),
                },
                seeds,
            ),
            tokens_out,
        )?;

        if curve.real_tokens == 0 {
            curve.complete = true;
            emit!(CurveCompleted { mint: mint_key, real_sol: curve.real_sol, slot: clock.slot });
        }
        emit!(TradeEvent {
            mint: mint_key,
            trader: ctx.accounts.trader.key(),
            is_buy: true,
            sol_amount: fees.gross_in,
            token_amount: tokens_out,
            price_q64: curve.last_price_q64,
            slot: clock.slot,
        });
        Ok(())
    }

    pub fn sell(ctx: Context<Trade>, tokens_in: u64, min_sol_out: u64) -> Result<()> {
        require!(!ctx.accounts.global.paused, LaunchError::Paused);
        let clock = Clock::get()?;
        let global = &ctx.accounts.global;
        let curve = &mut ctx.accounts.curve;
        require!(!curve.complete, LaunchError::CurveComplete);
        require!(tokens_in > 0, LaunchError::ZeroAmount);

        let gross = curve.quote_sell_gross(tokens_in)?;
        require!(gross <= curve.real_sol, LaunchError::InsufficientLiquidity);
        let protocol = mul_bps(gross, global.protocol_fee_bps)?;
        let creator_fee = mul_bps(gross, global.creator_fee_bps)?;
        let insurance = mul_bps(gross, global.insurance_fee_bps)?;
        let net_out = gross - protocol - creator_fee - insurance;
        require!(net_out >= min_sol_out, LaunchError::Slippage);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.trader_token_account.to_account_info(),
                    to: ctx.accounts.curve_token_vault.to_account_info(),
                    authority: ctx.accounts.trader.to_account_info(),
                },
            ),
            tokens_in,
        )?;

        curve.accumulate(clock.slot);
        curve.virtual_sol = curve.virtual_sol.checked_sub(gross).ok_or(LaunchError::MathOverflow)?;
        curve.virtual_tokens = curve.virtual_tokens.checked_add(tokens_in).ok_or(LaunchError::MathOverflow)?;
        curve.real_sol -= gross;
        curve.real_tokens = curve.real_tokens.checked_add(tokens_in).ok_or(LaunchError::MathOverflow)?;
        curve.add_creator_fee(creator_fee)?;
        curve.last_price_q64 = curve.spot_price_q64();
        curve.record_observation(clock.slot);

        // SOL leaves the program-owned curve account directly.
        let curve_ai = curve.to_account_info();
        curve_ai.sub_lamports(net_out + protocol + insurance)?;
        ctx.accounts.trader.to_account_info().add_lamports(net_out)?;
        ctx.accounts.fee_recipient.to_account_info().add_lamports(protocol)?;
        ctx.accounts.insurance_recipient.to_account_info().add_lamports(insurance)?;

        emit!(TradeEvent {
            mint: curve.mint,
            trader: ctx.accounts.trader.key(),
            is_buy: false,
            sol_amount: gross,
            token_amount: tokens_in,
            price_q64: curve.last_price_q64,
            slot: clock.slot,
        });
        Ok(())
    }

    /// Pays the creator `creator_fees_owed` (the early 20%) at any time, plus
    /// `creator_fees_locked` once the curve has graduated.
    pub fn claim_creator_fees(ctx: Context<ClaimCreatorFees>) -> Result<()> {
        let curve = &mut ctx.accounts.curve;
        let mut amount = curve.creator_fees_owed;
        curve.creator_fees_owed = 0;
        if curve.complete {
            amount = amount.checked_add(curve.creator_fees_locked).ok_or(LaunchError::MathOverflow)?;
            curve.creator_fees_locked = 0;
        }
        require!(amount > 0, LaunchError::ZeroAmount);
        curve.to_account_info().sub_lamports(amount)?;
        ctx.accounts.creator.to_account_info().add_lamports(amount)?;
        Ok(())
    }

    /// Permissionless. Once the curve is `CREATOR_FEE_FORFEIT_SECONDS` old and
    /// has not graduated, moves the locked creator fees to the protocol's
    /// `fee_recipient` and zeroes them. The early share stays claimable.
    pub fn forfeit_creator_fees(ctx: Context<ForfeitCreatorFees>) -> Result<()> {
        let curve = &mut ctx.accounts.curve;
        let now = Clock::get()?.unix_timestamp;
        let forfeit_ts = curve
            .created_ts
            .checked_add(CREATOR_FEE_FORFEIT_SECONDS)
            .ok_or(LaunchError::MathOverflow)?;
        require!(!curve.complete && now >= forfeit_ts, LaunchError::NotForfeitable);
        let amount = curve.creator_fees_locked;
        require!(amount > 0, LaunchError::ZeroAmount);
        curve.creator_fees_locked = 0;
        curve.to_account_info().sub_lamports(amount)?;
        ctx.accounts.fee_recipient.to_account_info().add_lamports(amount)?;
        emit!(CreatorFeesForfeited { mint: curve.mint, amount });
        Ok(())
    }

    /// Permissionless migration helper: grows a `Curve` created before
    /// `creator_fees_locked` existed to the current size (the payer funds the
    /// extra rent; new bytes are zero, so the new field reads 0). No-op if the
    /// account is already large enough.
    pub fn resize_curve(ctx: Context<ResizeCurve>) -> Result<()> {
        let info = ctx.accounts.curve.to_account_info();
        require_keys_eq!(*info.owner, crate::ID, anchor_lang::error::ErrorCode::AccountOwnedByWrongProgram);
        let mint = {
            let data = info.try_borrow_data()?;
            require!(data.len() >= 8 + 32, anchor_lang::error::ErrorCode::AccountDiscriminatorNotFound);
            require!(data[..8] == *Curve::DISCRIMINATOR, anchor_lang::error::ErrorCode::AccountDiscriminatorMismatch);
            Pubkey::new_from_array(data[8..40].try_into().unwrap())
        };
        let (expected, _) = Pubkey::find_program_address(&[SEED_CURVE, mint.as_ref()], &crate::ID);
        require_keys_eq!(expected, info.key(), anchor_lang::error::ErrorCode::ConstraintSeeds);
        let new_len = 8 + Curve::INIT_SPACE;
        if info.data_len() >= new_len {
            return Ok(());
        }
        // Rent for the extra bytes only: the account also holds real SOL / fee balances,
        // so comparing the new minimum with its total lamports would charge nothing.
        let rent = Rent::get()?;
        let needed = rent.minimum_balance(new_len).saturating_sub(rent.minimum_balance(info.data_len()));
        if needed > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer { from: ctx.accounts.payer.to_account_info(), to: info.clone() },
                ),
                needed,
            )?;
        }
        info.resize(new_len)?;
        Ok(())
    }

    pub fn release_dev_lock(ctx: Context<ReleaseDevLock>) -> Result<()> {
        let curve = &mut ctx.accounts.curve;
        let now = Clock::get()?.unix_timestamp;
        require!(now >= curve.dev_unlock_ts, LaunchError::StillLocked);
        let amount = curve.dev_locked_tokens;
        require!(amount > 0, LaunchError::ZeroAmount);
        curve.dev_locked_tokens = 0;
        let mint_key = curve.mint;
        let seeds: &[&[&[u8]]] = &[&[SEED_CURVE, mint_key.as_ref(), &[curve.bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.dev_lock_vault.to_account_info(),
                    to: ctx.accounts.creator_token_account.to_account_info(),
                    authority: curve.to_account_info(),
                },
                seeds,
            ),
            amount,
        )?;
        Ok(())
    }

    /// Permissionless graduation. Once the curve has sold out, creates a
    /// Raydium CPMM pool (token / wSOL) seeded with the raised SOL (minus the
    /// graduation fee and Raydium's costs) and the 200M reserve tokens, then
    /// burns every LP token so the liquidity can never be pulled.
    ///
    /// A system-owned PDA (`pool_creator`) acts as Raydium's `creator`, because
    /// Raydium pays rent and its fee from the creator with system transfers.
    pub fn migrate(ctx: Context<Migrate>) -> Result<()> {
        let curve = load_curve(&ctx.accounts.curve)?;
        require!(curve.mint == ctx.accounts.mint.key(), LaunchError::MigrationFailed);
        require!(curve.complete && !curve.migrated, LaunchError::NotReadyToMigrate);
        let mint = curve.mint;
        let fee = ctx.accounts.global.graduation_fee_lamports.min(curve.real_sol);
        let after_fee = curve.real_sol - fee;
        require!(after_fee > POOL_CREATION_RESERVE + 1_000_000, LaunchError::NotEnoughToMigrate);
        let pool_sol = after_fee - POOL_CREATION_RESERVE;
        // Open the pool at the curve's final price: pool_sol / tokens equal to
        // virtual_sol / virtual_tokens. Reserve tokens it doesn't need are burned,
        // so fees never show up as a price gap at graduation.
        let tokens_to_pool = ((pool_sol as u128) * (curve.virtual_tokens as u128) / (curve.virtual_sol as u128))
            .min(MIGRATION_SUPPLY as u128) as u64;
        require!(tokens_to_pool > 0, LaunchError::NotEnoughToMigrate);
        mark_curve_migrated(&ctx.accounts.curve)?;

        // Each step runs in its own function: SBF gives every call frame 4 KB of
        // stack, and one handler doing all of this overflowed it on chain.
        let creator_seeds: &[&[&[u8]]] = &[&[SEED_POOL_CREATOR, mint.as_ref(), &[ctx.bumps.pool_creator]]];
        let curve_bump = ctx.bumps.curve;
        migrate_sol(&ctx.accounts, fee, pool_sol, creator_seeds)?;
        migrate_tokens(&ctx.accounts, tokens_to_pool, &[&[SEED_CURVE, mint.as_ref(), &[curve_bump]]])?;
        let wsol = anchor_spl::token::spl_token::native_mint::ID;
        let (amount_0, amount_1) = if mint < wsol { (tokens_to_pool, pool_sol) } else { (pool_sol, tokens_to_pool) };
        create_raydium_pool(&ctx.accounts, mint < wsol, amount_0, amount_1, creator_seeds)?;
        let lp_amount = burn_lp_and_sweep(&ctx.accounts, creator_seeds)?;

        emit!(Migrated { mint, sol_to_pool: pool_sol, tokens_to_pool, pool: ctx.accounts.pool_state.key(), lp_burned: lp_amount });
        Ok(())
    }

    /// Admin: fee settings (devnet uses a small graduation fee).
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
        require_keys_eq!(ctx.accounts.pending.new_authority, ctx.accounts.new_authority.key(), LaunchError::NotPendingAuthority);
        ctx.accounts.global.authority = ctx.accounts.new_authority.key();
        emit!(AuthorityAccepted { authority: ctx.accounts.new_authority.key() });
        Ok(())
    }

    pub fn set_fees(ctx: Context<AdminOnly>, launch_fee_lamports: u64, graduation_fee_lamports: u64) -> Result<()> {
        let g = &mut ctx.accounts.global;
        g.launch_fee_lamports = launch_fee_lamports;
        g.graduation_fee_lamports = graduation_fee_lamports;
        Ok(())
    }

    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.global.paused = paused;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Fee handling
// ---------------------------------------------------------------------------

pub struct BuyFees {
    pub gross_in: u64,
    pub net_in: u64,
    pub protocol: u64,
    pub creator: u64,
    pub insurance: u64,
}

fn mul_bps(amount: u64, bps: u16) -> Result<u64> {
    Ok(((amount as u128) * (bps as u128) / BPS as u128) as u64)
}

fn pay_buy<'info>(
    payer: &AccountInfo<'info>,
    curve: &AccountInfo<'info>,
    fee_recipient: &AccountInfo<'info>,
    insurance_recipient: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    _gross: u64,
    fees: &BuyFees,
) -> Result<()> {
    let send = |to: &AccountInfo<'info>, amount: u64| -> Result<()> {
        if amount == 0 {
            return Ok(());
        }
        system_program::transfer(
            CpiContext::new(system.clone(), system_program::Transfer { from: payer.clone(), to: to.clone() }),
            amount,
        )
    };
    // Net SOL and the creator's share stay in the curve account.
    send(curve, fees.net_in + fees.creator)?;
    send(fee_recipient, fees.protocol)?;
    send(insurance_recipient, fees.insurance)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Global {
    pub authority: Pubkey,
    pub fee_recipient: Pubkey,
    pub insurance_recipient: Pubkey,
    pub migration_authority: Pubkey,
    pub launch_fee_lamports: u64,
    pub graduation_fee_lamports: u64,
    pub protocol_fee_bps: u16,
    pub creator_fee_bps: u16,
    pub insurance_fee_bps: u16,
    pub paused: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct Observation {
    pub slot: u64,
    pub cumulative: u128,
}

#[account]
#[derive(InitSpace)]
pub struct Curve {
    pub mint: Pubkey,
    pub creator: Pubkey,
    #[max_len(32)]
    pub name: String,
    #[max_len(10)]
    pub symbol: String,
    #[max_len(200)]
    pub uri: String,
    pub virtual_sol: u64,
    pub virtual_tokens: u64,
    pub real_sol: u64,
    pub real_tokens: u64,
    pub creator_fees_owed: u64,
    pub dev_locked_tokens: u64,
    pub dev_unlock_ts: i64,
    pub complete: bool,
    pub migrated: bool,
    pub created_slot: u64,
    pub created_ts: i64,
    /// TWAP accumulator: sum of price_q64 * slots, wrapping.
    pub price_cumulative: u128,
    pub last_price_q64: u128,
    pub last_slot: u64,
    pub observations: [Observation; OBSERVATIONS],
    pub obs_index: u8,
    pub obs_count: u8,
    pub bump: u8,
    /// The 80% of creator fees held until graduation. APPENDED after `bump`:
    /// curves created before this field existed need `resize_curve`.
    pub creator_fees_locked: u64,
}

/// Splits a creator fee into (early, locked). `early` is floored, so rounding
/// goes to the locked side and early + locked == fee exactly.
pub fn split_creator_fee(fee: u64) -> (u64, u64) {
    let early = ((fee as u128) * (CREATOR_FEE_EARLY_BPS as u128) / (BPS as u128)) as u64;
    (early, fee - early)
}

impl Curve {
    /// Books a creator fee that stays in the curve's lamports: the early share
    /// to `creator_fees_owed`, the rest to `creator_fees_locked`.
    pub fn add_creator_fee(&mut self, fee: u64) -> Result<()> {
        let (early, locked) = split_creator_fee(fee);
        self.creator_fees_owed = self.creator_fees_owed.checked_add(early).ok_or(LaunchError::MathOverflow)?;
        self.creator_fees_locked = self.creator_fees_locked.checked_add(locked).ok_or(LaunchError::MathOverflow)?;
        Ok(())
    }

    /// Spot price in lamports per base unit, Q64.64.
    pub fn spot_price_q64(&self) -> u128 {
        ((self.virtual_sol as u128) << 64) / (self.virtual_tokens as u128)
    }

    pub fn k(&self) -> u128 {
        (self.virtual_sol as u128) * (self.virtual_tokens as u128)
    }

    pub fn quote_buy(&self, sol_in: u64, g: &Global) -> Result<(u64, BuyFees)> {
        require!(sol_in > 0, LaunchError::ZeroAmount);
        let total_bps = (g.protocol_fee_bps + g.creator_fee_bps + g.insurance_fee_bps) as u64;
        let mut gross = sol_in;
        let mut net = gross - gross * total_bps / BPS;
        let k = self.k();
        let x = self.virtual_sol as u128;
        let y = self.virtual_tokens as u128;
        let new_y = ceil_div(k, x + net as u128);
        let mut out = (y - new_y) as u64;

        // Last buy: cap at the remaining curve supply and charge only what's needed.
        if out > self.real_tokens {
            out = self.real_tokens;
            let target_y = y - out as u128;
            let needed_net = (ceil_div(k, target_y) - x) as u64;
            net = needed_net;
            gross = ceil_div((needed_net as u128) * BPS as u128, (BPS - total_bps) as u128) as u64;
        }
        let protocol = mul_bps(gross, g.protocol_fee_bps)?;
        let creator = mul_bps(gross, g.creator_fee_bps)?;
        let insurance = gross - net - protocol - creator;
        Ok((out, BuyFees { gross_in: gross, net_in: net, protocol, creator, insurance }))
    }

    pub fn quote_sell_gross(&self, tokens_in: u64) -> Result<u64> {
        let k = self.k();
        let new_x = ceil_div(k, self.virtual_tokens as u128 + tokens_in as u128);
        Ok((self.virtual_sol as u128 - new_x) as u64)
    }

    fn apply_buy(&mut self, net_in: u64, tokens_out: u64, creator_fee: u64, slot: u64) -> Result<()> {
        self.accumulate(slot);
        self.virtual_sol = self.virtual_sol.checked_add(net_in).ok_or(LaunchError::MathOverflow)?;
        self.virtual_tokens = self.virtual_tokens.checked_sub(tokens_out).ok_or(LaunchError::MathOverflow)?;
        self.real_sol = self.real_sol.checked_add(net_in).ok_or(LaunchError::MathOverflow)?;
        self.real_tokens = self.real_tokens.checked_sub(tokens_out).ok_or(LaunchError::MathOverflow)?;
        self.add_creator_fee(creator_fee)?;
        self.last_price_q64 = self.spot_price_q64();
        self.record_observation(slot);
        Ok(())
    }

    /// Rolls the accumulator forward to `slot` at the last price.
    pub fn accumulate(&mut self, slot: u64) {
        let dt = slot.saturating_sub(self.last_slot) as u128;
        self.price_cumulative = self.price_cumulative.wrapping_add(self.last_price_q64.wrapping_mul(dt));
        self.last_slot = slot;
    }

    fn record_observation(&mut self, slot: u64) {
        let newest = self.observations[self.obs_index as usize];
        if slot < newest.slot + OBSERVATION_SPACING {
            return;
        }
        self.obs_index = ((self.obs_index as usize + 1) % OBSERVATIONS) as u8;
        self.observations[self.obs_index as usize] = Observation { slot, cumulative: self.price_cumulative };
        self.obs_count = (self.obs_count as usize + 1).min(OBSERVATIONS) as u8;
    }

    /// Cumulative price as of `slot`, without mutating state.
    pub fn cumulative_at(&self, slot: u64) -> u128 {
        let dt = slot.saturating_sub(self.last_slot) as u128;
        self.price_cumulative.wrapping_add(self.last_price_q64.wrapping_mul(dt))
    }

    /// Time-weighted average price over roughly `window` slots ending at `now`.
    /// Uses the newest observation at least `window` old; a younger curve
    /// averages over its whole life. Returns spot if no time has passed.
    pub fn twap_q64(&self, now: u64, window: u64) -> u128 {
        let cutoff = now.saturating_sub(window);
        let mut best: Option<Observation> = None;
        let mut oldest: Option<Observation> = None;
        for i in 0..self.obs_count as usize {
            let o = self.observations[i];
            if o.slot <= cutoff && best.map_or(true, |b| o.slot > b.slot) {
                best = Some(o);
            }
            if oldest.map_or(true, |b| o.slot < b.slot) {
                oldest = Some(o);
            }
        }
        let start = match best.or(oldest) {
            Some(o) => o,
            None => return self.last_price_q64,
        };
        if now <= start.slot {
            return self.last_price_q64;
        }
        self.cumulative_at(now).wrapping_sub(start.cumulative) / ((now - start.slot) as u128)
    }

    /// Virtual SOL reserve, used by the perps program to size Tier 0 OI caps.
    pub fn virtual_sol_lamports(&self) -> u64 {
        self.virtual_sol
    }
}

fn ceil_div(a: u128, b: u128) -> u128 {
    (a + b - 1) / b
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct GlobalParams {
    pub fee_recipient: Pubkey,
    pub insurance_recipient: Pubkey,
    pub migration_authority: Pubkey,
    pub launch_fee_lamports: u64,
    pub graduation_fee_lamports: u64,
    pub protocol_fee_bps: u16,
    pub creator_fee_bps: u16,
    pub insurance_fee_bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateTokenArgs {
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub dev_buy_lamports: u64,
}

#[derive(Accounts)]
pub struct InitializeGlobal<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Global::INIT_SPACE, seeds = [SEED_GLOBAL], bump)]
    pub global: Account<'info, Global>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateToken<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(seeds = [SEED_GLOBAL], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    #[account(init, payer = creator, mint::decimals = DECIMALS, mint::authority = curve)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(init, payer = creator, space = 8 + Curve::INIT_SPACE, seeds = [SEED_CURVE, mint.key().as_ref()], bump)]
    pub curve: Box<Account<'info, Curve>>,
    #[account(init, payer = creator, associated_token::mint = mint, associated_token::authority = curve)]
    pub curve_token_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        init, payer = creator,
        seeds = [SEED_DEV_LOCK, mint.key().as_ref()], bump,
        token::mint = mint, token::authority = curve
    )]
    pub dev_lock_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: checked against global.
    #[account(mut, address = global.fee_recipient)]
    pub fee_recipient: UncheckedAccount<'info>,
    /// CHECK: checked against global.
    #[account(mut, address = global.insurance_recipient)]
    pub insurance_recipient: UncheckedAccount<'info>,
    /// CHECK: the token's Metaplex metadata PDA, created by the CPI.
    #[account(mut, seeds = [metaplex::SEED, metaplex::PROGRAM.as_ref(), mint.key().as_ref()], bump, seeds::program = metaplex::PROGRAM)]
    pub metadata: UncheckedAccount<'info>,
    /// CHECK: Metaplex Token Metadata program.
    #[account(address = metaplex::PROGRAM)]
    pub token_metadata_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Trade<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(seeds = [SEED_GLOBAL], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [SEED_CURVE, mint.key().as_ref()], bump = curve.bump, has_one = mint)]
    pub curve: Box<Account<'info, Curve>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = curve)]
    pub curve_token_vault: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = trader, associated_token::mint = mint, associated_token::authority = trader)]
    pub trader_token_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: checked against global.
    #[account(mut, address = global.fee_recipient)]
    pub fee_recipient: UncheckedAccount<'info>,
    /// CHECK: checked against global.
    #[account(mut, address = global.insurance_recipient)]
    pub insurance_recipient: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimCreatorFees<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut, seeds = [SEED_CURVE, curve.mint.as_ref()], bump = curve.bump, has_one = creator)]
    pub curve: Account<'info, Curve>,
}

#[derive(Accounts)]
pub struct ForfeitCreatorFees<'info> {
    #[account(seeds = [SEED_GLOBAL], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    #[account(mut, seeds = [SEED_CURVE, curve.mint.as_ref()], bump = curve.bump)]
    pub curve: Box<Account<'info, Curve>>,
    /// CHECK: checked against global.
    #[account(mut, address = global.fee_recipient)]
    pub fee_recipient: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ResizeCurve<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: owner, discriminator and PDA seeds are verified in the handler,
    /// because an account too small for `Curve` cannot be deserialized.
    #[account(mut)]
    pub curve: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReleaseDevLock<'info> {
    pub creator: Signer<'info>,
    #[account(mut, seeds = [SEED_CURVE, curve.mint.as_ref()], bump = curve.bump, has_one = creator)]
    pub curve: Box<Account<'info, Curve>>,
    #[account(mut, seeds = [SEED_DEV_LOCK, curve.mint.as_ref()], bump)]
    pub dev_lock_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = curve.mint, token::authority = creator)]
    pub creator_token_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// CreateMetadataAccountV3 with the curve PDA as mint and update authority.
#[inline(never)]
fn create_metadata<'info>(a: &CreateToken<'info>, name: &str, symbol: &str, uri: &str, curve_seeds: &[&[&[u8]]]) -> Result<()> {
    let ix = anchor_lang::solana_program::instruction::Instruction {
        program_id: metaplex::PROGRAM,
        accounts: vec![
            AccountMeta::new(a.metadata.key(), false),
            AccountMeta::new_readonly(a.mint.key(), false),
            AccountMeta::new_readonly(a.curve.key(), true),
            AccountMeta::new(a.creator.key(), true),
            AccountMeta::new_readonly(a.curve.key(), true),
            AccountMeta::new_readonly(a.system_program.key(), false),
        ],
        data: metaplex::create_v3_data(name, symbol, uri),
    };
    anchor_lang::solana_program::program::invoke_signed(
        &ix,
        &[
            a.metadata.to_account_info(), a.mint.to_account_info(), a.curve.to_account_info(),
            a.creator.to_account_info(), a.system_program.to_account_info(), a.token_metadata_program.to_account_info(),
        ],
        curve_seeds,
    )?;
    Ok(())
}

// --- Migration steps (see `migrate`) ----------------------------------------------

/// The curve fields migrate needs, copied out so the full account never sits
/// in migrate's stack frame.
struct CurveForMigration {
    mint: Pubkey,
    complete: bool,
    migrated: bool,
    real_sol: u64,
    virtual_sol: u64,
    virtual_tokens: u64,
}

#[inline(never)]
fn load_curve(info: &UncheckedAccount) -> Result<CurveForMigration> {
    let data = info.try_borrow_data()?;
    let c = Box::new(Curve::try_deserialize(&mut &data[..])?);
    Ok(CurveForMigration {
        mint: c.mint,
        complete: c.complete,
        migrated: c.migrated,
        real_sol: c.real_sol,
        virtual_sol: c.virtual_sol,
        virtual_tokens: c.virtual_tokens,
    })
}

#[inline(never)]
fn mark_curve_migrated(info: &UncheckedAccount) -> Result<()> {
    let mut data = info.try_borrow_mut_data()?;
    let mut c = Box::new(Curve::try_deserialize(&mut &data[..])?);
    c.real_sol = 0;
    c.migrated = true;
    let mut out: &mut [u8] = &mut data[..];
    c.try_serialize(&mut out)?;
    Ok(())
}

/// SOL out of the curve. The runtime checks lamport sums across the accounts of
/// each cross-program call, so every account changed by hand rides along on the
/// next call: everything moves to the pool-creator PDA, the system program (which
/// accepts extra accounts) pays the fee with the curve attached, then funds wSOL.
#[inline(never)]
fn migrate_sol<'info>(a: &Migrate<'info>, fee: u64, pool_sol: u64, creator_seeds: &[&[&[u8]]]) -> Result<()> {
    create_creator_ata(a, &a.creator_token, &a.mint.to_account_info())?;
    create_creator_ata(a, &a.creator_wsol, &a.wsol_mint.to_account_info())?;
    let total = fee + POOL_CREATION_RESERVE + pool_sol;
    a.curve.to_account_info().sub_lamports(total)?;
    a.pool_creator.add_lamports(total)?;
    let mut pay_fee = anchor_lang::solana_program::system_instruction::transfer(&a.pool_creator.key(), &a.fee_recipient.key(), fee);
    pay_fee.accounts.push(AccountMeta::new(a.curve.key(), false));
    anchor_lang::solana_program::program::invoke_signed(
        &pay_fee,
        &[a.pool_creator.to_account_info(), a.fee_recipient.to_account_info(), a.curve.to_account_info(), a.system_program.to_account_info()],
        creator_seeds,
    )?;
    anchor_lang::system_program::transfer(
        CpiContext::new_with_signer(
            a.system_program.to_account_info(),
            anchor_lang::system_program::Transfer { from: a.pool_creator.to_account_info(), to: a.creator_wsol.to_account_info() },
            creator_seeds,
        ),
        pool_sol,
    )?;
    token::sync_native(CpiContext::new(a.token_program.to_account_info(), token::SyncNative { account: a.creator_wsol.to_account_info() }))
}

/// The pool creator's associated token account for `mint`, paid by the caller.
#[inline(never)]
fn create_creator_ata<'info>(a: &Migrate<'info>, ata: &UncheckedAccount<'info>, mint: &AccountInfo<'info>) -> Result<()> {
    anchor_spl::associated_token::create_idempotent(CpiContext::new(
        a.associated_token_program.to_account_info(),
        anchor_spl::associated_token::Create {
            payer: a.payer.to_account_info(),
            associated_token: ata.to_account_info(),
            authority: a.pool_creator.to_account_info(),
            mint: mint.clone(),
            system_program: a.system_program.to_account_info(),
            token_program: a.token_program.to_account_info(),
        },
    ))
}

/// Reserve tokens to the pool creator; the part the pool doesn't need is burned.
#[inline(never)]
fn migrate_tokens<'info>(a: &Migrate<'info>, tokens_to_pool: u64, curve_seeds: &[&[&[u8]]]) -> Result<()> {
    let burn_amount = MIGRATION_SUPPLY - tokens_to_pool;
    if burn_amount > 0 {
        token::burn(
            CpiContext::new_with_signer(
                a.token_program.to_account_info(),
                token::Burn { mint: a.mint.to_account_info(), from: a.curve_token_vault.to_account_info(), authority: a.curve.to_account_info() },
                curve_seeds,
            ),
            burn_amount,
        )?;
    }
    token::transfer(
        CpiContext::new_with_signer(
            a.token_program.to_account_info(),
            Transfer { from: a.curve_token_vault.to_account_info(), to: a.creator_token.to_account_info(), authority: a.curve.to_account_info() },
            curve_seeds,
        ),
        tokens_to_pool,
    )
}

/// Raydium CPMM initialize, signed by the pool-creator PDA.
#[inline(never)]
fn create_raydium_pool<'info>(a: &Migrate<'info>, mint_first: bool, amount_0: u64, amount_1: u64, creator_seeds: &[&[&[u8]]]) -> Result<()> {
    let (mint_0, mint_1) = if mint_first { (a.mint.to_account_info(), a.wsol_mint.to_account_info()) } else { (a.wsol_mint.to_account_info(), a.mint.to_account_info()) };
    let (creator_0, creator_1) = if mint_first {
        (a.creator_token.to_account_info(), a.creator_wsol.to_account_info())
    } else {
        (a.creator_wsol.to_account_info(), a.creator_token.to_account_info())
    };
    let metas = vec![
        AccountMeta::new(a.pool_creator.key(), true),
        AccountMeta::new_readonly(a.amm_config.key(), false),
        AccountMeta::new_readonly(a.cpmm_authority.key(), false),
        AccountMeta::new(a.pool_state.key(), false),
        AccountMeta::new_readonly(mint_0.key(), false),
        AccountMeta::new_readonly(mint_1.key(), false),
        AccountMeta::new(a.lp_mint.key(), false),
        AccountMeta::new(creator_0.key(), false),
        AccountMeta::new(creator_1.key(), false),
        AccountMeta::new(a.creator_lp_token.key(), false),
        AccountMeta::new(a.token_0_vault.key(), false),
        AccountMeta::new(a.token_1_vault.key(), false),
        AccountMeta::new(a.create_pool_fee.key(), false),
        AccountMeta::new(a.observation_state.key(), false),
        AccountMeta::new_readonly(a.token_program.key(), false),
        AccountMeta::new_readonly(a.token_program.key(), false),
        AccountMeta::new_readonly(a.token_program.key(), false),
        AccountMeta::new_readonly(a.associated_token_program.key(), false),
        AccountMeta::new_readonly(a.system_program.key(), false),
        AccountMeta::new_readonly(a.rent.key(), false),
    ];
    let mut data = raydium::INITIALIZE_IX.to_vec();
    data.extend_from_slice(&amount_0.to_le_bytes());
    data.extend_from_slice(&amount_1.to_le_bytes());
    data.extend_from_slice(&0u64.to_le_bytes()); // open_time: now
    let infos = vec![
        a.pool_creator.to_account_info(), a.amm_config.to_account_info(), a.cpmm_authority.to_account_info(),
        a.pool_state.to_account_info(), mint_0, mint_1, a.lp_mint.to_account_info(),
        creator_0, creator_1, a.creator_lp_token.to_account_info(),
        a.token_0_vault.to_account_info(), a.token_1_vault.to_account_info(), a.create_pool_fee.to_account_info(),
        a.observation_state.to_account_info(), a.token_program.to_account_info(), a.associated_token_program.to_account_info(),
        a.system_program.to_account_info(), a.rent.to_account_info(), a.cpmm_program.to_account_info(),
    ];
    anchor_lang::solana_program::program::invoke_signed(
        &anchor_lang::solana_program::instruction::Instruction { program_id: raydium::CPMM_PROGRAM, accounts: metas, data },
        &infos,
        creator_seeds,
    )?;
    Ok(())
}

/// Burns every LP token the pool creator received and sends what's left of the
/// creation reserve to the protocol. Returns the LP amount burned.
#[inline(never)]
fn burn_lp_and_sweep<'info>(a: &Migrate<'info>, creator_seeds: &[&[&[u8]]]) -> Result<u64> {
    let lp_amount = {
        let d = a.creator_lp_token.try_borrow_data()?;
        require!(d.len() >= 72, LaunchError::MigrationFailed);
        u64::from_le_bytes(d[64..72].try_into().unwrap())
    };
    token::burn(
        CpiContext::new_with_signer(
            a.token_program.to_account_info(),
            token::Burn { mint: a.lp_mint.to_account_info(), from: a.creator_lp_token.to_account_info(), authority: a.pool_creator.to_account_info() },
            creator_seeds,
        ),
        lp_amount,
    )?;
    let left = a.pool_creator.lamports();
    if left > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                a.system_program.to_account_info(),
                anchor_lang::system_program::Transfer { from: a.pool_creator.to_account_info(), to: a.fee_recipient.to_account_info() },
                creator_seeds,
            ),
            left,
        )?;
    }
    Ok(lp_amount)
}

#[derive(Accounts)]
pub struct Migrate<'info> {
    /// Anyone (a keeper) can graduate a sold-out curve; pays for two token accounts.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [SEED_GLOBAL], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    /// CHECK: the token's curve (PDA of this program, so ours). Read and
    /// updated in load/mark helpers: deserializing it here put try_accounts over
    /// SBF's 4 KB stack frame.
    #[account(mut, seeds = [SEED_CURVE, mint.key().as_ref()], bump)]
    pub curve: UncheckedAccount<'info>,
    #[account(mut)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(address = anchor_spl::token::spl_token::native_mint::ID)]
    pub wsol_mint: Box<Account<'info, Mint>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = curve)]
    pub curve_token_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: checked against global.
    #[account(mut, address = global.fee_recipient)]
    pub fee_recipient: UncheckedAccount<'info>,
    /// System-owned PDA that acts as Raydium's pool creator.
    #[account(mut, seeds = [SEED_POOL_CREATOR, mint.key().as_ref()], bump)]
    pub pool_creator: SystemAccount<'info>,
    /// CHECK: pool creator's token ATA, created (idempotently) in migrate_sol;
    /// the associated-token program verifies the address. Not `init_if_needed`:
    /// that codegen pushed try_accounts past SBF's 4 KB stack frame.
    #[account(mut)]
    pub creator_token: UncheckedAccount<'info>,
    /// CHECK: pool creator's wSOL ATA, created like creator_token.
    #[account(mut)]
    pub creator_wsol: UncheckedAccount<'info>,
    /// CHECK: Raydium CPMM program.
    #[account(address = raydium::CPMM_PROGRAM)]
    pub cpmm_program: UncheckedAccount<'info>,
    /// CHECK: Raydium config, fixed address.
    #[account(address = raydium::AMM_CONFIG)]
    pub amm_config: UncheckedAccount<'info>,
    /// CHECK: Raydium vault and LP mint authority PDA.
    #[account(seeds = [raydium::AUTH_SEED], bump, seeds::program = raydium::CPMM_PROGRAM)]
    pub cpmm_authority: UncheckedAccount<'info>,
    /// CHECK: pool PDA, checked against the mint.
    #[account(mut, address = raydium::pool_address(mint.key()))]
    pub pool_state: UncheckedAccount<'info>,
    /// CHECK: created by Raydium.
    #[account(mut, seeds = [raydium::POOL_LP_MINT_SEED, pool_state.key().as_ref()], bump, seeds::program = raydium::CPMM_PROGRAM)]
    pub lp_mint: UncheckedAccount<'info>,
    /// CHECK: created by Raydium as the pool creator's LP associated token account.
    #[account(mut)]
    pub creator_lp_token: UncheckedAccount<'info>,
    /// CHECK: created by Raydium.
    #[account(mut)]
    pub token_0_vault: UncheckedAccount<'info>,
    /// CHECK: created by Raydium.
    #[account(mut)]
    pub token_1_vault: UncheckedAccount<'info>,
    /// CHECK: Raydium's create-pool fee receiver, fixed address.
    #[account(mut, address = raydium::CREATE_POOL_FEE)]
    pub create_pool_fee: UncheckedAccount<'info>,
    /// CHECK: created by Raydium.
    #[account(mut, address = raydium::observation_address(pool_state.key()))]
    pub observation_state: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// CHECK: rent sysvar, passed through to Raydium.
    #[account(address = anchor_lang::solana_program::sysvar::rent::ID)]
    pub rent: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [SEED_GLOBAL], bump = global.bump, has_one = authority)]
    pub global: Account<'info, Global>,
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
    #[account(seeds = [SEED_GLOBAL], bump = global.bump, has_one = authority)]
    pub global: Box<Account<'info, Global>>,
    #[account(init_if_needed, payer = authority, space = 8 + PendingAuthority::INIT_SPACE, seeds = [SEED_PENDING_AUTHORITY], bump)]
    pub pending: Box<Account<'info, PendingAuthority>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    #[account(mut)]
    pub new_authority: Signer<'info>,
    #[account(mut, seeds = [SEED_GLOBAL], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    #[account(mut, seeds = [SEED_PENDING_AUTHORITY], bump = pending.bump, close = new_authority)]
    pub pending: Box<Account<'info, PendingAuthority>>,
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
pub struct TokenCreated {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub dev_locked_tokens: u64,
    pub slot: u64,
}

#[event]
pub struct TradeEvent {
    pub mint: Pubkey,
    pub trader: Pubkey,
    pub is_buy: bool,
    pub sol_amount: u64,
    pub token_amount: u64,
    pub price_q64: u128,
    pub slot: u64,
}

#[event]
pub struct CreatorFeesForfeited {
    pub mint: Pubkey,
    pub amount: u64,
}

#[event]
pub struct CurveCompleted {
    pub mint: Pubkey,
    pub real_sol: u64,
    pub slot: u64,
}

#[event]
pub struct Migrated {
    pub mint: Pubkey,
    pub sol_to_pool: u64,
    pub tokens_to_pool: u64,
    pub pool: Pubkey,
    pub lp_burned: u64,
}

#[error_code]
pub enum LaunchError {
    #[msg("Only the proposed new authority can accept")]
    NotPendingAuthority,
    #[msg("Program is paused")]
    Paused,
    #[msg("Total fee is too high")]
    FeeTooHigh,
    #[msg("Name, symbol or URI too long")]
    MetadataTooLong,
    #[msg("Dev buy exceeds 5% of supply")]
    DevBuyTooLarge,
    #[msg("Curve has sold out")]
    CurveComplete,
    #[msg("Slippage limit exceeded")]
    Slippage,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Not enough SOL in the curve")]
    InsufficientLiquidity,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Dev tokens are still locked")]
    StillLocked,
    #[msg("Curve is not complete or already migrated")]
    NotReadyToMigrate,
    #[msg("Not enough SOL raised to create the pool")]
    NotEnoughToMigrate,
    #[msg("Pool creation did not produce LP tokens")]
    MigrationFailed,
    #[msg("Deprecated, unused: the 7-day creator fee lock was replaced by the 20/80 split")]
    CreatorFeesLocked,
    #[msg("Creator fees can be forfeited only 30 days after launch, if the curve has not graduated")]
    NotForfeitable,
}

#[cfg(test)]
mod metaplex_tests {
    use super::*;
    #[test]
    fn create_v3_layout() {
        let d = metaplex::create_v3_data("Ab", "C", "u");
        assert_eq!(d, vec![33, 2, 0, 0, 0, b'A', b'b', 1, 0, 0, 0, b'C', 1, 0, 0, 0, b'u', 0, 0, 0, 0, 0, 0, 0]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn global() -> Global {
        Global {
            authority: Pubkey::default(),
            fee_recipient: Pubkey::default(),
            insurance_recipient: Pubkey::default(),
            migration_authority: Pubkey::default(),
            launch_fee_lamports: 20_000_000,
            graduation_fee_lamports: 1_500_000_000,
            protocol_fee_bps: 50,
            creator_fee_bps: 30,
            insurance_fee_bps: 20,
            paused: false,
            bump: 255,
        }
    }

    fn fresh_curve() -> Curve {
        Curve {
            mint: Pubkey::default(),
            creator: Pubkey::default(),
            name: String::new(),
            symbol: String::new(),
            uri: String::new(),
            virtual_sol: INITIAL_VIRTUAL_SOL,
            virtual_tokens: INITIAL_VIRTUAL_TOKENS,
            real_sol: 0,
            real_tokens: CURVE_SUPPLY,
            creator_fees_owed: 0,
            dev_locked_tokens: 0,
            dev_unlock_ts: 0,
            complete: false,
            migrated: false,
            created_slot: 0,
            created_ts: 0,
            price_cumulative: 0,
            last_price_q64: 0,
            last_slot: 0,
            observations: [Observation::default(); OBSERVATIONS],
            obs_index: 0,
            obs_count: 1,
            bump: 255,
            creator_fees_locked: 0,
        }
    }

    #[test]
    fn creator_fee_split_floors_early_and_sums_exactly() {
        for fee in [0u64, 1, 4, 5, 6, 9, 10, 1_234_567, u64::MAX] {
            let (early, locked) = split_creator_fee(fee);
            assert_eq!(early as u128, fee as u128 * 2_000 / 10_000);
            assert_eq!(early + locked, fee);
        }
        assert_eq!(split_creator_fee(5), (1, 4));
        assert_eq!(split_creator_fee(4), (0, 4));
    }

    #[test]
    fn graduation_raises_about_88_sol() {
        let g = global();
        let mut c = fresh_curve();
        c.last_price_q64 = c.spot_price_q64();
        let (out, fees) = c.quote_buy(500 * 1_000_000_000, &g).unwrap();
        assert_eq!(out, CURVE_SUPPLY);
        c.apply_buy(fees.net_in, out, fees.creator, 10).unwrap();
        let raised = c.real_sol as f64 / 1e9;
        assert!((raised - 87.912).abs() < 0.01, "raised {raised}");
    }

    #[test]
    fn round_trip_costs_only_fees() {
        let g = global();
        let mut c = fresh_curve();
        let (out, fees) = c.quote_buy(5_000_000_000, &g).unwrap();
        c.apply_buy(fees.net_in, out, fees.creator, 1).unwrap();
        let gross_back = c.quote_sell_gross(out).unwrap();
        // Without fees the round trip returns (almost exactly) the net SOL put in.
        assert!(fees.net_in - gross_back <= 1);
    }

    #[test]
    fn twap_lags_a_pump() {
        let g = global();
        let mut c = fresh_curve();
        c.last_price_q64 = c.spot_price_q64();
        let p0 = c.last_price_q64;
        // Quiet for 1,000 slots, then a big buy.
        let (out, fees) = c.quote_buy(20_000_000_000, &g).unwrap();
        c.apply_buy(fees.net_in, out, fees.creator, 1_000).unwrap();
        let spot = c.last_price_q64;
        let twap = c.twap_q64(1_010, 750);
        assert!(spot > p0 * 2);
        assert!(twap < p0 + (spot - p0) / 10, "TWAP should barely move 10 slots after the pump");
    }
    /// `client/scripts/resize-accounts.ts` hard-codes this size to find accounts that
    /// predate `creator_fees_locked`. Update both together.
    #[test]
    fn curve_account_size_matches_resize_script() {
        assert_eq!(8 + Curve::INIT_SPACE, 1219);
    }

}
