"""DraftKings Pick6 (NBA): pull the board's lines, estimate each pick's chance from game logs,
and rank picks by value against Pick6's own payout table.

Pick6 prices every line with a multiplier: the standard line is 1x (a 50/50), easier alternate
lines pay less (0.5x) and harder ones more (up to ~20x). Its implied chance is about 50% / multiplier,
and on real games that price is well calibrated, so it is the starting point. Our evidence moves it:
  - model: 4,000 simulated games from the player's projected minutes (with injury bumps from
    injuries.py) times per-minute production resampled from his latest season of real games
    (recent 10 weighted double), whole games at a time so combos (PRA etc.) keep their correlation;
  - history: how often he actually cleared that exact line in his last 5 / 10 games and season.
Our estimate = 60% model + 40% season hit rate; final probability = DK implied + TRUST x (ours - DK).
Edges therefore come from information the price misses (minutes freed by injuries, role changes).
A pick only counts as an edge when the model AND his real season hit rate both beat the price,
and (early season) when DK's standard line isn't far from his history, which signals a role change.
Every run is logged to nba/logs/; --review grades logged picks against box scores.

A pick's value is final probability x multiplier. Break-even per pick comes from the live payout
table: for an n-pick entry it's the hit rate at which a 1x entry returns exactly its fee.
ASSUMPTION: line multipliers multiply the entry's payout; check the payout your pick slip shows.

Usage: python3 nba/pick6.py [--size 3] [--top 40] [--json out.json]
       python3 nba/pick6.py --review     # how logged picks did, by line type and probability
"""

import argparse
import json
import random
import sys
import time
import zlib
from datetime import datetime, timedelta, timezone

sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))

import dk_nba  # noqa: E402

PICK6 = "https://pick6.draftkings.com"
SKIP_CATEGORIES = {"1st Quarter", "1st 3 Min"}  # partial-game stats can't be modeled from box scores
SIMS = 4000
SAMPLE_GAMES = 82    # latest season of games with real minutes
RECENT_GAMES, RECENT_WEIGHT = 10, 2.0
EARLY_CURRENT_WEIGHT = 5.0  # early season: each of this season's games counts as 5 of last season's
MODEL_WEIGHT = 0.6   # our estimate = 0.6 x model + 0.4 x season hit rate
TRUST = 0.35         # how far our estimate moves Pick6's implied chance; raise only if --review earns it
MAX_IMPLIED = 0.98
MAX_ENTRY_MULT = 2.0  # entries skip long-shot lines: their tiny hit rates make EV estimates fragile
# Early season (under ROLE_CHANGE_GAMES this season), our median outside these multiples of DK's
# standard line means DK likely knows about a role change: no edge.
ROLE_CHANGE_GAMES, ROLE_CHANGE_LOW, ROLE_CHANGE_HIGH = 10, 0.7, 1.4
USAGE_STATS = {"PTS", "AST", "3PM", "3PA", "FGM", "FGA", "FTM", "FTA", "TO"}  # scale with usage bumps

# Pick6 market name -> box-score components summed.
STATS = {
    "Points": ["PTS"], "Rebounds": ["REB"], "Assists": ["AST"], "3-Pointers Made": ["3PM"],
    "Pts + Rebs + Asts": ["PTS", "REB", "AST"], "Pts + Rebs": ["PTS", "REB"], "Pts + Asts": ["PTS", "AST"],
    "Rebs + Asts": ["REB", "AST"], "Points + Rebounds": ["PTS", "REB"], "Points + Assists": ["PTS", "AST"],
    "Assists + Rebounds": ["REB", "AST"], "Steals": ["STL"], "Blocks": ["BLK"], "Steals + Blocks": ["STL", "BLK"],
    "Blks + Stls": ["STL", "BLK"], "Turnovers": ["TO"], "Field Goals Made": ["FGM"],
    "Field Goals Attempted": ["FGA"], "Free Throws Made": ["FTM"], "3-Pointers Attempted": ["3PA"],
}


# ---- Pick6 page data ---------------------------------------------------------------------

