"""Two seasons of NBA box scores, reconstructed Pick6 lines, and a pattern backtest.

Neither DraftKings nor anyone else publishes past Pick6 lines or entry results, so this module:
  1. loads every current-roster player's game logs for the last two full seasons plus this one;
  2. reconstructs the standard (1x) line DK would most likely have posted before each game, from
     the player's previous games only, choosing the rule that best matches the real Pick6 lines
     logged by pick6.py (see calibrate());
  3. replays thousands of entries for any pattern (entry size, More/Less mix, stat) over every
     night of both seasons and counts exactly how many won and lost, and what they returned at
     Pick6's payouts.

Reconstructed lines are an approximation: DK also knows about injuries, rest and role changes
that a player's past games don't show, so a pattern that beats reconstructed lines may not beat
real ones. The real-line record from pick6.py --review is the check on that.

Usage: python3 nba/history.py --calibrate      # how close each line rule is to real Pick6 lines
       python3 nba/history.py --scan           # every pattern, ranked
"""

import argparse
import glob
import json
import os
import random
import statistics
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import dk_nba  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".cache", "history")
LOG_DIR = os.path.join(HERE, "logs")
SEASONS = (2025, 2026, 2027)  # ESPN labels a season by its end year: 2024-25, 2025-26, 2026-27
SEASON_NAMES = {2025: "2024-25", 2026: "2025-26", 2027: "2026-27"}

# Stats Pick6 posts for nearly every rotation player, as box-score components.
STATS = {"Points": ["PTS"], "Rebounds": ["REB"], "Assists": ["AST"], "3-Pointers Made": ["3PM"],
         "Pts + Rebs + Asts": ["PTS", "REB", "AST"]}

# Who gets lines: a rotation player with recent history (Pick6 rarely posts deep bench players).
MIN_PRIOR_GAMES, MIN_RECENT_MINUTES = 5, 20.0
MIN_LINE = {"Points": 5.5, "Rebounds": 2.5, "Assists": 1.5, "3-Pointers Made": 0.5, "Pts + Rebs + Asts": 10.5}
MIN_3PA = 2.5  # 3PM lines only for players who take threes

# Pick6 payout table seen on the live board (pick6.py reads it fresh each day).
PAYOUTS = {2: {2: 3}, 3: {3: 6}, 4: {4: 10}, 5: {5: 12, 4: 1}, 6: {6: 25, 5: 1.5}}


# ---- data --------------------------------------------------------------------------------

def player_ids():
    """{espn_id: (name, current DK team)} for every player on a current roster."""
    teams = dk_nba.get("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams")["sports"][0]["leagues"][0]["teams"]
    out = {}
    for t in teams:
        dk_team = dk_nba.ESPN_TO_DK.get(t["team"]["abbreviation"], t["team"]["abbreviation"])
        roster = dk_nba.get(dk_nba.ESPN_ROSTER.format(team=t["team"]["abbreviation"].lower()))
        for a in roster["athletes"]:
            out[a["id"]] = (a["displayName"], dk_team)
    return out


def season_games(espn_id, season):
    """Regular-season games for one player and season, cached (finished seasons for good)."""
    os.makedirs(CACHE, exist_ok=True)
    stamp = "" if season < max(SEASONS) else "_" + time.strftime("%Y%m%d")
    path = os.path.join(CACHE, f"{espn_id}_{season}{stamp}.json")
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    try:
        games, found = dk_nba.parse_gamelog(dk_nba.get(dk_nba.ESPN_GAMELOG.format(id=espn_id) + f"?season={season}"))
        games = [g for g in games if found == season]
    except Exception:
        return None  # not cached, so a transient failure is retried next run
    with open(path, "w") as f:
        json.dump(games, f)
    return games


