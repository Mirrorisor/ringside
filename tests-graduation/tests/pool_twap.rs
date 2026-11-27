//! Pool pricing after graduation (F6) and the graduation flags (F11), against the real
//! Raydium CPMM program:
//! - a fresh pool has no observation history: the mark stays at the curve's final price, no
//!   swap in the same transaction can move it, and new opens are refused (closes are not);
//! - once the history covers the TWAP window the mark follows it (band-limited);
//! - a donation to a pool vault does not move the mark;
//! - accrued pool fees are read from the real PoolState layout;
//! - `graduate_market` keeps an admin's reduce-only flag and clears only a retirement's.

mod common;

use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_spl::associated_token::get_associated_token_address;
use solana_sdk::{
    compute_budget::ComputeBudgetInstruction,
    instruction::Instruction,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_instruction, system_program,
};

use common::*;
use ringside_launch as launch;
use ringside_launch::raydium;
use ringside_perps as perps;

/// Moves the bank forward `slots` slots and `secs` seconds of unix time.
async fn advance(f: &mut Fx, slots: u64, secs: i64) {
    let c: solana_sdk::clock::Clock = f.ctx.banks_client.get_sysvar().await.unwrap();
    f.ctx.warp_to_slot(c.slot + slots).unwrap();
    let mut c: solana_sdk::clock::Clock = f.ctx.banks_client.get_sysvar().await.unwrap();
    c.unix_timestamp += secs;
    f.ctx.set_sysvar(&c);
}

struct G {
    f: Fx,
    p: PoolKeys,
    buyer: Keypair,
}

/// A launched token with a Tier 0 market; nothing sold yet.
async fn fresh() -> G {
    let mut f = Fx::new().await;
    let p = PoolKeys::new(launch::launch_pool_address(&f.mint), f.mint);
    let buyer = Keypair::new();
    f.fund(buyer.pubkey(), 5 * SOL).await;
    G { f, p, buyer }
}

/// Sells the curve out to one buyer, migrates, and graduates the market.
async fn graduated() -> G {
    let mut g = fresh().await;
    g.graduate().await;
    g
}

impl G {
    async fn graduate(&mut self) {
        let buyer = self.buyer.insecure_clone();
        self.f.buy(&buyer, 3 * SOL).await;
        self.f.migrate(&self.p).await.unwrap();
        let ix = self.f.graduate_ix(self.p.price_accounts());
        self.f.try_send(&[ComputeBudgetInstruction::set_compute_unit_limit(300_000), ix], &[]).await.unwrap();
    }

    fn swap_ix(&self, amount_in: u64) -> Vec<Instruction> {
        let (wsol, m) = (spl_token::native_mint::ID, self.f.mint);
        let buyer_ata = get_associated_token_address(&self.buyer.pubkey(), &m);
        let buyer_wsol = get_associated_token_address(&self.buyer.pubkey(), &wsol);
        vec![
            spl_associated_token_account::instruction::create_associated_token_account_idempotent(&self.f.payer(), &self.buyer.pubkey(), &wsol, &spl_token::ID),
            Instruction {
                program_id: raydium::CPMM_PROGRAM,
                accounts: raydium_cp_swap::accounts::Swap {
                    payer: self.buyer.pubkey(), authority: self.p.authority, amm_config: raydium::AMM_CONFIG, pool_state: self.p.pool,
                    input_token_account: buyer_ata, output_token_account: buyer_wsol, input_vault: self.p.tok_vault, output_vault: self.p.sol_vault,
                    input_token_program: spl_token::ID, output_token_program: spl_token::ID, input_token_mint: m, output_token_mint: wsol,
                    observation_state: self.p.obs,
                }
                .to_account_metas(None),
                data: raydium_cp_swap::instruction::SwapBaseInput { amount_in, minimum_amount_out: 1 }.data(),
            },
        ]
    }