def decode_stream(html):
    """The page's loader data, which React Router streams as a flat array of index references."""
    i = html.index("streamController.enqueue(") + len("streamController.enqueue(")
    j = i + 1
    while html[j] != '"':
        j += 2 if html[j] == "\\" else 1
    arr = json.loads(json.loads(html[i:j + 1]).split("\n")[0])
    memo = {}

    def dec(k):
        if isinstance(k, int) and k < 0:
            return None
        if k in memo:
            return memo[k]
        v = arr[k]
        if isinstance(v, list):
            out = memo[k] = []
            out.extend(dec(x) for x in v)
            return out
        if isinstance(v, dict):
            out = memo[k] = {}
            for kk, x in v.items():
                out[str(arr[int(kk[1:])])] = dec(x)
            return out
        return v
    return dec(0)["loaderData"]


def cards_of(loader):
    return next(v["pickCardsResponse"] for v in loader.values() if isinstance(v, dict) and v.get("pickCardsResponse"))


def fetch_board():
    """(pick group, payout packages, [pickCardsResponse per category])."""
    home = decode_stream(dk_nba.get(f"{PICK6}/?sport=NBA", as_json=False))
    shared = home["routes/_homeShared"]
    group = shared["selectedPickGroup"]
    first = cards_of(home)
    responses = [first]
    for cid in first["orderedPickCategoryIds"]:
        name = first["pickCategoryById"].get(str(cid), {}).get("categoryName", "")
        if cid == first["pickCategoryId"] or name in SKIP_CATEGORIES:
            continue
        time.sleep(1)
        try:
            page = dk_nba.get(f"{PICK6}/category/{cid}?sport=NBA&pickGroup={group['pickGroupId']}", as_json=False)
            responses.append(cards_of(decode_stream(page)))
        except Exception as e:  # one category failing shouldn't sink the board
            print(f"warning: Pick6 category {name or cid} not loaded: {e}", file=sys.stderr)
    return group, shared["entryDetails"]["payoutPackages"], responses


def parse_lines(responses):
    """One row per (player, stat, line, side), deduplicated across categories."""
    rows, unmapped = {}, set()
    for pc in responses:
        comps, ents, teams, markets = pc["competitionById"], pc["entityInfoByDkId"], pc["displayTeamById"], pc["pickSixMarketById"]
        for card in pc["pickCardByPickableId"].values():
            if len(card["entities"]) != 1:
                continue  # multi-player cards
            dk = str(card["entities"][0]["dkId"])
            comp = comps[str(card["entities"][0]["compIds"][0])]
            team_id = comp["entityCompByDkId"][dk]["teamId"]
            team = teams[str(team_id)]["name"]
            # A category only lists teams it has players for; the game name always has both.
            sides = [t.strip() for t in comp["name"].split(comp.get("matchUpSeparator") or "@")]
            opp = next((t for t in sides if t != team), "")
            start = datetime.fromisoformat(comp["startTime"][:19]).replace(tzinfo=timezone.utc)
            for m in card["activePickableMarkets"]:
                market = markets[str(m["pickSixMarketId"])]
                if m["isPaused"] or m.get("isLive"):
                    continue
                if market["name"] not in STATS:
                    unmapped.add(market["name"])
                    continue
                for sel in m["activeSelections"]:
                    side = market["propositionNameById"][str(sel["statLinePropositionId"])]
                    key = (dk, market["name"], m["targetValue"], side)
                    rows[key] = {
                        "dk_id": dk, "name": ents[dk]["fullName"], "team": team,
                        "opp": opp, "game": comp["name"], "start": start,
                        "position": comp["entityCompByDkId"][dk].get("position", ""),
                        "stat": market["name"], "line": float(m["targetValue"]), "side": side,
                        "mult": float(sel["standingsMultiplier"]), "promo": m["promoPickTypeId"] != 1,
                    }
    return list(rows.values()), unmapped


# ---- payouts -------------------------------------------------------------------------------

