"""DraftKings NBA classic: pull the slate, join recent ESPN game logs, project points.

NBA DFS is mostly a minutes x production-rate problem, unlike MLB where batting
order, park, and the opposing pitcher drive projections. So the features here are:
  - projected minutes (recent minutes, weighted toward the last 5 games)
  - DK fantasy points per minute (FP/min)
  - usage proxy per minute: FGA + 0.44*FTA + TOV
  - double-double rate (worth +1.5 on DK)
  - injury / starting status (one teammate out can change everyone's minutes)

Usage: python3 nba/dk_nba.py [--draft-group ID] [--csv out.csv]
Stdlib only. stats.nba.com isn't used because it blocks cloud IPs.
"""

import argparse
import csv
import io
import json
import re
import statistics
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import injuries

UA = {"User-Agent": "Mozilla/5.0"}
DK_CONTESTS = "https://www.draftkings.com/lobby/getcontests?sport=NBA"
DK_PLAYERS_CSV = "https://www.draftkings.com/lineup/getavailableplayerscsv?contestTypeId={gt}&draftGroupId={dg}"
ESPN_ROSTER = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/{team}/roster"
ESPN_GAMELOG = "https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/{id}/gamelog"
ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates={date}"

CLASSIC_GAME_TYPE = 70
# DK team abbreviation -> ESPN team abbreviation, where they differ.
DK_TO_ESPN = {"GSW": "GS", "NOP": "NO", "NYK": "NY", "SAS": "SA", "UTA": "UTAH", "WAS": "WSH"}
ESPN_TO_DK = {v: k for k, v in DK_TO_ESPN.items()}

# DK NBA classic scoring.
DK_PTS = {"PTS": 1.0, "3PM": 0.5, "REB": 1.25, "AST": 1.5, "STL": 2.0, "BLK": 2.0, "TO": -0.5}
DD_BONUS, TD_BONUS = 1.5, 3.0


def get(url, as_json=True, tries=3):
    req = urllib.request.Request(url, headers=UA)
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                body = r.read().decode("utf-8-sig")
            break
        except (urllib.error.URLError, TimeoutError):
            if attempt == tries - 1:
                raise
            time.sleep(2 ** attempt)
    return json.loads(body) if as_json else body


def norm_name(name):
    name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    name = re.sub(r"[.'\-]", " ", name.lower())
    name = re.sub(r"\b(jr|sr|ii|iii|iv)\b", "", name)
    return " ".join(name.split())


def dk_fantasy_points(g):
    fp = sum(DK_PTS[k] * g[k] for k in DK_PTS)
    tens = sum(g[k] >= 10 for k in ("PTS", "REB", "AST", "STL", "BLK"))
    if tens >= 3:
        fp += DD_BONUS + TD_BONUS
    elif tens == 2:
        fp += DD_BONUS
    return fp


def pick_draft_group():
    groups = [g for g in get(DK_CONTESTS)["DraftGroups"] if g["GameTypeId"] == CLASSIC_GAME_TYPE]
    if not groups:
        sys.exit("no classic NBA draft groups in the lobby right now")
    # Default to the slate with the most games (the main slate).
    return max(groups, key=lambda g: g["GameCount"])["DraftGroupId"]


def load_slate(draft_group):
    text = get(DK_PLAYERS_CSV.format(gt=CLASSIC_GAME_TYPE, dg=draft_group), as_json=False)
    players = []
    for row in csv.DictReader(io.StringIO(text)):
        home_away, date, clock, _ = row["Game Info"].split()  # "OKC@SAS 10/20/2026 09:30PM ET"
        away, home = home_away.split("@")
        month, day, year = date.split("/")
        players.append({
            "name": row["Name"],
            "dk_id": row["ID"],
            "positions": row["Roster Position"],
            "salary": int(row["Salary"]),
            "team": row["TeamAbbrev"],
            "opp": home if row["TeamAbbrev"] == away else away,
            "home": row["TeamAbbrev"] == home,
            "game": home_away,
            "game_date": year + month + day,
            "game_time": clock,
            "dk_avg_fp": float(row["AvgPointsPerGame"] or 0),
            "dk_status": row["Status"],
            "starting": row["Starting"],
        })
    return players


def load_roster(dk_team):
    data = get(ESPN_ROSTER.format(team=DK_TO_ESPN.get(dk_team, dk_team).lower()))
    out = {}
    for a in data["athletes"]:
        injuries = a.get("injuries") or []
        out[norm_name(a["displayName"])] = {
            "espn_id": a["id"],
            "injury": injuries[0].get("status", "") if injuries else "",
        }
    return out


