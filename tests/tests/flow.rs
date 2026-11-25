//! End-to-end flow on a local bank (solana-program-test), with both Ringside
//! programs running natively and the real SPL Token / ATA programs as BPF:
//! launch -> buy on the curve -> LP deposit -> perp market -> open long after
//! the fill delay -> caps enforced -> close -> payout.

use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_spl::associated_token::get_associated_token_address;
use solana_program_test::{processor, BanksClientError, ProgramTest, ProgramTestContext};
use solana_sdk::{
    account::Account,
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    instruction::{Instruction, InstructionError},
    program_pack::Pack,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_instruction, system_program,
    transaction::{Transaction, TransactionError},
};

use ringside_launch as launch;
use ringside_perps as perps;

const SOL: u64 = 1_000_000_000;
const USDC: u64 = 1_000_000;

fn launch_entry(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    // Anchor's entry wants one lifetime for the slice and its items.
    let accounts: &[AccountInfo] = unsafe { std::mem::transmute(accounts) };
    launch::entry(program_id, accounts, data)
}

fn perps_entry(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let accounts: &[AccountInfo] = unsafe { std::mem::transmute(accounts) };
    perps::entry(program_id, accounts, data)
}

struct Env {
    ctx: ProgramTestContext,
    authority: Keypair,
    fee_recipient: Pubkey,
    insurance: Pubkey,
    migration: Pubkey,
    usdc_mint: Keypair,
}

async fn setup() -> Env {
    let mut pt = ProgramTest::default();
    pt.prefer_bpf(false);
    pt.add_program("ringside_launch", launch::ID, processor!(launch_entry));
    pt.add_program("ringside_perps", perps::ID, processor!(perps_entry));
    pt.add_program("mpl_token_metadata", launch::metaplex::PROGRAM, processor!(metaplex_entry));
    let authority = Keypair::new();
    let (fee_recipient, insurance, migration) = (Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique());
    for k in [authority.pubkey(), fee_recipient, insurance, migration] {
        pt.add_account(k, Account { lamports: 100 * SOL, owner: system_program::ID, ..Account::default() });
    }
    let ctx = pt.start_with_context().await;
    Env { ctx, authority, fee_recipient, insurance, migration, usdc_mint: Keypair::new() }
}

impl Env {
    async fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), BanksClientError> {
        let payer = self.ctx.payer.insecure_clone();
        let mut all: Vec<&Keypair> = vec![&payer];
        all.extend_from_slice(signers);
        let bh = self.ctx.banks_client.get_latest_blockhash().await.unwrap();
        let tx = Transaction::new_signed_with_payer(ixs, Some(&payer.pubkey()), &all, bh);
        self.ctx.banks_client.process_transaction(tx).await
    }

    async fn get<T: AccountDeserialize>(&mut self, key: Pubkey) -> T {
        let acc = self.ctx.banks_client.get_account(key).await.unwrap().expect("account exists");
        T::try_deserialize(&mut acc.data.as_slice()).unwrap()
    }

    async fn token_balance(&mut self, key: Pubkey) -> u64 {
        let acc = self.ctx.banks_client.get_account(key).await.unwrap().unwrap();
        spl_token::state::Account::unpack(&acc.data).unwrap().amount
    }

    async fn warp(&mut self, slots: u64) {
        let now = self.ctx.banks_client.get_root_slot().await.unwrap();
        self.ctx.warp_to_slot(now + slots).unwrap();
    }

    async fn advance_clock(&mut self, seconds: i64) {
        let mut clock: solana_sdk::clock::Clock = self.ctx.banks_client.get_sysvar().await.unwrap();
        clock.unix_timestamp += seconds;
        self.ctx.set_sysvar(&clock);
    }

    async fn fund(&mut self, to: Pubkey, lamports: u64) {
        let payer = self.ctx.payer.pubkey();
        self.send(&[system_instruction::transfer(&payer, &to, lamports)], &[]).await.unwrap();
    }

    async fn usdc_account(&mut self, owner: &Pubkey, amount: u64) -> Pubkey {
        let ata = get_associated_token_address(owner, &self.usdc_mint.pubkey());
        let payer = self.ctx.payer.pubkey();
        let mint = self.usdc_mint.pubkey();
        let auth = self.authority.insecure_clone();
        let mut ixs = vec![spl_associated_token_account::instruction::create_associated_token_account(
            &payer, owner, &mint, &spl_token::ID,
        )];
        if amount > 0 {
            ixs.push(spl_token::instruction::mint_to(&spl_token::ID, &mint, &ata, &auth.pubkey(), &[], amount).unwrap());
        }
        if amount > 0 {
            self.send(&ixs, &[&auth]).await.unwrap();
        } else {
            self.send(&ixs, &[]).await.unwrap();
        }
        ata
    }
}

fn custom_error(e: BanksClientError) -> u32 {
    match e.unwrap() {
        TransactionError::InstructionError(_, InstructionError::Custom(c)) => c,
        other => panic!("unexpected error {other:?}"),
    }
}