def tiers(packages):
    return {p["pickSetSize"]: {t["numberOfPicksCorrect"]: t["guaranteedMultiplier"] for t in p["payoutTiers"]}
            for p in packages}


def hits_distribution(ps):
    """P(exactly k of the independent picks hit), k = 0..n."""
    dist = [1.0]
    for p in ps:
        nxt = [0.0] * (len(dist) + 1)
        for k, q in enumerate(dist):
            nxt[k] += q * (1 - p)
            nxt[k + 1] += q * p
        dist = nxt
    return dist


def entry_ev(ps, mults, table):
    """Expected return per $1 for one entry (independent picks)."""
    boost = 1.0
    for m in mults:
        boost *= m
    dist = hits_distribution(ps)
    return sum(dist[k] * mult * boost for k, mult in table.items())


def breakeven(table, n):
    """Per-pick hit rate at which an n-pick entry of 1x lines returns its fee."""
    lo, hi = 0.0, 1.0
    for _ in range(60):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if entry_ev([mid] * n, [1.0] * n, table) < 1 else (lo, mid)
    return hi


# ---- probabilities -------------------------------------------------------------------------

def projection_pool(date_et):
    """Our projected players for every DK classic slate on that date, keyed by (name, team)."""
    pool = {}
    for g in dk_nba.get(dk_nba.DK_CONTESTS)["DraftGroups"]:
        if g["GameTypeId"] != dk_nba.CLASSIC_GAME_TYPE or not g["StartDateEst"].startswith(date_et):
            continue
        players, _ = dk_nba.build(g["DraftGroupId"])
        for p in players:
            pool.setdefault((dk_nba.norm_name(p["name"]), p["team"]), p)
    return pool


def fallback_player(name, team, season):
    """Basic projection straight from ESPN for a Pick6 player on no DK slate (no injury bumps)."""
    try:
        match = dk_nba.load_roster(team).get(dk_nba.norm_name(name))
        if not match:
            return None
        games = dk_nba.load_gamelog(match["espn_id"])
        p = {"name": name, "team": team, **match, **dk_nba.summarize(games, season), "_games": games,
             "no_dk_slate": True, "dk_status": ""}
        if not p.get("proj_min"):
            return None
        p["base_fp_per_min"] = p["fp_per_min"]
        p["min_sd"] = p.get("min_sd_l10", 0.0)
        if games and games[0]["team"] != team:
            p["prev_team"] = games[0]["team"]
        return p
    except Exception:
        return None


def simulate(p):
    """SIMS (minutes ratio, game, usage scale) draws for one player, or None if too little data."""
    played = [g for g in p.get("_games", []) if g["MIN"] >= 10][:SAMPLE_GAMES]
    if len(played) < 5:
        return None
    rng = random.Random(zlib.crc32(p["name"].encode()))
    sd = max(p.get("min_sd", p.get("min_sd_l10", 0.0)), 2.0)
    usage = p["fp_per_min"] / p["base_fp_per_min"] if p.get("base_fp_per_min") else 1.0
    if p.get("early"):
        # Early season: this season's games show the current role; last season's count evenly.
        weights = [EARLY_CURRENT_WEIGHT if g["season"] == played[0]["season"] and i < p["early"]["n_cur"] else 1.0
                   for i, g in enumerate(played)]
    else:
        weights = [RECENT_WEIGHT if i < RECENT_GAMES else 1.0 for i in range(len(played))]
    games = rng.choices(played, weights=weights, k=SIMS)
    draws = []
    for g in games:
        minutes = min(max(rng.gauss(p["proj_min"], sd), 0.0), 48.0)
        draws.append((minutes / g["MIN"], g))
    return draws, usage


def stat_value(g, comps, ratio=1.0, usage=1.0):
    return sum(g[c] * ratio * (usage if c in USAGE_STATS else 1.0) for c in comps)


def season_games(played):
    for season in sorted({g["season"] for g in played}, reverse=True):
        rows = [g for g in played if g["season"] == season]
        if len(rows) >= 10:
            return rows
    return played


