"""Build the NBA Slate Board page: run the model for one or more slates and embed the results.

Usage: python3 nba/board.py OUT.html DRAFT_GROUP "LABEL" [DRAFT_GROUP "LABEL" ...]
  e.g. python3 nba/board.py board.html 155078 "Wed Oct 21 · Main (11 games)"
Labels are "<date> · <slate name>"; the page splits on " · ". Ratings are recomputed in the
page from the component scores, so its weight sliders work without rerunning the model.
"""

import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import dk_nba  # noqa: E402
import lineups as lu  # noqa: E402
import ratings  # noqa: E402

TEMPLATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "board_template.html")


def slate(dg, label):
    players, absences = dk_nba.build(dg)
    weights = ratings.build_weights("gpp", None, {}, leverage_available=False)
    rated = ratings.rate_players(players, weights, 85, 10.0, None)
    built = lu.optimize(rated, n=3, min_diff=2)

    late = {}
    for p in rated:
        for q, gain in p.get("if_out", []):
            late.setdefault(q, []).append((p["name"], gain))

    return {
        "label": label,
        "run_at": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "draft_group": dg,
        "ceiling_pct": 85,
        "risk_strength": 10,
        "ownership": False,
        "presets": ratings.PRESETS,
        "games": sorted({(p["game"], p["game_time"]) for p in rated},
                        key=lambda g: datetime.strptime(g[1], "%I:%M%p")),
        "players": [{
            "name": p["name"], "team": p["team"], "opp": p["opp"], "game": p["game"],
            "pos": p["positions"].replace("/UTIL", ""), "salary": p["salary"],
            "median": p["proj_fp"], "base_median": p["base_proj_fp"], "bump": p["fp_bump"],
            "bump_min": p["min_bump"], "bump_from": ", ".join(p["bump_from"]),
            "ceiling": p["ceiling"], "min": p["proj_min"], "min_sd": p["min_sd"],
            "fppm": p["fp_per_min"], "dk_avg": p["dk_avg_fp"], "status": p["dk_status"] or p.get("injury") or "",
            "severity": round(min(1.0, sum(s for _, s in p["risk_flags"])), 2),
            "flags": [r for r, _ in p["risk_flags"]],
            "risks": [r for r in p["risks"] if r not in [f for f, _ in p["risk_flags"]]] + p["notes"],
            "c": {k: p["comp"][k] for k in ratings.COMPONENTS},
        } for p in rated],
        "lineups": [{**lu.evaluate(l, 85), "slots": [{
            "slot": s, "name": l["slots"][s]["name"], "team": l["slots"][s]["team"],
            "salary": l["slots"][s]["salary"], "median": l["slots"][s]["proj_fp"],
            "ceiling": l["slots"][s]["ceiling"], "rating": l["slots"][s]["rating"],
        } for s in lu.SLOTS]} for l in built],
        "absences": [{
            "team": a["team"], "player": a["player"], "vacated_min": a["vacated_min"],
            "gainers": [{"name": n, "min": m, "fp": g} for n, m, g, _ in a["gainers"]],
        } for a in absences],
        "late_news": [{"player": q, "gainers": [{"name": n, "fp": g} for n, g in sorted(v, key=lambda x: -x[1])]}
                      for q, v in late.items()],
    }


def main():
    if len(sys.argv) < 4 or len(sys.argv) % 2:
        sys.exit(__doc__)
    args = sys.argv[2:]
    slates = [slate(int(args[i]), args[i + 1]) for i in range(0, len(args), 2)]
    data = json.dumps({"slates": slates}, separators=(",", ":")).replace("</", "<\\/")
    with open(TEMPLATE) as f:
        page = f.read().replace("/*__DATA__*/", data)
    with open(sys.argv[1], "w") as f:
        f.write(page)
    for o in slates:
        print(f"{o['label']}: draft group {o['draft_group']}, {len(o['players'])} players, {len(o['lineups'])} lineups")


if __name__ == "__main__":
    main()
