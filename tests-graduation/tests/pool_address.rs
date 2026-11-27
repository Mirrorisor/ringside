//! The token's Raydium pool cannot be pre-empted. `migrate` creates it at a PDA
//! of the launch program (which signs Raydium's `initialize`), not at Raydium's
//! canonical pool address, which anyone can create first.
//!
//! Also covers how perps treats the pool: a market stores it once at
//! `graduate_market`, and markets that graduated before it was stored keep
//! reading Raydium's canonical pool.

mod common;

use anchor_spl::associated_token::get_associated_token_address;
use solana_sdk::{
    program_pack::Pack,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_program,
};

use common::*;
use ringside_launch as launch;
use ringside_launch::raydium;
use ringside_perps as perps;

fn custom(e: solana_program_test::BanksClientError) -> u32 {
    use solana_sdk::{instruction::InstructionError, transaction::TransactionError};
    match e.unwrap() {
        TransactionError::InstructionError(_, InstructionError::Custom(c)) => c,
        other => panic!("unexpected error {other:?}"),
    }
}

const BAD_POOL: u32 = 6000 + perps::PerpsError::BadPool as u32;

/// An outsider creates the canonical Raydium pool for the token first, before the
/// curve has even sold out. migrate must still work, into the launch program's pool.
#[tokio::test]
async fn canonical_pool_created_first_does_not_block_migrate() {
    let mut f = Fx::new().await;
    let m = f.mint;
    let canonical = PoolKeys::new(raydium::canonical_pool_address(m), m);
    let ours = PoolKeys::new(launch::launch_pool_address(&m), m);
    assert_ne!(canonical.pool, ours.pool);

    let attacker = Keypair::new();
    f.outsider_creates_pool(&attacker, &canonical, None).await.unwrap();
    let theirs = f.ctx.banks_client.get_account(canonical.pool).await.unwrap().unwrap();
    assert_eq!(theirs.owner, raydium::CPMM_PROGRAM, "the outsider's pool exists");

    let c = f.sell_out().await;
    f.migrate(&ours).await.expect("migrate still succeeds");

    // The pool is ours, owned by Raydium, funded with the raised SOL, LP burned.
    let acc = f.ctx.banks_client.get_account(ours.pool).await.unwrap().expect("launch pool created");
    assert_eq!(acc.owner, raydium::CPMM_PROGRAM);
    let pool_sol = token_amount(&mut f.ctx, ours.sol_vault).await;
    assert_eq!(pool_sol, c.real_sol - SOL / 20 - launch::POOL_CREATION_RESERVE);
    let creator_lp = get_associated_token_address(&f.pool_creator, &ours.lp_mint);
    assert_eq!(token_amount(&mut f.ctx, creator_lp).await, 0, "LP burned");
    let lp = f.ctx.banks_client.get_account(ours.lp_mint).await.unwrap().unwrap();
    assert!(spl_token::state::Mint::unpack(&lp.data).unwrap().supply <= 100, "only Raydium's locked LP remains");
    let cs = f.curve_state().await;
    assert!(cs.migrated && cs.real_sol == 0);
    // The outsider's pool is untouched.
    assert_eq!(f.ctx.banks_client.get_account(canonical.pool).await.unwrap().unwrap().data, theirs.data);

    // The market graduates onto OUR pool, and refuses the outsider's.
    let e = f.try_send(&[f.graduate_ix(canonical.price_accounts())], &[]).await.unwrap_err();
    assert_eq!(custom(e), BAD_POOL, "the canonical pool is not accepted for a new market");
    assert_eq!(f.market_state().await.tier, 0);
    f.try_send(&[f.graduate_ix(ours.price_accounts())], &[]).await.unwrap();
    let mk = f.market_state().await;
    assert_eq!((mk.tier, mk.pool), (1, ours.pool));
    // From then on only the stored pool prices the market.
    f.ctx.warp_to_slot(f.ctx.banks_client.get_root_slot().await.unwrap() + 2).unwrap();
    f.try_send(&[f.crank_ix(ours.price_accounts())], &[]).await.unwrap();
    f.ctx.warp_to_slot(f.ctx.banks_client.get_root_slot().await.unwrap() + 2).unwrap();
    let e = f.try_send(&[f.crank_ix(canonical.price_accounts())], &[]).await.unwrap_err();
    assert_eq!(custom(e), BAD_POOL);
}

/// Someone sends lamports to the launch program's pool address (and to every
/// address Raydium derives from it) in advance. Raydium handles prefunded
/// accounts, so migrate still works.
#[tokio::test]
async fn prefunded_pool_addresses_do_not_block_migrate() {
    let mut f = Fx::new().await;
    let m = f.mint;
    let ours = PoolKeys::new(launch::launch_pool_address(&m), m);
    let creator_lp = get_associated_token_address(&f.pool_creator, &ours.lp_mint);
    let griefer = Keypair::new();
    f.fund(griefer.pubkey(), SOL).await;
    let payer = f.payer();
    let rent_min = f.ctx.banks_client.get_rent().await.unwrap().minimum_balance(0);
    // System-owned, empty, but holding lamports: the pool itself, then what Raydium derives from it.
    for (i, k) in [ours.pool, ours.lp_mint, ours.vault0, ours.vault1, ours.obs, creator_lp].into_iter().enumerate() {
        send(&mut f.ctx, &[solana_sdk::system_instruction::transfer(&payer, &k, rent_min + 1 + i as u64 * 1_000_000)], &[]).await;
        assert_eq!(f.ctx.banks_client.get_account(k).await.unwrap().unwrap().owner, system_program::ID);
    }
    f.sell_out().await;
    f.migrate(&ours).await.expect("migrate succeeds into the prefunded pool address");
    let acc = f.ctx.banks_client.get_account(ours.pool).await.unwrap().unwrap();
    assert_eq!(acc.owner, raydium::CPMM_PROGRAM);
    let creator_lp_amount = token_amount(&mut f.ctx, creator_lp).await;
    assert_eq!(creator_lp_amount, 0, "LP burned");
    f.try_send(&[f.graduate_ix(ours.price_accounts())], &[]).await.unwrap();
    assert_eq!(f.market_state().await.pool, ours.pool);
    let _ = griefer;
}

