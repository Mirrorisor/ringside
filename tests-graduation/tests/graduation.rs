//! Graduation end to end, with Raydium CPMM running natively next to Ringside:
//! launch -> buy until the curve sells out -> migrate (permissionless) ->
//! a real CPMM pool holding the raised SOL and the 200M reserve tokens, with
//! every LP token burned.
//!
//! Built with the `devnet` feature: curves start at 0.5 virtual SOL, and the
//! Raydium config and fee receiver are byte-for-byte copies of the live devnet
//! accounts.

mod common;

use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_spl::associated_token::get_associated_token_address;
use solana_program_test::{processor, ProgramTest};
use solana_sdk::{
    account::Account,
    compute_budget::ComputeBudgetInstruction,
    instruction::Instruction,
    program_pack::Pack,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_instruction, system_program, sysvar,
    transaction::Transaction,
};

use common::*;
use ringside_launch as launch;
use ringside_launch::raydium;
use ringside_perps as perps;

#[tokio::test]
async fn sold_out_curve_graduates_into_a_raydium_pool_with_lp_burned() {
    let authority = Keypair::new();
    let fee_recipient = Pubkey::new_unique();
    let pt = program_test(&authority, fee_recipient);
    let mut ctx = pt.start_with_context().await;
    let payer = ctx.payer.pubkey();

    // Global config with a small graduation fee, as on devnet.
    let (global, _) = Pubkey::find_program_address(&[launch::SEED_GLOBAL], &launch::ID);
    send(&mut ctx, &[Instruction {
        program_id: launch::ID,
        accounts: launch::accounts::InitializeGlobal { authority: authority.pubkey(), global, program_data: program_data_of(launch::ID), system_program: system_program::ID }.to_account_metas(None),
        data: launch::instruction::InitializeGlobal { params: launch::GlobalParams {
            fee_recipient, insurance_recipient: fee_recipient, migration_authority: fee_recipient,
            launch_fee_lamports: SOL / 100, graduation_fee_lamports: SOL / 20,
            protocol_fee_bps: 50, creator_fee_bps: 30, insurance_fee_bps: 20,
        } }.data(),
    }], &[&authority]).await;

    // Launch.
    let creator = Keypair::new();
    send(&mut ctx, &[system_instruction::transfer(&payer, &creator.pubkey(), 10 * SOL)], &[]).await;
    let mint = Keypair::new();
    let m = mint.pubkey();
    let (curve, _) = Pubkey::find_program_address(&[launch::SEED_CURVE, m.as_ref()], &launch::ID);
    let (dev_lock, _) = Pubkey::find_program_address(&[launch::SEED_DEV_LOCK, m.as_ref()], &launch::ID);
    let curve_vault = get_associated_token_address(&curve, &m);
    send(&mut ctx, &[Instruction {
        program_id: launch::ID,
        accounts: launch::accounts::CreateToken {
            creator: creator.pubkey(), global, mint: m, curve, curve_token_vault: curve_vault, dev_lock_vault: dev_lock,
            fee_recipient, insurance_recipient: fee_recipient, metadata: launch::metaplex::metadata_address(&m), token_metadata_program: launch::metaplex::PROGRAM, token_program: spl_token::ID,
            associated_token_program: spl_associated_token_account::ID, system_program: system_program::ID,
        }.to_account_metas(None),
        data: launch::instruction::CreateToken { args: launch::CreateTokenArgs { name: "Grad".into(), symbol: "GRAD".into(), uri: String::new(), dev_buy_lamports: 0 } }.data(),
    }], &[&creator, &mint]).await;

    // Perps vault and the token's market, live from launch.
    let usdc = Keypair::new();
    let rent = ctx.banks_client.get_rent().await.unwrap();
    send(&mut ctx, &[
        system_instruction::create_account(&payer, &usdc.pubkey(), rent.minimum_balance(82), 82, &spl_token::ID),
        spl_token::instruction::initialize_mint(&spl_token::ID, &usdc.pubkey(), &payer, None, 6).unwrap(),
    ], &[&usdc]).await;
    let (perps_vault, _) = Pubkey::find_program_address(&[perps::SEED_VAULT], &perps::ID);
    let (vault_usdc, _) = Pubkey::find_program_address(&[perps::SEED_VAULT_USDC], &perps::ID);
    let (market, _) = Pubkey::find_program_address(&[perps::SEED_MARKET, m.as_ref()], &perps::ID);
    let (registry, _) = Pubkey::find_program_address(&[perps::SEED_REGISTRY], &perps::ID);
    let (retired, _) = Pubkey::find_program_address(&[perps::SEED_RETIRED, market.as_ref()], &perps::ID);
    send(&mut ctx, &[
        Instruction {
            program_id: perps::ID,
            accounts: perps::accounts::InitializeVault { authority: authority.pubkey(), vault: perps_vault, usdc_mint: usdc.pubkey(), program_data: program_data_of(perps::ID), vault_usdc, token_program: spl_token::ID, system_program: system_program::ID }.to_account_metas(None),
            data: perps::instruction::InitializeVault { price_authority: authority.pubkey() }.data(),
        },
        Instruction {
            program_id: perps::ID,
            accounts: perps::accounts::CreateMarket { payer, curve, market, registry, system_program: system_program::ID }.to_account_metas(None),
            data: perps::instruction::CreateMarket {}.data(),
        },
    ], &[&authority]).await;

    // Buy the whole curve (the last buy is capped at the remaining supply).
    let buyer = Keypair::new();
    send(&mut ctx, &[system_instruction::transfer(&payer, &buyer.pubkey(), 5 * SOL)], &[]).await;
    let buyer_ata = get_associated_token_address(&buyer.pubkey(), &m);
    send(&mut ctx, &[Instruction {
        program_id: launch::ID,
        accounts: launch::accounts::Trade {
            trader: buyer.pubkey(), global, mint: m, curve, curve_token_vault: curve_vault, trader_token_account: buyer_ata,
            fee_recipient, insurance_recipient: fee_recipient, token_program: spl_token::ID,
            associated_token_program: spl_associated_token_account::ID, system_program: system_program::ID,
        }.to_account_metas(None),
        data: launch::instruction::Buy { sol_in: 3 * SOL, min_tokens_out: 1 }.data(),
    }], &[&buyer]).await;
    let c: launch::Curve = {
        let a = ctx.banks_client.get_account(curve).await.unwrap().unwrap();
        launch::Curve::try_deserialize(&mut a.data.as_slice()).unwrap()
    };
    assert!(c.complete, "curve sold out");
    assert_eq!(token_amount(&mut ctx, buyer_ata).await, launch::CURVE_SUPPLY);
    let raised = c.real_sol;
    assert!(raised > SOL && raised < 2 * SOL, "devnet curve raises ~1.47 SOL, got {raised}");

    // Migrate (anyone can call it).
    let wsol = spl_token::native_mint::ID;
    let (t0, t1) = raydium::order(m, wsol);
    let pool = launch::launch_pool_address(&m);
    let (cpmm_auth, _) = Pubkey::find_program_address(&[raydium::AUTH_SEED], &raydium::CPMM_PROGRAM);
    let (lp_mint, _) = Pubkey::find_program_address(&[raydium::POOL_LP_MINT_SEED, pool.as_ref()], &raydium::CPMM_PROGRAM);
    let vault = |t: Pubkey| Pubkey::find_program_address(&[raydium::POOL_VAULT_SEED, pool.as_ref(), t.as_ref()], &raydium::CPMM_PROGRAM).0;
    let (pool_creator, _) = Pubkey::find_program_address(&[launch::SEED_POOL_CREATOR, m.as_ref()], &launch::ID);
    let creator_lp = get_associated_token_address(&pool_creator, &lp_mint);
    let fee_before = ctx.banks_client.get_balance(fee_recipient).await.unwrap();
    let keeper = Keypair::new();
    send(&mut ctx, &[system_instruction::transfer(&payer, &keeper.pubkey(), SOL)], &[]).await;
    send(&mut ctx, &[
        ComputeBudgetInstruction::set_compute_unit_limit(400_000),
        Instruction {
            program_id: launch::ID,
            accounts: launch::accounts::Migrate {
                payer: keeper.pubkey(), global, curve, mint: m, wsol_mint: wsol, curve_token_vault: curve_vault, fee_recipient,
                pool_creator, creator_token: get_associated_token_address(&pool_creator, &m),
                creator_wsol: get_associated_token_address(&pool_creator, &wsol),
                cpmm_program: raydium::CPMM_PROGRAM, amm_config: raydium::AMM_CONFIG, cpmm_authority: cpmm_auth,
                pool_state: pool, lp_mint, creator_lp_token: creator_lp, token_0_vault: vault(t0), token_1_vault: vault(t1),
                create_pool_fee: raydium::CREATE_POOL_FEE, observation_state: raydium::observation_address(pool),
                token_program: spl_token::ID, associated_token_program: spl_associated_token_account::ID,
                system_program: system_program::ID, rent: sysvar::rent::ID,
            }.to_account_metas(None),
            data: launch::instruction::Migrate {}.data(),
        },
    ], &[&keeper]).await;

    // The pool exists, owned by Raydium, and holds the liquidity.
    let pool_acc = ctx.banks_client.get_account(pool).await.unwrap().expect("pool created");
    assert_eq!(pool_acc.owner, raydium::CPMM_PROGRAM);
    let (tok_vault, sol_vault) = if t0 == m { (vault(t0), vault(t1)) } else { (vault(t1), vault(t0)) };
    let pool_sol = token_amount(&mut ctx, sol_vault).await;
    let pool_tokens = token_amount(&mut ctx, tok_vault).await;
    let expected = raised - SOL / 20 - launch::POOL_CREATION_RESERVE;
    assert_eq!(pool_sol, expected, "raised SOL minus graduation fee and Raydium costs");
    assert!(pool_tokens <= launch::MIGRATION_SUPPLY);
    // The pool opens at the curve's final price; unneeded reserve tokens are burned.
    let curve_final = ((c.virtual_sol as u128) << 64) / c.virtual_tokens as u128;
    let pool_open = ((pool_sol as u128) << 64) / pool_tokens as u128;
    let gap_bps = pool_open.abs_diff(curve_final) * 10_000 / curve_final;
    assert!(gap_bps <= 1, "pool opens at the curve price ({gap_bps} bps)");
    let supply = spl_token::state::Mint::unpack(&ctx.banks_client.get_account(m).await.unwrap().unwrap().data).unwrap().supply;
    assert_eq!(supply, launch::CURVE_SUPPLY + pool_tokens, "the unneeded reserve is burned");
    assert_eq!(token_amount(&mut ctx, curve_vault).await, 0);

    // Every LP token the creator got is burned; only Raydium's 100 locked units remain.
    assert_eq!(token_amount(&mut ctx, creator_lp).await, 0, "LP burned");
    let lp = ctx.banks_client.get_account(lp_mint).await.unwrap().unwrap();
    let lp_supply = spl_token::state::Mint::unpack(&lp.data).unwrap().supply;
    assert!(lp_supply <= 100, "only the locked LP remains, supply {lp_supply}");

    // Fees and state.
    let fee_after = ctx.banks_client.get_balance(fee_recipient).await.unwrap();
    let creator_left = ctx.banks_client.get_balance(pool_creator).await.unwrap();
    assert_eq!(creator_left, 0, "leftover reserve swept");
    let raydium_cost = launch::POOL_CREATION_RESERVE - (fee_after - fee_before - SOL / 20);
    assert!(raydium_cost > 150_000_000 && raydium_cost < launch::POOL_CREATION_RESERVE, "Raydium took its 0.15 SOL fee plus pool rent: {raydium_cost}");
    let c: launch::Curve = {
        let a = ctx.banks_client.get_account(curve).await.unwrap().unwrap();
        launch::Curve::try_deserialize(&mut a.data.as_slice()).unwrap()
    };
    assert!(c.migrated && c.real_sol == 0);
    let left_in_curve = ctx.banks_client.get_balance(curve).await.unwrap();
    let rent_min = ctx.banks_client.get_rent().await.unwrap().minimum_balance(8 + <launch::Curve as anchor_lang::Space>::INIT_SPACE);
    assert!(left_in_curve >= rent_min, "curve keeps its rent");
    // Migration takes only the graduation fee, the pool reserve and the pool SOL: both creator-fee
    // buckets stay in the curve, which holds exactly rent + owed + locked.
    assert!(c.creator_fees_owed > 0 && c.creator_fees_locked > 0);
    assert_eq!(left_in_curve, rent_min + c.creator_fees_owed + c.creator_fees_locked, "fee buckets survive migration");
    // The graduated curve lets the creator claim both buckets.
    let creator_before = ctx.banks_client.get_balance(creator.pubkey()).await.unwrap();
    send(&mut ctx, &[Instruction {
        program_id: launch::ID,
        accounts: launch::accounts::ClaimCreatorFees { creator: creator.pubkey(), curve }.to_account_metas(None),
        data: launch::instruction::ClaimCreatorFees {}.data(),
    }], &[&creator]).await;
    let creator_after = ctx.banks_client.get_balance(creator.pubkey()).await.unwrap();
    assert_eq!(creator_after - creator_before, c.creator_fees_owed + c.creator_fees_locked, "claim after migration pays early + locked");
    assert_eq!(ctx.banks_client.get_balance(curve).await.unwrap(), rent_min);
    println!("raised {raised}, pool got {pool_sol} lamports + {} tokens, {} burned; Raydium cost {raydium_cost}",
        pool_tokens / 1_000_000, (launch::MIGRATION_SUPPLY - pool_tokens) / 1_000_000);

    // A second migrate is refused.
    let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let again = Transaction::new_signed_with_payer(&[Instruction {
        program_id: launch::ID,
        accounts: launch::accounts::Migrate {
            payer: keeper.pubkey(), global, curve, mint: m, wsol_mint: wsol, curve_token_vault: curve_vault, fee_recipient,
            pool_creator, creator_token: get_associated_token_address(&pool_creator, &m),
            creator_wsol: get_associated_token_address(&pool_creator, &wsol),
            cpmm_program: raydium::CPMM_PROGRAM, amm_config: raydium::AMM_CONFIG, cpmm_authority: cpmm_auth,
            pool_state: pool, lp_mint, creator_lp_token: creator_lp, token_0_vault: vault(t0), token_1_vault: vault(t1),
            create_pool_fee: raydium::CREATE_POOL_FEE, observation_state: raydium::observation_address(pool),
            token_program: spl_token::ID, associated_token_program: spl_associated_token_account::ID,
            system_program: system_program::ID, rent: sysvar::rent::ID,
        }.to_account_metas(None),
        data: launch::instruction::Migrate {}.data(),
    }], Some(&keeper.pubkey()), &[&keeper], bh);
    assert!(ctx.banks_client.process_transaction(again).await.is_err());

    // --- Perps market graduates to the pool price -----------------------------
    let pool_accounts = |obs: Pubkey| vec![
        solana_sdk::instruction::AccountMeta::new_readonly(pool, false),
        solana_sdk::instruction::AccountMeta::new_readonly(obs, false),
        solana_sdk::instruction::AccountMeta::new_readonly(tok_vault, false),
        solana_sdk::instruction::AccountMeta::new_readonly(sol_vault, false),
    ];
    let obs = raydium::observation_address(pool);
    let market_state = |d: Vec<u8>| perps::Market::try_deserialize(&mut d.as_slice()).unwrap();
    // Refused without the pool accounts, and with the wrong ones.
    let mut grad = Instruction {
        program_id: perps::ID,
        accounts: perps::accounts::GraduateMarket { market, curve, registry, retired }.to_account_metas(None),
        data: perps::instruction::GraduateMarket {}.data(),
    };
    let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let bad = Transaction::new_signed_with_payer(&[grad.clone()], Some(&payer), &[&ctx.payer], bh);
    assert!(ctx.banks_client.process_transaction(bad).await.is_err(), "no pool accounts");
    let mut swapped = pool_accounts(obs);
    swapped.swap(2, 3);
    let mut wrong = grad.clone();
    wrong.accounts.extend(swapped);
    let bad = Transaction::new_signed_with_payer(&[wrong], Some(&payer), &[&ctx.payer], bh);
    assert!(ctx.banks_client.process_transaction(bad).await.is_err(), "vaults swapped");
    grad.accounts.extend(pool_accounts(obs));
    let before = market_state(ctx.banks_client.get_account(market).await.unwrap().unwrap().data);
    send(&mut ctx, &[grad.clone()], &[]).await;
    let mk = market_state(ctx.banks_client.get_account(market).await.unwrap().unwrap().data);
    assert_eq!(mk.tier, 1);
    assert_eq!(mk.pool, pool, "the market stores the launch program's pool");
    assert_ne!(pool, raydium::canonical_pool_address(m), "not Raydium's canonical address");
    let reg: perps::Registry = perps::Registry::try_deserialize(&mut ctx.banks_client.get_account(registry).await.unwrap().unwrap().data.as_slice()).unwrap();
    assert_eq!(reg.live_tier0, 0, "graduation frees the Tier 0 slot");
    assert!(!mk.reduce_only, "graduated market trades again");
    let _ = before;
    assert_eq!(mk.band_anchor_q64, curve_final, "band restarts at the curve's final price");
    assert_eq!(mk.grad_price_q64, curve_final, "the final price is kept for pricing until the pool has history");
    let pool_spot = pool_open;
    let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let twice = Transaction::new_signed_with_payer(&[ComputeBudgetInstruction::set_compute_unit_limit(300_000), grad], Some(&payer), &[&ctx.payer], bh);
    assert!(ctx.banks_client.process_transaction(twice).await.is_err(), "graduates once");

    // Someone dumps 300M tokens into the pool, then 10 minutes pass. The
    // market's price follows Raydium's TWAP, but at most 15% per window.
    // Raydium opens swaps one second after the pool is created.
    let mut clock: solana_sdk::clock::Clock = ctx.banks_client.get_sysvar().await.unwrap();
    ctx.warp_to_slot(clock.slot + 10).unwrap();
    clock = ctx.banks_client.get_sysvar().await.unwrap();
    clock.unix_timestamp += 5;
    ctx.set_sysvar(&clock);
    let buyer_wsol = get_associated_token_address(&buyer.pubkey(), &wsol);
    let (in_vault, out_vault) = (tok_vault, sol_vault);
    send(&mut ctx, &[
        spl_associated_token_account::instruction::create_associated_token_account_idempotent(&payer, &buyer.pubkey(), &wsol, &spl_token::ID),
        Instruction {
            program_id: raydium::CPMM_PROGRAM,
            accounts: raydium_cp_swap::accounts::Swap {
                payer: buyer.pubkey(), authority: cpmm_auth, amm_config: raydium::AMM_CONFIG, pool_state: pool,
                input_token_account: buyer_ata, output_token_account: buyer_wsol, input_vault: in_vault, output_vault: out_vault,
                input_token_program: spl_token::ID, output_token_program: spl_token::ID, input_token_mint: m, output_token_mint: wsol,
                observation_state: obs,
            }.to_account_metas(None),
            data: raydium_cp_swap::instruction::SwapBaseInput { amount_in: 300_000_000 * 1_000_000, minimum_amount_out: 1 }.data(),
        },
    ], &[&buyer]).await;
    // The market prices from Raydium's observation history, never the live pool price: the first swap only
    // starts the history, so a second, small swap 400 s later (the TWAP needs observations a full window apart) records the price the dump left behind.
    clock = ctx.banks_client.get_sysvar().await.unwrap();
    ctx.warp_to_slot(clock.slot + 5).unwrap();
    clock = ctx.banks_client.get_sysvar().await.unwrap();
    clock.unix_timestamp += 400;
    ctx.set_sysvar(&clock);
    send(&mut ctx, &[Instruction {
        program_id: raydium::CPMM_PROGRAM,
        accounts: raydium_cp_swap::accounts::Swap {
            payer: buyer.pubkey(), authority: cpmm_auth, amm_config: raydium::AMM_CONFIG, pool_state: pool,
            input_token_account: buyer_ata, output_token_account: buyer_wsol, input_vault: in_vault, output_vault: out_vault,
            input_token_program: spl_token::ID, output_token_program: spl_token::ID, input_token_mint: m, output_token_mint: wsol,
            observation_state: obs,
        }.to_account_metas(None),
        data: raydium_cp_swap::instruction::SwapBaseInput { amount_in: 1_000 * 1_000_000, minimum_amount_out: 1 }.data(),
    }], &[&buyer]).await;
    let sol_after = token_amount(&mut ctx, sol_vault).await;
    let tok_after = token_amount(&mut ctx, tok_vault).await;
    let new_spot = ((sol_after as u128) << 64) / tok_after as u128;
    clock = ctx.banks_client.get_sysvar().await.unwrap();
    let slot = clock.slot + 1_500;
    ctx.warp_to_slot(slot).unwrap();
    clock = ctx.banks_client.get_sysvar().await.unwrap();
    clock.unix_timestamp += 600;
    ctx.set_sysvar(&clock);
    let mut crank = Instruction {
        program_id: perps::ID,
        accounts: perps::accounts::CrankFunding { vault: perps_vault, market, curve }.to_account_metas(None),
        data: perps::instruction::CrankFunding {}.data(),
    };
    crank.accounts.extend(pool_accounts(obs));
    send(&mut ctx, &[crank], &[]).await;
    let mk2 = market_state(ctx.banks_client.get_account(market).await.unwrap().unwrap().data);
    let moved = mk2.band_anchor_q64 as f64 / mk.band_anchor_q64 as f64 - 1.0;
    let pool_move = new_spot as f64 / pool_spot as f64 - 1.0;
    println!("pool price moved {:+.1}%, market mark moved {:+.1}% over 2 windows", pool_move * 100.0, moved * 100.0);
    assert!(pool_move < -0.5, "the dump moved the pool a lot");
    assert!(moved < -0.25, "mark follows the pool down");
    assert!(moved >= -0.2776, "but no faster than 15% per window (two windows)");
}