    /// Swaps `amount_in` lamports of wrapped SOL back into the token.
    fn buy_back_ix(&self, amount_in: u64) -> Instruction {
        let (wsol, m) = (spl_token::native_mint::ID, self.f.mint);
        let buyer_ata = get_associated_token_address(&self.buyer.pubkey(), &m);
        let buyer_wsol = get_associated_token_address(&self.buyer.pubkey(), &wsol);
        Instruction {
            program_id: raydium::CPMM_PROGRAM,
            accounts: raydium_cp_swap::accounts::Swap {
                payer: self.buyer.pubkey(), authority: self.p.authority, amm_config: raydium::AMM_CONFIG, pool_state: self.p.pool,
                input_token_account: buyer_wsol, output_token_account: buyer_ata, input_vault: self.p.sol_vault, output_vault: self.p.tok_vault,
                input_token_program: spl_token::ID, output_token_program: spl_token::ID, input_token_mint: wsol, output_token_mint: m,
                observation_state: self.p.obs,
            }
            .to_account_metas(None),
            data: raydium_cp_swap::instruction::SwapBaseInput { amount_in, minimum_amount_out: 1 }.data(),
        }
    }

    /// Sells `tokens` (whole tokens) into the pool.
    async fn dump(&mut self, tokens: u64) {
        let ixs = self.swap_ix(tokens * 1_000_000);
        let buyer = self.buyer.insecure_clone();
        self.f.try_send(&ixs, &[&buyer]).await.unwrap();
    }

    fn crank(&self) -> Instruction { self.f.crank_ix(self.p.price_accounts()) }

    async fn anchor(&mut self) -> u128 { self.f.market_state().await.band_anchor_q64 }

    /// Pool price as Q64 from the vault balances (before fees, close enough at these sizes).
    async fn pool_price(&mut self) -> u128 {
        let sol = token_amount(&mut self.f.ctx, self.p.sol_vault).await;
        let tok = token_amount(&mut self.f.ctx, self.p.tok_vault).await;
        ((sol as u128) << 64) / tok as u128
    }

    /// Sends tokens and wrapped SOL straight into the pool's vaults (not through a swap).
    async fn donate(&mut self, tokens: u64, lamports: u64) {
        let (wsol, m) = (spl_token::native_mint::ID, self.f.mint);
        let buyer_ata = get_associated_token_address(&self.buyer.pubkey(), &m);
        let buyer_wsol = get_associated_token_address(&self.buyer.pubkey(), &wsol);
        let ixs = vec![
            spl_token::instruction::transfer(&spl_token::ID, &buyer_ata, &self.p.tok_vault, &self.buyer.pubkey(), &[], tokens * 1_000_000).unwrap(),
            system_instruction::transfer(&self.buyer.pubkey(), &buyer_wsol, lamports),
            spl_token::instruction::sync_native(&spl_token::ID, &buyer_wsol).unwrap(),
            spl_token::instruction::transfer(&spl_token::ID, &buyer_wsol, &self.p.sol_vault, &self.buyer.pubkey(), &[], lamports).unwrap(),
        ];
        let buyer = self.buyer.insecure_clone();
        self.f.try_send(&ixs, &[&buyer]).await.unwrap();
    }
}

fn curve_final(c: &launch::Curve) -> u128 { ((c.virtual_sol as u128) << 64) / c.virtual_tokens as u128 }

#[tokio::test]
async fn graduation_stores_the_curve_final_price() {
    let mut g = graduated().await;
    let c = g.f.curve_state().await;
    let m = g.f.market_state().await;
    assert_eq!(m.tier, 1);
    assert_eq!(m.grad_price_q64, curve_final(&c));
    assert_eq!(m.band_anchor_q64, curve_final(&c));
}