/// Nobody but the launch program can sign for its pool address, so Raydium's
/// "non-canonical pool must sign" path stays closed to outsiders: they cannot create
/// a pool there with a keypair (the address is a PDA, not a key they hold).
#[tokio::test]
async fn an_outsider_cannot_create_a_pool_at_the_launch_address() {
    let mut f = Fx::new().await;
    let m = f.mint;
    let ours = PoolKeys::new(launch::launch_pool_address(&m), m);
    let attacker = Keypair::new();
    // Without the pool's signature Raydium refuses a non-canonical address.
    let r = f.outsider_creates_pool(&attacker, &ours, None).await;
    assert!(r.is_err(), "Raydium needs the pool account to sign");
    assert!(f.ctx.banks_client.get_account(ours.pool).await.unwrap().is_none());
}

/// A market that graduated before the pool was stored has `pool` all zero and keeps
/// reading Raydium's canonical pool, where those curves migrated.
#[tokio::test]
async fn market_graduated_before_the_pool_was_stored_keeps_the_canonical_pool() {
    let mut f = Fx::new().await;
    let m = f.mint;
    let canonical = PoolKeys::new(raydium::canonical_pool_address(m), m);
    let ours = PoolKeys::new(launch::launch_pool_address(&m), m);
    // Stand in for the old world: the token's pool is Raydium's canonical one.
    let who = Keypair::new();
    f.outsider_creates_pool(&who, &canonical, None).await.unwrap();
    f.sell_out().await;
    // Mark the curve migrated the way the old program did, and leave no launch pool behind.
    let mut a = f.ctx.banks_client.get_account(f.curve).await.unwrap().unwrap();
    let mut c = f.curve_state().await;
    c.migrated = true;
    {
        use anchor_lang::AccountSerialize;
        let mut buf = Vec::new();
        c.try_serialize(&mut buf).unwrap();
        a.data[..buf.len()].copy_from_slice(&buf);
    }
    f.ctx.set_account(&f.curve, &a.into());

    // Graduating onto a canonical pool needs the empty launch pool address as proof...
    let e = f.try_send(&[f.graduate_ix(canonical.price_accounts())], &[]).await.unwrap_err();
    assert_eq!(custom(e), BAD_POOL, "no proof that no launch pool exists");
    let mut with_proof = canonical.price_accounts();
    with_proof.push(solana_sdk::instruction::AccountMeta::new_readonly(ours.pool, false));
    f.try_send(&[f.graduate_ix(with_proof)], &[]).await.unwrap();
    assert_eq!(f.market_state().await.pool, canonical.pool);
    f.ctx.warp_to_slot(f.ctx.banks_client.get_root_slot().await.unwrap() + 2).unwrap();
    f.try_send(&[f.crank_ix(canonical.price_accounts())], &[]).await.unwrap();

    // Now blank the stored pool, as on a market that graduated before the field existed.
    let mut mk = f.ctx.banks_client.get_account(f.market).await.unwrap().unwrap();
    let n = mk.data.len();
    mk.data[n - 32..].fill(0);
    f.ctx.set_account(&f.market, &mk.into());
    assert_eq!(f.market_state().await.pool, Pubkey::default());
    f.ctx.warp_to_slot(f.ctx.banks_client.get_root_slot().await.unwrap() + 2).unwrap();
    f.try_send(&[f.crank_ix(canonical.price_accounts())], &[]).await.expect("legacy market prices from the canonical pool");
    f.ctx.warp_to_slot(f.ctx.banks_client.get_root_slot().await.unwrap() + 2).unwrap();
    let e = f.try_send(&[f.crank_ix(ours.price_accounts())], &[]).await.unwrap_err();
    assert_eq!(custom(e), BAD_POOL);
}

/// The canonical fallback is closed once the launch pool exists: for a curve that
/// migrated through this program, an outsider's canonical pool is never accepted.
#[tokio::test]
async fn canonical_fallback_is_refused_once_a_launch_pool_exists() {
    let mut f = Fx::new().await;
    let m = f.mint;
    let canonical = PoolKeys::new(raydium::canonical_pool_address(m), m);
    let ours = PoolKeys::new(launch::launch_pool_address(&m), m);
    f.outsider_creates_pool(&Keypair::new(), &canonical, None).await.unwrap();
    f.sell_out().await;
    f.migrate(&ours).await.unwrap();
    let mut with_proof = canonical.price_accounts();
    with_proof.push(solana_sdk::instruction::AccountMeta::new_readonly(ours.pool, false));
    let e = f.try_send(&[f.graduate_ix(with_proof)], &[]).await.unwrap_err();
    assert_eq!(custom(e), BAD_POOL);
    assert_eq!(f.market_state().await.tier, 0);
}
