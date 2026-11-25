"""
$RING launch and the protocol-owned-liquidity flywheel, simulated for 12 months.

Every constant marked [code] is read from the programs or init-mainnet.ts:
  launch: 30 virtual SOL, 1,073M virtual tokens, 800M curve supply, 1B supply,
          fees 0.5% protocol / 0.3% creator / 0.2% insurance of curve volume,
          0.02 SOL launch fee, 1.5 SOL graduation fee, ~0.15 SOL Raydium pool fee.
  perps:  OI cap per side = 1.5% of the SOL behind the price (curve virtual SOL,
          or pool SOL after graduation); fees 0.30% (tier 0) / 0.15% (tier 1);
          fee split 60% LPs, 10% protocol, 10% keeper, 10% creator, 10% insurance;
          risk budget per market 0.25% (tier 0) / 1% (tier 1) of LP assets;
          at most 40 live tier-0 markets.
Everything else (adoption, churn, utilisation, volatility) is an assumption and
is set per scenario below.

Treasury policy simulated: protocol perps fees compound into treasury LP shares
(as on devnet today); a share of SOL revenue (launch, graduation, curve protocol
fees) is swapped to USDC and deposited into the vault; the team seeds the vault
on day 0. $RING itself launches on day 0 from the treasury key.
"""
import json
import numpy as np

# ---- [code] constants ----------------------------------------------------------
V0_SOL, V0_TOK, CURVE_SUPPLY, SUPPLY = 30.0, 1_073e6, 800e6, 1e9
FEE_PROTO, FEE_CREATOR, FEE_INS = 0.005, 0.003, 0.002
LAUNCH_FEE, GRAD_FEE, RAYDIUM_FEE = 0.02, 1.5, 0.15
CAP_BPS = 0.015
PERP_FEE = {0: 0.0030, 1: 0.0015}
BUDGET = {0: 0.0025, 1: 0.01}
MAX_TIER0 = 40
LP_SHARE, PROTO_SHARE = 0.60, 0.10

# Curve at graduation (constant product on virtual reserves).
GRAD_VSOL = V0_SOL * V0_TOK / (V0_TOK - CURVE_SUPPLY)          # 117.9 SOL
RAISED = GRAD_VSOL - V0_SOL                                     # 87.9 SOL net of fees
POOL_SOL = RAISED - GRAD_FEE - RAYDIUM_FEE                      # SOL that opens the pool
GRAD_PRICE = GRAD_VSOL / (V0_TOK - CURVE_SUPPLY)                # SOL per token
TIER0_AVG_VSOL = 55.0  # typical virtual SOL on a live curve (most stall early)

SOL0 = 67.74  # SOL/USD from Pyth on 25 Nov 2026 (devnet run)

SCENARIOS = {
    "Quiet": dict(launches=20, grad_rate=0.008, churn=2.0, dead_curve_sol=1.0,
                  util=0.15, turns=3, tier1_life=7, ring_churn=1.5),
    "Base": dict(launches=100, grad_rate=0.012, churn=3.0, dead_curve_sol=2.0,
                 util=0.35, turns=6, tier1_life=14, ring_churn=3.0),
    "Hot": dict(launches=500, grad_rate=0.015, churn=4.0, dead_curve_sol=3.0,
                util=0.60, turns=10, tier1_life=21, ring_churn=6.0),
}
POLICIES = {"Fees only": 0.0, "Sweep 50% of SOL revenue": 0.5, "Sweep 100% of SOL revenue": 1.0}
SEEDS = [10_000, 50_000]
DAYS, PATHS = 365, 300
SOL_VOL = 0.80     # annual SOL volatility
DAILY_MOVE = 0.30  # daily sd of a memecoin, sets trader PnL against the vault
TEAM_BUY_SOL = 2.0  # disclosed, dev-locked team buy at $RING launch


def tokens_for(sol_in, vsol=V0_SOL, vtok=V0_TOK):
    """Tokens out for sol_in (after fees) on the virtual curve."""
    return vtok - vsol * vtok / (vsol + sol_in)


def ring_launch():
    """One-off numbers for $RING on its own curve, if it graduates."""
    vol = RAISED * (1 + FEE_PROTO + FEE_CREATOR + FEE_INS) * RING_CHURN_BASE
    proto = vol * FEE_PROTO
    creator = vol * FEE_CREATOR
    team_tokens = tokens_for(TEAM_BUY_SOL * (1 - FEE_PROTO - FEE_CREATOR - FEE_INS))
    return {
        "curve_volume_sol": vol,
        "treasury_sol": LAUNCH_FEE * 0 + GRAD_FEE + proto + creator,  # launch fee is paid to ourselves
        "breakdown_sol": {"graduation fee": GRAD_FEE, "protocol 0.5% of curve volume": proto, "creator 0.3% of curve volume": creator},
        "raised_sol": RAISED, "pool_sol": POOL_SOL, "pool_tokens": SUPPLY - CURVE_SUPPLY,
        "grad_fdv_sol": GRAD_PRICE * SUPPLY,
        "team_buy_sol": TEAM_BUY_SOL, "team_tokens_m": team_tokens / 1e6, "team_share": team_tokens / SUPPLY,
        "team_paper_sol_at_grad": team_tokens * GRAD_PRICE,
    }


