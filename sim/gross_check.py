"""Net-exposure caps: how much more volume, and how much more vault risk, if each
side may grow to K x cap while the net stays within the skew cap (25% of cap)."""
import json, sys
import numpy as np
from replay import load, replay, TIERS, VAULT_USD

meta, markets = load(sys.argv[1])
out = {}
for tier in (0, 1):
    ms = [m for m in markets if m["tier"] == tier]
    for label, kw in (("base", {}), ("heavy_demand", dict(demand_share=0.6, long_bias=0.8))):
        for k in (1, 2, 3, 4):
            v, w, f, b = [], [], [], []
            for mi, m in enumerate(ms):
                for s in range(4):
                    r = replay(m, 150, np.random.default_rng(1000 * mi + s), gross_mult=k, **kw)
                    v.append(r["vault"]); w.append(r["worst"]); f.append(r["fees"]); b.append(r["breach"])
            v, w = np.array(v), np.array(w)
            budget = TIERS[tier]["budget"] * VAULT_USD
            row = dict(fees_mean_usd=round(float(np.mean(f)), 2), vault_pnl_mean_usd=round(float(v.mean()), 2),
                       vault_pnl_p1_usd=round(float(np.percentile(v, 1)), 2), worst_drawdown_usd=round(float(w.min()), 2),
                       drawdown_p1_share_of_budget=round(float(-np.percentile(w, 1) / budget), 3),
                       budget_breach_rate=round(float(np.mean(b)), 4), share_of_markets_vault_lost=round(float((v < 0).mean()), 3))
            out[f"tier{tier}/{label}/gross{k}x"] = row
            print(f"tier{tier} {label:12} {k}x", row, flush=True)
json.dump(out, open("results-gross.json", "w"), indent=1)
