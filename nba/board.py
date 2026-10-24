"""Build the NBA Slate Board page: run the model for one or more slates and embed the results.

Usage: python3 nba/board.py OUT.html DRAFT_GROUP "LABEL" [DRAFT_GROUP "LABEL" ...] [--pick6]
  e.g. python3 nba/board.py board.html 155078 "Wed Oct 21 · Main (11 games)"
Labels are "<date> · <slate name>"; the page splits on " · ". Ratings are recomputed in the
page from the component scores, so its weight sliders work without rerunning the model.

Besides the model's outputs, every player carries the raw numbers behind them (box score
averages, minutes and DK-point history, Vegas lines, opponent DvP, his last 10 games and the
projection arithmetic) so the page can be checked rather than taken on trust.
"""

import json
import os
import statistics
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import dk_nba  # noqa: E402
import lateswap  # noqa: E402
import pick6  # noqa: E402
import lineups as lu  # noqa: E402
import ratings  # noqa: E402

TEMPLATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "board_template.html")
DVP_MIN_GAMES = 15  # opponent x position cells with fewer qualifying games show blank


def season_games(played):
    """Most recent regular season with 10+ games played; earlier in a season, the whole sample."""
    for season in sorted({g["season"] for g in played}, reverse=True):
        rows = [g for g in played if g["season"] == season]
        if len(rows) >= 10:
            return rows, season
    return played, (played[0]["season"] if played else None)


def season_label(season):
    return f"{season - 1}-{str(season)[2:]}" if season else ""


def mean(rows, key):
    return sum(g[key] for g in rows) / len(rows) if rows else None


def pct(made, att):
    return round(100 * made / att, 1) if att else None


def r1(v):
    return None if v is None else round(v, 1)


def et_date(iso):
    # ESPN dates are UTC; a 10:30 PM ET tip is the next day in UTC.
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00")) - timedelta(hours=5)
    return dt.strftime("%m/%d")


def compute_dvp(all_players):
    """DK points per minute each opponent allowed to guards / forwards / centers, vs league average.

    Built from every loaded player's game log (latest season, 10+ minute games), grouped by the
    player's current DK position group."""
    by_cell, by_group = defaultdict(lambda: [0.0, 0.0, 0]), defaultdict(lambda: [0.0, 0.0])
    seen = set()
    for p in all_players:
        if p["dk_id"] in seen or not p.get("_games"):
            continue
        seen.add(p["dk_id"])
        group = ratings.position_group(p["positions"])
        played = [g for g in p["_games"] if g["MIN"] >= 10 and "FP" in g]
        rows, _ = season_games(played)
        for g in rows:
            cell = by_cell[(g["opp"], group)]
            cell[0] += g["FP"]
            cell[1] += g["MIN"]
            cell[2] += 1
            by_group[group][0] += g["FP"]
            by_group[group][1] += g["MIN"]
    league = {grp: fp / mins for grp, (fp, mins) in by_group.items() if mins}
    out = {}
    for (opp, grp), (fp, mins, n) in by_cell.items():
        if n >= DVP_MIN_GAMES and grp in league:
            out[(opp, grp)] = (round(100 * (fp / mins / league[grp] - 1), 1), n)
    # Rank opponents within each group: 1 = allows the most.
    for grp in league:
        cells = sorted(((v[0], opp) for (opp, g), v in out.items() if g == grp), reverse=True)
        for rank, (_, opp) in enumerate(cells, 1):
            out[(opp, grp)] = out[(opp, grp)] + (rank, len(cells))
    return out


