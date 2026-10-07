#!/usr/bin/env python3
"""Local stats server for DK MLB DFS Research.

Serves the site at http://localhost:8000 and adds a small API that pulls
Statcast data from Baseball Savant through pybaseball:

  GET /api/health                     server + pybaseball status
  GET /api/progress                   progress of the pull in flight
  GET /api/league?role=&start=&end=   every pitch league-wide for a date range,
                                      labeled by batter or pitcher name
  GET /api/players?name=              player search (MLBAM ids)
  GET /api/player?id=&role=&start=&end=   one player's pitches, any date range
  GET /api/team?team=&side=&start=&end=   a team's batting or pitching pitches
  GET /api/totals?kind=&id=|team=&side=   career + season totals (MLB Stats API)
  GET /api/leaders?role=              career + season Statcast totals per player
                                      (Baseball Savant season leaderboards)
  GET /api/dk/slates                  today's DraftKings MLB slates
  GET /api/dk/salaries?id=            a slate's players, as a DKSalaries.csv

League pulls are cached per day under server/cache/, so a repeat or
overlapping date range only downloads the days it hasn't seen.

Run:  python3 server/server.py            (add --lan to reach it from a phone
                                           on the same Wi-Fi, --open to open
                                           the browser)
"""

import argparse
import csv
import datetime as dt
import io
import json
import shutil
import socket
import sys
import threading
import warnings
import webbrowser
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pandas as pd
import requests

try:
    import pybaseball
except ImportError:
    sys.exit("pybaseball is not installed. Run: pip3 install -r server/requirements.txt")

# pybaseball's date parsing trips pandas deprecation warnings on every pull.
warnings.filterwarnings("ignore", category=FutureWarning)

# Bumped whenever the site needs something new from the server; the page
# compares it and asks for a restart when an older server is still running.
SERVER_VERSION = 6

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = Path(__file__).resolve().parent / "cache"
DAY_CACHE = CACHE_DIR / "statcast-v3"
OLD_DAY_CACHES = [CACHE_DIR / "statcast-v1", CACHE_DIR / "statcast-v2"]
NAMES_FILE = CACHE_DIR / "names.json"
LEADER_CACHE = CACHE_DIR / "leaderboards"

# Columns the site reads, plus ids/game type used here for names and filters.
SITE_COLUMNS = [
    "pitch_type", "pitch_name", "game_date", "player_name", "events", "description",
    "stand", "p_throws", "home_team", "away_team", "bb_type", "balls", "strikes",
    "outs_when_up", "inning", "hit_distance_sc", "launch_speed", "launch_angle",
    "effective_speed", "release_speed",
]
# Extra columns for the full stat catalog (wOBA/xwOBA/xBA, zone and chase
# stats, spray direction, spin) and the Lookup tab's filters.
DETAIL_COLUMNS = [
    "inning_topbot", "n_thruorder_pitcher", "zone", "woba_value", "woba_denom",
    "estimated_woba_using_speedangle", "estimated_ba_using_speedangle",
    "hc_x", "hc_y", "release_spin_rate",
]
CACHE_COLUMNS = SITE_COLUMNS + DETAIL_COLUMNS + ["batter", "pitcher", "game_type", "game_pk",
                                                 "at_bat_number", "pitch_number"]
TEAMS = {
    "ATH", "ATL", "AZ", "BAL", "BOS", "CHC", "CIN", "CLE", "COL", "CWS", "DET", "HOU",
    "KC", "LAA", "LAD", "MIA", "MIL", "MIN", "NYM", "NYY", "PHI", "PIT", "SD", "SEA",
    "SF", "STL", "TB", "TEX", "TOR", "WSH",
}

REGULAR_SEASON = {"R"}
POSTSEASON = {"F", "D", "L", "W"}

MAX_LEAGUE_DAYS = 45
MAX_TEAM_DAYS = 45
# Savant keeps correcting a day's data for a while after the games end,
# so only days at least this old are cached permanently.
FINAL_AFTER_DAYS = 2
FETCH_WORKERS = 4

STATS_API = "https://statsapi.mlb.com/api/v1"
STATS_API_PEOPLE = STATS_API + "/people"
TEAM_IDS = {
    "LAA": 108, "AZ": 109, "BAL": 110, "BOS": 111, "CHC": 112, "CIN": 113, "CLE": 114,
    "COL": 115, "DET": 116, "HOU": 117, "KC": 118, "LAD": 119, "WSH": 120, "NYM": 121,
    "ATH": 133, "PIT": 134, "SD": 135, "SEA": 136, "SF": 137, "STL": 138, "TB": 139,
    "TEX": 140, "TOR": 141, "MIN": 142, "PHI": 143, "ATL": 144, "CWS": 145, "MIA": 146,
    "NYY": 147, "MIL": 158,
}

fetch_lock = threading.Lock()
names_lock = threading.Lock()
progress_lock = threading.Lock()
progress = {"active": False, "label": "", "done": 0, "total": 0}


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def set_progress(**kw):
    with progress_lock:
        progress.update(kw)


def bump_progress():
    with progress_lock:
        progress["done"] += 1


# --------------------------------------------------------------------------
# Data shaping
# --------------------------------------------------------------------------

def trim(df):
    """Keep the cached columns, as strings, with blanks for missing values."""
    if df is None or len(df) == 0:
        return pd.DataFrame(columns=CACHE_COLUMNS, dtype=str)
    df = df.copy()
    for col in CACHE_COLUMNS:
        if col not in df.columns:
            df[col] = ""
    df = df[CACHE_COLUMNS]
    df = df.astype(object).where(df.notna(), "")
    for col in ("batter", "pitcher", "game_pk", "at_bat_number", "pitch_number",
                "balls", "strikes", "outs_when_up", "inning", "n_thruorder_pitcher",
                "zone", "woba_denom"):
        df[col] = df[col].map(_int_str)
    df["game_date"] = df["game_date"].map(lambda v: str(v)[:10])
    return df.astype(str)


def _int_str(v):
    if v == "" or v is None:
        return ""
    try:
        return str(int(float(v)))
    except (TypeError, ValueError):
        return str(v)


