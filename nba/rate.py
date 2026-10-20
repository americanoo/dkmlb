"""Rate a DraftKings NBA slate for a GPP preset and build legal lineups.

Examples:
  python3 nba/rate.py                                  # largest classic slate, default GPP preset
  python3 nba/rate.py --preset high-variance --lineups 10
  python3 nba/rate.py --weight ceiling=25 --weight value=6 --risk-strength 12
  python3 nba/rate.py --ownership own.csv --max-own 40  # CSV columns: Name or ID, Ownership (percent)

Every run logs ratings, components and inputs to nba/logs/ for nba/review.py.
"""

import argparse
import csv
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

import dk_nba  # noqa: E402
import lineups as lu  # noqa: E402
import ratings  # noqa: E402

LOG_DIR = os.path.join(os.path.dirname(__file__), "logs")


def parse_weight(s):
    k, _, v = s.partition("=")
    return k.strip(), float(v)


def load_ownership(path):
    own = {}
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            val = row.get("Ownership") or row.get("ownership") or row.get("Own")
            if val in (None, ""):
                continue
            val = float(str(val).rstrip("%"))
            for key in ("ID", "Name"):
                if row.get(key):
                    own[row[key]] = val
    return own


def show_weights(w, args, leverage_ok):
    parts = "  ".join(f"{k} {v:g}" for k, v in w.items())
    print(f"preset {args.preset}" + (f", prioritize {args.prioritize}" if args.prioritize else "")
          + f" | ceiling p{args.ceiling_pct} | risk strength {args.risk_strength:g}")
    print(f"active weights (sum {sum(w.values()):.0f}): {parts}")
    if not leverage_ok:
        print("LEVERAGE unavailable (no ownership projections): weight moved to projection/ceiling/minutes/role")


def print_absences(absences):
    if not absences:
        print("\nno absences that change teammates' baselines")
        return
    print("\nabsences (minutes vacated vs. teammates' recent baselines):")
    for a in absences:
        if a["vacated_min"] < 1:
            print(f"  {a['team']} {a['player']} out: already reflected in teammates' recent games")
            continue
        gains = ", ".join(f"{n} +{m:g} min / {g:+g} FP" + (" [wowy]" if emp else "")
                          for n, m, g, emp in a["gainers"][:4]) or "no meaningful shift"
        print(f"  {a['team']} {a['player']} out, {a['vacated_min']:g} min: {gains}")


def print_players(rated, top):
    print(f"\n{'player':24} {'sal':>6} {'median':>6} {'ceil':>6} {'rating':>6} {'tier':17} {'own':>5}  positives | risks")
    for p in rated[:top]:
        own = f"{p['own']:.1f}" if p["own"] is not None else "n/a"
        pos = ", ".join(p["positives"]) or "-"
        risk = ", ".join(p["risks"] + p["notes"]) or "-"
        print(f"{p['name'][:24]:24} {p['salary']:>6} {p['proj_fp']:>6} {p['ceiling']:>6} {p['rating']:>6} "
              f"{p['tier']:17} {own:>5}  {pos} | {risk}")


def print_lineups(built, ceiling_pct):
    for n, lineup in enumerate(built, 1):
        ev = lu.evaluate(lineup, ceiling_pct)
        own = f", own {ev['own_total']}% total / {ev['own_avg']}% avg" if ev["own_total"] is not None else ""
        print(f"\nLineup {n}: rating {ev['rating']} | median {ev['median']} | ceiling p{ceiling_pct} {ev['ceiling']} "
              f"| salary ${ev['salary']:,}{own}")
        for slot in lu.SLOTS:
            p = lineup["slots"][slot]
            print(f"  {slot:4} {p['name']:24} {p['team']:4} ${p['salary']:>6,}  {p['proj_fp']:>5} / {p['ceiling']:>5}  "
                  f"rating {p['rating']}")
        print("  correlation: " + "; ".join(ev["correlation"]))
        if ev["risks"]:
            print("  risks: " + "; ".join(ev["risks"]))