RING_CHURN_BASE = SCENARIOS["Base"]["ring_churn"]


def run(sc, sweep, seed_usd, rng):
    P, D = PATHS, DAYS
    sol = np.full(P, SOL0)
    vault = np.full(P, float(seed_usd))     # LP assets (USD)
    t_shares = np.full(P, float(seed_usd))  # treasury LP shares; share price starts at 1
    shares = np.full(P, float(seed_usd))
    ext = np.zeros(P)
    sources = {k: np.zeros(P) for k in ["Seed", "SOL revenue swept", "Perps protocol fees", "$RING launch fees", "LP fee share", "Trader PnL vs vault"]}
    sources["Seed"] += seed_usd
    # Tier-1 markets: per path, preallocated by expected graduations.
    max_m = int(sc["launches"] * sc["grad_rate"] * D * 2.5) + 10
    t1_birth = np.full((P, max_m), -1)
    t1_pnl = np.zeros((P, max_m))
    t1_halt = np.zeros((P, max_m), bool)
    n_t1 = np.zeros(P, int)
    out = {k: np.zeros((P, D)) for k in ["vault", "treasury_value", "treasury_frac", "perp_vol", "sol_rev_usd", "halted_share", "apy"]}
    sol_rev_cum = np.zeros(P)
    ring = ring_launch()
    for d in range(D):
        sol *= np.exp(rng.normal(-0.5 * SOL_VOL**2 / 365, SOL_VOL / np.sqrt(365), P))
        launches = rng.poisson(sc["launches"], P)
        grads = rng.binomial(launches, sc["grad_rate"])
        dead = launches - grads
        dead_vol = rng.gamma(1.0, sc["dead_curve_sol"], P) * dead
        grad_vol = grads * RAISED * sc["churn"]
        curve_vol = dead_vol + grad_vol
        sol_rev = launches * LAUNCH_FEE + grads * GRAD_FEE + curve_vol * FEE_PROTO
        if d == 0:  # $RING graduates on day 0 (treasury is its creator)
            sol_rev += ring["treasury_sol"]
            sources["$RING launch fees"] += ring["treasury_sol"] * sol * sweep
        rev_usd = sol_rev * sol
        sol_rev_cum += rev_usd
        out["sol_rev_usd"][:, d] = sol_rev_cum
        deposit = rev_usd * sweep
        sources["SOL revenue swept"] += deposit - (ring["treasury_sol"] * sol * sweep if d == 0 else 0)

        # ---- perps: tier 0 (40 registry slots, filled when enough curves are live) ----
        live0 = np.minimum(MAX_TIER0, launches * 0.6)  # curves alive long enough to trade
        cap0 = CAP_BPS * TIER0_AVG_VSOL * sol
        oi0 = 2 * cap0 * sc["util"]
        budget0 = BUDGET[0] * vault
        pnl0 = rng.standard_normal((P, MAX_TIER0)) * (DAILY_MOVE * oi0 / 2)[:, None] * (np.arange(MAX_TIER0)[None, :] < live0[:, None])
        halted0 = pnl0 > budget0[:, None]
        active0 = live0 - halted0.sum(1) * 0.5  # a halted market loses about half its day
        vol0 = active0 * oi0 * sc["turns"]
        trader_pnl0 = np.minimum(pnl0, budget0[:, None]).sum(1)

        # ---- perps: tier 1 (every graduated token gets a market; activity decays) ----
        for p in np.nonzero(grads)[0]:
            k = min(grads[p], max_m - n_t1[p])
            t1_birth[p, n_t1[p]:n_t1[p] + k] = d
            n_t1[p] += k
        age = d - t1_birth
        alive = (t1_birth >= 0)
        act = np.where(alive, np.exp(-np.maximum(age, 0) / sc["tier1_life"]), 0.0)
        cap1 = CAP_BPS * POOL_SOL * sol
        oi1 = 2 * cap1[:, None] * sc["util"] * act
        budget1 = BUDGET[1] * vault
        dp = rng.normal(0, DAILY_MOVE, (P, max_m)) * oi1 / 2 * (~t1_halt)
        t1_pnl += dp
        newly = (t1_pnl > budget1[:, None]) & ~t1_halt & alive
        t1_halt |= newly
        vol1 = (oi1 * (~t1_halt)).sum(1) * sc["turns"]
        trader_pnl1 = dp.sum(1)

        fees = vol0 * PERP_FEE[0] + vol1 * PERP_FEE[1]
        lp_fee = fees * LP_SHARE
        proto_fee = fees * PROTO_SHARE
        trader_pnl = trader_pnl0 + trader_pnl1

        # Share accounting: LP fees and trader PnL move the share price; deposits
        # and compounding mint treasury shares at the current price.
        price = vault / shares
        vault += lp_fee - trader_pnl
        sources["LP fee share"] += lp_fee * (t_shares / shares)
        sources["Trader PnL vs vault"] += -trader_pnl * (t_shares / shares)
        price = vault / shares
        for amt, key in ((proto_fee, "Perps protocol fees"), (deposit, None)):
            new = amt / price
            vault += amt
            shares += new
            t_shares += new
            if key:
                sources[key] += amt
        vault = np.maximum(vault, 1.0)

        out["vault"][:, d] = vault
        out["treasury_value"][:, d] = vault * t_shares / shares
        out["treasury_frac"][:, d] = t_shares / shares
        out["perp_vol"][:, d] = vol0 + vol1
        out["halted_share"][:, d] = (t1_halt & alive).sum(1) / np.maximum(alive.sum(1), 1)
        out["apy"][:, d] = (lp_fee - trader_pnl) / np.maximum(vault, 1) * 365
    return out, sources


