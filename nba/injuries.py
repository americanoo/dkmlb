"""Shift minutes and usage from absent players to their teammates.

Only what is missing from the teammates' baselines gets redistributed: an absent player's
average minutes over his team's last 10 games. A player who was already sitting (or who
just joined the team) vacates nothing, because the teammates' recent stats already reflect
playing without him.

Redistribution is a heuristic prior (position similarity x room for more minutes; usage
flows mostly to high-usage players), blended with what actually happened in games the
absent player missed when there are enough of them. All constants are starting guesses
to calibrate with review.py.
"""

import math
from statistics import mean

from ratings import position_group

POS_SIM = {frozenset("G"): 1.0, frozenset("F"): 1.0, frozenset("C"): 1.0,
           frozenset("GF"): 0.5, frozenset("FC"): 0.6, frozenset("GC"): 0.15}
MAX_MIN = 40.0          # nobody is projected past this after a bump
USAGE_ELASTICITY = 0.6  # FP/min gain per unit of relative usage gain (efficiency falls as usage rises)
TEAM_WINDOW = 10        # recent team games used to measure what's baked into baselines
WOWY_MIN_WITHOUT = 3    # games without the absent player needed before trusting the split
WOWY_MIN_WITH = 5
# Empirical weight = n / (n + prior). Per-minute production is noisier and more confounded
# (season trends, opponents) than minutes, so it needs more games before it moves anything.
WOWY_PRIOR_MIN = 10
WOWY_PRIOR_RATE = 25


def is_absent(p, assume_out=(), assume_in=()):
    if p["name"] in assume_in:
        return False
    if p["name"] in assume_out:
        return True
    return (p.get("dk_status") or "").upper() == "OUT" or p.get("injury") == "Out"


def team_games(p, team):
    return [g for g in p.get("_games", []) if g.get("team") == team]


def recent_team_events(team, roster):
    dates = {}
    for p in roster:
        for g in team_games(p, team):
            dates[g["event_id"]] = g["date"]
    return sorted(dates, key=dates.get, reverse=True)[:TEAM_WINDOW]


def vacated_minutes(absent, team, recent):
    """Absent player's average minutes over the team's recent games (0 for games he missed)."""
    if not recent:
        return 0.0
    mins = {g["event_id"]: g["MIN"] for g in team_games(absent, team)}
    return sum(mins.get(e, 0.0) for e in recent) / len(recent)


def heuristic_bump(absent, vac_min, mates):
    """{dk_id: (extra minutes, new FP/min, usage gain per minute)} for the active teammates."""
    if vac_min <= 0 or not mates:
        return {}
    group = position_group(absent["positions"])
    extra = {m["dk_id"]: 0.0 for m in mates}
    remaining = vac_min
    for _ in range(3):  # hand overflow from capped players back out
        open_mates = [m for m in mates if m["proj_min"] + extra[m["dk_id"]] < MAX_MIN - 0.1]
        weights = {m["dk_id"]: POS_SIM[frozenset(group + position_group(m["positions"]))]
                   * m["proj_min"] * max(0.05, (38 - m["proj_min"]) / 38) for m in open_mates}
        total = sum(weights.values())
        if remaining <= 0.01 or total <= 0:
            break
        handed = 0.0
        for m in open_mates:
            room = MAX_MIN - m["proj_min"] - extra[m["dk_id"]]
            give = min(room, remaining * weights[m["dk_id"]] / total)
            extra[m["dk_id"]] += give
            handed += give
        remaining -= handed

    vac_usage = absent.get("usage_per_min", 0.0) * vac_min
    pull = {m["dk_id"]: (m["proj_min"] + extra[m["dk_id"]]) * m["usage_per_min"] for m in mates}
    pull_total = sum(pull.values()) or 1.0
    out = {}
    for m in mates:
        new_min = m["proj_min"] + extra[m["dk_id"]]
        du = vac_usage * pull[m["dk_id"]] / pull_total / new_min if new_min else 0.0
        rel = du / m["usage_per_min"] if m["usage_per_min"] else 0.0
        out[m["dk_id"]] = (extra[m["dk_id"]], m["fp_per_min"] * (1 + USAGE_ELASTICITY * rel), du)
    return out


