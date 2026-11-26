/** PDA helpers. Seeds are SEED_* in programs/ringside_perps/src/lib.rs:50-52 and the Accounts structs (lib.rs:1219-1252). */
import { PublicKey } from "@solana/web3.js";

const enc = (s: string) => new TextEncoder().encode(s);
const find = (seeds: Uint8Array[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];

/** `["vault"]`, lib.rs:1065 */
export const vaultPda = (perps: PublicKey) => find([enc("vault")], perps);
/** `["vault_usdc"]`, lib.rs:1068 */
export const vaultUsdcPda = (perps: PublicKey) => find([enc("vault_usdc")], perps);
/** `["market", mint]`, lib.rs:1221 */
export const marketPda = (perps: PublicKey, mint: PublicKey) => find([enc("market"), mint.toBytes()], perps);
/** `["position", owner, market, side]`, lib.rs:1245 */
export const positionPda = (perps: PublicKey, owner: PublicKey, market: PublicKey, side: number) =>
  find([enc("position"), owner.toBytes(), market.toBytes(), Uint8Array.from([side])], perps);
/** `["order", owner, market, side]`, lib.rs:1250 */
export const orderPda = (perps: PublicKey, owner: PublicKey, market: PublicKey, side: number) =>
  find([enc("order"), owner.toBytes(), market.toBytes(), Uint8Array.from([side])], perps);
/** `["global"]` of the launch program, and `["curve", mint]` (ringside_launch SEED_CURVE). */
export const launchGlobalPda = (launch: PublicKey) => find([enc("global")], launch);
export const curvePda = (launch: PublicKey, mint: PublicKey) => find([enc("curve"), mint.toBytes()], launch);