/// Stand-in for Metaplex Token Metadata in native tests: checks what Ringside
/// controls (CreateMetadataAccountV3 tag, metadata PDA, signers) and creates
/// the metadata account. The real program accepted the same bytes in a devnet
/// simulation (see README).
fn mock_metaplex(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    use solana_sdk::program::invoke_signed;
    use solana_sdk::program_error::ProgramError;
    if data.first() != Some(&33) || accounts.len() < 6 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (metadata, mint, mint_auth, payer, update_auth, system) = (&accounts[0], &accounts[1], &accounts[2], &accounts[3], &accounts[4], &accounts[5]);
    let (pda, bump) = Pubkey::find_program_address(&[b"metadata", program_id.as_ref(), mint.key.as_ref()], program_id);
    if *metadata.key != pda || !mint_auth.is_signer || !payer.is_signer || !update_auth.is_signer || !metadata.data_is_empty() {
        return Err(ProgramError::InvalidArgument);
    }
    let space = data.len();
    invoke_signed(
        &solana_sdk::system_instruction::create_account(payer.key, metadata.key, 10_000_000, space as u64, program_id),
        &[payer.clone(), metadata.clone(), system.clone()],
        &[&[b"metadata", program_id.as_ref(), mint.key.as_ref(), &[bump]]],
    )?;
    metadata.try_borrow_mut_data()?.copy_from_slice(data);
    Ok(())
}
fn metaplex_entry(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let a: &[AccountInfo] = unsafe { std::mem::transmute(a) };
    mock_metaplex(p, a, d)
}