def filter_game_types(df, postseason):
    allowed = REGULAR_SEASON | (POSTSEASON if postseason else set())
    return df[df["game_type"].isin(allowed)]


def sort_pitches(df):
    if len(df) == 0:
        return df
    keys = pd.DataFrame({
        "d": df["game_date"],
        "g": pd.to_numeric(df["game_pk"], errors="coerce"),
        "ab": pd.to_numeric(df["at_bat_number"], errors="coerce"),
        "p": pd.to_numeric(df["pitch_number"], errors="coerce"),
    })
    return df.loc[keys.sort_values(["d", "g", "ab", "p"]).index]


# --------------------------------------------------------------------------
# Player names
# --------------------------------------------------------------------------

def _load_names():
    try:
        return json.loads(NAMES_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _save_names(names):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    NAMES_FILE.write_text(json.dumps(names, ensure_ascii=False), encoding="utf-8")


def _format_stats_api_name(p):
    last = p.get("useLastName") or p.get("lastName")
    first = p.get("useName") or p.get("firstName")
    if last and first:
        suffix = p.get("nameSuffix")
        return f"{last}{' ' + suffix if suffix else ''}, {first}"
    return p.get("lastFirstName") or p.get("fullName")


def _names_from_stats_api(ids):
    found = {}
    for i in range(0, len(ids), 150):
        chunk = ids[i:i + 150]
        resp = requests.get(STATS_API_PEOPLE, params={"personIds": ",".join(chunk)}, timeout=20)
        resp.raise_for_status()
        for p in resp.json().get("people", []):
            name = _format_stats_api_name(p)
            if name:
                found[str(p["id"])] = name
    return found


def _names_from_chadwick(ids):
    table = pybaseball.playerid_reverse_lookup([int(i) for i in ids], key_type="mlbam")
    found = {}
    for _, row in table.iterrows():
        last = str(row.get("name_last", "")).title()
        first = str(row.get("name_first", "")).title()
        if last and first:
            found[str(int(row["key_mlbam"]))] = f"{last}, {first}"
    return found


def resolve_names(ids, seed=None):
    """Map MLBAM ids to Savant-style "Last, First" names.

    Order: names seen in Savant's own data (seed) -> cache -> MLB Stats API
    -> Chadwick register via pybaseball -> "Player <id>".
    """
    ids = sorted({i for i in ids if i})
    with names_lock:
        names = _load_names()
        changed = False
        for k, v in (seed or {}).items():
            if k and v and names.get(k) != v:
                names[k] = v
                changed = True
        missing = [i for i in ids if i not in names]
        for source in (_names_from_stats_api, _names_from_chadwick):
            if not missing:
                break
            try:
                found = source(missing)
            except Exception as exc:  # network or lookup failure: try the next source
                print(f"  name lookup via {source.__name__} failed: {exc}", file=sys.stderr)
                continue
            names.update(found)
            changed = changed or bool(found)
            missing = [i for i in missing if i not in names]
        if changed:
            _save_names(names)
    return {i: names.get(i, f"Player {i}") for i in ids}


def seed_names(df, id_col):
    """Savant labels player_name with the searched player type's name."""
    pairs = df[[id_col, "player_name"]].drop_duplicates()
    return {r[id_col]: r["player_name"] for _, r in pairs.iterrows() if r[id_col] and r["player_name"]}


def to_payload(df, role, seed=None, detail=False):
    """Rows labeled with the batter's or pitcher's name. detail adds the
    Lookup columns plus opp_player, the name on the other side of each pitch."""
    id_col = "batter" if role == "batter" else "pitcher"
    opp_col = "pitcher" if role == "batter" else "batter"
    ids = df[id_col].unique().tolist()
    if detail:
        ids += df[opp_col].unique().tolist()
    names = resolve_names(ids, seed)
    out = df.copy()
    out["player_name"] = out[id_col].map(lambda i: names.get(i, f"Player {i}"))
    out["player_id"] = out[id_col]
    columns = SITE_COLUMNS + ["player_id"]
    if detail:
        out["opp_player"] = out[opp_col].map(lambda i: names.get(i, f"Player {i}"))
        columns = SITE_COLUMNS + ["player_id"] + DETAIL_COLUMNS + ["opp_player"]
    return {
        "columns": columns,
        "rows": out[columns].values.tolist(),
        "count": int(len(out)),
        "players": int(out[id_col].nunique()),
    }


# --------------------------------------------------------------------------
# Savant pulls
# --------------------------------------------------------------------------

def day_path(day):
    return DAY_CACHE / f"{day.isoformat()}.csv"


def fetch_day(day):
    iso = day.isoformat()
    df = pybaseball.statcast(start_dt=iso, end_dt=iso, verbose=False, parallel=False)
    return trim(df)


def ensure_days(days):
    """Download any days not cached yet. Finished days go to the cache;
    the most recent ones are returned in memory instead."""
    today = dt.date.today()
    missing = [d for d in days if not day_path(d).exists()]
    set_progress(active=True, done=len(days) - len(missing), total=len(days),
                 label=f"Pulling {len(missing)} day(s) from Baseball Savant")
    fresh, errors = {}, []
    if missing:
        DAY_CACHE.mkdir(parents=True, exist_ok=True)
        with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
            futures = {pool.submit(fetch_day, day): day for day in missing}
            for fut in as_completed(futures):
                day = futures[fut]
                try:
                    df = fut.result()
                except Exception as exc:
                    errors.append(f"{day.isoformat()}: {exc}")
                    bump_progress()
                    continue
                if (today - day).days >= FINAL_AFTER_DAYS:
                    df.to_csv(day_path(day), index=False)
                else:
                    fresh[day] = df
                bump_progress()
    if errors:
        raise ApiError(502, "Baseball Savant didn't return data for " + "; ".join(errors[:3]) +
                       (" …" if len(errors) > 3 else "") +
                       ". Days that did load are cached; try again in a minute.")
    return fresh


def iter_day_frames(start, end):
    """Every pitch from start..end (inclusive), one day at a time, so long
    ranges never hold more than a day of league data in memory."""
    days = [start + dt.timedelta(days=n) for n in range((end - start).days + 1)]
    fresh = ensure_days(days)
    for day in days:
        if day in fresh:
            df = fresh[day]
        else:
            df = pd.read_csv(day_path(day), dtype=str, keep_default_na=False)
        if len(df):
            yield df


def load_league(start, end):
    parts = list(iter_day_frames(start, end))
    return pd.concat(parts, ignore_index=True) if parts else trim(None)


def team_mask(df, team, side):
    """Rows where `team` is batting (side=batting) or pitching."""
    top = df["inning_topbot"] == "Top"
    batting = (top & (df["away_team"] == team)) | (~top & (df["home_team"] == team))
    if side == "batting":
        return batting
    return ((df["away_team"] == team) | (df["home_team"] == team)) & ~batting


def load_team(team, side, start, end):
    parts = [df[team_mask(df, team, side)] for df in iter_day_frames(start, end)]
    parts = [p for p in parts if len(p)]
    return pd.concat(parts, ignore_index=True) if parts else trim(None)


def player_search(name):
    name = " ".join(name.split())
    if not name:
        raise ApiError(400, "Type a player name to search.")
    tokens = name.split(" ")
    attempts = []
    if len(tokens) > 1:
        attempts.append((" ".join(tokens[1:]), tokens[0], False))
        attempts.append((tokens[-1], " ".join(tokens[:-1]), False))
    attempts.append((tokens[-1], None, False))
    attempts.append((name, None, True))
    for last, first, fuzzy in attempts:
        try:
            table = pybaseball.playerid_lookup(last, first, fuzzy=fuzzy)
        except Exception as exc:
            raise ApiError(502, f"Player lookup failed: {exc}")
        if table is None or len(table) == 0:
            continue
        table = table[pd.to_numeric(table["key_mlbam"], errors="coerce").fillna(-1) > 0]
        if "mlb_played_last" in table.columns:
            table = table[pd.to_numeric(table["mlb_played_last"], errors="coerce").fillna(0) >= 2008]
        if len(table) == 0:
            continue
        results = []
        for _, r in table.head(15).iterrows():
            first_year = _int_str(r.get("mlb_played_first", ""))
            last_year = _int_str(r.get("mlb_played_last", ""))
            results.append({
                "id": _int_str(r["key_mlbam"]),
                "name": f"{str(r['name_first']).title()} {str(r['name_last']).title()}",
                "years": f"{first_year}–{last_year}" if first_year else "",
            })
        return results
    return []


def load_player(player_id, role, start, end):
    fn = pybaseball.statcast_batter if role == "batter" else pybaseball.statcast_pitcher
    set_progress(active=True, done=0, total=1, label="Pulling player data from Baseball Savant")
    try:
        df = fn(start.isoformat(), end.isoformat(), int(player_id))
    except Exception as exc:
        raise ApiError(502, f"Baseball Savant didn't return data: {exc}. Try again in a minute.")
    bump_progress()
    return trim(df)


# --------------------------------------------------------------------------
# Career / season totals (MLB Stats API, regular season)
# --------------------------------------------------------------------------

HITTING_COUNTS = ["gamesPlayed", "plateAppearances", "atBats", "hits", "doubles", "triples",
                  "homeRuns", "baseOnBalls", "strikeOuts", "hitByPitch", "sacFlies",
                  "totalBases", "numberOfPitches"]
PITCHING_COUNTS = ["gamesPlayed", "battersFaced", "atBats", "hits", "homeRuns", "baseOnBalls",
                   "strikeOuts", "hitByPitch", "earnedRuns", "outs", "numberOfPitches"]


def _f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _outs(stat):
    outs = _f(stat.get("outs"))
    if outs is None and stat.get("inningsPitched") not in (None, ""):
        whole, _, part = str(stat["inningsPitched"]).partition(".")
        outs = int(whole or 0) * 3 + int(part or 0)
    return outs


def _pick_stat(splits, counts):
    """One stat dict for a split list. Traded players get a split per team;
    prefer the combined split, otherwise add the teams' counting stats."""
    splits = [sp for sp in (splits or []) if isinstance(sp.get("stat"), dict)]
    if not splits:
        return None
    combined = [sp for sp in splits if "team" not in sp]
    if combined:
        return combined[0]["stat"]
    if len(splits) == 1:
        return splits[0]["stat"]
    total = {}
    for sp in splits:
        st = sp["stat"]
        for key in counts:
            v = _outs(st) if key == "outs" else _f(st.get(key))
            if v is not None:
                total[key] = total.get(key, 0) + v
    return total


def _ratio(a, b):
    return a / b if a is not None and b else None


def hitting_line(st):
    g = lambda k: _f(st.get(k))
    pa, ab, h = g("plateAppearances"), g("atBats"), g("hits")
    bb, so, hbp, sf = g("baseOnBalls") or 0, g("strikeOuts"), g("hitByPitch") or 0, g("sacFlies") or 0
    tb = g("totalBases")
    if tb is None and h is not None:
        tb = h + (g("doubles") or 0) + 2 * (g("triples") or 0) + 3 * (g("homeRuns") or 0)
    obp = _ratio((h or 0) + bb + hbp, (ab or 0) + bb + hbp + sf) if h is not None else None
    slg = _ratio(tb, ab)
    return {
        "games": g("gamesPlayed"), "pitches": g("numberOfPitches"), "pa": pa,
        "avg": _ratio(h, ab), "obp": obp, "slg": slg,
        "ops": obp + slg if obp is not None and slg is not None else None,
        "k_pct": _ratio(so, pa) * 100 if _ratio(so, pa) is not None else None,
        "bb_pct": _ratio(bb, pa) * 100 if pa else None,
        "hr": g("homeRuns"), "hits": h,
    }


def pitching_line(st):
    g = lambda k: _f(st.get(k))
    bf, so, bb, h, ab = g("battersFaced"), g("strikeOuts"), g("baseOnBalls") or 0, g("hits"), g("atBats")
    outs, er = _outs(st), g("earnedRuns")
    return {
        "games": g("gamesPlayed"), "pitches": g("numberOfPitches"), "pa": bf,
        "ip": f"{int(outs // 3)}.{int(outs % 3)}" if outs is not None else None,
        "era": er * 27 / outs if er is not None and outs else None,
        "whip": (bb + (h or 0)) * 3 / outs if outs else None,
        "k_pct": _ratio(so, bf) * 100 if _ratio(so, bf) is not None else None,
        "bb_pct": _ratio(bb, bf) * 100 if bf else None,
        "avg": _ratio(h, ab), "hr": g("homeRuns"), "hits": h,
    }


def current_season():
    today = dt.date.today()
    return today.year if today.month >= 3 else today.year - 1


def load_totals(kind, key, side):
    group = "hitting" if side == "batting" else "pitching"
    season = current_season()
    if kind == "team":
        url = f"{STATS_API}/teams/{TEAM_IDS[key]}/stats"
        params = {"stats": "season", "group": group, "season": season}
    else:
        url = f"{STATS_API_PEOPLE}/{key}/stats"
        params = {"stats": "career,season", "group": group, "season": season}
    try:
        resp = requests.get(url, params=params, timeout=20)
    except requests.RequestException:
        raise ApiError(502, "MLB's stats site couldn't be reached for career/season totals.")
    if resp.status_code >= 400:
        raise ApiError(502, f"MLB's stats site returned an error ({resp.status_code}) for career/season totals.")
    try:
        data = resp.json()
    except ValueError:
        raise ApiError(502, "MLB's stats site sent an unreadable response for career/season totals.")
    counts = HITTING_COUNTS if group == "hitting" else PITCHING_COUNTS
    to_line = hitting_line if group == "hitting" else pitching_line
    out = {"season_year": season, "career": None, "season": None}
    for block in data.get("stats", []):
        kind_name = str((block.get("type") or {}).get("displayName", "")).lower()
        if kind_name in ("career", "season"):
            stat = _pick_stat(block.get("splits"), counts)
            if stat:
                out[kind_name] = to_line(stat)
    return out


# --------------------------------------------------------------------------
# Career and season totals from Baseball Savant's season leaderboards
# --------------------------------------------------------------------------

STATCAST_FIRST_YEAR = 2015
LEADER_REFRESH_HOURS = 12
LEADERBOARDS = {
    # pybaseball's statcast_*_expected_stats / statcast_*_exitvelo_barrels use these.
    "expected": "/leaderboard/expected_statistics?type={role}&year={year}&position=&team=&min=1&csv=true",
    "statcast": "/leaderboard/statcast?type={role}&year={year}&position=&team=&min=1&csv=true",
    "battedball": "/leaderboard/batted-ball?type={role}&year={year}&min=1&csv=true",
}
# Savant column names vary by leaderboard and over time; the first match wins.
LEADER_FIELDS = {
    "expected": {"pa": ["pa"], "woba": ["woba"], "xwoba": ["est_woba", "xwoba"]},
    "statcast": {
        "bbe": ["attempts", "bbe", "bip"], "hh": ["ev95plus", "hard_hit", "hardhit"],
        "barrels": ["barrels", "barrel"], "avg_ev": ["avg_hit_speed", "exit_velocity_avg"],
        "max_ev": ["max_hit_speed", "exit_velocity_max"], "avg_la": ["avg_hit_angle", "launch_angle_avg"],
    },
    "battedball": {
        "bb_bbe": ["bbe", "bip", "attempts", "n_bbe"],
        "gb_pct": ["gb_rate", "gb_percent", "groundballs_percent", "gb_pct"],
        "fb_pct": ["fb_rate", "fb_percent", "flyballs_percent", "fb_pct"],
        "ld_pct": ["ld_rate", "ld_percent", "linedrives_percent", "ld_pct"],
        "pu_pct": ["pu_rate", "pu_percent", "popups_percent", "pu_pct"],
    },
}
ID_COLUMNS = ["player_id", "id", "mlbam_id", "entity_id", "batter", "pitcher"]
NAME_COLUMNS = ["last_name, first_name", "player_name", "name", "entity_name", "name_display_last_first"]


def leader_path(role, board, year):
    return LEADER_CACHE / f"{role}-{board}-{year}.csv"


def fetch_leaderboard(role, board, year):
    """One season leaderboard as text, cached (the current season refreshes)."""
    path = leader_path(role, board, year)
    fresh_enough = year < current_season() or (
        path.exists() and (dt.datetime.now().timestamp() - path.stat().st_mtime) < LEADER_REFRESH_HOURS * 3600)
    if path.exists() and fresh_enough:
        return path.read_text(encoding="utf-8")
    url = "https://baseballsavant.mlb.com" + LEADERBOARDS[board].format(role=role, year=year)
    resp = requests.get(url, timeout=60)
    resp.raise_for_status()
    text = resp.content.decode("utf-8-sig", errors="replace")
    if "," not in text.split("\n", 1)[0]:
        raise ValueError("not a CSV")
    LEADER_CACHE.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return text


def _first_column(df, names):
    lower = {c.strip().lower(): c for c in df.columns}
    for n in names:
        if n in lower:
            return lower[n]
    return None


def parse_leaderboard(text, board):
    """{player_id: {"name": ..., field: value}} plus the fields found."""
    df = pd.read_csv(io.StringIO(text), dtype=str, keep_default_na=False)
    df.columns = [c.strip() for c in df.columns]
    id_col = _first_column(df, ID_COLUMNS)
    if id_col is None:
        return {}, set()
    name_col = _first_column(df, NAME_COLUMNS)
    last_col, first_col = _first_column(df, ["last_name"]), _first_column(df, ["first_name"])
    found = {}
    for field, names in LEADER_FIELDS[board].items():
        col = _first_column(df, names)
        if col is not None:
            found[field] = col
    # Rates may be fractions (0.45) or percents (45.0); store percents.
    as_fraction = {}
    for field, col in found.items():
        if field.endswith("_pct"):
            vals = pd.to_numeric(df[col], errors="coerce").dropna()
            as_fraction[field] = len(vals) > 0 and vals.max() <= 1.0
    out = {}
    for _, row in df.iterrows():
        pid = _int_str(row[id_col])
        if not pid:
            continue
        if name_col:
            name = row[name_col].strip()
        elif last_col and first_col:
            name = f"{row[last_col].strip()}, {row[first_col].strip()}"
        else:
            name = ""
        rec = {"name": name}
        for field, col in found.items():
            v = _f(row[col])
            if v is not None and as_fraction.get(field):
                v *= 100
            rec[field] = v
        out[pid] = rec
    return out, set(found)


def load_leaders(role):
    """Season (current year) and career (2015 on) lines per player id."""
    season_year = current_season()
    years = list(range(STATCAST_FIRST_YEAR, season_year + 1))
    jobs = [(board, y) for board in LEADERBOARDS for y in years]
    set_progress(active=True, done=0, total=len(jobs), label="Loading Savant leaderboards")
    tables, failed, found_fields = {}, [], set()

    def work(job):
        board, y = job
        return job, parse_leaderboard(fetch_leaderboard(role, board, y), board)

    with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
        futures = [pool.submit(work, j) for j in jobs]
        for fut in as_completed(futures):
            try:
                (board, y), (table, fields) = fut.result()
                tables[(board, y)] = table
                found_fields |= fields
            except Exception as exc:
                failed.append(str(exc)[:120])
            bump_progress()

    def line_for(year_list):
        acc = {}
        for y in year_list:
            for board in LEADERBOARDS:
                for pid, rec in (tables.get((board, y)) or {}).items():
                    a = acc.setdefault(pid, {"name": rec.get("name", ""), "pa": 0, "woba_num": 0, "xwoba_num": 0,
                                             "woba_pa": 0, "xwoba_pa": 0, "bbe": 0, "hh": 0, "barrels": 0,
                                             "ev_num": 0, "ev_bbe": 0, "la_num": 0, "la_bbe": 0, "max_ev": None,
                                             "bb_bbe": 0, "gb": 0, "fb": 0, "ld": 0, "pu": 0, "mix_bbe": 0,
                                             "has": set()})
                    if rec.get("name") and not a["name"]:
                        a["name"] = rec["name"]
                    if board == "expected" and rec.get("pa"):
                        a["pa"] += rec["pa"]
                        a["has"].add("pa")
                        for k in ("woba", "xwoba"):
                            if rec.get(k) is not None:
                                a[k + "_num"] += rec[k] * rec["pa"]
                                a[k + "_pa"] += rec["pa"]
                                a["has"].add(k)
                    if board == "statcast":
                        n = rec.get("bbe") or 0
                        for k in ("bbe", "hh", "barrels"):
                            if rec.get(k) is not None:
                                a[k] += rec[k]
                                a["has"].add(k)
                        if rec.get("avg_ev") is not None and n:
                            a["ev_num"] += rec["avg_ev"] * n
                            a["ev_bbe"] += n
                        if rec.get("avg_la") is not None and n:
                            a["la_num"] += rec["avg_la"] * n
                            a["la_bbe"] += n
                        if rec.get("max_ev") is not None:
                            a["max_ev"] = max(a["max_ev"] or 0, rec["max_ev"])
                    if board == "battedball":
                        # Weight rates by balls in play; fall back to the exit-velo board's count.
                        n = rec.get("bb_bbe") or ((tables.get(("statcast", y)) or {}).get(pid) or {}).get("bbe")
                        if n:
                            a["mix_bbe"] += n
                            for k in ("gb", "fb", "ld", "pu"):
                                if rec.get(k + "_pct") is not None:
                                    a[k] += rec[k + "_pct"] * n / 100
                                    a["has"].add(k + "_pct")
        out = {}
        for pid, a in acc.items():
            line = {"name": a["name"]}
            if "pa" in a["has"]:
                line["pa"] = a["pa"]
            for k in ("woba", "xwoba"):
                if k in a["has"] and a[k + "_pa"]:
                    line[k] = a[k + "_num"] / a[k + "_pa"]
            for k in ("bbe", "hh", "barrels"):
                if k in a["has"]:
                    line[k] = a[k]
            if a["bbe"]:
                if "hh" in a["has"]:
                    line["hardhit_pct"] = a["hh"] / a["bbe"] * 100
                if "barrels" in a["has"]:
                    line["barrel_pct"] = a["barrels"] / a["bbe"] * 100
            if a["ev_bbe"]:
                line["avg_ev"] = a["ev_num"] / a["ev_bbe"]
            if a["la_bbe"]:
                line["avg_la"] = a["la_num"] / a["la_bbe"]
            if a["max_ev"] is not None:
                line["max_ev"] = a["max_ev"]
            for k in ("gb", "fb", "ld", "pu"):
                if k + "_pct" in a["has"] and a["mix_bbe"]:
                    line[k + "_pct"] = a[k] / a["mix_bbe"] * 100
            out[pid] = line
        return out

    wanted = {"pa", "woba", "xwoba", "bbe", "hh", "barrels", "avg_ev", "max_ev", "avg_la",
              "gb_pct", "fb_pct", "ld_pct", "pu_pct"}
    return {
        "role": role,
        "season_year": season_year,
        "career_years": f"{years[0]}–{years[-1]}",
        "season": line_for([season_year]),
        "career": line_for(years),
        "missing": sorted(wanted - found_fields),
        "failed": failed[:5],
        "failed_count": len(failed),
        "fetched": dt.date.today().isoformat(),
    }


# --------------------------------------------------------------------------
# DraftKings slates and salaries (the public endpoints DraftKings' own
# lobby and lineup pages use; no login)
# --------------------------------------------------------------------------

DK_WWW = "https://www.draftkings.com"
DK_API = "https://api.draftkings.com"
# Sent only when a plain request is refused: a browser-like session that has
# first visited the lobby, so it carries DraftKings' cookies.
DK_BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.draftkings.com/",
    "Origin": "https://www.draftkings.com",
}
BLOCKED_STATUSES = {401, 403, 429}
DK_CSV_HEADER = ["Position", "Name + ID", "Name", "ID", "Roster Position", "Salary",
                 "Game Info", "TeamAbbrev", "AvgPointsPerGame"]
