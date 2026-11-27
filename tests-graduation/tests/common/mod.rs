//! Shared setup for the graduation tests: Ringside + vendored Raydium CPMM running natively.
#![allow(dead_code)]

use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_spl::associated_token::get_associated_token_address;
use solana_program_test::{processor, ProgramTest, ProgramTestContext};
use solana_sdk::{
    account::Account,
    account_info::AccountInfo,
    compute_budget::ComputeBudgetInstruction,
    entrypoint::ProgramResult,
    instruction::Instruction,
    program_pack::Pack,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_instruction, system_program, sysvar,
    transaction::Transaction,
};

use ringside_launch as launch;
use ringside_perps as perps;
use ringside_launch::raydium;

pub const SOL: u64 = 1_000_000_000;

pub fn launch_entry(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let a: &[AccountInfo] = unsafe { std::mem::transmute(a) };
    launch::entry(p, a, d)
}
pub fn perps_entry(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let a: &[AccountInfo] = unsafe { std::mem::transmute(a) };
    perps::entry(p, a, d)
}
pub fn cpmm_entry(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let a: &[AccountInfo] = unsafe { std::mem::transmute(a) };
    raydium_cp_swap::entry(p, a, d)
}

pub fn b64(s: &str) -> Vec<u8> {
    // Small decoder so the test has no extra dependency.
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let (mut buf, mut bits) = (0u32, 0u32);
    for c in s.bytes().filter(|c| *c != b'=') {
        buf = (buf << 6) | T.iter().position(|x| *x == c).unwrap() as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    out
}

/// Live devnet copies (fetched 2026-11-25).
pub const AMM_CONFIG_0: &str = "2vQhaMvLK2/9AAAAxAkAAAAAAADA1AEAAAAAAECcAAAAAAAAgNHwCAAAAAC4mJaRONvzA6sDp2AE1wRgqmmZIOQxnfZ7bFgjjmAnrLiYlpE42/MDqwOnYATXBGCqaZkg5DGd9ntsWCOOYCesxAkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
pub const CREATE_POOL_FEE_DATA: &str = "BpuIV/6rgYT7aH9jRhjANdrEOdwa6ztVmKDwAAAAAAG4mJeWr6vW5z/gclM0sV3uNkK57dEt4kypM71w+PadqUhQxv0KAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAA4thYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

pub async fn send(ctx: &mut ProgramTestContext, ixs: &[Instruction], signers: &[&Keypair]) {
    let payer = ctx.payer.insecure_clone();
    let mut all = vec![&payer];
    all.extend_from_slice(signers);
    let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(ixs, Some(&payer.pubkey()), &all, bh);
    ctx.banks_client.process_transaction(tx).await.unwrap();
}

pub async fn token_amount(ctx: &mut ProgramTestContext, key: Pubkey) -> u64 {
    let acc = ctx.banks_client.get_account(key).await.unwrap().expect("token account");
    spl_token::state::Account::unpack(&acc.data).unwrap().amount
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
pub fn metaplex_entry(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let a: &[AccountInfo] = unsafe { std::mem::transmute(a) };
    mock_metaplex(p, a, d)
}


/// The ProgramData account the upgradeable loader keeps for a deployed program
/// (at the PDA of the program id, owned by the loader), naming `authority` as
/// upgrade authority. The programs run natively in program-test, which creates
/// none of its own; `initialize_*` reads it exactly as on chain.
pub fn program_data_account(authority: Option<Pubkey>) -> Account {
    use solana_sdk::bpf_loader_upgradeable::{self, UpgradeableLoaderState};
    let mut data = bincode::serialize(&UpgradeableLoaderState::ProgramData { slot: 0, upgrade_authority_address: authority }).unwrap();
    data.extend_from_slice(&[0u8; 32]); // stand-in for the ELF bytes
    Account { lamports: 1_000_000_000, data, owner: bpf_loader_upgradeable::id(), executable: false, rent_epoch: 0 }
}
pub fn program_data_of(program_id: Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[program_id.as_ref()], &solana_sdk::bpf_loader_upgradeable::id()).0
}

/// Ringside and Raydium CPMM (devnet addresses and config) on a local bank.
pub fn program_test(authority: &Keypair, fee_recipient: Pubkey) -> ProgramTest {
    let mut pt = ProgramTest::default();
    pt.prefer_bpf(false);
    pt.add_program("ringside_launch", launch::ID, processor!(launch_entry));
    pt.add_program("ringside_perps", perps::ID, processor!(perps_entry));
    pt.add_program("mpl_token_metadata", launch::metaplex::PROGRAM, processor!(metaplex_entry));
    pt.add_program("raydium_cp_swap", raydium::CPMM_PROGRAM, processor!(cpmm_entry));
    pt.add_account(raydium::AMM_CONFIG, Account { lamports: 2_533_440, data: b64(AMM_CONFIG_0), owner: raydium::CPMM_PROGRAM, ..Account::default() });
    pt.add_account(raydium::CREATE_POOL_FEE, Account { lamports: 1_488_440 + 2_246_230_560_840 /* rent reserve + recorded amount */, data: b64(CREATE_POOL_FEE_DATA), owner: spl_token::ID, ..Account::default() });
    let mut native = vec![0u8; spl_token::state::Mint::LEN];
    spl_token::state::Mint { decimals: 9, is_initialized: true, ..Default::default() }.pack_into_slice(&mut native);
    pt.add_account(spl_token::native_mint::ID, Account { lamports: 1_000_000_000, data: native, owner: spl_token::ID, ..Account::default() });
    for k in [authority.pubkey(), fee_recipient] {
        pt.add_account(k, Account { lamports: 10 * SOL, owner: system_program::ID, ..Account::default() });
    }
    for id in [launch::ID, perps::ID] {
        pt.add_account(program_data_of(id), program_data_account(Some(authority.pubkey())));
    }
    pt
}

/// Every account of one token's pool at `pool`.
#[derive(Clone, Copy)]
pub struct PoolKeys {
    pub pool: Pubkey,
    pub authority: Pubkey,
    pub lp_mint: Pubkey,
    pub obs: Pubkey,
    pub t0: Pubkey,
    pub t1: Pubkey,
    pub vault0: Pubkey,
    pub vault1: Pubkey,
    pub tok_vault: Pubkey,
    pub sol_vault: Pubkey,
}
impl PoolKeys {
    pub fn new(pool: Pubkey, mint: Pubkey) -> Self {
        let (t0, t1) = raydium::order(mint, spl_token::native_mint::ID);
        let find = |seeds: &[&[u8]]| Pubkey::find_program_address(seeds, &raydium::CPMM_PROGRAM).0;
        let vault = |t: Pubkey| find(&[raydium::POOL_VAULT_SEED, pool.as_ref(), t.as_ref()]);
        let (vault0, vault1) = (vault(t0), vault(t1));
        let (tok_vault, sol_vault) = if t0 == mint { (vault0, vault1) } else { (vault1, vault0) };
        PoolKeys {
            pool, t0, t1, vault0, vault1, tok_vault, sol_vault,
            authority: find(&[raydium::AUTH_SEED]),
            lp_mint: find(&[raydium::POOL_LP_MINT_SEED, pool.as_ref()]),
            obs: raydium::observation_address(pool),
        }
    }
    /// The four accounts perps reads a graduated market's price from.
    pub fn price_accounts(&self) -> Vec<solana_sdk::instruction::AccountMeta> {
        [self.pool, self.obs, self.tok_vault, self.sol_vault].map(|k| solana_sdk::instruction::AccountMeta::new_readonly(k, false)).to_vec()
    }
}

/// One launched token with its perps market, on a bank with both programs initialized.
pub struct Fx {
    pub ctx: ProgramTestContext,
    pub authority: Keypair,
    pub fee_recipient: Pubkey,
    pub global: Pubkey,
    pub mint: Pubkey,
    pub curve: Pubkey,
    pub curve_vault: Pubkey,
    pub creator: Keypair,
    pub perps_vault: Pubkey,
    pub market: Pubkey,
    pub registry: Pubkey,
    pub retired: Pubkey,
    pub pool_creator: Pubkey,
}

impl Fx {
    pub async fn new() -> Fx {
        let authority = Keypair::new();
        let fee_recipient = Pubkey::new_unique();
        let mut ctx = program_test(&authority, fee_recipient).start_with_context().await;
        let payer = ctx.payer.pubkey();
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
        let (pool_creator, _) = Pubkey::find_program_address(&[launch::SEED_POOL_CREATOR, m.as_ref()], &launch::ID);
        Fx { ctx, authority, fee_recipient, global, mint: m, curve, curve_vault, creator, perps_vault, market, registry, retired, pool_creator }
    }

    pub fn payer(&self) -> Pubkey { self.ctx.payer.pubkey() }

    pub async fn fund(&mut self, to: Pubkey, lamports: u64) {
        let payer = self.payer();
        send(&mut self.ctx, &[system_instruction::transfer(&payer, &to, lamports)], &[]).await;
    }

    /// `trader` buys `sol_in` lamports worth on the curve.
    pub async fn buy(&mut self, trader: &Keypair, sol_in: u64) {
        let ata = get_associated_token_address(&trader.pubkey(), &self.mint);
        send(&mut self.ctx, &[Instruction {
            program_id: launch::ID,
            accounts: launch::accounts::Trade {
                trader: trader.pubkey(), global: self.global, mint: self.mint, curve: self.curve, curve_token_vault: self.curve_vault, trader_token_account: ata,
                fee_recipient: self.fee_recipient, insurance_recipient: self.fee_recipient, token_program: spl_token::ID,
                associated_token_program: spl_associated_token_account::ID, system_program: system_program::ID,
            }.to_account_metas(None),
            data: launch::instruction::Buy { sol_in, min_tokens_out: 1 }.data(),
        }], &[trader]).await;
    }

    /// A fresh buyer sells the curve out.
    pub async fn sell_out(&mut self) -> launch::Curve {
        let buyer = Keypair::new();
        self.fund(buyer.pubkey(), 5 * SOL).await;
        self.buy(&buyer, 3 * SOL).await;
        let c = self.curve_state().await;
        assert!(c.complete, "curve sold out");
        c
    }

    pub async fn curve_state(&mut self) -> launch::Curve {
        let a = self.ctx.banks_client.get_account(self.curve).await.unwrap().unwrap();
        launch::Curve::try_deserialize(&mut a.data.as_slice()).unwrap()
    }
    pub async fn market_state(&mut self) -> perps::Market {
        let a = self.ctx.banks_client.get_account(self.market).await.unwrap().unwrap();
        perps::Market::try_deserialize(&mut a.data.as_slice()).unwrap()
    }

    /// Raydium `initialize` for the token at an arbitrary pool address: what an
    /// outsider can do. `pool` is the canonical address (a plain pool creation, no
    /// signature needed) or any other address that signs.
    pub async fn outsider_creates_pool(&mut self, who: &Keypair, pool_keys: &PoolKeys, pool_signer: Option<&Keypair>) -> Result<(), solana_program_test::BanksClientError> {
        let m = self.mint;
        let wsol = spl_token::native_mint::ID;
        self.fund(who.pubkey(), 2 * SOL).await;
        self.buy(who, SOL / 1000).await;
        let who_ata = get_associated_token_address(&who.pubkey(), &m);
        let who_wsol = get_associated_token_address(&who.pubkey(), &wsol);
        let payer = self.payer();
        send(&mut self.ctx, &[
            spl_associated_token_account::instruction::create_associated_token_account_idempotent(&payer, &who.pubkey(), &wsol, &spl_token::ID),
            system_instruction::transfer(&who.pubkey(), &who_wsol, 1_000_000),
            spl_token::instruction::sync_native(&spl_token::ID, &who_wsol).unwrap(),
        ], &[who]).await;
        let p = pool_keys;
        let (a0, a1) = if p.t0 == m { (who_ata, who_wsol) } else { (who_wsol, who_ata) };
        let mut signers = vec![who];
        if let Some(s) = pool_signer { signers.push(s); }
        self.try_send(&[
            ComputeBudgetInstruction::set_compute_unit_limit(400_000),
            Instruction {
                program_id: raydium::CPMM_PROGRAM,
                accounts: raydium_cp_swap::accounts::Initialize {
                    creator: who.pubkey(), amm_config: raydium::AMM_CONFIG, authority: p.authority, pool_state: p.pool,
                    token_0_mint: p.t0, token_1_mint: p.t1, lp_mint: p.lp_mint, creator_token_0: a0, creator_token_1: a1,
                    creator_lp_token: get_associated_token_address(&who.pubkey(), &p.lp_mint),
                    token_0_vault: p.vault0, token_1_vault: p.vault1, create_pool_fee: raydium::CREATE_POOL_FEE,
                    observation_state: p.obs, token_program: spl_token::ID,
                    token_0_program: spl_token::ID, token_1_program: spl_token::ID,
                    associated_token_program: spl_associated_token_account::ID, system_program: system_program::ID, rent: sysvar::rent::ID,
                }.to_account_metas(None),
                data: raydium_cp_swap::instruction::Initialize { init_amount_0: 1_000_000, init_amount_1: 1_000_000, open_time: 0 }.data(),
            },
        ], &signers).await
    }

    /// The permissionless `migrate` instruction, with the pool the launch program derives.
    pub fn migrate_ix(&self, keeper: Pubkey, p: &PoolKeys) -> Instruction {
        let wsol = spl_token::native_mint::ID;
        Instruction {
            program_id: launch::ID,
            accounts: launch::accounts::Migrate {
                payer: keeper, global: self.global, curve: self.curve, mint: self.mint, wsol_mint: wsol, curve_token_vault: self.curve_vault, fee_recipient: self.fee_recipient,
                pool_creator: self.pool_creator, creator_token: get_associated_token_address(&self.pool_creator, &self.mint),
                creator_wsol: get_associated_token_address(&self.pool_creator, &wsol),
                cpmm_program: raydium::CPMM_PROGRAM, amm_config: raydium::AMM_CONFIG, cpmm_authority: p.authority,
                pool_state: p.pool, lp_mint: p.lp_mint, creator_lp_token: get_associated_token_address(&self.pool_creator, &p.lp_mint),
                token_0_vault: p.vault0, token_1_vault: p.vault1,
                create_pool_fee: raydium::CREATE_POOL_FEE, observation_state: p.obs,
                token_program: spl_token::ID, associated_token_program: spl_associated_token_account::ID,
                system_program: system_program::ID, rent: sysvar::rent::ID,
            }.to_account_metas(None),
            data: launch::instruction::Migrate {}.data(),
        }
    }

    pub async fn try_send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), solana_program_test::BanksClientError> {
        let payer = self.ctx.payer.insecure_clone();
        let mut all = vec![&payer];
        all.extend_from_slice(signers);
        let bh = self.ctx.banks_client.get_latest_blockhash().await.unwrap();
        let tx = Transaction::new_signed_with_payer(ixs, Some(&payer.pubkey()), &all, bh);
        self.ctx.banks_client.process_transaction(tx).await
    }

    /// Migrates as a fresh keeper with a 400k compute budget.
    pub async fn migrate(&mut self, p: &PoolKeys) -> Result<(), solana_program_test::BanksClientError> {
        let keeper = Keypair::new();
        self.fund(keeper.pubkey(), SOL).await;
        let ix = self.migrate_ix(keeper.pubkey(), p);
        self.try_send(&[ComputeBudgetInstruction::set_compute_unit_limit(400_000), ix], &[&keeper]).await
    }

    /// `graduate_market` with `rem` as the remaining accounts.
    pub fn graduate_ix(&self, rem: Vec<solana_sdk::instruction::AccountMeta>) -> Instruction {
        let mut ix = Instruction {
            program_id: perps::ID,
            accounts: perps::accounts::GraduateMarket { market: self.market, curve: self.curve, registry: self.registry, retired: self.retired }.to_account_metas(None),
            data: perps::instruction::GraduateMarket {}.data(),
        };
        ix.accounts.extend(rem);
        ix
    }

    pub fn crank_ix(&self, rem: Vec<solana_sdk::instruction::AccountMeta>) -> Instruction {
        let mut ix = Instruction {
            program_id: perps::ID,
            accounts: perps::accounts::CrankFunding { vault: self.perps_vault, market: self.market, curve: self.curve }.to_account_metas(None),
            data: perps::instruction::CrankFunding {}.data(),
        };
        ix.accounts.extend(rem);
        ix
    }
}