def player_stats(p, dvp):
    played = [g for g in p.get("_games", []) if g["MIN"] > 0]
    szn, season = season_games(played)
    l5, l10, l20 = played[:5], played[:10], played[:20]
    fp_l10 = [g["FP"] for g in l10]
    target5, target6 = 5 * p["salary"] / 1000, 6 * p["salary"] / 1000
    sims = p["_sims"]
    tot_fga, tot_fgm = sum(g["FGA"] for g in szn), sum(g["FGM"] for g in szn)
    szn_min = sum(g["MIN"] for g in szn)

    def per36(f):
        return r1(36 * sum(f(g) for g in szn) / szn_min) if szn_min else None

    tens = [sum(g[k] >= 10 for k in ("PTS", "REB", "AST", "STL", "BLK")) for g in szn]
    group = ratings.position_group(p["positions"])
    d = dvp.get((p["opp"], group))

    # The projection arithmetic, exactly as dk_nba.summarize and injuries.apply_absences do it.
    all_min = mean(played, "MIN")
    fppm_l10 = sum(g["FP"] for g in l10) / sum(g["MIN"] for g in l10)
    fppm_all = sum(g["FP"] for g in played) / sum(g["MIN"] for g in played)
    math = {
        "min_l5": r1(mean(l5, "MIN")), "min_l10": r1(mean(l10, "MIN")), "min_all": r1(all_min),
        "n_all": len(played), "base_min": p["base_proj_min"],
        "fppm_l10": round(fppm_l10, 3), "fppm_all": round(fppm_all, 3), "base_fppm": round(p["base_fp_per_min"], 3),
        "min": p["proj_min"], "fppm": p["fp_per_min"], "proj": p["proj_fp"], "base_proj": p["base_proj_fp"],
        "bump_min": p["min_bump"], "bump_fp": p["fp_bump"], "bump_from": ", ".join(p["bump_from"]),
        "sims": len(sims), "early": p.get("early"),
    }
    log = [[et_date(g["date"]), "@" if g["away"] else "vs", g["opp"], round(g["MIN"]), g["PTS"], g["REB"], g["AST"],
            g["STL"], g["BLK"], g["TO"], f"{g['FGM']}-{g['FGA']}", f"{g['3PM']}-{g['3PA']}", f"{g['FTM']}-{g['FTA']}",
            round(g["FP"], 2),
            season_label(g["season"])] for g in l10]
    return {
        "ha": "Home" if p["home"] else "Away", "time": p["game_time"], "dk_avg": p["dk_avg_fp"],
        "floor": r1(ratings.quantile(sims, 15)),
        "x5": round(100 * sum(s >= target5 for s in sims) / len(sims)),
        "x6": round(100 * sum(s >= target6 for s in sims) / len(sims)),
        "min_l5": r1(mean(l5, "MIN")), "min_l10": r1(mean(l10, "MIN")), "min_szn": r1(mean(szn, "MIN")),
        "fp_l5": r1(mean(l5, "FP")), "fp_l10": r1(mean(l10, "FP")), "fp_szn": r1(mean(szn, "FP")),
        "fp_hi": r1(max(fp_l10)), "fp_lo": r1(min(fp_l10)),
        "fp_sd": r1(statistics.pstdev([g["FP"] for g in szn])) if len(szn) > 1 else None,
        "fppm_l10": round(fppm_l10, 2), "fppm_szn": round(sum(g["FP"] for g in szn) / szn_min, 2) if szn_min else None,
        "hit5": round(100 * sum(g["FP"] >= target5 for g in l20) / len(l20)),
        "pts": r1(mean(szn, "PTS")), "reb": r1(mean(szn, "REB")), "ast": r1(mean(szn, "AST")),
        "stl": r1(mean(szn, "STL")), "blk": r1(mean(szn, "BLK")), "tov": r1(mean(szn, "TO")),
        "tpm": r1(mean(szn, "3PM")), "fga": r1(mean(szn, "FGA")), "tpa": r1(mean(szn, "3PA")),
        "fta": r1(mean(szn, "FTA")), "fga_l5": r1(mean(l5, "FGA")), "tpa_l5": r1(mean(l5, "3PA")),
        "fta_l5": r1(mean(l5, "FTA")), "fga36": per36(lambda g: g["FGA"]), "tpa36": per36(lambda g: g["3PA"]),
        "fta36": per36(lambda g: g["FTA"]),
        "tpa_rate": pct(sum(g["3PA"] for g in szn), tot_fga),
        "fg_pct": pct(tot_fgm, tot_fga), "tp_pct": pct(sum(g["3PM"] for g in szn), sum(g["3PA"] for g in szn)),
        "ft_pct": pct(sum(g["FTM"] for g in szn), sum(g["FTA"] for g in szn)),
        "pts36": per36(lambda g: g["PTS"]), "reb36": per36(lambda g: g["REB"]), "ast36": per36(lambda g: g["AST"]),
        "stk36": per36(lambda g: g["STL"] + g["BLK"]),
        "usg36": per36(lambda g: g["FGA"] + 0.44 * g["FTA"] + g["TO"]),
        "dd": round(100 * sum(t >= 2 for t in tens) / len(tens)) if tens else None,
        "td": round(100 * sum(t >= 3 for t in tens) / len(tens)) if tens else None,
        "total": p.get("game_total"), "spread": p.get("team_spread"), "implied": p.get("implied_total"),
        "dvp": d[0] if d else None, "dvp_rank": f"{d[2]}/{d[3]}" if d and len(d) > 2 else None,
        "dvp_n": d[1] if d else None, "dvp_group": group,
        "gp": len(szn), "season": season_label(season), "gp_cur": p.get("gp_current", 0),
        "last": played[0]["date"][:10] if played else None,
        "math": math, "log": log,
    }