def evaluate(lines, pool, season):
    sims, out = {}, []
    for row in lines:
        key = (dk_nba.norm_name(row["name"]), row["team"])
        if key not in pool:
            pool[key] = fallback_player(row["name"], row["team"], season)
        p = pool[key]
        if not p or p.get("excluded") or p.get("absent"):
            continue
        if key not in sims:
            sims[key] = simulate(p)
        if not sims[key]:
            continue
        draws, usage = sims[key]
        comps = STATS[row["stat"]]
        values = sorted(round(stat_value(g, comps, ratio, usage)) for ratio, g in draws)
        line, more = row["line"], row["side"] == "More"
        model = sum((v > line) if more else (v < line) for v in values) / len(values)
        played = [g for g in p["_games"] if g["MIN"] > 0]

        def hit_rate(games):
            if not games:
                return None, 0
            k = sum((stat_value(g, comps) > line) if more else (stat_value(g, comps) < line) for g in games)
            return round(100 * k / len(games)), len(games)

        szn = season_games(played)
        hist, n_hist = hit_rate(szn)
        ours = model if hist is None else MODEL_WEIGHT * model + (1 - MODEL_WEIGHT) * hist / 100
        implied = min(0.5 / row["mult"], MAX_IMPLIED)
        prob = implied + TRUST * (ours - implied)
        agree = hist is not None and model > implied and hist / 100 > implied
        flags = []
        if (p.get("dk_status") or "").upper() in ("Q", "GTD", "D"):
            flags.append(f"{p['dk_status']} tag")
        if p.get("prev_team"):
            flags.append(f"new team (games from {p['prev_team']})")
        if p.get("no_dk_slate"):
            flags.append("not on a DK slate: no injury adjustment")
        if p.get("fp_bump", 0) >= 2:
            flags.append(f"+{p['min_bump']} min with {', '.join(p['bump_from'])} out")
        out.append({
            **{k: v for k, v in row.items() if k != "start"},
            "tip": row["start"].astimezone(timezone(timedelta(hours=-4))).strftime("%I:%M%p"),
            "prob": round(100 * prob, 1), "model": round(100 * model, 1), "ours": round(100 * ours, 1),
            "implied": round(100 * implied, 1), "agree": agree,
            "espn_id": p.get("espn_id", ""), "date": row["start"].astimezone(timezone(timedelta(hours=-4))).strftime("%Y-%m-%d"),
            "median": values[len(values) // 2], "p10": values[len(values) // 10], "p90": values[9 * len(values) // 10],
            "proj_min": p["proj_min"], "value": round(prob * row["mult"], 3),
            "l5": hit_rate(played[:5]), "l10": hit_rate(played[:10]), "szn": hit_rate(szn),
            "last10": [[g["date"][5:10].replace("-", "/"), g["opp"], round(g["MIN"]), stat_value(g, comps)] for g in played[:10]],
            "flags": flags,
        })
    flag_role_changes(out, pool)
    return out


def flag_role_changes(picks, pool):
    """Early in a season, a standard line far from his history usually means DK knows about a new
    role (a starter is out, a trade) that his old games can't show. Trust the price there."""
    std = {(p["dk_id"], p["stat"]): p["line"] for p in picks if p["mult"] == 1}
    for p in picks:
        line = std.get((p["dk_id"], p["stat"]))
        player = pool.get((dk_nba.norm_name(p["name"]), p["team"])) or {}
        if line is None or player.get("gp_current", 0) >= ROLE_CHANGE_GAMES or line <= 0:
            continue
        ratio = p["median"] / line
        if ratio < ROLE_CHANGE_LOW or ratio > ROLE_CHANGE_HIGH:
            p["agree"] = False
            p["flags"].insert(0, f"DK's standard line ({line}) is far from his history (median {p['median']}): "
                                 "likely a role change, trust DK")


# ---- entries -------------------------------------------------------------------------------

def best_entries(picks, table, sizes=(2, 3, 4, 5, 6), max_per_game=2):
    """Greedy best entry per size from the highest-value standard picks: one pick per player,
    at least two teams, at most max_per_game picks from one game (picks are treated as
    independent, which same-game picks are not)."""
    legal = sorted((p for p in picks if not p["promo"] and p["mult"] <= MAX_ENTRY_MULT and p["agree"]),
                   key=lambda p: -p["value"])
    out = []
    for n in sizes:
        if n not in table:
            continue
        chosen, players, games = [], set(), {}
        for p in legal:
            if p["dk_id"] in players or games.get(p["game"], 0) >= max_per_game:
                continue
            chosen.append(p)
            players.add(p["dk_id"])
            games[p["game"]] = games.get(p["game"], 0) + 1
            if len(chosen) == n:
                break
        if len(chosen) < n or len({p["team"] for p in chosen}) < 2:
            continue
        ev = entry_ev([p["prob"] / 100 for p in chosen], [p["mult"] for p in chosen], table[n])
        all_hit = 1.0
        for p in chosen:
            all_hit *= p["prob"] / 100
        out.append({"size": n, "ev": round(ev, 3), "all_hit": round(100 * all_hit, 1),
                    "picks": [{k: p[k] for k in ("name", "team", "stat", "line", "side", "mult", "prob", "value")} for p in chosen]})
    return out


def run():
    group, packages, responses = fetch_board()
    table = tiers(packages)
    lines, unmapped = parse_lines(responses)
    if not lines:
        return {"group": group, "lines": [], "unmapped": sorted(unmapped)}
    first = min(r["start"] for r in lines).astimezone(timezone(timedelta(hours=-4)))
    season = first.year + 1 if first.month >= 8 else first.year
    pool = projection_pool(first.strftime("%Y-%m-%d"))
    picks = evaluate(lines, pool, season)
    return {
        "group": {"id": group["pickGroupId"], "label": group.get("contestsStartingTerm", ""),
                  "first_tip": first.strftime("%a %b %-d %I:%M%p ET")},
        "payouts": {str(n): {str(k): v for k, v in t.items()} for n, t in sorted(table.items())},
        "breakeven": {str(n): round(100 * breakeven(t, n), 1) for n, t in sorted(table.items())},
        "picks": picks,
        "entries": best_entries(picks, table),
        "unmapped": sorted(unmapped),
        "trust": TRUST, "model_weight": MODEL_WEIGHT, "max_entry_mult": MAX_ENTRY_MULT,
    }


LOG_DIR = __import__("os").path.join(__import__("os").path.dirname(__import__("os").path.abspath(__file__)), "logs")


def log_run(data):
    os = __import__("os")
    os.makedirs(LOG_DIR, exist_ok=True)
    picks = data["picks"]
    if not picks:
        return None
    path = os.path.join(LOG_DIR, f"pick6_{picks[0]['date']}.json")
    keep = ("name", "team", "opp", "espn_id", "date", "stat", "line", "side", "mult", "promo",
            "implied", "model", "ours", "prob", "value", "agree", "szn")
    with open(path, "w") as f:
        json.dump({"trust": TRUST, "breakeven": data["breakeven"],
                   "picks": [{k: p[k] for k in keep} for p in picks]}, f)
    return path


def review():
    """Grade every logged pick whose game is final, grouped the ways that decide the settings."""
    os, glob = __import__("os"), __import__("glob")
    graded = []
    for path in sorted(glob.glob(os.path.join(LOG_DIR, "pick6_*.json"))):
        for p in json.load(open(path))["picks"]:
            if not p["espn_id"]:
                continue
            try:
                games, _ = dk_nba.parse_gamelog(dk_nba.get(dk_nba.ESPN_GAMELOG.format(id=p["espn_id"])))
            except Exception:
                continue
            day = datetime.strptime(p["date"], "%Y-%m-%d").date()
            g = next((g for g in games if (datetime.fromisoformat(g["date"].replace("Z", "+00:00"))
                                           - timedelta(hours=5)).date() == day), None)
            if g is None or g["MIN"] == 0:
                continue  # not final yet, or he didn't play (Pick6 voids those)
            v = stat_value(g, STATS[p["stat"]])
            graded.append({**p, "hit": v > p["line"] if p["side"] == "More" else v < p["line"]})
    if not graded:
        print("no logged picks with final results yet")
        return

    def show(label, rows):
        if rows:
            hit = sum(r["hit"] for r in rows) / len(rows)
            print(f"  {label:34} n={len(rows):<5} hit {100 * hit:5.1f}%   DK implied {sum(r['implied'] for r in rows) / len(rows):5.1f}%"
                  f"   ours {sum(r['ours'] for r in rows) / len(rows):5.1f}%   final {sum(r['prob'] for r in rows) / len(rows):5.1f}%")
    print(f"{len(graded)} graded picks")
    print("by line type (does DK's price hold up?):")
    for lo, hi, label in ((0, 0.95, "easier lines (<1x)"), (0.95, 1.05, "standard lines (1x)"), (1.05, 2.0, "harder lines (1-2x)"), (2.0, 100, "long shots (>2x)")):
        show(label, [r for r in graded if lo <= r["mult"] < hi])
    print("our edges (model and season both beat DK):")
    show("agree, value above 3-pick break-even", [r for r in graded if r["agree"] and 100 * r["value"] > 55])
    show("agree, any", [r for r in graded if r["agree"]])
    show("everything else", [r for r in graded if not r["agree"]])
    print("If 'agree' picks hit above their DK implied rate over a few hundred picks, TRUST can go up;\n"
          "if they don't beat DK implied, our estimate isn't adding information and TRUST should go down.")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--size", type=int, default=3, help="entry size the edges are measured against")
    ap.add_argument("--top", type=int, default=40)
    ap.add_argument("--json", help="write everything to this file")
    ap.add_argument("--review", action="store_true", help="grade logged picks against results")
    args = ap.parse_args()
    if args.review:
        review()
        return

    data = run()
    logged = log_run(data)
    picks = data["picks"]
    be = data["breakeven"].get(str(args.size))
    print(f"Pick6 NBA {data['group']['label']}, first tip {data['group']['first_tip']}: {len(picks)} picks scored")
    print("break-even per pick: " + "  ".join(f"{n}-pick {v}%" for n, v in data["breakeven"].items()))
    if data["unmapped"]:
        print(f"not modeled: {', '.join(data['unmapped'])}")
    agree = [p for p in picks if p["agree"]]
    print(f"\nedges where model and season history both beat DK's price, best for a {args.size}-pick entry "
          f"(value = prob x multiplier; edge vs {be}% break-even):")
    print(f"{'player':22} {'tm':3} {'stat':18} {'line':>5} {'pick':4} {'mult':>4} {'DK':>5} {'model':>6} {'szn':>8} {'L10':>4} {'final':>6} {'med':>4} {'edge':>6}  flags")
    for p in sorted((p for p in agree if p["mult"] <= MAX_ENTRY_MULT), key=lambda p: -p["value"])[:args.top]:
        szn = f"{p['szn'][0]}%/{p['szn'][1]}" if p["szn"][0] is not None else "-"
        print(f"{p['name'][:22]:22} {p['team']:3} {p['stat'][:18]:18} {p['line']:>5} {p['side'][:4]:4} {p['mult']:>4} "
              f"{p['implied']:>4}% {p['model']:>5}% {szn:>8} {p['l10'][0]:>3}% {p['prob']:>5}% {p['median']:>4} "
              f"{100 * p['value'] - be:>+5.1f}  {'; '.join(p['flags'])}")
    for e in data["entries"]:
        print(f"\n{e['size']}-pick entry: expected return {e['ev']:.2f} per $1, all hit {e['all_hit']}%")
        for p in e["picks"]:
            print(f"  {p['name']} {p['side']} {p['line']} {p['stat']} ({p['mult']}x, {p['prob']}%)")
    if logged:
        print(f"\nlogged to {logged}; run with --review after the games to grade it")
    if args.json:
        with open(args.json, "w") as f:
            json.dump(data, f)


if __name__ == "__main__":
    main()