def pct(a, q):
    return [round(float(x), 2) for x in np.percentile(a, q, axis=0)]


def main():
    rng = np.random.default_rng(7)
    res = {"assumptions": {k: v for k, v in SCENARIOS.items()}, "ring_launch": ring_launch(), "runs": []}
    weeks = list(range(0, DAYS, 7)) + [DAYS - 1]
    for sname, sc in SCENARIOS.items():
        for pname, sweep in POLICIES.items():
            for seed in SEEDS:
                out, src = run(sc, sweep, seed, rng)
                v = out["vault"]
                perp_year = out["perp_vol"].sum(1)
                lp_apy = (out["apy"][:, -90:].mean(1))
                res["runs"].append({
                    "scenario": sname, "policy": pname, "seed": seed,
                    "vault_p10": pct(v[:, weeks], 10), "vault_p50": pct(v[:, weeks], 50), "vault_p90": pct(v[:, weeks], 90),
                    "treasury_value_p50": pct(out["treasury_value"][:, weeks], 50),
                    "end": {
                        "vault_p10": float(np.percentile(v[:, -1], 10)), "vault_p50": float(np.median(v[:, -1])), "vault_p90": float(np.percentile(v[:, -1], 90)),
                        "treasury_value_p50": float(np.median(out["treasury_value"][:, -1])),
                        "sol_revenue_usd_p50": float(np.median(out["sol_rev_usd"][:, -1])),
                        "perp_volume_usd_p50": float(np.median(perp_year)),
                        "perp_volume_day_last30_p50": float(np.median(out["perp_vol"][:, -30:].mean(1))),
                        "lp_apy_last90_p50": float(np.median(lp_apy)),
                        "tier1_halted_share_p50": float(np.median(out["halted_share"][:, -1])),
                        "vault_below_seed_prob": float((v[:, -1] < seed).mean()),
                    },
                    "sources_p50": {k: float(np.median(x)) for k, x in src.items()},
                })
                e = res["runs"][-1]["end"]
                print(f"{sname:5} {pname:26} seed {seed:>6}: vault p50 ${e['vault_p50']:>11,.0f} (p10 ${e['vault_p10']:>10,.0f})  "
                      f"SOL rev ${e['sol_revenue_usd_p50']:>10,.0f}  perps vol/day ${e['perp_volume_day_last30_p50']:>9,.0f}  LP APY {e['lp_apy_last90_p50']*100:5.1f}%  halted {e['tier1_halted_share_p50']*100:4.1f}%")
    res["weeks"] = weeks
    # Vault size needed so a typical market's budget covers a 1-sd daily trader win.
    need0 = DAILY_MOVE * (2 * CAP_BPS * TIER0_AVG_VSOL * SOL0 * 0.35) / 2 / BUDGET[0]
    need1 = DAILY_MOVE * (2 * CAP_BPS * POOL_SOL * SOL0 * 0.35) / 2 / BUDGET[1]
    res["vault_needed_usd"] = {"tier0_1sd": need0, "tier1_1sd": need1}
    res["caps_usd"] = {"tier0_per_side_launch": CAP_BPS * V0_SOL * SOL0, "tier0_per_side_at_grad": CAP_BPS * GRAD_VSOL * SOL0, "tier1_per_side": CAP_BPS * POOL_SOL * SOL0}
    print(json.dumps(res["ring_launch"], indent=1))
    print("vault needed", res["vault_needed_usd"], "caps", res["caps_usd"])
    json.dump(res, open("sim/results-ring.json", "w"), indent=1)


if __name__ == "__main__":
    main()
