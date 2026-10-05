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

League pulls are cached per day under server/cache/, so a repeat or
overlapping date range only downloads the days it hasn't seen.

Run:  python3 server/server.py            (add --lan to reach it from a phone
                                           on the same Wi-Fi, --open to open
                                           the browser)
"""

import argparse
import datetime as dt
import json
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

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = Path(__file__).resolve().parent / "cache"
DAY_CACHE = CACHE_DIR / "statcast-v1"
NAMES_FILE = CACHE_DIR / "names.json"

# Columns the site reads, plus ids/game type used here for names and filters.
SITE_COLUMNS = [
    "pitch_type", "pitch_name", "game_date", "player_name", "events", "description",
    "stand", "p_throws", "home_team", "away_team", "bb_type", "balls", "strikes",
    "outs_when_up", "inning", "hit_distance_sc", "launch_speed", "launch_angle",
    "effective_speed", "release_speed",
]
CACHE_COLUMNS = SITE_COLUMNS + ["batter", "pitcher", "game_type", "game_pk",
                                "at_bat_number", "pitch_number"]

REGULAR_SEASON = {"R"}
POSTSEASON = {"F", "D", "L", "W"}

MAX_LEAGUE_DAYS = 45
# Savant keeps correcting a day's data for a while after the games end,
# so only days at least this old are cached permanently.
FINAL_AFTER_DAYS = 2
FETCH_WORKERS = 4

STATS_API_PEOPLE = "https://statsapi.mlb.com/api/v1/people"

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
                "balls", "strikes", "outs_when_up", "inning"):
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


def to_payload(df, role, seed=None):
    id_col = "batter" if role == "batter" else "pitcher"
    names = resolve_names(df[id_col].unique().tolist(), seed)
    out = df.copy()
    out["player_name"] = out[id_col].map(lambda i: names.get(i, f"Player {i}"))
    return {
        "columns": SITE_COLUMNS,
        "rows": out[SITE_COLUMNS].values.tolist(),
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


def load_league(start, end):
    """Every pitch from start..end (inclusive), cached per finished day."""
    days = [start + dt.timedelta(days=n) for n in range((end - start).days + 1)]
    today = dt.date.today()
    frames, missing = {}, []
    for day in days:
        path = day_path(day)
        if path.exists():
            frames[day] = pd.read_csv(path, dtype=str, keep_default_na=False)
        else:
            missing.append(day)

    set_progress(active=True, done=len(days) - len(missing), total=len(days),
                 label=f"Pulling {len(missing)} day(s) from Baseball Savant")
    errors = []
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
                frames[day] = df
                if (today - day).days >= FINAL_AFTER_DAYS:
                    df.to_csv(day_path(day), index=False)
                bump_progress()
    if errors:
        raise ApiError(502, "Baseball Savant didn't return data for " + "; ".join(errors[:3]) +
                       (" …" if len(errors) > 3 else "") +
                       ". Days that did load are cached; try again in a minute.")
    parts = [frames[d] for d in days if d in frames and len(frames[d])]
    if not parts:
        return trim(None)
    return pd.concat(parts, ignore_index=True)


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


def parse_range(qs, max_days=None):
    today = dt.date.today()
    start = parse_date(qs, "start")
    end = min(parse_date(qs, "end", today), today)
    if start > end:
        raise ApiError(400, "The start date is after the end date.")
    if max_days and (end - start).days + 1 > max_days:
        raise ApiError(400, f"League-wide pulls are limited to {max_days} days at a time "
                            f"(that's about {max_days * 4300:,} pitches). Use Player lookup for longer ranges.")
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
                self.send_json(200, {"ok": True, "pybaseball": getattr(pybaseball, "__version__", "?"),
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
                payload = to_payload(df, role, seed_names(df, "pitcher"))
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
                payload = to_payload(df, role, seed_names(df, id_col))
                payload.update(start=start.isoformat(), end=end.isoformat(), role=role, id=player_id)
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
