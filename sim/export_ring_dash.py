"""Turns sim/results-ring.json into the dashboard's data files ({rows, meta})."""
import json, sys
from pathlib import Path
here = Path(__file__).parent
r = json.load(open(here / "results-ring.json"))
code = [{"label": "ring_flywheel.py", "value": (here / "ring_flywheel.py").read_text(), "type": "code", "lang": "python"},
        {"label": "export_ring_dash.py", "value": Path(__file__).read_text(), "type": "code", "lang": "python"},
        {"label": "Input", "value": "Contract constants from programs/ringside_launch, programs/ringside_perps and client/scripts/init-mainnet.ts; adoption assumptions per scenario (see Assumptions)"},
        {"label": "Run", "value": "300 Monte Carlo paths x 365 days per run, seed 7, 25 Nov 2026"}]
out = Path(sys.argv[1])
out.mkdir(exist_ok=True)
def dump(name, rows):
    json.dump({"rows": rows, "meta": code}, open(out / name, "w"))

traj = []
for run in r["runs"]:
    for i, w in enumerate(r["weeks"]):
        traj.append({"day": w + 1, "scenario": run["scenario"], "policy": run["policy"], "seed": run["seed"],
                     "vault_p10": run["vault_p10"][i], "vault_p50": run["vault_p50"][i], "vault_p90": run["vault_p90"][i],
                     "treasury_p50": run["treasury_value_p50"][i]})
dump("trajectories.json", traj)

summary = []
for run in r["runs"]:
    e = run["end"]
    summary.append({"run": f'{run["scenario"]} | {run["policy"]} | {run["seed"]}', "scenario": run["scenario"], "policy": run["policy"], "seed": run["seed"],
                    "vault_p10": round(e["vault_p10"]), "vault_p50": round(e["vault_p50"]), "vault_p90": round(e["vault_p90"]),
                    "treasury_value_p50": round(e["treasury_value_p50"]), "sol_revenue_usd": round(e["sol_revenue_usd_p50"]),
                    "perps_volume_day": round(e["perp_volume_day_last30_p50"]), "lp_apy": round(e["lp_apy_last90_p50"], 4),
                    "halted_share": e["tier1_halted_share_p50"]})
dump("summary.json", summary)

src = []
for run in r["runs"]:
    for k, v in run["sources_p50"].items():
        src.append({"scenario": run["scenario"], "policy": run["policy"], "seed": run["seed"], "source": k, "usd": round(v)})
dump("treasury_sources.json", src)

ring = r["ring_launch"]
facts = [
    {"metric": "raised_sol", "label": "SOL raised on the $RING curve", "value": round(ring["raised_sol"], 1)},
    {"metric": "pool_sol", "label": "SOL locked in the Raydium pool (LP burned)", "value": round(ring["pool_sol"], 1)},
    {"metric": "treasury_sol", "label": "SOL the treasury earns from the launch", "value": round(ring["treasury_sol"], 2)},
    {"metric": "grad_fee_sol", "label": "Graduation fee", "value": ring["breakdown_sol"]["graduation fee"]},
    {"metric": "proto_sol", "label": "Protocol 0.5% of curve volume", "value": round(ring["breakdown_sol"]["protocol 0.5% of curve volume"], 2)},
    {"metric": "creator_sol", "label": "Creator 0.3% of curve volume", "value": round(ring["breakdown_sol"]["creator 0.3% of curve volume"], 2)},
    {"metric": "curve_volume_sol", "label": "Curve volume assumed (3x the raise)", "value": round(ring["curve_volume_sol"])},
    {"metric": "grad_fdv_sol", "label": "Fully diluted value at graduation", "value": round(ring["grad_fdv_sol"])},
    {"metric": "team_buy_sol", "label": "Disclosed team buy at launch", "value": ring["team_buy_sol"]},
    {"metric": "team_share", "label": "Share of supply that buy gets", "value": round(ring["team_share"], 4)},
    {"metric": "team_paper_sol", "label": "Paper value of that buy at graduation", "value": round(ring["team_paper_sol_at_grad"], 1)},
    {"metric": "sol_usd", "label": "SOL/USD used (Pyth, 25 Nov 2026)", "value": 67.74},
    {"metric": "cap_t0_launch", "label": "Perp OI cap per side, new curve (USD)", "value": round(r["caps_usd"]["tier0_per_side_launch"])},
    {"metric": "cap_t0_grad", "label": "Perp OI cap per side, curve near graduation (USD)", "value": round(r["caps_usd"]["tier0_per_side_at_grad"])},
    {"metric": "cap_t1", "label": "Perp OI cap per side, graduated token (USD)", "value": round(r["caps_usd"]["tier1_per_side"])},
    {"metric": "vault_needed", "label": "Vault size where a typical tier-0 market's risk budget covers a 1-sd daily trader win (USD)", "value": round(r["vault_needed_usd"]["tier0_1sd"])},
]
dump("ring_launch.json", facts)

assume = []
for s, a in r["assumptions"].items():
    assume.append({"scenario": s, "launches_per_day": a["launches"], "graduation_rate": a["grad_rate"], "curve_churn": a["churn"],
                   "dead_curve_sol": a["dead_curve_sol"], "perp_cap_utilisation": a["util"], "perp_turnover_per_day": a["turns"],
                   "graduated_market_fade_days": a["tier1_life"]})
dump("assumptions.json", assume)
print("ok", len(traj), len(summary), len(src))
