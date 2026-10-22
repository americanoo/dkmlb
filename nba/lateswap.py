"""Late-swap plans: how each lineup should change when a questionable player's status is announced.

For every questionable player on the slate, two scenarios are rescored from scratch:
  - ruled out: his minutes and usage go to teammates (injuries.apply_absences), and if he is
    in the lineup he has to be replaced;
  - confirmed active: his risk penalty comes off, which can make him the better play.

Players in games that tip before his are locked. The rest of the lineup can be swapped,
under the cap. A suggested swap has to be caused by the news: it brings in a player the news
helps (a teammate whose projection rises, or the player himself once cleared), plus at most one
cheaper player to make the salary work. Forced swaps are always listed; optional ones only
when they add at least MIN_GAIN rating points across the lineup.
"""

import pulp

import injuries
import lineups as lu
import ratings

QUESTIONABLE = ("Q", "GTD", "D")
MIN_GAIN = 4.0  # summed rating points; about half a rating point per roster spot
AFFECTED_FP = 1.0  # a teammate's projection has to rise this much for the news to count as his
MIN_PROJ, MIN_CEIL = 1.0, 2.0  # an optional swap must also add this much projection or ceiling


def rescore(players, q, case, weights, ceiling_pct, risk_strength, ownership=None):
    """Rated copy of the pool with q ruled out ("out") or cleared to play ("active")."""
    ps = [dict(p) for p in players]
    excluded = {p["name"] for p in players if p.get("excluded")}
    if case == "active":
        for p in ps:
            if p["name"] == q["name"]:
                p["dk_status"], p["injury"] = "", ""
        injuries.apply_absences(ps, excluded=excluded)
    else:
        injuries.apply_absences(ps, assume_out={q["name"]}, excluded=excluded)
    return {p["dk_id"]: p for p in ratings.rate_players(ps, weights, ceiling_pct, risk_strength, ownership)}


def best_swap(lineup, pool, news_tip, affected, forced):
    """Best news-driven re-fill of the lineup's still-open slots, scored on the rescored pool.

    Optional swaps must bring in at least one `affected` player (one the news helps) and may
    add one unaffected player to make the salary work. A forced swap (the lineup's own player
    ruled out) may bring in one more unaffected replacement. Players keep their slots unless a
    swap needs them moved. Returns ({slot: player}, keep_value) or (None, keep_value)."""
    slots = lineup["slots"]
    locked = {s: p for s, p in slots.items() if lu.tip(p) < news_tip}
    open_slots = [s for s in lu.SLOTS if s not in locked]
    keep = sum(pool[slots[s]["dk_id"]]["rating"] if slots[s]["dk_id"] in pool else 0.0 for s in open_slots)
    if not open_slots:
        return None, keep
    current = {slots[s]["dk_id"]: s for s in open_slots}
    locked_ids = {p["dk_id"] for p in locked.values()}
    cands = [p for p in pool.values() if p["dk_id"] not in locked_ids and lu.tip(p) >= news_tip]
    budget = lu.SALARY_CAP - sum(p["salary"] for p in locked.values())

    prob = pulp.LpProblem("late_swap", pulp.LpMaximize)
    y = {(i, s): pulp.LpVariable(f"y{i}_{s}", cat="Binary")
         for i, p in enumerate(cands) for s in open_slots if s in p["positions"].split("/")}
    # A hair of credit for staying put, so equal-value lineups don't reshuffle slots.
    prob += pulp.lpSum((cands[i]["rating"] + (0.001 if current.get(cands[i]["dk_id"]) == s else 0)) * v
                       for (i, s), v in y.items())
    for s in open_slots:
        prob += pulp.lpSum(v for (_, slot), v in y.items() if slot == s) == 1
    for i in range(len(cands)):
        prob += pulp.lpSum(v for (j, _), v in y.items() if j == i) <= 1
    prob += pulp.lpSum(cands[i]["salary"] * v for (i, _), v in y.items()) <= budget
    new_affected = [v for (i, _), v in y.items() if cands[i]["dk_id"] not in current and cands[i]["dk_id"] in affected]
    new_other = [v for (i, _), v in y.items() if cands[i]["dk_id"] not in current and cands[i]["dk_id"] not in affected]
    prob += pulp.lpSum(new_other) <= (2 if forced else 1)
    if not forced:
        prob += pulp.lpSum(new_affected) >= 1
    # DK requires players from at least 2 games.
    locked_games = {p["game"] for p in locked.values()}
    if len(locked_games) < 2:
        games = sorted({p["game"] for p in cands} - locked_games)
        z = {g: pulp.LpVariable(f"g{k}", cat="Binary") for k, g in enumerate(games)}
        for g in games:
            prob += z[g] <= pulp.lpSum(v for (i, _), v in y.items() if cands[i]["game"] == g)
        prob += len(locked_games) + pulp.lpSum(z.values()) >= 2
    prob.solve(pulp.HiGHS(msg=False))
    if pulp.LpStatus[prob.status] != "Optimal":
        return None, keep
    return {s: cands[i] for (i, s), v in y.items() if v.value() > 0.5}, keep


