/**
 * Order-instruction builder: `request_order` (lib.rs:306-346) for open, increase and close.
 * Accounts are laid out in the IDL's order with the IDL's signer/writable flags, matching what
 * Anchor's `.accountsPartial(...).instruction()` produced in the app. Open and increase are the
 * same on-chain order (kind 0); close is kind 1 (full close; size and collateral are ignored).
 */
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { BN, type Idl } from "./anchor.js";
import { perpsCoders, type PerpsCoders } from "./accounts.js";
import { BPS, DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS, ORDER_CLOSE, ORDER_INCREASE, SIDE_LONG } from "./math.js";
import { marketPda, orderPda, positionPda, vaultPda, vaultUsdcPda } from "./pda.js";

export type OrderAction = "open" | "increase" | "close";
export interface OrderParams {
  idl: Idl;
  action: OrderAction;
  /** Position owner and USDC payer; signs. */
  trader: PublicKey;
  /** Market, by mint (the market PDA is derived). */
  mint: PublicKey;
  side: 0 | 1;
  /** Rent payer for the order and first-time position; signs. Defaults to the trader. A relayer goes here. */
  payer?: PublicKey;
  usdcMint: PublicKey;
  /** USDC base units (6 dp). Required for open and increase, ignored for close. */
  collateral?: bigint;
  /** Notional in USDC base units. Required for open and increase, ignored for close. */
  sizeUsd?: bigint;
  /**
   * Slippage bound. Either an explicit `acceptablePriceQ64`, or a reference price (Q64 lamports per base unit)
   * plus slippage in bps. One of the two is required: the program refuses an order whose acceptable price is 0
   * (`AcceptablePriceRequired`), because an unbounded order can be filled by anyone at any price. Direction follows the program
   * (lib.rs:382-387): an increase long or a close short caps the price; an increase short or a close long floors it.
   */
  acceptablePriceQ64?: bigint;
  referencePriceQ64?: bigint;
  slippageBps?: number;
  coders?: PerpsCoders;
}

const U64 = (1n << 64n) - 1n, U128 = (1n << 128n) - 1n;

/** The acceptable price for a slippage bound, from a Q64 reference. */
export function acceptablePrice(side: 0 | 1, action: OrderAction, referenceQ64: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) throw new Error("slippageBps must be an integer 0..10000");
  if (referenceQ64 <= 0n) throw new Error("reference price must be positive");
  const cap = (action !== "close") === (side === SIDE_LONG);
  const v = cap ? (referenceQ64 * (BPS + BigInt(slippageBps))) / BPS : (referenceQ64 * (BPS - BigInt(slippageBps))) / BPS;
  return v < 1n ? 1n : v;
}

export function buildOrderInstruction(p: OrderParams): TransactionInstruction {
  if (p.side !== 0 && p.side !== 1) throw new Error("side must be 0 (long) or 1 (short)");
  const close = p.action === "close";
  const collateral = close ? 0n : p.collateral ?? 0n, sizeUsd = close ? 0n : p.sizeUsd ?? 0n;
  if (!close && (collateral <= 0n || sizeUsd <= 0n)) throw new Error("open/increase needs positive collateral and sizeUsd");
  if (collateral < 0n || collateral > U64 || sizeUsd < 0n || sizeUsd > U64) throw new Error("amount out of u64 range");
  let acceptable = p.acceptablePriceQ64 ?? 0n;
  if (p.acceptablePriceQ64 === undefined && p.referencePriceQ64 !== undefined) {
    const bps = p.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
    if (bps > MAX_SLIPPAGE_BPS) throw new Error(`slippage above ${MAX_SLIPPAGE_BPS / 100}% is not offered on perp orders`);
    acceptable = acceptablePrice(p.side, p.action, p.referencePriceQ64, bps);
  }
  if (acceptable <= 0n || acceptable > U128) throw new Error("an order needs a non-zero acceptable price (acceptablePriceQ64, or referencePriceQ64 and slippageBps)");

  const coders = p.coders ?? perpsCoders(p.idl);
  const programId = new PublicKey(p.idl.address);
  const market = marketPda(programId, p.mint);
  const named: Record<string, PublicKey> = {
    owner: p.trader, payer: p.payer ?? p.trader, vault: vaultPda(programId), vault_usdc: vaultUsdcPda(programId), market,
    position: positionPda(programId, p.trader, market, p.side), order: orderPda(programId, p.trader, market, p.side),
    owner_usdc: getAssociatedTokenAddressSync(p.usdcMint, p.trader), token_program: TOKEN_PROGRAM_ID, system_program: SystemProgram.programId,
  };
  const def = p.idl.instructions.find((i) => i.name === "request_order");
  if (!def) throw new Error("IDL has no request_order");
  const keys = def.accounts.map((a) => {
    const acc = a as { name: string; writable?: boolean; signer?: boolean };
    const pubkey = named[acc.name];
    if (!pubkey) throw new Error(`no value for account ${acc.name}`);
    return { pubkey, isSigner: !!acc.signer, isWritable: !!acc.writable };
  });
  const data = coders.instructions.encode("request_order", {
    args: {
      side: p.side, kind: close ? ORDER_CLOSE : ORDER_INCREASE,
      collateral: new BN(collateral.toString()), size_usd: new BN(sizeUsd.toString()), acceptable_price_q64: new BN(acceptable.toString()),
    },
  });
  return new TransactionInstruction({ programId, keys, data });
}