PITCHER_POSITIONS = {"SP", "RP", "P"}
ROSTER_SLOT_ORDER = ["P", "C", "1B", "2B", "3B", "SS", "OF", "UTIL", "CPT", "FLEX"]


def roster_position(position):
    """DK's CSV lists eligible slots in lineup order: "1B/C" -> "C/1B"."""
    if position in PITCHER_POSITIONS:
        return "P"
    slots = [x for x in position.split("/") if x]
    rank = {slot: i for i, slot in enumerate(ROSTER_SLOT_ORDER)}
    return "/".join(sorted(slots, key=lambda x: rank.get(x, len(rank))))

try:
    from zoneinfo import ZoneInfo
    EASTERN = ZoneInfo("America/New_York")
except Exception:  # no tz database (some Windows installs): times show in UTC
    EASTERN = None


class DkFail(Exception):
    """One DraftKings request that didn't produce usable data; reason is short."""


dk_browser_lock = threading.Lock()
dk_browser = None


def _browser_session():
    global dk_browser
    with dk_browser_lock:
        if dk_browser is None:
            session = requests.Session()
            session.headers.update(DK_BROWSER_HEADERS)
            try:
                session.get(f"{DK_WWW}/lobby", timeout=20,
                            headers={"Accept": "text/html,application/xhtml+xml,*/*;q=0.8"})
            except requests.RequestException:
                pass  # cookies are a bonus; the session still sends browser headers
            dk_browser = session
        return dk_browser


