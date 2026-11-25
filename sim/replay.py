"""
Ringside risk refit: historical replay on real pump.fun launches.

Instead of a synthetic price process, every market is replayed on a real
minute-by-minute price path (GeckoTerminal candles, priced in SOL):
  - tier 0: pump.fun bonding curves (active and freshly launched),
  - tier 1: tokens after graduation (PumpSwap pools).

The program's rules are applied exactly as on chain, at one-minute steps:
5-minute TWAP mark with a +/-15% band per window (catching up across
windows), worse-of mark/spot execution, no opens while clamped, tier
leverage / maintenance / fee / loss budget, 20% per-account cap, 25% skew
cap, skew funding, liquidation at the mark, and reduce-only + ADL once a
market's loss budget is spent.

What is still an assumption (and is varied): how much perp demand a token
attracts relative to its spot volume, and how traders pick a side. Traders
are trend followers with a long bias, which is the harsh case for a vault.

Usage: python3 replay.py launch-data.json [results-replay.json]
"""
from __future__ import annotations

import json
import math
import sys
from collections import defaultdict

import numpy as np

K_CURVE = 30.0 * 1_073_000_000.0      # mainnet curve: 30 virtual SOL x 1.073B virtual tokens
CURVE_P0 = 30.0 / 1_073_000_000.0      # launch price, SOL per token
CURVE_P_GRAD = (30.0 + 87.9) ** 2 / K_CURVE  # price when the curve sells out
SOL_USD = 68.8                         # Pyth at fetch time
WIN = 5                                # minutes per TWAP / band window
BAND = 0.15
VAULT_USD = 1_000_000.0                # beta vault size the budgets are measured against
TIERS = {
    0: dict(lev=2, maint=0.20, fee=0.0030, budget=0.0025),
    1: dict(lev=5, maint=0.08, fee=0.0015, budget=0.0100),
}
FUND_BASE, FUND_MAX = 0.0005, 0.005     # per hour, x skew/cap
SKEW_CAP, ACCOUNT_SHARE = 0.25, 0.20
LP_FEE_SHARE = 0.70                    # LP share + market insurance; the rest is protocol/creator/keeper
LIQ_REWARD = 0.01