def wowy(mate, absent, team, vac_min):
    """Teammate's minutes and FP/min change in games the absent player missed, scaled to the
    share of his role that's actually vacated. None if the sample is too thin."""
    a_games = team_games(absent, team)
    if not a_games:
        return None
    a_events = {g["event_id"] for g in a_games}
    first, last = min(g["date"] for g in a_games), max(g["date"] for g in a_games)
    games = [g for g in team_games(mate, team) if first <= g["date"] <= last and g["MIN"] > 0]
    without = [g for g in games if g["event_id"] not in a_events]
    with_ = [g for g in games if g["event_id"] in a_events]
    if len(without) < WOWY_MIN_WITHOUT or len(with_) < WOWY_MIN_WITH:
        return None
    share = vac_min / mean(g["MIN"] for g in a_games)

    def fp_pm(rows):
        return sum(g["FP"] for g in rows) / sum(g["MIN"] for g in rows)
    return (len(without),
            share * (mean(g["MIN"] for g in without) - mean(g["MIN"] for g in with_)),
            share * (fp_pm(without) - fp_pm(with_)))


def apply_absences(players, assume_out=(), assume_in=()):
    """Mark absences, bump teammates in place, and return a summary per absent player."""
    for p in players:
        p["absent"] = is_absent(p, assume_out, assume_in)
        p["min_bump"] = p["fp_bump"] = p["usage_bump"] = 0.0
        p["bump_from"], p["if_out"] = [], []
        if "proj_min" in p:
            p["base_proj_min"], p["base_fp_per_min"] = p["proj_min"], p["fp_per_min"]
            p["min_sd"] = p.get("min_sd_l10", 0.0)

    summary = []
    for team in sorted({p["team"] for p in players}):
        roster = [p for p in players if p["team"] == team]
        mates = [p for p in roster if not p["absent"] and "proj_min" in p]
        recent = recent_team_events(team, roster)
        absents = [(a, vacated_minutes(a, team, recent)) for a in roster if a["absent"] and "proj_min" in a]
        summary += [{"team": team, "player": a["name"], "vacated_min": round(v, 1), "gainers": []}
                    for a, v in absents if v < 1.0]
        absents = [(a, v) for a, v in absents if v >= 1.0]
        single = len(absents) == 1

        for a, vac in absents:
            bumps = heuristic_bump(a, vac, mates)
            gainers = []
            for m in mates:
                extra, new_fppm, du = bumps.get(m["dk_id"], (0.0, m["fp_per_min"], 0.0))
                emp = wowy(m, a, team, vac) if single else None
                if emp:
                    n, d_min, d_fppm = emp
                    # A teammate sitting shouldn't cut anyone's minutes; a negative split is noise.
                    w_min, w_rate = n / (n + WOWY_PRIOR_MIN), n / (n + WOWY_PRIOR_RATE)
                    extra = (1 - w_min) * extra + w_min * max(d_min, 0.0)
                    new_fppm = (1 - w_rate) * new_fppm + w_rate * max(m["fp_per_min"] + d_fppm, 0.0)
                extra = min(extra, MAX_MIN - m["proj_min"])
                before = m["proj_min"] * m["fp_per_min"]
                m["proj_min"] += extra
                m["fp_per_min"] = new_fppm
                m["usage_bump"] += du
                gain = m["proj_min"] * m["fp_per_min"] - before
                if abs(gain) >= 0.5:
                    m["bump_from"].append(a["name"])
                    gainers.append((m["name"], round(extra, 1), round(gain, 1), bool(emp)))
            summary.append({"team": team, "player": a["name"], "vacated_min": round(vac, 1),
                            "gainers": sorted(gainers, key=lambda g: -g[2])})

        # Late-news scenarios: what each questionable player sitting would add (not applied).
        for q in roster:
            if q["absent"] or (q.get("dk_status") or "").upper() not in ("Q", "GTD", "D") or "proj_min" not in q:
                continue
            vac = vacated_minutes(q, team, recent)
            others = [m for m in mates if m is not q]
            for dk_id, (extra, new_fppm, _) in heuristic_bump(q, vac, others).items():
                m = next(o for o in others if o["dk_id"] == dk_id)
                gain = (m["proj_min"] + extra) * new_fppm - m["proj_min"] * m["fp_per_min"]
                if gain >= 1.0:
                    m["if_out"].append((q["name"], round(gain, 1)))

    for p in players:
        if "proj_min" not in p:
            continue
        p["proj_min"] = round(p["proj_min"], 1)
        p["fp_per_min"] = round(p["fp_per_min"], 3)
        p["min_bump"] = round(p["proj_min"] - p["base_proj_min"], 1)
        p["usage_bump"] = round(p["usage_bump"], 3)
        p["base_proj_fp"] = round(p["base_proj_min"] * p["base_fp_per_min"], 1)
        p["proj_fp"] = 0.0 if p["absent"] else round(p["proj_min"] * p["fp_per_min"], 1)
        p["fp_bump"] = 0.0 if p["absent"] else round(p["proj_fp"] - p["base_proj_fp"], 1)
        # A role change is less certain than an established role.
        p["min_sd"] = round(math.hypot(p["min_sd"], 0.5 * p["min_bump"]), 1)
    return summary