def dk_fetch(url, params=None):
    """A DraftKings response, trying a plain request first (what open-source
    DraftKings clients send) and a browser-like session if that's refused."""
    reason = "no response"
    for attempt in ("plain", "browser"):
        try:
            if attempt == "plain":
                resp = requests.get(url, params=params, timeout=20)
            else:
                resp = _browser_session().get(url, params=params, timeout=20)
        except requests.RequestException:
            reason = "couldn't connect"
            continue
        if resp.status_code in BLOCKED_STATUSES:
            reason = f"refused ({resp.status_code})"
            continue
        if resp.status_code >= 400:
            raise DkFail(f"error {resp.status_code}")
        return resp
    raise DkFail(reason)


def dk_json(url, params=None):
    resp = dk_fetch(url, params)
    try:
        return resp.json()
    except ValueError:
        raise DkFail("unreadable response")


def dk_get(url, params=None):
    try:
        return dk_json(url, params)
    except DkFail as exc:
        raise ApiError(502, f"DraftKings {exc}. Try again in a minute, or upload the salary CSV instead.")


def parse_dk_time(value):
    """DraftKings sends ISO times ("2026-10-07T23:08:00.0000000Z") or "/Date(ms)/"."""
    if not value:
        return None
    text = str(value)
    if text.startswith("/Date("):
        try:
            ms = int(text[6:].split(")")[0].split("-")[0].split("+")[0])
            return dt.datetime.fromtimestamp(ms / 1000, tz=dt.timezone.utc)
        except ValueError:
            return None
    text = text.replace("Z", "+00:00")
    if "." in text:  # trim 7-digit fractions that fromisoformat rejects on older Pythons
        head, _, tail = text.partition(".")
        frac = "".join(ch for ch in tail if ch.isdigit())
        zone = tail[len(frac):]
        text = f"{head}.{frac[:6]}{zone}"
    try:
        stamp = dt.datetime.fromisoformat(text)
    except ValueError:
        return None
    return stamp if stamp.tzinfo else stamp.replace(tzinfo=dt.timezone.utc)


