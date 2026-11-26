/** RPC-backed PerpsPort for the copy builder. Devnet only in practice (see build.ts). */
import { Connection, PublicKey } from "@solana/web3.js";
import { address } from "@solana/kit";
import { decodeCurve, LAUNCH_PROGRAM } from "../graduation.js";
import { decodeMarket, decodePosition, decodeVault, perpsCoders } from "../perps/accounts.js";
import type { Idl } from "../perps/anchor.js";
import { curvePda, marketPda, orderPda, positionPda, vaultPda } from "../perps/pda.js";
import type { PerpsPort } from "./build.js";

/**
 * Reads vault, market, curve, both positions and both orders in one call. The slippage reference is the
 * curve's spot price; the program fills at the worse of spot and its banded TWAP mark, so a reference that
 * differs from the mark by more than the slippage gets the order refunded rather than filled.
 * A migrated (graduated) curve is reported as such and not priced here.
 */
export function rpcPerpsPort(connection: Connection, idl: Idl): PerpsPort {
  const coders = perpsCoders(idl);
  const program = new PublicKey(idl.address);
  const launch = new PublicKey(LAUNCH_PROGRAM);
  return {
    async state(mintStr, ownerStr) {
      const mint = new PublicKey(mintStr), owner = new PublicKey(ownerStr);
      const market = marketPda(program, mint);
      const keys = [vaultPda(program), market, curvePda(launch, mint),
        positionPda(program, owner, market, 0), positionPda(program, owner, market, 1),
        orderPda(program, owner, market, 0), orderPda(program, owner, market, 1)];
      const [v, m, c, p0, p1, o0, o1] = await connection.getMultipleAccountsInfo(keys);
      if (!m) return null;
      if (!v || !c) throw new Error("vault or curve account missing");
      const curve = decodeCurve(address(keys[2].toBase58()), c.data);
      return {
        vault: decodeVault(coders, v.data), market: decodeMarket(coders, m.data),
        positions: { 0: p0 ? decodePosition(coders, p0.data) : null, 1: p1 ? decodePosition(coders, p1.data) : null },
        orders: { 0: !!o0, 1: !!o1 },
        solReserve: curve.virtualSol, graduated: curve.migrated,
        referencePriceQ64: curve.virtualTokens > 0n ? (curve.virtualSol << 64n) / curve.virtualTokens : undefined,
        nowSec: Math.floor(Date.now() / 1000),
      };
    },
  };
}