def plan(lineups, players, weights, ceiling_pct=85, risk_strength=10.0, ownership=None):
    """Late-swap plans for each lineup (same order), most urgent first."""
    qs = [p for p in players if (p.get("dk_status") or "").upper() in QUESTIONABLE
          and p.get("proj_fp", 0) > 0 and not p.get("absent") and not p.get("excluded")]
    base = {p["dk_id"]: p for p in players}
    base_proj = {i: p.get("proj_fp", 0) for i, p in base.items()}
    plans = [[] for _ in lineups]
    for q in qs:
        news_tip = lu.tip(q)
        for case in ("out", "active"):
            pool = rescore(players, q, case, weights, ceiling_pct, risk_strength, ownership)
            if case == "out":
                affected = {i for i, p in pool.items() if p["proj_fp"] >= base_proj.get(i, 0) + AFFECTED_FP}
            else:
                affected = {q["dk_id"]} & pool.keys()
            for n, lineup in enumerate(lineups):
                ids = {p["dk_id"] for p in lineup["slots"].values()}
                forced = case == "out" and q["dk_id"] in ids
                if not forced and not affected - ids:
                    continue
                refill, keep = best_swap(lineup, pool, news_tip, affected, forced)
                if refill is None:
                    if forced:
                        plans[n].append(_entry(q, case, forced, [], 0, 0, 0, "no legal swap left"))
                    continue
                moves = [(s, lineup["slots"][s], p) for s, p in refill.items() if p["dk_id"] != lineup["slots"][s]["dk_id"]]
                if not {p["dk_id"] for p in refill.values()} - ids:
                    continue  # only reshuffled slots

                def total(ps, key):
                    # A ruled-out player counts at what he was projected for, not zero, so a
                    # forced swap is measured against the lineup as built.
                    return sum(pool[p["dk_id"]][key] if p["dk_id"] in pool else base[p["dk_id"]].get(key, 0.0)
                               for p in ps)

                old = [lineup["slots"][s] for s in refill]
                gain = total(refill.values(), "rating") - total(old, "rating")
                d_proj = total(refill.values(), "proj_fp") - total(old, "proj_fp")
                d_ceil = total(refill.values(), "ceiling") - total(old, "ceiling")
                if forced or (gain >= MIN_GAIN and (d_proj >= MIN_PROJ or d_ceil >= MIN_CEIL)):
                    plans[n].append(_entry(q, case, forced, moves, gain, d_proj, d_ceil))
    for p in plans:
        p.sort(key=lambda e: (not e["forced"], -e["d_rating"]))
    return plans


def _entry(q, case, forced, moves, gain, d_proj, d_ceil, note=""):
    return {
        "player": q["name"], "team": q["team"], "game": q["game"], "tip": q["game_time"],
        "case": case, "forced": forced, "note": note,
        "moves": [{"slot": s, "out": old["name"], "in": new["name"], "in_team": new["team"],
                   "in_tip": new["game_time"], "in_salary": new["salary"],
                   "moved": new["name"] in {o["name"] for _, o, _ in moves}} for s, old, new in moves],
        "d_rating": round(gain, 1), "d_proj": round(d_proj, 1), "d_ceil": round(d_ceil, 1),
    }


def describe(e):
    """One line for terminal output."""
    head = f"if {e['player']} ({e['team']}, {e['tip']}) is {'OUT' if e['case'] == 'out' else 'ACTIVE'}"
    if e["note"]:
        return f"{head}: {e['note']}"
    swaps = "; ".join(f"{m['slot']}: {m['out']} -> {m['in']} ({m['in_team']}, ${m['in_salary']:,}"
                      + (", moves slots" if m["moved"] else "") + ")" for m in e["moves"])
    tag = "must swap" if e["forced"] else "swap"
    return f"{head}, {tag}: {swaps}  [{e['d_proj']:+g} proj, {e['d_ceil']:+g} ceiling, {e['d_rating']:+g} rating]"
