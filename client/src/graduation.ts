/**
 * Graduation helpers: Raydium CPMM addresses for a Ringside token and the
 * permissionless `migrate` (launch program) and `graduate_market` (perps)
 * instructions the keeper sends once a curve sells out.
 *
 * Addresses follow `ringside_launch::raydium`; NETWORK=mainnet switches the
 * Raydium program and config to mainnet.
 */
import {
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  AccountRole,
  type Address,
  type Instruction,
} from "@solana/kit";
import { createHash } from "node:crypto";

const MAINNET = (process.env.NETWORK ?? "devnet") === "mainnet";

export const LAUNCH_PROGRAM = address(process.env.LAUNCH_PROGRAM_ID ?? "AfZWCTaDQEC9CVTwXkH7pFtDXs4RtLWCK5godexWQDVH");
export const PERPS_PROGRAM = address(process.env.PERPS_PROGRAM_ID ?? "DsZ69w3q25nRmAzJCRBMLbwZWN6NyVbYipTWsCAUsg1F");
export const CPMM_PROGRAM = address(MAINNET ? "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C" : "DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb");
export const AMM_CONFIG = address(MAINNET ? "D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2" : "5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy");
export const CREATE_POOL_FEE = address(MAINNET ? "DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8" : "3oE58BKVt8KuYkGxx8zBojugnymWmBiyafWgMrnb6eYy");
export const WSOL_MINT = address("So11111111111111111111111111111111111111112");
export const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ATA_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
export const RENT_SYSVAR = address("SysvarRent111111111111111111111111111111111");

const enc = new TextEncoder();
const bytes = (a: Address) => new Uint8Array(getAddressEncoder().encode(a));
const pda = async (program: Address, seeds: Uint8Array[]) => (await getProgramDerivedAddress({ programAddress: program, seeds }))[0];
export const ixDisc = (name: string) => new Uint8Array(createHash("sha256").update(`global:${name}`).digest().subarray(0, 8));

/** Raydium orders the two mints by their bytes, like Pubkey's Ord in Rust. */
export function orderMints(a: Address, b: Address): [Address, Address] {
  const x = bytes(a), y = bytes(b);
  for (let i = 0; i < 32; i++) if (x[i] !== y[i]) return x[i] < y[i] ? [a, b] : [b, a];
  return [a, b];
}

export async function ata(owner: Address, mint: Address) {
  return pda(ATA_PROGRAM, [bytes(owner), bytes(TOKEN_PROGRAM), bytes(mint)]);
}

export interface PoolAccounts {
  pool: Address;
  observation: Address;
  authority: Address;
  lpMint: Address;
  tokenVault: Address;
  solVault: Address;
  token0: Address;
  token1: Address;
}

export async function poolAccounts(mint: Address): Promise<PoolAccounts> {
  const [token0, token1] = orderMints(mint, WSOL_MINT);
  const pool = await pda(CPMM_PROGRAM, [enc.encode("pool"), bytes(AMM_CONFIG), bytes(token0), bytes(token1)]);
  const vault = (m: Address) => pda(CPMM_PROGRAM, [enc.encode("pool_vault"), bytes(pool), bytes(m)]);
  return {
    pool,
    observation: await pda(CPMM_PROGRAM, [enc.encode("observation"), bytes(pool)]),
    authority: await pda(CPMM_PROGRAM, [enc.encode("vault_and_lp_mint_auth_seed")]),
    lpMint: await pda(CPMM_PROGRAM, [enc.encode("pool_lp_mint"), bytes(pool)]),
    tokenVault: await vault(mint),
    solVault: await vault(WSOL_MINT),
    token0,
    token1,
  };
}

/** The four accounts perps reads a graduated market's price from, in program order. */
export async function priceAccounts(mint: Address) {
  const p = await poolAccounts(mint);
  return [p.pool, p.observation, p.tokenVault, p.solVault].map((a) => ({ address: a, role: AccountRole.READONLY }));
}

const ro = (a: Address) => ({ address: a, role: AccountRole.READONLY });
const w = (a: Address) => ({ address: a, role: AccountRole.WRITABLE });

