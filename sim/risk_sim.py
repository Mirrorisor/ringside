"""
Ringside Tier 0 risk model.

Two questions:
  1. Manipulation: at what OI cap does pumping the curve to profit on perps
     become profitable for an attacker, given organic traders who sell into
     the pump?
  2. Portfolio: across many launches with ordinary perp traders (and rugs),
     what does the LP vault earn or lose per market, and how often is the
     per-market risk budget breached?

Everything is simulated on the real curve math (constant product over virtual
reserves, 1% fee) with the real mark rules (5-minute TWAP, +/-15% band per
window). Flow parameters are ASSUMPTIONS, chosen to be harsh, not fitted to
data. Replace them with fitted values from historical launch data before
setting mainnet caps.

One step = 10 seconds. TWAP window = 30 steps.
"""
from __future__ import annotations

import json
import math
import sys
from dataclasses import dataclass

import numpy as np

FEE = 0.01
VSOL0, VTOK0 = 30.0, 1_073_000_000.0
K = VSOL0 * VTOK0
CURVE_SOL_CAP = 87.9  # real SOL at graduation
WIN = 30              # steps per TWAP window and band window
BAND = 0.15
PERP_FEE = 0.003
SOL_USD = 150.0       # assumption for USD figures
MAINT = 0.20          # maintenance margin at 2x


@dataclass
class Curve:
    x: float = VSOL0
    y: float = VTOK0

    def price(self) -> float:
        return self.x / self.y

    def buy(self, sol: float) -> float:
        sol = min(sol, VSOL0 + CURVE_SOL_CAP - self.x)
        if sol <= 0:
            return 0.0
        net = sol * (1 - FEE)
        out = self.y - K / (self.x + net)
        self.x += net
        self.y -= out
        return out

    def sell_tokens(self, tok: float) -> float:
        if tok <= 0:
            return 0.0
        back = self.x - K / (self.y + tok)
        back = min(back, self.x - VSOL0)
        if back <= 0:
            return 0.0
        self.y = K / (self.x - back)
        self.x -= back
        return back * (1 - FEE)

    def sell_sol_value(self, sol_gross: float) -> float:
        """Sell tokens worth roughly `sol_gross` SOL before fees."""
        sol_gross = min(sol_gross, max(0.0, self.x - VSOL0 - 1e-9))
        if sol_gross <= 0:
            return 0.0
        tok = K / (self.x - sol_gross) - self.y
        return self.sell_tokens(tok)


class Mark:
    """Rolling TWAP over the last WIN step prices, clamped to a band whose
    anchor rolls once per window (mirrors ringside_perps::mark_price)."""

    def __init__(self, p0: float):
        self.hist = [p0] * WIN
        self.anchor = p0
        self.t = 0

    def push(self, p: float) -> float:
        self.hist.append(p)
        self.hist = self.hist[-WIN:]
        self.t += 1
        m = self.mark()
        if self.t % WIN == 0:
            self.anchor = m
        return m

    def mark(self) -> float:
        tw = sum(self.hist) / len(self.hist)
        return min(self.anchor * (1 + BAND), max(self.anchor * (1 - BAND), tw))


def organic_step(c: Curve, rng, lam: float, ref_price: float, take_profit_k: float, mean_size: float):
    """Random retail spot flow. Sell pressure rises when price is above the
    recent reference (holders take profit into a pump)."""
    n = rng.poisson(lam)
    for _ in range(n):
        size = rng.lognormal(math.log(mean_size) - 0.5, 1.0)
        up = c.price() / ref_price - 1
        p_sell = min(0.9, max(0.1, 0.5 + take_profit_k * up))
        if rng.random() < p_sell:
            c.sell_sol_value(size)
        else:
            c.buy(size)


# ---------------------------------------------------------------------------
# 1. Manipulation
# ---------------------------------------------------------------------------