/// Right after graduation the pool has no history. A big swap and a crank in one
/// transaction, two band windows later, must not move the mark.
#[tokio::test]
async fn fresh_pool_swap_and_crank_in_one_tx_does_not_move_the_mark() {
    let mut g = graduated().await;
    let start = g.anchor().await;
    advance(&mut g.f, 10, 5).await;
    advance(&mut g.f, 2 * perps::TWAP_WINDOW_SLOTS + 10, 700).await;
    let before = g.pool_price().await;
    let mut ixs = g.swap_ix(300_000_000 * 1_000_000);
    ixs.push(g.crank());
    let buyer = g.buyer.insecure_clone();
    g.f.try_send(&ixs, &[&buyer]).await.unwrap();
    let after = g.pool_price().await;
    assert!(after < before / 2, "the swap moved the pool price a lot ({before} -> {after})");
    assert_eq!(g.anchor().await, start, "but the mark is still the curve's final price");
    // And again a window later with only that single observation in the pool: still no history.
    advance(&mut g.f, perps::TWAP_WINDOW_SLOTS + 5, 400).await;
    g.f.try_send(&[g.crank()], &[]).await.unwrap();
    assert_eq!(g.anchor().await, start, "one observation is not history");
}

/// A trader whose open and close orders run against the graduated market.
struct Trading {
    trader: Keypair,
    usdc: Pubkey,
    vault: Pubkey,
    vault_usdc: Pubkey,
    position: Pubkey,
    order: Pubkey,
}