def load():
    """[{id, name, team, games: oldest first}] for every current-roster player."""
    ids = player_ids()
    jobs = [(eid, s) for eid in ids for s in SEASONS]
    with ThreadPoolExecutor(8) as ex:
        results = list(ex.map(lambda j: season_games(*j), jobs))
    by_player = defaultdict(list)
    for (eid, _), games in zip(jobs, results):
        by_player[eid].extend(games or [])
    players = []
    for eid, games in by_player.items():
        played = sorted((g for g in games if g["MIN"] > 0), key=lambda g: g["date"])
        if played:
            players.append({"id": eid, "name": ids[eid][0], "team": ids[eid][1], "games": played})
    return players


def et_day(iso):
    return (datetime.fromisoformat(iso.replace("Z", "+00:00")) - timedelta(hours=5)).date().isoformat()


def stat(g, name):
    return sum(g[c] for c in STATS[name])


# ---- reconstructed lines -----------------------------------------------------------------

def half(x):
    """Pick6 lines sit on .5 so nothing pushes: 18.3 -> 18.5, 18.0 -> 18.5, 17.9 -> 17.5."""
    return int(x) + 0.5 if x >= 0 else 0.5


def fair(vals, n):
    """The .5 line that splits his last n games closest to 50/50 (what a book aims for), ties
    going to the line nearer his average. Rounding an average to .5 instead is biased: a
    median of 2 threes becomes 2.5, and his most common result then always counts for Less."""
    window = vals[-n:]
    mean = statistics.mean(window)
    lines = [k + 0.5 for k in range(int(min(window)) - 1, int(max(window)) + 1)]
    return min(lines, key=lambda c: (abs(sum(v > c for v in window) / len(window) - 0.5), abs(c - mean)))


RULES = {
    "L10 average": lambda vals: half(statistics.mean(vals[-10:])),
    "L20 average": lambda vals: half(statistics.mean(vals[-20:])),
    "L5/L20 blend": lambda vals: half(0.4 * statistics.mean(vals[-5:]) + 0.6 * statistics.mean(vals[-20:])),
    "Fair line L10": lambda vals: fair(vals, 10),
    "Fair line L20": lambda vals: fair(vals, 20),
}
DEFAULT_RULE = "Fair line L20"


def prior_values(games, i, name):
    return [stat(g, name) for g in games[:i]]


def calibrate(players, quiet=False):
    """Mean distance between each rule's reconstructed line and the real standard (1x) Pick6
    lines logged by pick6.py. Returns {rule: {stat: (n, mean abs diff, share within 1)}}."""
    by_id = {p["id"]: p for p in players}
    real = {}
    for path in glob.glob(os.path.join(LOG_DIR, "pick6_*.json")):
        for p in json.load(open(path))["picks"]:
            if p["mult"] == 1 and p["stat"] in STATS and p["espn_id"] in by_id:
                real[(p["espn_id"], p["date"], p["stat"])] = p["line"]
    out = {}
    for rule, fn in RULES.items():
        diffs = defaultdict(list)
        for (eid, day, name), line in real.items():
            games = by_id[eid]["games"]
            i = sum(1 for g in games if et_day(g["date"]) < day)
            vals = prior_values(games, i, name)
            if len(vals) >= MIN_PRIOR_GAMES:
                diffs[name].append(fn(vals) - line)
        out[rule] = {name: (len(d), round(statistics.mean(abs(x) for x in d), 2), round(sum(abs(x) <= 1 for x in d) / len(d), 2),
                            round(statistics.mean(d), 2)) for name, d in diffs.items() if d}
    if not quiet:
        print(f"{len(real)} real standard Pick6 lines to compare against")
        for rule, by_stat in out.items():
            n = sum(v[0] for v in by_stat.values())
            mae = sum(v[0] * v[1] for v in by_stat.values()) / n if n else float("nan")
            print(f"  {rule:14} overall mean miss {mae:.2f}   " +
                  "  ".join(f"{k.split()[0]} {v[1]} (bias {v[3]:+})" for k, v in by_stat.items()))
    return out


def overall_miss(cal, rule):
    by_stat = cal.get(rule, {})
    n = sum(v[0] for v in by_stat.values())
    return round(sum(v[0] * v[1] for v in by_stat.values()) / n, 2) if n else None