def load(path):
    d = json.load(open(path))
    out = []
    for p in d["pools"]:
        c = p.get("candles") or []
        if len(c) < 30:
            continue
        arr = np.array(c, dtype=float)        # ts, o, h, l, c, volume (USD)
        arr = arr[np.argsort(arr[:, 0])]
        if np.any(arr[:, 4] <= 0):
            continue
        # GeckoTerminal only has candles for minutes with trades: fill the quiet
        # minutes at the last close with zero volume, so windows span real time.
        t0, t1 = int(arr[0, 0]), int(arr[-1, 0])
        n = (t1 - t0) // 60 + 1
        full = np.zeros((n, 6))
        full[:, 0] = t0 + 60 * np.arange(n)
        idx = ((arr[:, 0] - t0) // 60).astype(int)
        have = np.zeros(n, bool)
        have[idx] = True
        full[idx, 1:] = arr[:, 1:]
        last = arr[0, 4]
        for i in range(n):
            if have[i]:
                last = full[i, 4]
            else:
                full[i, 1:5] = last
        arr = full[-1440:]  # at most the last 24 hours
        tier = 0 if p["group"] in ("active_curve", "fresh_curve") else 1
        out.append(dict(group=p["group"], tier=tier, address=p["address"], reserve_usd=p.get("reserve_usd", 0.0),
                        ts=arr[:, 0], close=arr[:, 4], low=arr[:, 3], high=arr[:, 2], vol=arr[:, 5]))
    return d, out


def reserve_sol(m):
    """SOL behind the price each minute: virtual curve SOL (tier 0) or pool SOL (tier 1)."""
    p = m["close"]
    if m["tier"] == 0:
        return np.sqrt(K_CURVE * p)
    sol_now = max(m["reserve_usd"], 1.0) / 2 / SOL_USD    # constant-product pool: half the reserve is SOL
    return sol_now * np.sqrt(p / p[-1])


def path_stats(m):
    p = m["close"]
    r1 = np.diff(np.log(p))
    r5 = np.log(p[WIN:] / p[:-WIN])
    peak = np.maximum.accumulate(p)
    return dict(
        minutes=len(p),
        vol_1m=float(np.std(r1)),
        worst_1m=float(r1.min()),
        worst_5m=float(r5.min()) if len(r5) else 0.0,
        best_5m=float(r5.max()) if len(r5) else 0.0,
        max_drawdown=float((p / peak - 1).min()),
        rugged=bool((p / peak - 1).min() < -0.8),
    )


def replay(m, cap_bps, rng, demand_share=0.2, long_bias=0.4, hold_min=15.0, gross_mult=1.0):
    """gross_mult: each side may reach gross_mult x cap; the net (long - short) stays within SKEW_CAP x cap."""
    t = TIERS[m["tier"]]
    p, vol = m["close"], m["vol"]
    res = reserve_sol(m)
    n = len(p)
    hist = [p[0]] * WIN
    anchor, anchor_t = p[0], 0
    pos = []            # [side, size, collateral, entry, close_at]
    vault = fees = 0.0
    worst = 0.0
    reduce_only = False
    clamped_minutes = 0
    breach = False
    oi_l = oi_s = 0.0
    for i in range(n):
        spot = p[i]
        hist = (hist + [spot])[-WIN:]
        twap = sum(hist) / WIN
        # band anchor: catches up one window at a time (mirrors mark_price)
        while i - anchor_t >= WIN:
            anchor = min(anchor * (1 + BAND), max(anchor * (1 - BAND), twap))
            anchor_t += WIN
        mark = min(anchor * (1 + BAND), max(anchor * (1 - BAND), twap))
        clamped = abs(mark - twap) > 1e-15 * twap
        clamped_minutes += clamped
        cap = cap_bps / 1e4 * res[i] * SOL_USD
        oi_l = sum(q[1] for q in pos if q[0] > 0)
        oi_s = sum(q[1] for q in pos if q[0] < 0)

        # funding, per minute, paid by the crowded side to the vault
        if cap > 0 and pos:
            rate = max(-FUND_MAX, min(FUND_MAX, FUND_BASE * (oi_l - oi_s) / cap)) / 60
            for q in pos:
                pay = q[1] * rate * q[0]
                q[2] -= pay
                vault += pay

        # liquidations at the mark; closes at worse-of
        keep = []
        for q in pos:
            eq = q[2] + q[0] * q[1] * (mark / q[3] - 1)
            if eq < t["maint"] * q[1]:
                left = max(0.0, eq)
                # trader loses all collateral; the keeper's reward comes out of it,
                # the rest (incl. the market's insurance cut) stays with the vault side
                vault += q[2] - min(left, q[1] * LIQ_REWARD)
                continue
            if i >= q[4]:
                px = min(mark, spot) if q[0] > 0 else max(mark, spot)
                pnl = q[0] * q[1] * (px / q[3] - 1)
                fee = q[1] * t["fee"]
                fees += fee
                vault += -max(pnl, -q[2]) + fee * LP_FEE_SHARE
                continue
            keep.append(q)
        pos = keep

        unreal = sum(-q[0] * q[1] * (mark / q[3] - 1) for q in pos)
        worst = min(worst, vault + unreal)
        if vault + unreal < -t["budget"] * VAULT_USD and not reduce_only:
            reduce_only = breach = True
        if reduce_only:
            # ADL: close every profitable position at the mark
            keep = []
            for q in pos:
                pnl = q[0] * q[1] * (mark / q[3] - 1)
                if pnl > 0:
                    vault -= pnl
                else:
                    keep.append(q)
            pos = keep
            continue

        # new orders: demand follows real spot volume; trend followers with a long bias
        if clamped or cap < 20:
            continue
        demand = demand_share * vol[i]
        if demand < 5:
            continue
        mom = math.log(spot / p[max(0, i - WIN)])
        orders = 0
        while demand >= 5 and orders < 3:  # at most three new orders a minute
            orders += 1
            side = 1 if rng.random() < 1 / (1 + math.exp(-(long_bias + 6 * mom))) else -1
            size = min(demand, cap * ACCOUNT_SHARE * rng.uniform(0.1, 1.0))
            room = gross_mult * cap - (oi_l if side > 0 else oi_s)
            net_after = oi_l - oi_s + side * size
            if abs(net_after) > SKEW_CAP * cap:
                size = max(0.0, SKEW_CAP * cap - side * (oi_l - oi_s))
            size = min(size, room)
            demand -= max(size, 5)
            if size < 5:
                continue
            lev = rng.uniform(1.0, t["lev"])
            fee = size * t["fee"]
            fees += fee
            vault += fee * LP_FEE_SHARE
            entry = max(mark, spot) if side > 0 else min(mark, spot)
            pos.append([side, size, size / lev, entry, i + 1 + int(rng.exponential(hold_min))])
            if side > 0:
                oi_l += size
            else:
                oi_s += size
    vault += sum(-q[0] * q[1] * (mark / q[3] - 1) for q in pos)
    return dict(vault=vault, worst=worst, fees=fees, breach=breach, clamped_share=clamped_minutes / n)


def study(markets, tier, grid, seeds=4, **kw):
    rows = []
    for bps in grid:
        kw_ = kw
        v, w, f, b = [], [], [], []
        for mi, m in enumerate(markets):
            for s in range(seeds):
                r = replay(m, bps, np.random.default_rng(1000 * mi + s), **kw)
                v.append(r["vault"]); w.append(r["worst"]); f.append(r["fees"]); b.append(r["breach"])
        v, w = np.array(v), np.array(w)
        budget = TIERS[tier]["budget"] * VAULT_USD
        rows.append(dict(
            cap_bps=bps,
            vault_pnl_mean_usd=round(float(v.mean()), 2),
            vault_pnl_p5_usd=round(float(np.percentile(v, 5)), 2),
            vault_pnl_p1_usd=round(float(np.percentile(v, 1)), 2),
            worst_drawdown_usd=round(float(w.min()), 2),
            drawdown_p1_share_of_budget=round(float(-np.percentile(w, 1) / budget), 3),
            budget_breach_rate=round(float(np.mean(b)), 4),
            fees_mean_usd=round(float(np.mean(f)), 2),
            share_of_markets_vault_lost=round(float((v < 0).mean()), 3),
        ))
        print(tier, rows[-1], file=sys.stderr)
    return rows


def main():
    src = sys.argv[1]
    meta, markets = load(src)
    by_group = defaultdict(list)
    for m in markets:
        by_group[m["group"]].append(m)
    stats = {g: [path_stats(m) for m in ms] for g, ms in by_group.items()}
    summary = {}
    for g, ss in stats.items():
        summary[g] = dict(
            markets=len(ss),
            median_minutes=int(np.median([s["minutes"] for s in ss])),
            vol_1m_median=round(float(np.median([s["vol_1m"] for s in ss])), 4),
            vol_1m_p90=round(float(np.percentile([s["vol_1m"] for s in ss], 90)), 4),
            worst_1m_p10=round(float(np.percentile([s["worst_1m"] for s in ss], 10)), 3),
            worst_5m_p10=round(float(np.percentile([s["worst_5m"] for s in ss], 10)), 3),
            best_5m_p90=round(float(np.percentile([s["best_5m"] for s in ss], 90)), 3),
            rug_share=round(float(np.mean([s["rugged"] for s in ss])), 3),
        )
    # sanity: curve prices must sit on the curve
    curve_px = [float(np.median(m["close"])) for m in markets if m["tier"] == 0]
    on_curve = float(np.mean([CURVE_P0 * 0.5 <= x <= CURVE_P_GRAD * 2 for x in curve_px])) if curve_px else 0
    t0 = [m for m in markets if m["tier"] == 0]
    t1 = [m for m in markets if m["tier"] == 1]
    out = dict(
        source=meta.get("source"), fetched_at=meta.get("fetched_at"),
        curve_prices_on_curve_share=round(on_curve, 3),
        paths=summary,
        tier0=dict(base=study(t0, 0, [50, 100, 200, 400]),
                   heavy_demand=study(t0, 0, [100, 200], demand_share=0.6, long_bias=0.8)),
        tier1=dict(base=study(t1, 1, [100, 300, 600, 1000]),
                   heavy_demand=study(t1, 1, [300, 600], demand_share=0.6, long_bias=0.8)),
    )
    dst = sys.argv[2] if len(sys.argv) > 2 else "results-replay.json"
    json.dump(out, open(dst, "w"), indent=1)
    print(json.dumps({k: out[k] for k in ("curve_prices_on_curve_share", "paths")}, indent=1))


if __name__ == "__main__":
    main()