def eastern(stamp):
    if stamp is None:
        return None, ""
    if EASTERN is not None:
        return stamp.astimezone(EASTERN), "ET"
    return stamp.astimezone(dt.timezone.utc), "UTC"


def game_info(name, start):
    """DK CSV style: "MIL@SD 08/10/2026 09:40PM ET"."""
    matchup = "@".join(part.strip() for part in (name or "").split("@"))
    local, zone = eastern(start)
    when = f" {local.strftime('%m/%d/%Y %I:%M%p')} {zone}" if local else ""
    return (matchup + when).strip()


def _slate_details(group_id):
    try:
        return dk_json(f"{DK_API}/draftgroups/v1/{group_id}").get("draftGroup") or {}
    except DkFail:
        return {}


NON_CLASSIC_WORDS = ("showdown", "single game", "tiers", "snake", "best ball", "in-game")
# Matched against DraftKings' game-type names. Anything not named here counts
# as a full slate, whatever DraftKings calls it ("Classic", "Salary Cap"...).
NON_CLASSIC_TYPES = NON_CLASSIC_WORDS + ("captain", "pick", "single")


def slate_game_type(details, contests, games):
    """(type, how it was decided): from the slate details, else its contests'
    game type, else contest names; a one-game slate is never Classic."""
    game_type = (details.get("contestType") or {}).get("gameType")
    if game_type:
        return game_type, "slate details"
    types = [c.get("gameType") for c in contests if c.get("gameType")]
    if types:
        return max(set(types), key=types.count), "contest game types"
    flagged = sum(1 for c in contests if any(w in str(c.get("n") or "").lower() for w in NON_CLASSIC_WORDS))
    if games == 1:
        return "Single game", "game count"
    if contests and flagged * 2 > len(contests):
        return "Single-game format", "contest names"
    return "Classic", "contest names"