def attack_once(rng, start_raised: float, lam: float, oi_usd: float, pump_sol: float, windows: int,
                take_profit_k: float = 1.5, mean_size: float = 0.25, worst_of: bool = False) -> float:
    """Attacker (with as many wallets as needed) fills the long side to oi_usd,
    pumps the curve with pump_sol, holds `windows` TWAP windows, closes the
    perp at mark, then sells the tokens. Returns attacker profit in USD."""
    c = Curve()
    c.buy(start_raised / (1 - FEE))
    # warm up a quiet window so TWAP and anchor reflect the starting price
    mk = Mark(c.price())
    for _ in range(WIN):
        organic_step(c, rng, lam, c.price(), 0.0, mean_size)
        mk.push(c.price())
    entry = max(mk.mark(), c.price()) if worst_of else mk.mark()
    ref = c.price()
    tokens = c.buy(pump_sol)
    for _ in range(WIN * windows + 2):  # +2 slots fill delay, rounded up to a step
        organic_step(c, rng, lam, ref, take_profit_k, mean_size)
        mk.push(c.price())
    exit_mark = min(mk.mark(), c.price()) if worst_of else mk.mark()
    perp = oi_usd * (exit_mark / entry - 1) - 2 * PERP_FEE * oi_usd
    spot_sol = c.sell_tokens(tokens) - pump_sol
    return perp + spot_sol * SOL_USD


def manipulation_study(rng, trials: int = 300, worst_of: bool = False):
    rows = []
    for stage, raised in (("early (10 SOL raised)", 10.0), ("late (70 SOL raised)", 70.0)):
        vsol = VSOL0 + raised
        fee_bound_usd = FEE * vsol * SOL_USD
        for activity, lam in (("quiet", 0.3), ("busy", 2.0)):
            for mult in (1, 3, 10, 30):
                oi = mult * fee_bound_usd
                best = None
                for pump in (0.5, 1, 2, 5, 10, 20):
                    for w in (1, 2):
                        prof = np.array([attack_once(rng, raised, lam, oi, pump, w, worst_of=worst_of) for _ in range(trials)])
                        ev = prof.mean()
                        if best is None or ev > best["ev_usd"]:
                            best = {"ev_usd": ev, "p_profit": float((prof > 0).mean()), "pump_sol": pump,
                                    "windows": w, "p95_usd": float(np.percentile(prof, 95))}
                rows.append({"stage": stage, "activity": activity, "cap_multiple": mult,
                             "oi_cap_usd": round(oi, 0), **{k: (round(v, 2) if isinstance(v, float) else v)
                                                             for k, v in best.items()}})
                print(rows[-1], file=sys.stderr)
    return rows


# ---------------------------------------------------------------------------
# 2. Portfolio of launches with ordinary perp traders
# ---------------------------------------------------------------------------