#[tokio::test]
async fn launch_trade_and_perps_end_to_end() {
    let mut env = setup().await;
    let authority = env.authority.insecure_clone();
    let creator = Keypair::new();
    let trader = Keypair::new();
    let keeper = Keypair::new();
    let lp = Keypair::new();
    // The relayer pays the trader's order rent; the trader's account holds no SOL beyond fees.
    let sponsor = Keypair::new();
    for k in [creator.pubkey(), trader.pubkey(), keeper.pubkey(), lp.pubkey(), sponsor.pubkey()] {
        env.fund(k, 50 * SOL).await;
    }

    // --- USDC test mint -----------------------------------------------------
    let usdc = env.usdc_mint.insecure_clone();
    let rent = env.ctx.banks_client.get_rent().await.unwrap();
    let payer = env.ctx.payer.pubkey();
    env.send(
        &[
            system_instruction::create_account(&payer, &usdc.pubkey(), rent.minimum_balance(82), 82, &spl_token::ID),
            spl_token::instruction::initialize_mint(&spl_token::ID, &usdc.pubkey(), &authority.pubkey(), None, 6).unwrap(),
        ],
        &[&usdc],
    )
    .await
    .unwrap();

    // --- Launch program ------------------------------------------------------
    let (global, _) = Pubkey::find_program_address(&[launch::SEED_GLOBAL], &launch::ID);
    env.send(
        &[Instruction {
            program_id: launch::ID,
            accounts: launch::accounts::InitializeGlobal { authority: authority.pubkey(), global, system_program: system_program::ID }
                .to_account_metas(None),
            data: launch::instruction::InitializeGlobal {
                params: launch::GlobalParams {
                    fee_recipient: env.fee_recipient,
                    insurance_recipient: env.insurance,
                    migration_authority: env.migration,
                    launch_fee_lamports: SOL / 50,
                    graduation_fee_lamports: 3 * SOL / 2,
                    protocol_fee_bps: 50,
                    creator_fee_bps: 30,
                    insurance_fee_bps: 20,
                },
            }
            .data(),
        }],
        &[&authority],
    )
    .await
    .unwrap();

    let mint = Keypair::new();
    let (curve, _) = Pubkey::find_program_address(&[launch::SEED_CURVE, mint.pubkey().as_ref()], &launch::ID);
    let (dev_lock, _) = Pubkey::find_program_address(&[launch::SEED_DEV_LOCK, mint.pubkey().as_ref()], &launch::ID);
    let curve_vault = get_associated_token_address(&curve, &mint.pubkey());
    let fee_before = env.ctx.banks_client.get_balance(env.fee_recipient).await.unwrap();
    env.send(
        &[Instruction {
            program_id: launch::ID,
            accounts: launch::accounts::CreateToken {
                creator: creator.pubkey(),
                global,
                mint: mint.pubkey(),
                curve,
                curve_token_vault: curve_vault,
                dev_lock_vault: dev_lock,
                fee_recipient: env.fee_recipient,
                insurance_recipient: env.insurance,
                metadata: launch::metaplex::metadata_address(&mint.pubkey()), token_metadata_program: launch::metaplex::PROGRAM, token_program: spl_token::ID,
                associated_token_program: spl_associated_token_account::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: launch::instruction::CreateToken {
                args: launch::CreateTokenArgs {
                    name: "Night Moth".into(),
                    symbol: "MOTH".into(),
                    uri: "https://example.com/moth.json".into(),
                    dev_buy_lamports: SOL / 2,
                },
            }
            .data(),
        }],
        &[&creator, &mint],
    )
    .await
    .unwrap();
    let meta = env.ctx.banks_client.get_account(launch::metaplex::metadata_address(&mint.pubkey())).await.unwrap().expect("metadata created");
    assert_eq!(meta.owner, launch::metaplex::PROGRAM);
    assert_eq!(meta.data, launch::metaplex::create_v3_data("Night Moth", "MOTH", "https://example.com/moth.json"), "name, symbol, uri; immutable");

    let c: launch::Curve = env.get(curve).await;
    assert!(c.dev_locked_tokens > 0 && c.dev_locked_tokens < launch::MAX_DEV_BUY_TOKENS);
    assert_eq!(env.token_balance(dev_lock).await, c.dev_locked_tokens);
    let mint_acc = env.ctx.banks_client.get_account(mint.pubkey()).await.unwrap().unwrap();
    let mint_state = spl_token::state::Mint::unpack(&mint_acc.data).unwrap();
    assert!(mint_state.mint_authority.is_none(), "mint authority revoked");
    assert_eq!(mint_state.supply, launch::TOTAL_SUPPLY);
    let fee_after = env.ctx.banks_client.get_balance(env.fee_recipient).await.unwrap();
    assert!(fee_after - fee_before >= SOL / 50, "launch fee paid");

    // Trader buys 5 SOL on the curve.
    let trader_tokens = get_associated_token_address(&trader.pubkey(), &mint.pubkey());
    let (fee_recipient, insurance, mint_key) = (env.fee_recipient, env.insurance, mint.pubkey());
    let trade_accounts = move |who: Pubkey, who_ata: Pubkey| launch::accounts::Trade {
        trader: who,
        global,
        mint: mint_key,
        curve,
        curve_token_vault: curve_vault,
        trader_token_account: who_ata,
        fee_recipient,
        insurance_recipient: insurance,
        token_program: spl_token::ID,
        associated_token_program: spl_associated_token_account::ID,
        system_program: system_program::ID,
    };
    env.send(
        &[Instruction {
            program_id: launch::ID,
            accounts: trade_accounts(trader.pubkey(), trader_tokens).to_account_metas(None),
            data: launch::instruction::Buy { sol_in: 5 * SOL, min_tokens_out: 1 }.data(),
        }],
        &[&trader],
    )
    .await
    .unwrap();
    let bought = env.token_balance(trader_tokens).await;
    assert!(bought > 100_000_000 * launch::ONE_TOKEN, "got {bought}");
    let c: launch::Curve = env.get(curve).await;
    let curve_lamports = env.ctx.banks_client.get_balance(curve).await.unwrap();
    assert!(curve_lamports >= c.real_sol + c.creator_fees_owed, "curve account holds the SOL it owes");

    // --- Perps vault and market ------------------------------------------------
    let (vault, _) = Pubkey::find_program_address(&[perps::SEED_VAULT], &perps::ID);
    let (vault_usdc, _) = Pubkey::find_program_address(&[perps::SEED_VAULT_USDC], &perps::ID);
    env.send(
        &[
            Instruction {
                program_id: perps::ID,
                accounts: perps::accounts::InitializeVault {
                    authority: authority.pubkey(),
                    vault,
                    usdc_mint: usdc.pubkey(),
                    vault_usdc,
                    token_program: spl_token::ID,
                    system_program: system_program::ID,
                }
                .to_account_metas(None),
                data: perps::instruction::InitializeVault { price_authority: authority.pubkey() }.data(),
            },
            Instruction {
                program_id: perps::ID,
                accounts: perps::accounts::SetSolPrice { price_authority: authority.pubkey(), vault }.to_account_metas(None),
                data: perps::instruction::SetSolPrice { price_e6: 150 * USDC }.data(),
            },
        ],
        &[&authority],
    )
    .await
    .unwrap();

    let lp_usdc = env.usdc_account(&lp.pubkey(), 10_000 * USDC).await;
    let (lp_acc, _) = Pubkey::find_program_address(&[perps::SEED_LP, lp.pubkey().as_ref()], &perps::ID);
    env.send(
        &[Instruction {
            program_id: perps::ID,
            accounts: perps::accounts::Liquidity {
                owner: lp.pubkey(),
                vault,
                vault_usdc,
                lp: lp_acc,
                owner_usdc: lp_usdc,
                token_program: spl_token::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: perps::instruction::DepositLiquidity { amount: 10_000 * USDC }.data(),
        }],
        &[&lp],
    )
    .await
    .unwrap();
    assert_eq!(env.token_balance(vault_usdc).await, 10_000 * USDC);

    let (market, _) = Pubkey::find_program_address(&[perps::SEED_MARKET, mint.pubkey().as_ref()], &perps::ID);
    let (registry, _) = Pubkey::find_program_address(&[perps::SEED_REGISTRY], &perps::ID);
    env.send(
        &[Instruction {
            program_id: perps::ID,
            accounts: perps::accounts::CreateMarket { payer: keeper.pubkey(), curve, market, registry, system_program: system_program::ID }
                .to_account_metas(None),
            data: perps::instruction::CreateMarket {}.data(),
        }],
        &[&keeper],
    )
    .await
    .unwrap();

    // Tier 0 cap: 1% of virtual SOL x $150. ~35.4 vSOL -> ~$53 per side.
    let c: launch::Curve = env.get(curve).await;
    let cap = (c.virtual_sol as u128 * 150 * USDC as u128 / SOL as u128 / 100) as u64;
    assert!(cap > 50 * USDC && cap < 56 * USDC, "cap {cap}");

    // --- Trader opens a long --------------------------------------------------
    let trader_usdc = env.usdc_account(&trader.pubkey(), 100 * USDC).await;
    let keeper_usdc = env.usdc_account(&keeper.pubkey(), 0).await;
    let (position, _) = Pubkey::find_program_address(
        &[perps::SEED_POSITION, trader.pubkey().as_ref(), market.as_ref(), &[perps::SIDE_LONG]],
        &perps::ID,
    );
    let (order, _) = Pubkey::find_program_address(
        &[perps::SEED_ORDER, trader.pubkey().as_ref(), market.as_ref(), &[perps::SIDE_LONG]],
        &perps::ID,
    );
    let request = |kind: u8, collateral: u64, size: u64| Instruction {
        program_id: perps::ID,
        accounts: perps::accounts::RequestOrder {
            owner: trader.pubkey(),
            payer: sponsor.pubkey(),
            vault,
            vault_usdc,
            market,
            position,
            order,
            owner_usdc: trader_usdc,
            token_program: spl_token::ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: perps::instruction::RequestOrder {
            args: perps::OrderArgs { side: perps::SIDE_LONG, kind, collateral, size_usd: size, acceptable_price_q64: 0 },
        }
        .data(),
    };
    let execute = Instruction {
        program_id: perps::ID,
        accounts: perps::accounts::ExecuteOrder {
            keeper: keeper.pubkey(),
            vault,
            vault_usdc,
            market,
            curve,
            rent_payer: sponsor.pubkey(),
            order,
            position,
            owner_usdc: trader_usdc,
            keeper_usdc,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
        data: perps::instruction::ExecuteOrder {}.data(),
    };

    // Too big for one account (20% of ~$53 = ~$10.6): rejected at fill.
    env.send(&[request(perps::ORDER_INCREASE, 11 * USDC, 20 * USDC)], &[&trader, &sponsor]).await.unwrap();
    env.warp(5).await;
    let err = env.send(&[execute.clone()], &[&keeper]).await.unwrap_err();
    assert_eq!(custom_error(err), perps::PerpsError::AccountCap as u32 + 6000);
    // Owner cancels after expiry and gets the collateral back.
    env.warp(perps::ORDER_EXPIRY_SLOTS + 1).await;
    env.send(
        &[Instruction {
            program_id: perps::ID,
            accounts: perps::accounts::CancelOrder {
                owner: trader.pubkey(),
                vault,
                vault_usdc,
                rent_payer: sponsor.pubkey(),
                order,
                owner_usdc: trader_usdc,
                token_program: spl_token::ID,
            }
            .to_account_metas(None),
            data: perps::instruction::CancelOrder {}.data(),
        }],
        &[&trader],
    )
    .await
    .unwrap();
    assert_eq!(env.token_balance(trader_usdc).await, 100 * USDC);

    // A $10 long at ~2x (collateral covers the fee too): fills only after the delay.
    let sponsor_before = env.ctx.banks_client.get_balance(sponsor.pubkey()).await.unwrap();
    env.send(&[request(perps::ORDER_INCREASE, 5_100_000, 10 * USDC)], &[&trader, &sponsor]).await.unwrap();
    let err = env.send(&[execute.clone()], &[&keeper]).await.unwrap_err();
    assert_eq!(custom_error(err), perps::PerpsError::TooEarly as u32 + 6000);
    env.warp(3).await;
    env.send(&[execute.clone()], &[&keeper]).await.unwrap();
    // The order's rent came back to the sponsor; only the position's rent stays spent.
    let sponsor_after = env.ctx.banks_client.get_balance(sponsor.pubkey()).await.unwrap();
    assert_eq!(sponsor_after, sponsor_before, "position rent was paid on the first request, order rent refunded");

    let p: perps::Position = env.get(position).await;
    assert_eq!(p.size_usd, 10 * USDC);
    assert_eq!(p.collateral, 5_100_000 - 30_000); // minus 0.30% fee
    let m: perps::Market = env.get(market).await;
    assert_eq!(m.oi_long, 10 * USDC);
    assert_eq!(env.token_balance(keeper_usdc).await, 3_000); // half of the 20% protocol share

    // Healthy positions can't be liquidated.
    let liq = Instruction {
        program_id: perps::ID,
        accounts: perps::accounts::Liquidate {
            keeper: keeper.pubkey(),
            vault,
            vault_usdc,
            market,
            curve,
            position,
            owner_usdc: trader_usdc,
            keeper_usdc,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
        data: perps::instruction::Liquidate {}.data(),
    };
    let err = env.send(&[liq.clone()], &[&keeper]).await.unwrap_err();
    assert_eq!(custom_error(err), perps::PerpsError::Healthy as u32 + 6000);

    // --- Close ------------------------------------------------------------------
    env.warp(10).await;
    env.send(&[request(perps::ORDER_CLOSE, 0, 0)], &[&trader, &sponsor]).await.unwrap();
    env.warp(3).await;
    let before = env.token_balance(trader_usdc).await;
    env.send(&[execute.clone()], &[&keeper]).await.unwrap();
    let after = env.token_balance(trader_usdc).await;
    let payout = after - before;
    // Price barely moved: payout is collateral minus the close fee, give or take PnL.
    assert!(payout > 4_950_000 && payout < 5_200_000, "payout {payout}");
    let p: perps::Position = env.get(position).await;
    assert_eq!(p.size_usd, 0);
    let m: perps::Market = env.get(market).await;
    assert_eq!(m.oi_long, 0);
    let v: perps::Vault = env.get(vault).await;
    assert_eq!(v.trader_collateral, 0, "no collateral left stranded");
    // Vault balance = LP deposit + fees kept; nothing lost to rounding.
    let bal = env.token_balance(vault_usdc).await;
    let keeper_got = env.token_balance(keeper_usdc).await;
    assert_eq!(bal + payout + keeper_got, 10_000 * USDC + 5_100_000, "USDC is conserved");

    // --- Skew cap, then a crash and a liquidation -----------------------------
    // A whale buys 20 SOL, which also raises the cap (it scales with virtual SOL).
    let whale = Keypair::new();
    env.fund(whale.pubkey(), 50 * SOL).await;
    let whale_tokens = get_associated_token_address(&whale.pubkey(), &mint.pubkey());
    env.send(
        &[Instruction {
            program_id: launch::ID,
            accounts: trade_accounts(whale.pubkey(), whale_tokens).to_account_metas(None),
            data: launch::instruction::Buy { sol_in: 20 * SOL, min_tokens_out: 1 }.data(),
        }],
        &[&whale],
    )
    .await
    .unwrap();
    let crank = Instruction {
        program_id: perps::ID,
        accounts: perps::accounts::CrankFunding { vault, market, curve }.to_account_metas(None),
        data: perps::instruction::CrankFunding {}.data(),
    };
    // Let the band catch up with the new price: a 2.5x move at 15% per
    // window takes ~7 windows (~35 minutes), and new positions wait until then.
    for _ in 0..8 {
        env.warp(perps::TWAP_WINDOW_SLOTS + 10).await;
        env.send(&[crank.clone()], &[]).await.unwrap();
    }
    env.send(&[Instruction {
        program_id: perps::ID,
        accounts: perps::accounts::SetSolPrice { price_authority: authority.pubkey(), vault }.to_account_metas(None),
        data: perps::instruction::SetSolPrice { price_e6: 150 * USDC }.data(),
    }], &[&authority]).await.unwrap();

    // Trader goes long $10 again.
    env.send(&[request(perps::ORDER_INCREASE, 5_100_000, 10 * USDC)], &[&trader, &sponsor]).await.unwrap();
    env.warp(3).await;
    env.send(&[execute.clone()], &[&keeper]).await.unwrap();

    // A second account adds $12 long: the vault would be net long $22,
    // above 25% of the ~$82 cap, so the skew cap stops it.
    let t2 = Keypair::new();
    env.fund(t2.pubkey(), 5 * SOL).await;
    let t2_usdc = env.usdc_account(&t2.pubkey(), 100 * USDC).await;
    let (pos2, _) = Pubkey::find_program_address(&[perps::SEED_POSITION, t2.pubkey().as_ref(), market.as_ref(), &[perps::SIDE_LONG]], &perps::ID);
    let (ord2, _) = Pubkey::find_program_address(&[perps::SEED_ORDER, t2.pubkey().as_ref(), market.as_ref(), &[perps::SIDE_LONG]], &perps::ID);
    env.send(&[Instruction {
        program_id: perps::ID,
        accounts: perps::accounts::RequestOrder { owner: t2.pubkey(), payer: t2.pubkey(), vault, vault_usdc, market, position: pos2, order: ord2, owner_usdc: t2_usdc, token_program: spl_token::ID, system_program: system_program::ID }.to_account_metas(None),
        data: perps::instruction::RequestOrder { args: perps::OrderArgs { side: perps::SIDE_LONG, kind: perps::ORDER_INCREASE, collateral: 7 * USDC, size_usd: 12 * USDC, acceptable_price_q64: 0 } }.data(),
    }], &[&t2]).await.unwrap();
    env.warp(3).await;
    let err = env.send(&[Instruction {
        program_id: perps::ID,
        accounts: perps::accounts::ExecuteOrder { keeper: keeper.pubkey(), vault, vault_usdc, market, curve, rent_payer: t2.pubkey(), order: ord2, position: pos2, owner_usdc: t2_usdc, keeper_usdc, token_program: spl_token::ID }.to_account_metas(None),
        data: perps::instruction::ExecuteOrder {}.data(),
    }], &[&keeper]).await.unwrap_err();
    assert_eq!(custom_error(err), perps::PerpsError::SkewCap as u32 + 6000);

    // The whale dumps everything. Spot crashes at once; the mark can only
    // follow 15% per window, so liquidation waits for the band to move.
    let whale_bal = env.token_balance(whale_tokens).await;
    env.send(&[Instruction {
        program_id: launch::ID,
        accounts: trade_accounts(whale.pubkey(), whale_tokens).to_account_metas(None),
        data: launch::instruction::Sell { tokens_in: whale_bal, min_sol_out: 1 }.data(),
    }], &[&whale]).await.unwrap();
    env.warp(3).await;
    let err = env.send(&[liq.clone()], &[&keeper]).await.unwrap_err();
    assert_eq!(custom_error(err), perps::PerpsError::Healthy as u32 + 6000, "no instant liquidation on a spot wick");

    let mut liquidated = false;
    for _ in 0..10 {
        env.warp(perps::TWAP_WINDOW_SLOTS + 10).await;
        env.send(&[crank.clone()], &[]).await.unwrap();
        if env.send(&[liq.clone()], &[&keeper]).await.is_ok() {
            liquidated = true;
            break;
        }
    }
    assert!(liquidated, "position liquidated once the mark caught up");
    let p: perps::Position = env.get(position).await;
    assert_eq!(p.size_usd, 0);
    let m: perps::Market = env.get(market).await;
    assert_eq!(m.oi_long, 0);
    assert!(m.insurance > 0, "leftover equity went to the market's insurance");
    let v: perps::Vault = env.get(vault).await;
    assert_eq!(v.trader_collateral, 7 * USDC, "only t2's escrowed order collateral remains");

    // --- LP withdrawal: request, 24 h wait, then paid at the vault's value then ---
    let (request, _) = Pubkey::find_program_address(&[perps::SEED_WITHDRAWAL, lp.pubkey().as_ref()], &perps::ID);
    let lp_state: perps::LpAccount = env.get(lp_acc).await;
    let half = lp_state.shares / 2;
    let req_ix = Instruction {
        program_id: perps::ID,
        accounts: perps::accounts::RequestWithdrawal { owner: lp.pubkey(), lp: lp_acc, request, system_program: system_program::ID }.to_account_metas(None),
        data: perps::instruction::RequestWithdrawal { shares: half }.data(),
    };
    env.send(&[req_ix], &[&lp]).await.unwrap();
    let v_before: perps::Vault = env.get(vault).await;
    let lp_after_req: perps::LpAccount = env.get(lp_acc).await;
    assert_eq!(lp_after_req.shares, lp_state.shares - half, "requested shares leave the LP account");
    assert_eq!(v_before.total_shares, lp_state.shares, "but stay in the vault's share count, sharing PnL");
    let withdraw = Instruction {
        program_id: perps::ID,
        accounts: perps::accounts::CompleteWithdrawal {
            owner: lp.pubkey(), vault, vault_usdc, request, owner_usdc: lp_usdc, token_program: spl_token::ID,
        }.to_account_metas(None),
        data: perps::instruction::WithdrawLiquidity {}.data(),
    };
    let err = env.send(&[withdraw.clone()], &[&lp]).await.unwrap_err();
    assert_eq!(custom_error(err), perps::PerpsError::WithdrawalLocked as u32 + 6000, "no instant withdrawal");
    env.advance_clock(perps::WITHDRAW_DELAY_SECONDS + 1).await;
    env.warp(2).await;
    let vault_bal = env.token_balance(vault_usdc).await;
    let expected = (half as u128 * perps::lp_assets(&v_before, vault_bal) as u128 / v_before.total_shares as u128) as u64;
    let usdc_before = env.token_balance(lp_usdc).await;
    env.send(&[withdraw], &[&lp]).await.unwrap();
    assert_eq!(env.token_balance(lp_usdc).await - usdc_before, expected, "paid at the vault's value at completion");
    assert!(env.ctx.banks_client.get_account(request).await.unwrap().is_none(), "request closed, rent back");
    let v_after: perps::Vault = env.get(vault).await;
    assert_eq!(v_after.total_shares, lp_state.shares - half);

    // --- Tier 0 registry: the market holds a slot until it graduates or is retired ---
    let reg: perps::Registry = env.get(registry).await;
    assert_eq!((reg.live_tier0, reg.max_live_tier0), (1, perps::DEFAULT_MAX_LIVE_TIER0));
    let (retired, _) = Pubkey::find_program_address(&[perps::SEED_RETIRED, market.as_ref()], &perps::ID);
    let retire = Instruction {
        program_id: perps::ID,
        accounts: perps::accounts::RetireMarket { payer: keeper.pubkey(), market, curve, registry, retired, system_program: system_program::ID }.to_account_metas(None),
        data: perps::instruction::RetireMarket {}.data(),
    };
    let err = env.send(&[retire.clone()], &[&keeper]).await.unwrap_err();
    assert_eq!(custom_error(err), perps::PerpsError::NotRetirable as u32 + 6000, "the curve traded recently");
    env.warp(perps::RETIRE_IDLE_SLOTS).await;
    env.send(&[retire.clone()], &[&keeper]).await.unwrap();
    let reg: perps::Registry = env.get(registry).await;
    assert_eq!(reg.live_tier0, 0, "slot freed");
    let m: perps::Market = env.get(market).await;
    assert!(m.reduce_only, "retired market is reduce-only");
    env.warp(1).await;
    assert!(env.send(&[retire], &[&keeper]).await.is_err(), "retires once");

    // The admin can lower the limit; a full registry refuses new markets.
    env.send(&[Instruction {
        program_id: perps::ID,
        accounts: perps::accounts::SetMarketLimit { authority: authority.pubkey(), vault, registry }.to_account_metas(None),
        data: perps::instruction::SetMarketLimit { max_live_tier0: 1 }.data(),
    }], &[&authority]).await.unwrap();
    let reg: perps::Registry = env.get(registry).await;
    assert_eq!(reg.max_live_tier0, 1);

    // --- Protocol fees: the treasury can claim some as cash (admin only), and
    // anyone can compound the rest into treasury-owned vault liquidity ---
    let v0: perps::Vault = env.get(vault).await;
    assert!(v0.protocol_fees > 1, "trades earned protocol fees");
    let treasury_usdc = env.usdc_account(&authority.pubkey(), 0).await;
    let cash = v0.protocol_fees / 2;
    let claim = |who: &Keypair, to: Pubkey, amount: u64| Instruction {
        program_id: perps::ID,
        accounts: perps::accounts::ClaimProtocolFees { authority: who.pubkey(), vault, vault_usdc, treasury_usdc: to, token_program: spl_token::ID }.to_account_metas(None),
        data: perps::instruction::ClaimProtocolFees { amount }.data(),
    };
    let stranger = Keypair::new();
    env.fund(stranger.pubkey(), SOL).await;
    let stranger_usdc = env.usdc_account(&stranger.pubkey(), 0).await;
    assert!(env.send(&[claim(&stranger, stranger_usdc, cash)], &[&stranger]).await.is_err(), "only the admin claims fees as cash");
    env.send(&[claim(&authority, treasury_usdc, cash)], &[&authority]).await.unwrap();
    assert_eq!(env.token_balance(treasury_usdc).await, cash);

    // The treasury is its own key (on mainnet the multisig's vault), set by the admin.
    let treasury = Keypair::new();
    let (treasury_config, _) = Pubkey::find_program_address(&[perps::SEED_TREASURY], &perps::ID);
    let set_treasury = |who: &Keypair| Instruction {
        program_id: perps::ID,
        accounts: perps::accounts::SetTreasury { authority: who.pubkey(), vault, treasury_config, system_program: system_program::ID }.to_account_metas(None),
        data: perps::instruction::SetTreasury { treasury: treasury.pubkey() }.data(),
    };
    assert!(env.send(&[set_treasury(&stranger)], &[&stranger]).await.is_err(), "only the admin names the treasury");
    env.send(&[set_treasury(&authority)], &[&authority]).await.unwrap();
    let (treasury_lp, _) = Pubkey::find_program_address(&[perps::SEED_LP, treasury.pubkey().as_ref()], &perps::ID);

    let v1: perps::Vault = env.get(vault).await;
    let bal1 = env.token_balance(vault_usdc).await;
    let price1 = perps::lp_assets(&v1, bal1) as f64 / v1.total_shares as f64;
    let compound = |lp: Pubkey| Instruction {
        program_id: perps::ID,
        accounts: perps::accounts::CompoundProtocolFees { payer: stranger.pubkey(), vault, vault_usdc, treasury_config, treasury_lp: lp, system_program: system_program::ID }.to_account_metas(None),
        data: perps::instruction::CompoundProtocolFees {}.data(),
    };
    env.send(&[compound(treasury_lp)], &[&stranger]).await.unwrap();
    let v2: perps::Vault = env.get(vault).await;
    let tlp: perps::LpAccount = env.get(treasury_lp).await;
    assert_eq!(v2.protocol_fees, 0, "all remaining fees compounded");
    assert_eq!(tlp.owner, treasury.pubkey(), "shares belong to the treasury, whoever called");
    assert_eq!(v2.total_shares, v1.total_shares + tlp.shares);
    let price2 = perps::lp_assets(&v2, bal1) as f64 / v2.total_shares as f64;
    assert!((price2 / price1 - 1.0).abs() < 1e-6, "existing LPs neither gain nor lose: {price1} vs {price2}");
    // A payer can't redirect the shares to its own LP account.
    env.warp(1).await;
    let (own_lp, _) = Pubkey::find_program_address(&[perps::SEED_LP, stranger.pubkey().as_ref()], &perps::ID);
    assert!(env.send(&[compound(own_lp)], &[&stranger]).await.is_err());

    // A hot key deposits USDC for the treasury: the shares go to the treasury, not the depositor.
    let sweeper = Keypair::new();
    env.fund(sweeper.pubkey(), SOL).await;
    let sweeper_usdc = env.usdc_account(&sweeper.pubkey(), 3 * USDC).await;
    let deposit = |lp: Pubkey, amount: u64| Instruction {
        program_id: perps::ID,
        accounts: perps::accounts::DepositToTreasury { depositor: sweeper.pubkey(), vault, vault_usdc, treasury_config, treasury_lp: lp, depositor_usdc: sweeper_usdc, token_program: spl_token::ID, system_program: system_program::ID }.to_account_metas(None),
        data: perps::instruction::DepositToTreasury { amount }.data(),
    };
    let (sweeper_lp, _) = Pubkey::find_program_address(&[perps::SEED_LP, sweeper.pubkey().as_ref()], &perps::ID);
    assert!(env.send(&[deposit(sweeper_lp, USDC)], &[&sweeper]).await.is_err(), "can't deposit into its own LP this way");
    let before: perps::LpAccount = env.get(treasury_lp).await;
    env.send(&[deposit(treasury_lp, 3 * USDC)], &[&sweeper]).await.unwrap();
    let after: perps::LpAccount = env.get(treasury_lp).await;
    assert!(after.shares > before.shares, "treasury got the shares");
    assert_eq!(env.token_balance(sweeper_usdc).await, 0);
    let v3: perps::Vault = env.get(vault).await;
    let price3 = perps::lp_assets(&v3, env.token_balance(vault_usdc).await) as f64 / v3.total_shares as f64;
    assert!((price3 / price2 - 1.0).abs() < 1e-6, "deposit at the share price: {price2} vs {price3}");

    // --- Admin market limits (e.g. keep perps off the protocol's own token) ---
    let limits = |cap: u64, ro: bool| Instruction {
        program_id: perps::ID,
        accounts: perps::accounts::AdminMarket { authority: authority.pubkey(), vault, market, curve }.to_account_metas(None),
        data: perps::instruction::SetMarketLimits { oi_cap_override: cap, reduce_only: ro }.data(),
    };
    env.send(&[limits(5 * USDC, false)], &[&authority]).await.unwrap();
    let m: perps::Market = env.get(market).await;
    assert_eq!((m.oi_cap_override, m.reduce_only), (5 * USDC, false));
    env.warp(1).await;
    env.send(&[limits(0, true)], &[&authority]).await.unwrap();
    let m: perps::Market = env.get(market).await;
    assert!(m.reduce_only);

    // --- Admin handover to a multisig: propose, then the successor accepts ---
    let multisig = Keypair::new();
    env.fund(multisig.pubkey(), SOL).await;
    let (perps_pending, _) = Pubkey::find_program_address(&[perps::SEED_PENDING_AUTHORITY], &perps::ID);
    let (launch_pending, _) = Pubkey::find_program_address(&[launch::SEED_PENDING_AUTHORITY], &launch::ID);
    let propose_perps = |who: &Keypair| Instruction {
        program_id: perps::ID,
        accounts: perps::accounts::ProposeAuthority { authority: who.pubkey(), vault, pending: perps_pending, system_program: system_program::ID }.to_account_metas(None),
        data: perps::instruction::ProposeAuthority { new_authority: multisig.pubkey() }.data(),
    };
    let accept_perps = |who: &Keypair| Instruction {
        program_id: perps::ID,
        accounts: perps::accounts::AcceptAuthority { new_authority: who.pubkey(), vault, pending: perps_pending }.to_account_metas(None),
        data: perps::instruction::AcceptAuthority {}.data(),
    };
    assert!(env.send(&[propose_perps(&stranger)], &[&stranger]).await.is_err(), "only the admin proposes");
    env.send(&[propose_perps(&authority)], &[&authority]).await.unwrap();
    assert!(env.send(&[accept_perps(&stranger)], &[&stranger]).await.is_err(), "only the proposed key accepts");
    env.send(&[accept_perps(&multisig)], &[&multisig]).await.unwrap();
    let v: perps::Vault = env.get(vault).await;
    assert_eq!(v.authority, multisig.pubkey());
    env.warp(1).await;
    assert!(env.send(&[limits(0, false)], &[&authority]).await.is_err(), "the old admin is out");

    let propose_launch = Instruction {
        program_id: launch::ID,
        accounts: launch::accounts::ProposeAuthority { authority: authority.pubkey(), global, pending: launch_pending, system_program: system_program::ID }.to_account_metas(None),
        data: launch::instruction::ProposeAuthority { new_authority: multisig.pubkey() }.data(),
    };
    env.send(&[propose_launch], &[&authority]).await.unwrap();
    env.send(&[Instruction {
        program_id: launch::ID,
        accounts: launch::accounts::AcceptAuthority { new_authority: multisig.pubkey(), global, pending: launch_pending }.to_account_metas(None),
        data: launch::instruction::AcceptAuthority {}.data(),
    }], &[&multisig]).await.unwrap();
    let g: launch::Global = env.get(global).await;
    assert_eq!(g.authority, multisig.pubkey());
    let _ = (env.migration, dev_lock);
}