def is_classic_slate(game_type, games):
    if games == 1:
        return False
    kind = (game_type or "").lower()
    return not any(word in kind for word in NON_CLASSIC_TYPES)


def dk_slates(include_all=False):
    """MLB Classic slates DraftKings lists now, plus a count of the others
    (or every slate, with how its type was decided, when include_all)."""
    data = dk_get(f"{DK_WWW}/lobby/getcontests", {"sport": "MLB"})
    groups = [g for g in data.get("DraftGroups") or []
              if g.get("DraftGroupId") and str(g.get("Sport", "MLB")).upper() == "MLB"]
    contests_by_group = {}
    for c in data.get("Contests") or []:
        contests_by_group.setdefault(c.get("dg"), []).append(c)
    with ThreadPoolExecutor(max_workers=6) as pool:
        details = dict(zip([g["DraftGroupId"] for g in groups],
                           pool.map(_slate_details, [g["DraftGroupId"] for g in groups])))
    slates, others = [], {}
    for g in groups:
        gid = g["DraftGroupId"]
        det = details.get(gid) or {}
        contests = contests_by_group.get(gid, [])
        games = g.get("GameCount") or len(det.get("games") or [])
        game_type, decided_by = slate_game_type(det, contests, games)
        is_classic = is_classic_slate(game_type, games)
        if not is_classic:
            others[game_type] = others.get(game_type, 0) + 1
            if not include_all:
                continue
        start = parse_dk_time(det.get("minStartTime") or g.get("StartDateEst") or g.get("StartDate"))
        local, zone = eastern(start)
        suffix = (g.get("ContestStartTimeSuffix") or "").strip().strip("()").strip()
        parts = [f"{games} game{'s' if games != 1 else ''}"]
        if local:
            parts.append(local.strftime("%a %-I:%M %p" if sys.platform != "win32" else "%a %#I:%M %p") + f" {zone}")
        if suffix:
            parts.append(suffix)
        slates.append({
            "id": gid,
            "label": " · ".join(parts),
            "game_type": game_type,
            "games": games,
            "start": start.isoformat() if start else None,
            "contests": len(contests),
            "contest_type_id": g.get("ContestTypeId"),
            "main": suffix.lower() == "main",
        })
        if include_all:
            slates[-1].update(classic=is_classic, type_decided_by=decided_by,
                              contest_names=[c.get("n") for c in contests[:5]])
    slates.sort(key=lambda sl: (sl["start"] or "", -(sl["games"] or 0)))
    return {"slates": slates, "total": len(groups), "other_types": others}