def split_made_att(s):
    made, att = s.split("-")
    return int(made), int(att)


def load_gamelog(espn_id, min_games=10):
    """Regular-season games, newest first. Early in a season, backfills from last season."""
    games, season_end = parse_gamelog(get(ESPN_GAMELOG.format(id=espn_id)))
    if len(games) < min_games and season_end:
        prior, _ = parse_gamelog(get(ESPN_GAMELOG.format(id=espn_id) + f"?season={season_end - 1}"))
        games += prior
    return games


def parse_gamelog(data):
    labels = data.get("labels", [])
    events = data.get("events", {})
    games, season_end = [], None
    for st in data.get("seasonTypes", []):
        name = st.get("displayName", "")  # e.g. "2025-26 Regular Season"
        # Skip postseason, preseason and "Play In Regular Season".
        if not re.fullmatch(r"\d{4}-\d{2} Regular Season", name):
            continue
        season_end = int(name[:2] + name[5:7])
        for cat in st.get("categories", []):
            for ev in cat.get("events", []):
                row = dict(zip(labels, ev["stats"]))
                fgm, fga = split_made_att(row["FG"])
                tpm, _ = split_made_att(row["3PT"])
                _, fta = split_made_att(row["FT"])
                meta = events.get(ev["eventId"], {})
                team = meta.get("team", {}).get("abbreviation", "")
                games.append({
                    "date": meta.get("gameDate", ""),
                    "event_id": ev["eventId"],
                    "season": season_end,
                    "team": ESPN_TO_DK.get(team, team),
                    "MIN": float(row["MIN"]), "PTS": int(row["PTS"]), "3PM": tpm,
                    "REB": int(row["REB"]), "AST": int(row["AST"]), "STL": int(row["STL"]),
                    "BLK": int(row["BLK"]), "TO": int(row["TO"]), "FGA": fga, "FTA": fta,
                })
        break  # most recent regular season only
    games.sort(key=lambda g: g["date"], reverse=True)
    return games, season_end


def summarize(games, current_season=None):
    played = [g for g in games if g["MIN"] > 0]
    if not played:
        return {}
    for g in played:
        g["FP"] = dk_fantasy_points(g)

    def avg(rows, key):
        return sum(r[key] for r in rows) / len(rows)

    def per_min(rows, f):
        return sum(f(g) for g in rows) / sum(g["MIN"] for g in rows)

    def usage(g):
        return g["FGA"] + 0.44 * g["FTA"] + g["TO"]

    mins = sum(g["MIN"] for g in played)
    l5, l10 = played[:5], played[:10]
    # Minutes drive NBA projections; lean on recent games because roles shift.
    proj_min = 0.5 * avg(l5, "MIN") + 0.3 * avg(l10, "MIN") + 0.2 * avg(played, "MIN")
    # FP/min is more stable, so weight the season more heavily.
    fp_per_min = 0.3 * (sum(g["FP"] for g in l10) / sum(g["MIN"] for g in l10)) + \
        0.7 * (sum(g["FP"] for g in played) / mins)
    dd_rate = sum(sum(g[k] >= 10 for k in ("PTS", "REB", "AST", "STL", "BLK")) >= 2
                  for g in played) / len(played)
    stocks_pm = per_min(played, lambda g: g["STL"] + g["BLK"])
    return {
        "gp": len(played),
        "gp_current": sum(g["season"] == current_season for g in played),
        "min_season": round(avg(played, "MIN"), 1),
        "min_l5": round(avg(l5, "MIN"), 1),
        "min_sd_l10": round(statistics.pstdev([g["MIN"] for g in l10]), 1),
        "proj_min": round(proj_min, 1),
        "fp_per_min": round(fp_per_min, 3),
        "fppg": round(avg(played, "FP"), 1),
        "usage_per_min": round(per_min(played, usage), 3),
        "usage_l10": round(per_min(l10, usage), 3),
        "ast_per_min": round(per_min(played, lambda g: g["AST"]), 3),
        "reb_per_min": round(per_min(played, lambda g: g["REB"]), 3),
        "stocks_per_min": round(stocks_pm, 3),
        # Share of FP from steals + blocks, the most volatile DK stats.
        "stocks_fp_share": round(2 * stocks_pm / fp_per_min, 2) if fp_per_min > 0 else 0,
        "dd_rate": round(dd_rate, 2),
        "proj_fp": round(proj_min * fp_per_min, 1),
        # Per-game FP/min from recent real-minutes games, for ceiling simulation.
        "_rate_samples": [g["FP"] / g["MIN"] for g in played[:30] if g["MIN"] >= 10],
    }