def props(players, rule):
    """{day: [prop]} where each prop is one player-stat with its reconstructed line and result."""
    fn = RULES[rule]
    out = defaultdict(list)
    for p in players:
        games = p["games"]
        for i in range(MIN_PRIOR_GAMES, len(games)):
            g = games[i]
            recent = games[max(0, i - 10):i]
            if statistics.mean(x["MIN"] for x in recent) < MIN_RECENT_MINUTES:
                continue
            day = et_day(g["date"])
            for name in STATS:
                if name == "3-Pointers Made" and statistics.mean(x["3PA"] for x in recent) < MIN_3PA:
                    continue
                line = fn(prior_values(games, i, name))
                if line < MIN_LINE[name]:
                    continue
                out[day].append({"pid": p["id"], "team": g["team"], "game": day + "|" + "|".join(sorted([g["team"], g["opp"]])),
                                 "stat": name, "line": line, "actual": stat(g, name), "season": g["season"]})
    return out


# ---- pattern backtest --------------------------------------------------------------------

def hits(prop, side):
    return prop["actual"] > prop["line"] if side == "More" else prop["actual"] < prop["line"]


def backtest(by_day, size, n_more, stat_name=None, per_day=60, seed=7, same_game=None):
    """Replay entries of `size` picks with `n_more` More and the rest Less, on `stat_name` (any
    stat if None), one pick per player, at least two teams (Pick6's rules), sampled per night.
    same_game: None = any, False = every pick from a different game, True = all one game."""
    rng = random.Random(seed * 1000 + size * 10 + n_more)
    res = {"entries": 0, "wins": 0, "payout": 0.0, "by_season": defaultdict(lambda: [0, 0]), "leg_hits": 0, "legs": 0}
    sides = ["More"] * n_more + ["Less"] * (size - n_more)
    for day, day_props in by_day.items():
        pool = [p for p in day_props if stat_name is None or p["stat"] == stat_name]
        by_player = defaultdict(list)
        for p in pool:
            by_player[p["pid"]].append(p)
        pids = list(by_player)
        if len(pids) < size:
            continue
        for _ in range(per_day):
            if same_game:
                games = defaultdict(list)
                for pid in pids:
                    games[by_player[pid][0]["game"]].append(pid)
                options = [v for v in games.values() if len(v) >= size]
                if not options:
                    break
                chosen = rng.sample(rng.choice(options), size)
            else:
                chosen = rng.sample(pids, size)
            legs = [rng.choice(by_player[pid]) for pid in chosen]
            if len({leg["team"] for leg in legs}) < 2:
                continue
            if same_game is False and len({leg["game"] for leg in legs}) < size:
                continue
            k = sum(hits(leg, s) for leg, s in zip(legs, sides))
            res["entries"] += 1
            res["legs"] += size
            res["leg_hits"] += k
            won = k == size
            res["wins"] += won
            res["payout"] += PAYOUTS[size].get(k, 0)
            s = res["by_season"][legs[0]["season"]]
            s[0] += 1
            s[1] += won
    n = res["entries"] or 1
    return {
        "size": size, "n_more": n_more, "stat": stat_name or "Any stat",
        "entries": res["entries"], "wins": res["wins"], "losses": res["entries"] - res["wins"],
        "win_pct": round(100 * res["wins"] / n, 2),
        "leg_hit_pct": round(100 * res["leg_hits"] / (res["legs"] or 1), 1),
        "return": round(res["payout"] / n, 3),  # average payout per $1 (1.0 = break even)
        "by_season": {SEASON_NAMES[s]: {"entries": v[0], "wins": v[1], "win_pct": round(100 * v[1] / v[0], 2) if v[0] else None}
                      for s, v in sorted(res["by_season"].items())},
    }


def needed_win_pct(size):
    """All-hit rate a power entry needs to break even (flex sizes also pay partial hits)."""
    return round(100 / PAYOUTS[size][size], 2)


