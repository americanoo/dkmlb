"""Calibrate logged ratings against what actually happened.

Reads every nba/logs/*.csv written by rate.py, fetches actual minutes and DK points from
ESPN for finished games, and reports projection error, ceiling hit rate, and how well
ratings sorted players within each salary tier. Reweight only after many slates.

Usage: python3 nba/review.py [--results contests.csv]
  contests.csv (optional, kept by hand): date, contest, entry_fee, winnings
"""

import argparse
import csv
import glob
import os
import statistics
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(__file__))

import dk_nba  # noqa: E402
from ratings import SALARY_TIERS, TIERS  # noqa: E402

LOG_DIR = os.path.join(os.path.dirname(__file__), "logs")


def final_events(date, cache={}):
    if date not in cache:
        events = dk_nba.get(dk_nba.ESPN_SCOREBOARD.format(date=date)).get("events", [])
        cache[date] = {e["id"] for e in events if e["status"]["type"].get("completed")}
    return cache[date]


def actuals(espn_id, season, cache={}):
    key = (espn_id, season)
    if key not in cache:
        data = dk_nba.get(dk_nba.ESPN_GAMELOG.format(id=espn_id) + f"?season={season}")
        games, _ = dk_nba.parse_gamelog(data)
        cache[key] = {g["event_id"]: g for g in games}
    return cache[key]


def spearman(xs, ys):
    def ranks(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0] * len(v)
        for rank, i in enumerate(order):
            r[i] = rank
        return r
    if len(xs) < 3:
        return None
    rx, ry = ranks(xs), ranks(ys)
    return statistics.correlation(rx, ry) if len(set(rx)) > 1 and len(set(ry)) > 1 else None


def load_rows():
    rows = []
    for path in sorted(glob.glob(os.path.join(LOG_DIR, "*.csv"))):
        with open(path, newline="") as f:
            rows += list(csv.DictReader(f))
    return rows


def attach_actuals(rows):
    done = []
    for r in rows:
        if not r["espn_id"] or not r["event_id"] or r["event_id"] not in final_events(r["game_date"]):
            continue
        year, month = int(r["game_date"][:4]), int(r["game_date"][4:6])
        g = actuals(r["espn_id"], year + 1 if month >= 8 else year).get(r["event_id"])
        # A finished game with no box score line means the player didn't play.
        r["act_min"] = g["MIN"] if g else 0.0
        r["act_fp"] = dk_nba.dk_fantasy_points(g) if g else 0.0
        for k in ("proj_min", "proj_fp", "ceiling", "rating", "salary", "ceiling_pct"):
            r[k] = float(r[k]) if r.get(k) not in (None, "") else None
        done.append(r)
    return done


def report(rows):
    slates = {(r["game_date"], r["draft_group"]) for r in rows}
    print(f"{len(rows)} player-games across {len(slates)} slate(s)")
    if len(slates) < 10:
        print("small sample: results below say more about variance than about the weights")

    played = [r for r in rows if r["act_min"] > 0]
    dnp = len(rows) - len(played)
    min_err = [r["act_min"] - r["proj_min"] for r in played]
    fp_err = [r["act_fp"] - r["proj_fp"] for r in rows]
    print(f"\nminutes  MAE {statistics.mean(abs(e) for e in min_err):.1f}  bias {statistics.mean(min_err):+.1f}"
          f"  (excludes {dnp} DNP)")
    print(f"DK pts   MAE {statistics.mean(abs(e) for e in fp_err):.1f}  bias {statistics.mean(fp_err):+.1f}")
    pct = statistics.mean(r["ceiling_pct"] or 85 for r in rows)
    hit = sum(r["act_fp"] >= r["ceiling"] for r in rows) / len(rows)
    print(f"ceiling hit rate {hit:.0%} (a p{pct:.0f} ceiling should be hit about {100 - pct:.0f}% of the time)")

    print(f"\n{'tier':18} {'n':>4} {'avg rating':>10} {'avg actual':>10} {'pts/$1K':>8}")
    for floor, name in TIERS:
        t = [r for r in rows if r["tier"] == name]
        if t:
            print(f"{name:18} {len(t):>4} {statistics.mean(r['rating'] for r in t):>10.1f} "
                  f"{statistics.mean(r['act_fp'] for r in t):>10.1f} "
                  f"{statistics.mean(r['act_fp'] / r['salary'] * 1000 for r in t):>8.2f}")

    print("\nrating vs actual DK points, rank correlation within salary tier (higher is better):")
    by_tier = defaultdict(list)
    for r in rows:
        by_tier[next(n for f, n in SALARY_TIERS if r["salary"] >= f)].append(r)
    for _, name in SALARY_TIERS:
        t = by_tier.get(name, [])
        rho = spearman([r["rating"] for r in t], [r["act_fp"] for r in t])
        rho_proj = spearman([r["proj_fp"] for r in t], [r["act_fp"] for r in t])
        if rho is not None:
            print(f"  {name:5} n={len(t):<4} rating {rho:+.2f}   median projection alone {rho_proj:+.2f}")

    own_rows = [r for r in rows if r.get("own") not in (None, "") and r.get("c_leverage") not in (None, "")]
    if own_rows:
        hi = [r for r in own_rows if float(r["c_leverage"]) >= 70]
        lo = [r for r in own_rows if float(r["c_leverage"]) < 70]
        if hi and lo:
            print(f"\nhigh-leverage players: avg actual {statistics.mean(r['act_fp'] for r in hi):.1f} at "
                  f"{statistics.mean(float(r['own']) for r in hi):.1f}% own vs others "
                  f"{statistics.mean(r['act_fp'] for r in lo):.1f} at {statistics.mean(float(r['own']) for r in lo):.1f}%")


def contest_report(path):
    with open(path, newline="") as f:
        rows = list(csv.DictReader(f))
    fees = sum(float(r["entry_fee"]) for r in rows)
    won = sum(float(r["winnings"]) for r in rows)
    roi = (won - fees) / fees if fees else 0
    print(f"\ncontests: {len(rows)} entries, fees ${fees:,.2f}, winnings ${won:,.2f}, ROI {roi:+.1%}")
    print("GPP results are high-variance: judge the model on projection and ceiling accuracy first.")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--results", help="hand-kept contest results CSV")
    args = ap.parse_args()
    rows = attach_actuals(load_rows())
    if not rows:
        print("no finished games in the logs yet")
    else:
        report(rows)
    if args.results:
        contest_report(args.results)


if __name__ == "__main__":
    main()