def load_odds(date):
    """Vegas lines from ESPN's scoreboard (DraftKings is ESPN's odds provider), keyed by DK team."""
    out = {}
    for ev in get(ESPN_SCOREBOARD.format(date=date)).get("events", []):
        comp = ev["competitions"][0]
        teams = {c["homeAway"]: ESPN_TO_DK.get(c["team"]["abbreviation"], c["team"]["abbreviation"])
                 for c in comp["competitors"]}
        odds = (comp.get("odds") or [{}])[0]
        total, home_spread = odds.get("overUnder"), odds.get("spread")
        for side, team in teams.items():
            line = {"event_id": ev["id"], "game_total": total, "team_spread": None, "implied_total": None}
            if total is not None and home_spread is not None:
                spread = home_spread if side == "home" else -home_spread
                line.update(team_spread=spread, implied_total=round(total / 2 - spread / 2, 1))
            out[team] = line
    return out


def build(draft_group, assume_out=(), assume_in=()):
    """Enriched slate players plus a summary of injury redistributions."""
    players = load_slate(draft_group)
    teams = sorted({p["team"] for p in players})
    with ThreadPoolExecutor(8) as ex:
        rosters = dict(zip(teams, ex.map(load_roster, teams)))
    odds = {}
    for date in sorted({p["game_date"] for p in players}):
        odds.update(load_odds(date))
    year, month = int(players[0]["game_date"][:4]), int(players[0]["game_date"][4:6])
    current_season = year + 1 if month >= 8 else year  # ESPN labels a season by its end year

    def enrich(p):
        p = {**p, **odds.get(p["team"], {"event_id": "", "game_total": None,
                                          "team_spread": None, "implied_total": None})}
        match = rosters[p["team"]].get(norm_name(p["name"]))
        if not match:
            return {**p, "espn_id": "", "injury": "", "note": "no ESPN match"}
        p = {**p, **match}
        try:
            games = load_gamelog(p["espn_id"])
            p.update(summarize(games, current_season))
            p["_games"] = games
        except Exception as e:  # one bad player shouldn't sink the slate
            p["note"] = f"gamelog error: {e}"
        return p

    with ThreadPoolExecutor(8) as ex:
        out = list(ex.map(enrich, players))
    absences = injuries.apply_absences(out, assume_out, assume_in)
    for p in out:
        if p.get("proj_fp"):
            p["value"] = round(p["proj_fp"] / (p["salary"] / 1000), 2)
    return sorted(out, key=lambda p: p.get("proj_fp", 0), reverse=True), absences


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--draft-group", type=int, help="DK draft group id (default: largest classic slate)")
    ap.add_argument("--csv", help="write full results to this CSV")
    args = ap.parse_args()

    dg = args.draft_group or pick_draft_group()
    rows, _ = build(dg)
    print(f"draft group {dg}: {len(rows)} players\n")
    hdr = f"{'player':24} {'pos':10} {'team':4} {'opp':4} {'sal':>6} {'pMIN':>5} {'FP/m':>5} {'USG/m':>5} {'DD%':>4} {'proj':>5} {'val':>5}  status"
    print(hdr)
    for p in rows:
        if not p.get("proj_fp"):
            continue
        status = " ".join(s for s in (p["dk_status"], p.get("injury", "")) if s)
        print(f"{p['name'][:24]:24} {p['positions'][:10]:10} {p['team']:4} {p['opp']:4} {p['salary']:>6} "
              f"{p['proj_min']:>5} {p['fp_per_min']:>5} {p['usage_per_min']:>5} {p['dd_rate']:>4} "
              f"{p['proj_fp']:>5} {p['value']:>5}  {status}")
    unmatched = [p["name"] for p in rows if p.get("note")]
    if unmatched:
        print(f"\nno projection ({len(unmatched)}): {', '.join(unmatched)}")

    if args.csv:
        keys = sorted({k for p in rows for k in p if not k.startswith("_")})
        with open(args.csv, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=keys, extrasaction="ignore")
            w.writeheader()
            w.writerows(rows)


if __name__ == "__main__":
    main()