export async function migrateIx(payer: Address, mint: Address, feeRecipient: Address): Promise<Instruction> {
  const global = await pda(LAUNCH_PROGRAM, [enc.encode("global")]);
  const curve = await pda(LAUNCH_PROGRAM, [enc.encode("curve"), bytes(mint)]);
  const poolCreator = await pda(LAUNCH_PROGRAM, [enc.encode("pool_creator"), bytes(mint)]);
  const p = await poolAccounts(mint);
  const vault = (m: Address) => (m === mint ? p.tokenVault : p.solVault);
  return {
    programAddress: LAUNCH_PROGRAM,
    accounts: [
      { address: payer, role: AccountRole.WRITABLE_SIGNER },
      ro(global), w(curve), w(mint), ro(WSOL_MINT), w(await ata(curve, mint)), w(feeRecipient), w(poolCreator),
      w(await ata(poolCreator, mint)), w(await ata(poolCreator, WSOL_MINT)),
      ro(CPMM_PROGRAM), ro(AMM_CONFIG), ro(p.authority), w(p.pool), w(p.lpMint), w(await ata(poolCreator, p.lpMint)),
      w(vault(p.token0)), w(vault(p.token1)), w(CREATE_POOL_FEE), w(p.observation),
      ro(TOKEN_PROGRAM), ro(ATA_PROGRAM), ro(SYSTEM_PROGRAM), ro(RENT_SYSVAR),
    ],
    data: ixDisc("migrate"),
  };
}

export const registryAddress = () => pda(PERPS_PROGRAM, [enc.encode("registry")]);
const retiredAddress = (market: Address) => pda(PERPS_PROGRAM, [enc.encode("retired"), bytes(market)]);

export async function graduateMarketIx(market: Address, curve: Address, mint: Address): Promise<Instruction> {
  return {
    programAddress: PERPS_PROGRAM,
    accounts: [w(market), ro(curve), w(await registryAddress()), ro(await retiredAddress(market)), ...(await priceAccounts(mint))],
    data: ixDisc("graduate_market"),
  };
}

/** Frees the Tier 0 slot of a launch whose curve hasn't traded for ~7 days (the program checks). */
export async function retireMarketIx(payer: Address, market: Address, curve: Address): Promise<Instruction> {
  return {
    programAddress: PERPS_PROGRAM,
    accounts: [
      { address: payer, role: AccountRole.WRITABLE_SIGNER },
      w(market), ro(curve), w(await registryAddress()), w(await retiredAddress(market)), ro(SYSTEM_PROGRAM),
    ],
    data: ixDisc("retire_market"),
  };
}

// --- Curve decoding -----------------------------------------------------------

export interface CurveState { key: Address; mint: Address; complete: boolean; migrated: boolean; virtualSol: bigint; virtualTokens: bigint; realSol: bigint }

/** Curve: disc | mint | creator | name | symbol | uri (borsh strings) | virtual_sol | virtual_tokens | real_sol | real_tokens | fees | dev_locked | dev_unlock_ts | complete | migrated … */
export function decodeCurve(key: Address, d: Uint8Array): CurveState {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const mint = addressAt(d, 8);
  let o = 8 + 64;
  for (let i = 0; i < 3; i++) o += 4 + v.getUint32(o, true);
  const virtualSol = v.getBigUint64(o, true), virtualTokens = v.getBigUint64(o + 8, true), realSol = v.getBigUint64(o + 16, true);
  o += 8 * 7;
  return { key, mint, virtualSol, virtualTokens, realSol, complete: d[o] !== 0, migrated: d[o + 1] !== 0 };
}

/** Global: disc | authority | fee_recipient | … */
export const decodeFeeRecipient = (d: Uint8Array) => addressAt(d, 8 + 32);

function addressAt(d: Uint8Array, o: number): Address {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const b = d.subarray(o, o + 32);
  let n = BigInt("0x" + Buffer.from(b).toString("hex"));
  let s = "";
  while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  for (const byte of b) { if (byte === 0) s = "1" + s; else break; }
  return address(s);
}
