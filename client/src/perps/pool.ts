/**
 * Raydium pool reads, mirroring `pool_twap_x32` / `pool_fee_total` in programs/ringside_perps/src/lib.rs.
 * The mark never uses the pool's instantaneous price: the TWAP comes from the observation history only,
 * and `null` means the history does not cover the window yet (the market is then priced at its fallback price
 * and refuses new opens). Vault balances are net of the pool's accrued protocol, fund and creator fees.
 */
export const POOL_TWAP_SECONDS = 300n;
const U128 = 1n << 128n;
const N = 100, BASE = 43;

const u64 = (b: Uint8Array, o: number): bigint => {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]);
  return v;
};
const u128 = (b: Uint8Array, o: number): bigint => u64(b, o) | (u64(b, o + 8) << 64n);

/**
 * TWAP of the token's price (lamports per base unit, x32) over POOL_TWAP_SECONDS from a Raydium ObservationState,
 * extended from the newest observation to `now` at the last observed price (the average over the newest observed
 * interval). `null` while there is no observation at least POOL_TWAP_SECONDS old or no interval to take a price from.
 */
export function poolTwapX32(obs: Uint8Array, tokenIs0: boolean, now: bigint): bigint | null {
  if (obs.length < BASE + N * 40 || obs[8] === 0) return null;
  const latest = (obs[9] | (obs[10] << 8)) % N;
  const ts = (k: number) => u64(obs, BASE + k * 40);
  const cum = (k: number) => u128(obs, BASE + k * 40 + 8 + (tokenIs0 ? 0 : 16));
  const tLatest = ts(latest), prev = (latest + N - 1) % N, tPrev = ts(prev);
  if (tLatest === 0n || tLatest > now || tPrev === 0n || tPrev >= tLatest) return null;
  const lastPrice = ((cum(latest) - cum(prev) + U128) % U128) / (tLatest - tPrev);
  const cumNow = (cum(latest) + lastPrice * (now - tLatest)) % U128;
  const cutoff = now > POOL_TWAP_SECONDS ? now - POOL_TWAP_SECONDS : 0n;
  let start: [bigint, bigint] | null = null;
  for (let k = 0; k < N; k++) {
    const t = ts(k);
    if (t !== 0n && t <= cutoff && t <= tLatest && (!start || t > start[0])) start = [t, cum(k)];
  }
  if (!start) return null;
  return ((cumNow - start[1] + U128) % U128) / (now - start[0]);
}

/** Accrued fees sitting in a pool vault (protocol + fund + creator) for token 0 or token 1, from raw PoolState bytes. */
export function poolFeeTotal(pool: Uint8Array, token1: boolean): bigint {
  if (pool.length < 413) throw new Error("pool state too short");
  const o = token1 ? 8 : 0;
  return u64(pool, 341 + o) + u64(pool, 357 + o) + u64(pool, 397 + o);
}

/** Vault balance net of the pool's accrued fees (what the program prices from). */
export const netOfFees = (balance: bigint, fees: bigint): bigint => (balance > fees ? balance - fees : 0n);
