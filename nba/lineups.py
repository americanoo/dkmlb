"""Legal DraftKings NBA classic lineups, built and evaluated as combinations.

Roster: PG, SG, SF, PF, C, G, F, UTIL; $50,000 cap; players from at least 2 games.
Solved exactly with an integer program (PuLP + HiGHS), not by taking the top 8 ratings.
Slots are then arranged for late swap: the latest tips go in UTIL, F and G.
"""

from collections import Counter
from datetime import datetime
from itertools import combinations, permutations

import pulp

SLOTS = ["PG", "SG", "SF", "PF", "C", "G", "F", "UTIL"]
SALARY_CAP = 50000
FLEX = ("UTIL", "F", "G")  # most to least flexible: the slots a late swap can fill from more positions


def optimize(players, n=5, min_diff=2, objective="rating"):
    """Top-n lineups by summed `objective`; each differs from every earlier one by >= min_diff players."""
    lineups, games = [], sorted({p["game"] for p in players})
    for _ in range(n):
        prob = pulp.LpProblem("dk_nba", pulp.LpMaximize)
        x = {i: pulp.LpVariable(f"x{i}", cat="Binary") for i in range(len(players))}
        y = {(i, s): pulp.LpVariable(f"y{i}_{s}", cat="Binary")
             for i, p in enumerate(players) for s in p["positions"].split("/") if s in SLOTS}
        prob += pulp.lpSum(players[i][objective] * x[i] for i in x)
        for s in SLOTS:
            prob += pulp.lpSum(v for (i, slot), v in y.items() if slot == s) == 1
        for i in x:
            prob += pulp.lpSum(v for (j, _), v in y.items() if j == i) == x[i]
        prob += pulp.lpSum(players[i]["salary"] * x[i] for i in x) <= SALARY_CAP
        if len(games) >= 2:
            z = {g: pulp.LpVariable(f"g{k}", cat="Binary") for k, g in enumerate(games)}
            for g in games:
                prob += z[g] <= pulp.lpSum(x[i] for i, p in enumerate(players) if p["game"] == g)
            prob += pulp.lpSum(z.values()) >= 2
        for prev in lineups:
            prob += pulp.lpSum(x[i] for i in prev["idx"]) <= len(SLOTS) - min_diff
        prob.solve(pulp.HiGHS(msg=False))
        if pulp.LpStatus[prob.status] != "Optimal":
            break
        idx = [i for i in x if x[i].value() > 0.5]
        lineups.append({"idx": idx, "slots": late_swap_slots([players[i] for i in idx])})
    return lineups


def tip(p):
    return datetime.strptime(p["game_date"] + p["game_time"], "%Y%m%d%I:%M%p")


def late_swap_slots(ps):
    """Legal slot assignment that keeps late swap open: as much of the latest tip-offs as
    possible in the flex slots, the very latest in UTIL, then F, then G."""
    best, best_key = None, None
    for perm in permutations(ps):
        if not all(s in p["positions"].split("/") for s, p in zip(SLOTS, perm)):
            continue
        slots = dict(zip(SLOTS, perm))
        flex_tips = [tip(slots[s]) for s in FLEX]
        key = (sum(t.timestamp() for t in flex_tips), *flex_tips)
        if best_key is None or key > best_key:
            best, best_key = slots, key
    return best


def evaluate(lineup, ceiling_pct=85):
    ps = list(lineup["slots"].values())
    # Joint ceiling: sum the players' simulated outcomes draw by draw, then take the percentile.
    # Draws are independent, so this ignores teammate/game correlation in both directions.
    totals = sorted(sum(p["_sims"][k] for p in ps) for k in range(len(ps[0]["_sims"])))
    owns = [p["own"] for p in ps]
    has_own = all(o is not None for o in owns)
    return {
        "median": round(sum(p["proj_fp"] for p in ps), 1),
        "ceiling": round(totals[min(int(ceiling_pct / 100 * len(totals)), len(totals) - 1)], 1),
        "salary": sum(p["salary"] for p in ps),
        "rating": round(sum(p["rating"] for p in ps) / len(ps), 1),
        "own_total": round(sum(owns), 1) if has_own else None,
        "own_avg": round(sum(owns) / len(owns), 1) if has_own else None,
        "correlation": correlation_notes(ps),
        "risks": lineup_risks(ps, lineup["slots"]),
    }


def correlation_notes(ps):
    notes = []
    teams = Counter(p["team"] for p in ps)
    games = Counter(p["game"] for p in ps)
    for game, n in games.most_common():
        if n < 3:
            continue
        home_away = Counter(p["team"] for p in ps if p["game"] == game)
        split = " + ".join(f"{n_} {t}" for t, n_ in home_away.most_common())
        total = next((p["game_total"] for p in ps if p["game"] == game and p.get("game_total")), None)
        notes.append(f"{n}-player {game} stack ({split})" + (f", total {total:g}" if total else ""))
    # Teammates who both carry heavy usage share the same shots and touches.
    for a, b in combinations(ps, 2):
        if a["team"] == b["team"] and a["comp"]["role"] >= 75 and b["comp"]["role"] >= 75:
            notes.append(f"{a['name']} and {b['name']} compete for {a['team']} usage")
    heavy = [t for t, n in teams.items() if n >= 4]
    if heavy:
        notes.append(f"{teams[heavy[0]]} players from {heavy[0]}: needs that team to hit")
    if all(p["own"] is not None for p in ps):
        own = sum(p["own"] for p in ps)
        notes.append(f"duplication risk {'high' if own >= 250 else 'moderate' if own >= 180 else 'low'} "
                     f"(total ownership {own:.0f}%)")
    else:
        notes.append("duplication risk not assessed (no ownership projections)")
    return notes or ["no notable correlation"]


def lineup_risks(ps, slots):
    risks = [f"{p['name']}: {', '.join(p['risks'])}" for p in ps if p["risk_flags"]]
    first = min(tip(p) for p in ps)
    stuck = [(s, p) for s, p in slots.items() if s not in FLEX and tip(p) > first
             and any(tip(slots[f]) < tip(p) for f in FLEX)]
    for s, p in stuck:
        risks.append(f"late swap: {p['name']} ({p['game_time']}) has to stay in {s}; "
                     f"only another {s} can replace him")
    times = sorted({(datetime.strptime(p["game_time"], "%I:%M%p"), p["game_time"], p["game"]) for p in ps})
    if len(times) > 1:
        risks.append("late news windows: " + "; ".join(f"{g} {t} ET" for _, t, g in times))
    return risks