def write_log(rated, weights, args, draft_group):
    os.makedirs(LOG_DIR, exist_ok=True)
    date = rated[0]["game_date"] if rated else "unknown"
    path = os.path.join(LOG_DIR, f"{date}_{draft_group}_{args.preset}.csv")
    fields = ["game_date", "draft_group", "preset", "weights", "ceiling_pct", "risk_strength", "name", "dk_id", "espn_id", "event_id", "team",
              "opp", "salary", "positions", "dk_status", "injury", "proj_min", "min_sd", "min_bump",
              "base_proj_fp", "fp_bump", "proj_fp", "ceiling",
              "own", "rating", "raw_rating", "risk_penalty", "tier"] + [f"c_{k}" for k in ratings.COMPONENTS]
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for p in rated:
            w.writerow({**p, "draft_group": draft_group, "preset": args.preset, "weights": json.dumps(weights),
                        "ceiling_pct": args.ceiling_pct, "risk_strength": args.risk_strength,
                        **{f"c_{k}": v for k, v in p["comp"].items()}})
    return path


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--draft-group", type=int)
    ap.add_argument("--preset", choices=ratings.PRESETS, default="gpp")
    ap.add_argument("--prioritize", choices=ratings.PRIORITIES)
    ap.add_argument("--weight", action="append", type=parse_weight, default=[], metavar="COMPONENT=N",
                    help="pin a component weight; the others rescale so the total stays 100")
    ap.add_argument("--risk-strength", type=float, default=10.0, help="max risk penalty, 0-15 (default 10)")
    ap.add_argument("--ceiling-pct", type=int, default=85, choices=range(70, 100), metavar="70-99")
    ap.add_argument("--ownership", help="CSV of projected ownership; enables LEVERAGE")
    ap.add_argument("--min-own", type=float, help="exclude players below this ownership from lineups")
    ap.add_argument("--max-own", type=float, help="exclude players above this ownership from lineups")
    ap.add_argument("--lineups", type=int, default=3)
    ap.add_argument("--min-diff", type=int, default=2, help="players each lineup must differ by")
    ap.add_argument("--top", type=int, default=40, help="players to print")
    ap.add_argument("--assume-out", action="append", default=[], metavar="NAME",
                    help="treat a player as out (late-news scenario); repeatable")
    ap.add_argument("--assume-in", action="append", default=[], metavar="NAME",
                    help="treat a player listed as out as playing; repeatable")
    ap.add_argument("--no-log", action="store_true")
    args = ap.parse_args()
    if not 0 <= args.risk_strength <= 15:
        ap.error("--risk-strength must be 0-15")

    ownership = load_ownership(args.ownership) if args.ownership else None
    dg = args.draft_group or dk_nba.pick_draft_group()
    players, absences = dk_nba.build(dg, set(args.assume_out), set(args.assume_in))

    # Leverage needs ownership for every rateable player; partial data would be fabricated by omission.
    rateable = [p for p in players if p.get("proj_fp", 0) > 0]
    leverage_ok = bool(ownership) and all(
        p["dk_id"] in ownership or p["name"] in ownership for p in rateable)
    if ownership and not leverage_ok:
        missing = [p["name"] for p in rateable if p["dk_id"] not in ownership and p["name"] not in ownership]
        print(f"ownership file is missing {len(missing)} players (e.g. {', '.join(missing[:3])}); LEVERAGE disabled")
    weights = ratings.build_weights(args.preset, args.prioritize, dict(args.weight), leverage_ok)
    rated = ratings.rate_players(players, weights, args.ceiling_pct, args.risk_strength,
                                 ownership if leverage_ok else None)

    print(f"draft group {dg}: {len(rated)} rated players of {len(players)}")
    show_weights(weights, args, leverage_ok)
    print_absences(absences)
    print_players(rated, args.top)

    pool = rated
    if args.min_own is not None or args.max_own is not None:
        if leverage_ok:
            pool = [p for p in rated if (args.min_own is None or p["own"] >= args.min_own)
                    and (args.max_own is None or p["own"] <= args.max_own)]
        else:
            print("\n--min-own/--max-own ignored: no complete ownership projections")
    built = lu.optimize(pool, n=args.lineups, min_diff=args.min_diff) if args.lineups else []
    if args.lineups and not built:
        print("\nno legal lineup from this pool")
    print_lineups(built, args.ceiling_pct)

    if not args.no_log:
        print(f"\nlogged to {write_log(rated, weights, args, dg)}")


if __name__ == "__main__":
    main()