async fn trading(g: &mut G) -> Trading {
    let trader = Keypair::new();
    g.f.fund(trader.pubkey(), SOL).await;
    let usdc_mint = {
        let v = g.f.ctx.banks_client.get_account(g.f.perps_vault).await.unwrap().unwrap();
        perps::Vault::try_deserialize(&mut v.data.as_slice()).unwrap().usdc_mint
    };
    let ata = get_associated_token_address(&trader.pubkey(), &usdc_mint);
    let payer = g.f.payer();
    let payer_kp = g.f.ctx.payer.insecure_clone();
    g.f.try_send(&[
        spl_associated_token_account::instruction::create_associated_token_account(&payer, &trader.pubkey(), &usdc_mint, &spl_token::ID),
        spl_token::instruction::mint_to(&spl_token::ID, &usdc_mint, &ata, &payer, &[], 10_000_000_000).unwrap(),
    ], &[&payer_kp]).await.unwrap();
    let (vault_usdc, _) = Pubkey::find_program_address(&[perps::SEED_VAULT_USDC], &perps::ID);
    // LP liquidity so the vault can pay out a close that realises a profit.
    let (lp, _) = Pubkey::find_program_address(&[perps::SEED_LP, trader.pubkey().as_ref()], &perps::ID);
    g.f.try_send(&[Instruction {
        program_id: perps::ID,
        accounts: perps::accounts::Liquidity {
            owner: trader.pubkey(), vault: g.f.perps_vault, vault_usdc, lp, owner_usdc: ata, token_program: spl_token::ID, system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: perps::instruction::DepositLiquidity { amount: 5_000_000_000 }.data(),
    }], &[&trader]).await.unwrap();
    let (position, _) = Pubkey::find_program_address(&[perps::SEED_POSITION, trader.pubkey().as_ref(), g.f.market.as_ref(), &[perps::SIDE_LONG]], &perps::ID);
    let (order, _) = Pubkey::find_program_address(&[perps::SEED_ORDER, trader.pubkey().as_ref(), g.f.market.as_ref(), &[perps::SIDE_LONG]], &perps::ID);
    Trading { trader, usdc: ata, vault: g.f.perps_vault, vault_usdc, position, order }
}

impl Trading {
    fn request(&self, g: &G, kind: u8, collateral: u64, size: u64) -> Instruction {
        let acceptable = if kind == perps::ORDER_INCREASE { u128::MAX } else { 1 };
        Instruction {
            program_id: perps::ID,
            accounts: perps::accounts::RequestOrder {
                owner: self.trader.pubkey(), payer: self.trader.pubkey(), vault: self.vault, vault_usdc: self.vault_usdc, market: g.f.market,
                position: self.position, order: self.order, owner_usdc: self.usdc, token_program: spl_token::ID, system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: perps::instruction::RequestOrder { args: perps::OrderArgs { side: perps::SIDE_LONG, kind, collateral, size_usd: size, acceptable_price_q64: acceptable } }.data(),
        }
    }
    fn execute(&self, g: &G, pool: bool) -> Instruction {
        let mut ix = Instruction {
            program_id: perps::ID,
            accounts: perps::accounts::ExecuteOrder {
                keeper: self.trader.pubkey(), vault: self.vault, vault_usdc: self.vault_usdc, market: g.f.market, curve: g.f.curve,
                rent_payer: self.trader.pubkey(), order: self.order, position: self.position, owner_usdc: self.usdc, keeper_usdc: self.usdc, token_program: spl_token::ID,
            }
            .to_account_metas(None),
            data: perps::instruction::ExecuteOrder {}.data(),
        };
        if pool {
            ix.accounts.extend(g.p.price_accounts());
        }
        ix
    }
    fn sol_price(&self, g: &G) -> Instruction {
        Instruction {
            program_id: perps::ID,
            accounts: perps::accounts::SetSolPrice { price_authority: g.f.authority.pubkey(), vault: self.vault }.to_account_metas(None),
            data: perps::instruction::SetSolPrice { price_e6: 150_000_000 }.data(),
        }
    }
    /// Requests, waits out the fill delay and has the order filled (or refunded).
    async fn run(&self, g: &mut G, kind: u8, collateral: u64, size: u64, pool: bool) {
        let t = self.trader.insecure_clone();
        g.f.try_send(&[self.request(g, kind, collateral, size)], &[&t]).await.unwrap();
        advance(&mut g.f, 3, 1).await;
        let auth = g.f.authority.insecure_clone();
        let (price, exec) = (self.sol_price(g), self.execute(g, pool));
        g.f.try_send(&[price, ComputeBudgetInstruction::set_compute_unit_limit(400_000), exec], &[&t, &auth]).await.unwrap();
    }
    async fn position(&self, g: &mut G) -> perps::Position {
        let a = g.f.ctx.banks_client.get_account(self.position).await.unwrap().unwrap();
        perps::Position::try_deserialize(&mut a.data.as_slice()).unwrap()
    }
}

#[tokio::test]
async fn opens_wait_for_pool_history_closes_do_not() {
    let mut g = graduated().await;
    let t = trading(&mut g).await;
    advance(&mut g.f, 10, 5).await;
    g.dump(5_000_000).await; // a modest move (~5%): inside the band, first observation only
    advance(&mut g.f, 400, 400).await;

    // No usable history: an open is refunded, not filled.
    let usdc_before = token_amount(&mut g.f.ctx, t.usdc).await;
    t.run(&mut g, perps::ORDER_INCREASE, 50_000, 100_000, true).await;
    assert_eq!(t.position(&mut g).await.size_usd, 0, "no position on a pool without history");
    assert_eq!(token_amount(&mut g.f.ctx, t.usdc).await, usdc_before, "collateral refunded");
    assert!(g.f.ctx.banks_client.get_account(t.order).await.unwrap().is_none());

    // A second observation 400 s later gives the pool a full window of history.
    g.dump(1_000).await;
    advance(&mut g.f, 5, 5).await;
    t.run(&mut g, perps::ORDER_INCREASE, 50_000, 100_000, true).await;
    assert_eq!(t.position(&mut g).await.size_usd, 100_000, "the open fills once there is history");

    // Closing never needed history: the warm-up path prices closes too.
    t.run(&mut g, perps::ORDER_CLOSE, 0, 0, true).await;
    assert_eq!(t.position(&mut g).await.size_usd, 0, "closed");
}

/// A position opened while the curve was live can always be closed after graduation, before the
/// pool has any history: the close is priced at the curve's final price (worst-of with the pool).
#[tokio::test]
async fn a_position_from_before_graduation_closes_on_a_pool_without_history() {
    let mut g = fresh().await;
    let t = trading(&mut g).await;
    t.run(&mut g, perps::ORDER_INCREASE, 60_000, 100_000, false).await;
    assert_eq!(t.position(&mut g).await.size_usd, 100_000, "opened on the curve");
    g.graduate().await;
    advance(&mut g.f, 10, 5).await;
    let before = token_amount(&mut g.f.ctx, t.usdc).await;
    t.run(&mut g, perps::ORDER_CLOSE, 0, 0, true).await;
    assert_eq!(t.position(&mut g).await.size_usd, 0, "closed with no pool history");
    assert!(token_amount(&mut g.f.ctx, t.usdc).await > before, "collateral paid out");
}

/// The same pool history, with and without a donation to both vaults just before the crank.
async fn scenario(donate: bool) -> (u128, u128, u128) {
    let mut g = graduated().await;
    let start = g.anchor().await;
    advance(&mut g.f, 10, 5).await;
    g.dump(5_000_000).await;
    let after_first = g.pool_price().await;
    advance(&mut g.f, 5, 405).await;
    g.dump(1_000).await;
    advance(&mut g.f, perps::TWAP_WINDOW_SLOTS + 5, 20).await;
    if donate {
        g.donate(100_000_000, SOL / 2).await;
    }
    g.f.try_send(&[g.crank()], &[]).await.unwrap();
    (start, g.anchor().await, after_first)
}

#[tokio::test]
async fn after_history_accumulates_the_mark_follows_the_twap() {
    let (start, anchor, after_first) = scenario(false).await;
    assert!(anchor < start, "the mark moved down with the pool");
    // The TWAP over the window is the price after the first swap (the newest observed interval).
    let gap = anchor.abs_diff(after_first) * 10_000 / after_first;
    assert!(gap <= 50, "mark {anchor} follows the observed price {after_first} ({gap} bps)");
}

#[tokio::test]
async fn a_donation_to_the_vaults_does_not_move_the_mark() {
    let (_, plain, _) = scenario(false).await;
    let (_, donated, _) = scenario(true).await;
    assert_eq!(donated, plain, "same observations, same mark, whatever sits in the vaults");
}

/// N1: price P, pushed far away for ~20 s, swapped back, then the pool goes quiet for longer than
/// the window. The short manipulated interval must not become the TWAP (no extrapolation past the
/// newest observation), and with the newest observation stale opens are refused (closes are not).
#[tokio::test]
async fn n1_a_short_pool_manipulation_then_quiet_does_not_set_the_mark_and_blocks_opens() {
    let mut g = graduated().await;
    let t = trading(&mut g).await;
    let start = g.anchor().await;
    advance(&mut g.f, 10, 5).await;
    g.dump(1_000).await; // first observation
    advance(&mut g.f, 5, 400).await;
    g.dump(1_000).await; // history now spans the window
    let base = g.pool_price().await;
    advance(&mut g.f, 5, 30).await;
    g.dump(300_000_000).await; // manipulate: the price falls by more than half
    assert!(g.pool_price().await < base / 2);
    advance(&mut g.f, 5, 20).await;
    let wsol = get_associated_token_address(&g.buyer.pubkey(), &spl_token::native_mint::ID);
    let sol_in = token_amount(&mut g.f.ctx, wsol).await;
    let (back, buyer) = (g.buy_back_ix(sol_in), g.buyer.insecure_clone());
    g.f.try_send(&[back], &[&buyer]).await.unwrap(); // this swap records the manipulated price over those 20 s
    let after = g.pool_price().await;
    assert!(after.abs_diff(base) * 100 < base * 10, "price is back near {base}: {after}");
    // Quiet for well over a window.
    advance(&mut g.f, perps::TWAP_WINDOW_SLOTS + 50, 400).await;
    g.f.try_send(&[g.crank()], &[]).await.unwrap();
    let anchor = g.anchor().await;
    assert!(anchor < start, "the mark follows the real observations down a little");
    assert!(anchor.abs_diff(base) * 100 < base * 5, "mark {anchor} stays within 5% of the true price {base}");
    // Stale newest observation: an open is refunded, not filled.
    t.run(&mut g, perps::ORDER_INCREASE, 50_000, 100_000, true).await;
    assert_eq!(t.position(&mut g).await.size_usd, 0, "no opens while the newest observation is stale");
    // A fresh swap makes it current again; the open then fills.
    g.dump(1_000).await;
    advance(&mut g.f, 5, 5).await;
    t.run(&mut g, perps::ORDER_INCREASE, 50_000, 100_000, true).await;
    assert_eq!(t.position(&mut g).await.size_usd, 100_000, "opens resume once a swap refreshes the history");
}

/// The fee offsets used to net vault balances match Raydium's real PoolState.
#[tokio::test]
async fn pool_fee_offsets_match_raydium_pool_state() {
    let mut g = graduated().await;
    advance(&mut g.f, 10, 5).await;
    g.dump(20_000_000).await;
    g.dump(1_000).await;
    let data = g.f.ctx.banks_client.get_account(g.p.pool).await.unwrap().unwrap().data;
    assert_eq!(data.len(), raydium_cp_swap::states::PoolState::LEN);
    let ps: raydium_cp_swap::states::PoolState = unsafe { std::ptr::read_unaligned(data[8..].as_ptr() as *const raydium_cp_swap::states::PoolState) };
    let fees = |t0: bool| {
        if t0 { (ps.protocol_fees_token_0, ps.fund_fees_token_0, ps.creator_fees_token_0) } else { (ps.protocol_fees_token_1, ps.fund_fees_token_1, ps.creator_fees_token_1) }
    };
    let (p0, f0, c0) = fees(true);
    let (p1, f1, c1) = fees(false);
    assert!(p0 + f0 + c0 + p1 + f1 + c1 > 0, "the swaps accrued fees in the pool");
    assert_eq!(perps::pool_fee_total(&data, false), p0 + f0 + c0);
    assert_eq!(perps::pool_fee_total(&data, true), p1 + f1 + c1);
}

// --- F11 -------------------------------------------------------------------------------------

fn set_limits_ix(f: &Fx, reduce_only: bool) -> Instruction {
    Instruction {
        program_id: perps::ID,
        accounts: perps::accounts::AdminMarket { authority: f.authority.pubkey(), vault: f.perps_vault, market: f.market, curve: f.curve }.to_account_metas(None),
        data: perps::instruction::SetMarketLimits { oi_cap_override: 0, reduce_only }.data(),
    }
}

async fn graduate_now(f: &mut Fx) {
    let p = PoolKeys::new(launch::launch_pool_address(&f.mint), f.mint);
    let buyer = Keypair::new();
    f.fund(buyer.pubkey(), 5 * SOL).await;
    f.buy(&buyer, 3 * SOL).await;
    f.migrate(&p).await.unwrap();
    let ix = f.graduate_ix(p.price_accounts());
    f.try_send(&[ComputeBudgetInstruction::set_compute_unit_limit(300_000), ix], &[]).await.unwrap();
}

#[tokio::test]
async fn graduation_keeps_an_admin_reduce_only_setting() {
    let mut f = Fx::new().await;
    let auth = f.authority.insecure_clone();
    f.try_send(&[set_limits_ix(&f, true)], &[&auth]).await.unwrap();
    assert!(f.market_state().await.reduce_only);
    graduate_now(&mut f).await;
    let m = f.market_state().await;
    assert_eq!(m.tier, 1);
    assert!(m.reduce_only, "the admin's reduce-only survives graduation");
    // The admin can lift it afterwards.
    f.try_send(&[set_limits_ix(&f, false)], &[&auth]).await.unwrap();
    assert!(!f.market_state().await.reduce_only);
}

#[tokio::test]
async fn graduation_clears_only_the_retirement_flag() {
    let mut f = Fx::new().await;
    let auth = f.authority.insecure_clone();
    f.try_send(&[Instruction {
        program_id: perps::ID,
        accounts: perps::accounts::AdminRetireMarket {
            authority: auth.pubkey(), vault: f.perps_vault, market: f.market, registry: f.registry, retired: f.retired, system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: perps::instruction::AdminRetireMarket {}.data(),
    }], &[&auth]).await.unwrap();
    assert!(f.market_state().await.reduce_only, "retired");
    graduate_now(&mut f).await;
    assert!(!f.market_state().await.reduce_only, "a retired market that graduates trades again");
}