def one_launch(rng, cap_mult: float, steps: int = 2160, skew_cap: float | None = None,
               fund_base: float = 0.0005, fund_max: float = 0.005, stats: dict | None = None,
               worst_of: bool = False):
    """Six hours of a launch. Returns vault PnL (USD), peak loss, fees."""
    c = Curve()
    mk = Mark(c.price())
    quality = rng.normal(0, 1)
    lam0 = rng.lognormal(math.log(0.8), 0.9)          # trades per step at launch
    tau = rng.uniform(300, 1500)                      # hype decay (steps)
    rug_at = rng.integers(60, steps) if rng.random() < 0.35 else None
    sentiment = quality
    positions = []  # [side(+1/-1), size_usd, collateral, entry, close_step]
    vault = 0.0
    fees = 0.0
    worst = 0.0
    ref = c.price()
    for t in range(steps):
        lam = lam0 * math.exp(-t / tau)
        sentiment += rng.normal(-0.002, 0.05)
        if rug_at is not None and t == rug_at:
            # creator's 5% dev bag plus panic: sell a large block
            c.sell_tokens(50_000_000.0)
            c.sell_sol_value(max(0.0, (c.x - VSOL0) * 0.6))
            sentiment -= 3
        # spot flow
        n = rng.poisson(lam)
        p_buy = 1 / (1 + math.exp(-sentiment))
        for _ in range(n):
            size = rng.lognormal(math.log(0.25) - 0.5, 1.0)
            if rng.random() < p_buy:
                c.buy(size)
            else:
                c.sell_sol_value(size)
        if t % WIN == 0:
            ref = c.price()
        m = mk.push(c.price())
        clamped = abs(sum(mk.hist) / len(mk.hist) - m) > 1e-18
        cap = cap_mult * FEE * c.x * SOL_USD
        oi_long = sum(p[1] for p in positions if p[0] > 0)
        oi_short = sum(p[1] for p in positions if p[0] < 0)
        # perp arrivals: trend followers, some contrarian shorts
        for _ in range(rng.poisson(lam * 0.15)):
            if clamped:
                break
            mom = math.log(c.price() / ref) * 5
            side = 1 if rng.random() < 1 / (1 + math.exp(-(sentiment * 0.5 + mom))) else -1
            room = cap - (oi_long if side > 0 else oi_short)
            if skew_cap is not None:
                # vault's net exposure limited to skew_cap x cap (plus a floor so a market can start)
                net_after = (oi_long - oi_short) + side * room
                limit = skew_cap * cap
                if abs(net_after) > limit:
                    room = max(0.0, limit - side * (oi_long - oi_short))
            size = min(room, cap * 0.2 * rng.uniform(0.2, 1.0))
            if size < 5:
                continue
            fee = size * PERP_FEE
            fees += fee
            vault += fee * 0.7  # LP share + market insurance
            px = (max(m, c.price()) if side > 0 else min(m, c.price())) if worst_of else m
            positions.append([side, size, size / 2 - fee, px, t + int(rng.exponential(120)) + 1])
            if side > 0:
                oi_long += size
            else:
                oi_short += size
        # funding (hourly rate 0.05% x skew/cap, max 0.5%), per step
        if cap > 0:
            rate = max(-fund_max, min(fund_max, fund_base * (oi_long - oi_short) / cap)) / 360
            for p in positions:
                pay = p[1] * rate * p[0]
                p[2] -= pay
                vault += pay
        # closes and liquidations
        keep = []
        for p in positions:
            pnl = p[0] * p[1] * (m / p[3] - 1)
            equity = p[2] + pnl
            if equity < MAINT * p[1]:
                vault += p[2] - max(0.0, equity)  # trader loses collateral; remainder to keeper/insurance
                continue
            if t >= p[4]:
                if worst_of:
                    px = min(m, c.price()) if p[0] > 0 else max(m, c.price())
                    pnl = p[0] * p[1] * (px / p[3] - 1)
                fee = p[1] * PERP_FEE
                fees += fee
                vault += -pnl + fee * 0.7
                if stats is not None:
                    stats['long' if p[0] > 0 else 'short'] = stats.get('long' if p[0] > 0 else 'short', 0) + pnl
                continue
            keep.append(p)
        positions = keep
        unreal = sum(-p[0] * p[1] * (m / p[3] - 1) for p in positions)
        worst = min(worst, vault + unreal)
    m = mk.mark()
    vault += sum(-p[0] * p[1] * (m / p[3] - 1) for p in positions)
    return vault, worst, fees, c.x - VSOL0 >= CURVE_SOL_CAP - 1e-6


def portfolio_study(rng, launches: int = 800, **kw):
    out = []
    budget = 0.0025 * 1_000_000  # 0.25% of a $1M beta vault
    for mult in (3, 10, 30, 100):
        res = [one_launch(rng, mult, **kw) for _ in range(launches)]
        v = np.array([r[0] for r in res])
        worst = np.array([r[1] for r in res])
        fees = np.array([r[2] for r in res])
        grads = np.array([r[3] for r in res])
        row = {
            "cap_multiple": mult,
            "vault_pnl_mean_usd": round(float(v.mean()), 2),
            "vault_pnl_p5_usd": round(float(np.percentile(v, 5)), 2),
            "vault_pnl_p95_usd": round(float(np.percentile(v, 95)), 2),
            "worst_drawdown_usd": round(float(worst.min()), 2),
            "budget_breach_rate": float((worst < -budget).mean()),
            "fees_mean_usd": round(float(fees.mean()), 2),
            "graduation_rate": float(grads.mean()),
            "portfolio_total_usd": round(float(v.sum()), 0),
        }
        out.append(row)
        print(row, file=sys.stderr)
    return out


if __name__ == "__main__":
    out = {}
    for name, kw in (("v0_twap_mark", {}), ("fixed_worst_of_skew25", {"worst_of": True, "skew_cap": 0.25})):
        rng = np.random.default_rng(7)
        out[name] = {
            "manipulation": manipulation_study(rng, worst_of=kw.get("worst_of", False)),
            "portfolio": portfolio_study(rng, **kw),
        }
    with open(sys.argv[1] if len(sys.argv) > 1 else "results.json", "w") as f:
        json.dump(out, f, indent=1, default=float)