def export_slate(dg, label, players, absences, dvp):
    weights = ratings.build_weights("gpp", None, {}, leverage_available=False)
    rated = ratings.rate_players(players, weights, 85, 10.0, None)
    built = lu.optimize(rated, n=3, min_diff=2)
    plans = lateswap.plan(built, players, weights, 85, 10.0)

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
        "two_way": sorted(f"{p['name']} ({p['team']})" for p in players if p.get("excluded")),
        "two_way_unchecked": sorted({p["team"] for p in players if not p.get("two_way_checked", True)}),
        "games": sorted({(p["game"], p["game_time"]) for p in rated},
                        key=lambda g: datetime.strptime(g[1], "%I:%M%p")),
        "players": [{
            "name": p["name"], "team": p["team"], "opp": p["opp"], "game": p["game"],
            "pos": p["positions"].replace("/UTIL", ""), "salary": p["salary"],
            "median": p["proj_fp"], "base_median": p["base_proj_fp"], "bump": p["fp_bump"],
            "bump_min": p["min_bump"], "bump_from": ", ".join(p["bump_from"]),
            "ceiling": p["ceiling"], "min": p["proj_min"], "min_sd": p["min_sd"],
            "fppm": p["fp_per_min"], "status": p["dk_status"] or p.get("injury") or "",
            "severity": round(min(1.0, sum(s for _, s in p["risk_flags"])), 2),
            "flags": [r for r, _ in p["risk_flags"]],
            "risks": [r for r in p["risks"] if r not in [f for f, _ in p["risk_flags"]]] + p["notes"],
            "c": {k: p["comp"][k] for k in ratings.COMPONENTS},
            **player_stats(p, dvp),
        } for p in rated],
        "lineups": [{**lu.evaluate(l, 85), "late_swap": plans[k], "slots": [{
            "slot": s, "name": l["slots"][s]["name"], "team": l["slots"][s]["team"], "tip": l["slots"][s]["game_time"],
            "salary": l["slots"][s]["salary"], "median": l["slots"][s]["proj_fp"],
            "ceiling": l["slots"][s]["ceiling"], "rating": l["slots"][s]["rating"],
        } for s in lu.SLOTS]} for k, l in enumerate(built)],
        "absences": [{
            "team": a["team"], "player": a["player"], "vacated_min": a["vacated_min"],
            "gainers": [{"name": n, "min": m, "fp": g} for n, m, g, _ in a["gainers"]],
        } for a in absences],
        "late_news": [{"player": q, "gainers": [{"name": n, "fp": g} for n, g in sorted(v, key=lambda x: -x[1])]}
                      for q, v in late.items()],
    }


def export_pick6():
    """Today's Pick6 board for the page; each player-stat's last 10 games stored once."""
    data = pick6.run()
    pick6.log_run(data)  # graded later by pick6.py --review
    hist = {}
    for p in data["picks"]:
        key = f"{p['dk_id']}|{p['stat']}"
        hist.setdefault(key, p.pop("last10"))
        p["hist"] = key
        for k in ("espn_id", "dk_id", "date"):
            p.pop(k, None)
    data["hist"] = hist
    return data


def main():
    argv = [a for a in sys.argv[1:] if a != "--pick6"]
    with_pick6 = len(argv) != len(sys.argv) - 1
    if len(argv) < 3 or len(argv) % 2 == 0:
        sys.exit(__doc__)
    out_path, args = argv[0], argv[1:]
    loaded = [(int(args[i]), args[i + 1], *dk_nba.build(int(args[i]))) for i in range(0, len(args), 2)]
    # One DvP table from every player loaded, so small slates borrow the bigger sample.
    dvp = compute_dvp([p for _, _, players, _ in loaded for p in players])
    slates = [export_slate(dg, label, players, absences, dvp) for dg, label, players, absences in loaded]
    board = {"slates": slates}
    if with_pick6:
        try:
            board["pick6"] = export_pick6()
        except Exception as e:  # the DFS board still publishes without Pick6
            print(f"warning: Pick6 not added: {e}", file=sys.stderr)
    data = json.dumps(board, separators=(",", ":")).replace("</", "<\\/")
    with open(TEMPLATE) as f:
        page = f.read().replace("/*__DATA__*/", data)
    with open(out_path, "w") as f:
        f.write(page)
    if "pick6" in board:
        print(f"Pick6: {len(board['pick6']['picks'])} picks scored")
    for o in slates:
        print(f"{o['label']}: draft group {o['draft_group']}, {len(o['players'])} players, {len(o['lineups'])} lineups")


if __name__ == "__main__":
    main()