def _salaries_from_draftables(group_id):
    data = dk_json(f"{DK_API}/draftgroups/v1/draftgroups/{group_id}/draftables")
    competitions = {c.get("competitionId"): c for c in data.get("competitions") or []}
    try:
        listing = dk_json(f"{DK_WWW}/lineup/getavailableplayers", {"draftGroupId": group_id})
        ppg = {p.get("pid"): p.get("ppg") for p in listing.get("playerList") or []}
    except DkFail:
        ppg = {}  # DK Avg is a nice-to-have; salaries still load

    # Showdown lists each player twice (captain at 1.5x salary, flex):
    # keep the flex entry so salaries match the classic scale.
    best = {}
    for p in data.get("draftables") or []:
        key = p.get("playerId") or p.get("draftableId")
        if key is None or p.get("salary") is None:
            continue
        if key not in best or p["salary"] < best[key]["salary"]:
            best[key] = p
    if not best:
        raise DkFail("no players listed")

    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(DK_CSV_HEADER)
    for p in sorted(best.values(), key=lambda x: (-x["salary"], x.get("displayName") or "")):
        comp = p.get("competition") or competitions.get(p.get("competitionId")) or {}
        position = p.get("position") or ""
        name = p.get("displayName") or " ".join(filter(None, [p.get("firstName"), p.get("lastName")]))
        draftable_id = p.get("draftableId")
        writer.writerow([
            position,
            f"{name} ({draftable_id})",
            name,
            draftable_id,
            roster_position(position),
            int(p["salary"]),
            game_info(comp.get("name"), parse_dk_time(comp.get("startTime"))),
            p.get("teamAbbreviation") or "",
            ppg.get(p.get("playerId")) or "",
        ])
    return out.getvalue(), len(best)


def count_csv_players(text):
    """Players in a DKSalaries.csv (the table starts at the row naming Position and Salary)."""
    rows = list(csv.reader(io.StringIO(text)))
    for i, row in enumerate(rows):
        if "Position" in row and "Salary" in row:
            col = row.index("Position")
            return sum(1 for r in rows[i + 1:] if len(r) > col and r[col].strip())
    return 0


def _salaries_from_csv_export(group_id, contest_type_id):
    """DraftKings' own "Export to CSV" file for the slate."""
    resp = dk_fetch(f"{DK_WWW}/lineup/getavailableplayerscsv",
                    {"contestTypeId": contest_type_id, "draftGroupId": group_id})
    text = resp.content.decode("utf-8-sig", errors="replace")
    count = count_csv_players(text)
    if not count:
        raise DkFail("didn't return a salary file")
    return text, count


def dk_salaries_csv(group_id, contest_type_id=None):
    reasons = []
    try:
        return _salaries_from_draftables(group_id)
    except DkFail as exc:
        reasons.append(f"player API {exc}")
    if contest_type_id:
        try:
            return _salaries_from_csv_export(group_id, contest_type_id)
        except DkFail as exc:
            reasons.append(f"CSV export {exc}")
    raise ApiError(502, "DraftKings didn't send salaries (" + "; ".join(reasons) + "). "
                        "Upload the salary CSV from DraftKings instead; that always works.")


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

STATIC_PREFIXES = ("/index.html", "/css/", "/js/", "/sample-data/", "/favicon")


def parse_date(qs, key, default=None):
    raw = (qs.get(key) or [""])[0].strip()
    if not raw:
        if default is None:
            raise ApiError(400, f"Missing {key} date.")
        return default
    try:
        return dt.date.fromisoformat(raw)
    except ValueError:
        raise ApiError(400, f"{key} must be a date like 2026-09-27.")


def parse_range(qs, max_days=None, limit_note=None):
    today = dt.date.today()
    start = parse_date(qs, "start")
    end = min(parse_date(qs, "end", today), today)
    if start > end:
        raise ApiError(400, "The start date is after the end date.")
    if max_days and (end - start).days + 1 > max_days:
        raise ApiError(400, limit_note or (
            f"League-wide pulls are limited to {max_days} days at a time "
            f"(that's about {max_days * 4300:,} pitches). Use the Lookup tab for longer ranges."))
    return start, end


def parse_role(qs):
    role = (qs.get("role") or ["batter"])[0]
    if role not in ("batter", "pitcher"):
        raise ApiError(400, "role must be batter or pitcher.")
    return role