def scan(by_day, sizes=(2, 3, 4, 5, 6), per_day=60):
    rows = []
    for size in sizes:
        for n_more in range(size + 1):
            for name in [None, *STATS]:
                rows.append(backtest(by_day, size, n_more, name, per_day=per_day))
    return rows


def leg_rates(players, rule):
    """Per-stat More/Less hit rates against reconstructed lines, by season: the building block
    every pattern compounds."""
    by_day = props(players, rule)
    out = defaultdict(lambda: [0, 0])
    for day_props in by_day.values():
        for p in day_props:
            k = (p["stat"], p["season"])
            out[k][0] += 1
            out[k][1] += p["actual"] > p["line"]
    return {f"{name} {SEASON_NAMES[s]}": {"n": n, "more_pct": round(100 * m / n, 1), "less_pct": round(100 * (n - m) / n, 1)}
            for (name, s), (n, m) in sorted(out.items())}


COMPACT = ("PTS", "REB", "AST", "STL", "BLK", "TO", "3PM", "3PA", "FGM", "FGA", "FTM", "FTA")


def compact_games(players, ids, components=COMPACT):
    """{espn_id: [[season, *components], ...] oldest first} for the given players, for the board."""
    by_id = {p["id"]: p for p in players}
    return {eid: [[g["season"], *[g[c] for c in components]] for g in by_id[eid]["games"]] for eid in ids if eid in by_id}


def export_for_board(players, rule=DEFAULT_RULE):
    """Pattern scan, per-stat More/Less rates and calibration, cached for the day."""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f"scan_{time.strftime('%Y%m%d')}_{rule.replace(' ', '_')}.json")
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    cal = calibrate(players, quiet=True)
    by_day = props(players, rule)
    out = {
        "rule": rule, "nights": len(by_day), "props": sum(len(v) for v in by_day.values()),
        "players": len(players), "games": sum(len(p["games"]) for p in players),
        "seasons": [SEASON_NAMES[s] for s in SEASONS],
        "calibration": {"real_lines": sum(v[0] for v in cal.get(rule, {}).values()), "miss": overall_miss(cal, rule),
                        "by_stat": {k: {"n": v[0], "miss": v[1], "within1": v[2], "bias": v[3]} for k, v in cal.get(rule, {}).items()}},
        "leg_rates": leg_rates(players, rule),
        "needed": {str(n): needed_win_pct(n) for n in PAYOUTS},
        "scan": scan(by_day),
    }
    with open(path, "w") as f:
        json.dump(out, f)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--calibrate", action="store_true")
    ap.add_argument("--scan", action="store_true")
    ap.add_argument("--rule", choices=RULES)
    args = ap.parse_args()
    players = load()
    print(f"{len(players)} players, {sum(len(p['games']) for p in players):,} games")
    if args.calibrate:
        calibrate(players)
    rule = args.rule or DEFAULT_RULE
    print(f"line rule: {rule}")
    if args.scan:
        by_day = props(players, rule)
        print(f"{len(by_day)} nights, {sum(len(v) for v in by_day.values()):,} props")
        for k, v in leg_rates(players, rule).items():
            print(f"  {k:28} n={v['n']:<6} More {v['more_pct']}%  Less {v['less_pct']}%")
        rows = scan(by_day)
        print(f"\n{'size':>4} {'mix':10} {'stat':18} {'entries':>8} {'won':>7} {'lost':>8} {'win%':>6} {'need':>6} {'return':>7}")
        for r in sorted(rows, key=lambda r: -r["return"]):
            mix = f"{r['n_more']}M/{r['size'] - r['n_more']}L"
            print(f"{r['size']:>4} {mix:10} {r['stat'][:18]:18} {r['entries']:>8,} {r['wins']:>7,} {r['losses']:>8,} "
                  f"{r['win_pct']:>5}% {needed_win_pct(r['size']):>5}% {r['return']:>7}")


if __name__ == "__main__":
    main()