def flag(qs, key, default=True):
    raw = (qs.get(key) or [""])[0].lower()
    if raw == "":
        return default
    return raw in ("1", "true", "yes", "on")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        if self.path.startswith("/api/") and not self.path.startswith("/api/progress"):
            sys.stderr.write("  " + (fmt % args) + "\n")

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path.startswith("/api/"):
            self.handle_api(url.path, parse_qs(url.query))
            return
        if url.path == "/":
            self.path = "/index.html"
        elif not url.path.startswith(STATIC_PREFIXES):
            self.send_error(404)
            return
        super().do_GET()

    def handle_api(self, path, qs):
        try:
            if path == "/api/health":
                self.send_json(200, {"ok": True, "version": SERVER_VERSION,
                                     "pybaseball": getattr(pybaseball, "__version__", "?"),
                                     "today": dt.date.today().isoformat()})
            elif path == "/api/progress":
                with progress_lock:
                    self.send_json(200, dict(progress))
            elif path == "/api/league":
                role = parse_role(qs)
                start, end = parse_range(qs, MAX_LEAGUE_DAYS)
                with fetch_lock:
                    try:
                        df = load_league(start, end)
                    finally:
                        set_progress(active=False)
                df = sort_pitches(filter_game_types(df, flag(qs, "postseason")))
                # Savant's league search is pitcher-typed, so its player_name is the pitcher.
                payload = to_payload(df, role, seed_names(df, "pitcher"), detail=True)
                payload.update(start=start.isoformat(), end=end.isoformat(), role=role)
                self.send_json(200, payload)
            elif path == "/api/players":
                self.send_json(200, {"results": player_search((qs.get("name") or [""])[0])})
            elif path == "/api/player":
                role = parse_role(qs)
                player_id = (qs.get("id") or [""])[0]
                if not player_id.isdigit():
                    raise ApiError(400, "Pick a player from the search results first.")
                start, end = parse_range(qs)
                with fetch_lock:
                    try:
                        df = load_player(player_id, role, start, end)
                    finally:
                        set_progress(active=False)
                df = sort_pitches(filter_game_types(df, flag(qs, "postseason")))
                id_col = "batter" if role == "batter" else "pitcher"
                payload = to_payload(df, role, seed_names(df, id_col), detail=True)
                payload.update(start=start.isoformat(), end=end.isoformat(), role=role, id=player_id)
                self.send_json(200, payload)
            elif path == "/api/totals":
                kind = (qs.get("kind") or ["player"])[0]
                side = (qs.get("side") or ["batting"])[0]
                if side not in ("batting", "pitching"):
                    raise ApiError(400, "side must be batting or pitching.")
                if kind == "team":
                    key = (qs.get("team") or [""])[0].upper()
                    if key not in TEAM_IDS:
                        raise ApiError(400, "Pick a team from the list.")
                else:
                    key = (qs.get("id") or [""])[0]
                    if not key.isdigit():
                        raise ApiError(400, "Pick a player from the search results first.")
                self.send_json(200, load_totals(kind, key, side))
            elif path == "/api/leaders":
                role = parse_role(qs)
                with fetch_lock:
                    try:
                        data = load_leaders(role)
                    finally:
                        set_progress(active=False)
                if not data["season"] and not data["career"]:
                    raise ApiError(502, "Baseball Savant's leaderboards didn't load (" +
                                   "; ".join(data["failed"][:2]) + "). Try again in a minute.")
                self.send_json(200, data)
            elif path == "/api/dk/slates":
                self.send_json(200, dk_slates(include_all=flag(qs, "all", default=False)))
            elif path == "/api/dk/salaries":
                group_id = (qs.get("id") or [""])[0]
                if not group_id.isdigit():
                    raise ApiError(400, "Pick a slate first.")
                ct = (qs.get("ct") or [""])[0]
                text, count = dk_salaries_csv(int(group_id), int(ct) if ct.isdigit() else None)
                self.send_json(200, {"csv": text, "count": count, "id": int(group_id)})
            elif path == "/api/team":
                team = (qs.get("team") or [""])[0].upper()
                if team not in TEAMS:
                    raise ApiError(400, "Pick a team from the list.")
                side = (qs.get("side") or ["batting"])[0]
                if side not in ("batting", "pitching"):
                    raise ApiError(400, "side must be batting or pitching.")
                start, end = parse_range(qs, MAX_TEAM_DAYS, f"Team lookups are limited to {MAX_TEAM_DAYS} "
                                                             "days at a time.")
                with fetch_lock:
                    try:
                        df = load_team(team, side, start, end)
                    finally:
                        set_progress(active=False)
                df = sort_pitches(filter_game_types(df, flag(qs, "postseason")))
                role = "batter" if side == "batting" else "pitcher"
                # Day files come from Savant's pitcher-typed search: player_name is the pitcher.
                payload = to_payload(df, role, seed_names(df, "pitcher"), detail=True)
                payload.update(start=start.isoformat(), end=end.isoformat(), team=team, side=side)
                self.send_json(200, payload)
            else:
                raise ApiError(404, "Unknown API endpoint.")
        except ApiError as exc:
            self.send_json(exc.status, {"error": exc.message})
        except Exception as exc:  # keep the server alive and tell the page what broke
            self.send_json(500, {"error": f"Server error: {exc}"})


def lan_address():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return None


def main():
    parser = argparse.ArgumentParser(description="Local stats server for DK MLB DFS Research")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--lan", action="store_true",
                        help="also accept connections from other devices on your network (e.g. your phone)")
    parser.add_argument("--open", action="store_true", help="open the site in your browser")
    args = parser.parse_args()

    for old in OLD_DAY_CACHES:
        shutil.rmtree(old, ignore_errors=True)  # superseded cache formats

    host = "0.0.0.0" if args.lan else "127.0.0.1"
    try:
        server = ThreadingHTTPServer((host, args.port), Handler)
    except OSError as exc:
        sys.exit(f"Couldn't start on port {args.port} ({exc}). Is the server already running? "
                 f"Try --port {args.port + 1}.")
    local_url = f"http://localhost:{args.port}"
    print("DK MLB DFS Research — local stats server")
    print(f"  Open {local_url} in your browser.")
    if args.lan:
        ip = lan_address()
        if ip:
            print(f"  On your phone (same Wi-Fi): http://{ip}:{args.port}")
    print("  Press Ctrl+C to stop.")
    if args.open:
        threading.Timer(0.8, lambda: webbrowser.open(local_url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
