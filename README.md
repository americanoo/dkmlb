# DK MLB DFS Research

A zero-dependency static site for DraftKings MLB DFS research built around
Baseball Savant statcast exports and the DraftKings salary CSV.

Open `index.html` in a browser (no server or build step needed), or host the
repo on GitHub Pages. To pull stats straight from Baseball Savant instead of
uploading CSVs, run the local stats server below.

## Local stats server (pybaseball)

A small Python server on your computer pulls Statcast data from Baseball
Savant through [pybaseball](https://github.com/jldbc/pybaseball) and serves the
site at http://localhost:8000.

**Start it:** double-click `start-server.command` (Mac) or `start-server.bat`
(Windows). The first run creates a private Python environment in
`server/.venv` and installs pybaseball, which takes a minute; after that it
starts in seconds and opens the site in your browser. Needs Python 3 from
python.org. To run it by hand instead:

```
pip3 install -r server/requirements.txt
python3 server/server.py            # --lan: also reachable from your phone on the same Wi-Fi
```

Leave the terminal window open while you use the site; close it (or Ctrl+C)
to stop the server.

When the server is running, the site shows a **Pull from Baseball Savant**
panel:

- **Batters / Pitchers date ranges** (defaults: last 8 days for batters,
  last 30 for pitchers; 5d / 10d / 15d buttons set the batter range in one
  click) and **Include postseason**. One click pulls every
  pitch league-wide for each range, so batters get true pitches seen and
  pitchers get full pitch-level data. Up to 45 days per pull.
- Pulled days are cached in `server/cache/`, so a repeat or overlapping range
  only downloads the days it hasn't seen. The most recent two days are always
  re-downloaded, since Savant keeps correcting them after the games end.
- If Savant fails on a day, the pull stops with a message naming the day;
  the days that did load stay cached, so trying again is quick.

The **Lookup** tab looks up any **player** (as a batter or pitcher) or any
**team** (batting or pitching) without downloading a season of pitch data.
Each lookup shows:

- **Career** (players) and **this season**: MLB's official regular-season
  totals from the MLB Stats API: PA, AVG, OBP, SLG, OPS, K%, BB%, HR and
  hits, plus IP, ERA and WHIP for pitchers. One small request.
- **Last 15, 10 and 5 days**: full Statcast detail from a single 15-day
  pull, including Pitches, AVG/OBP/SLG/OPS, wOBA, xwOBA, K%, BB%, Whiff% and
  Chase% (plus CSW% and velo for pitchers), and the contact stats (BBE, HH,
  HardHit%, Barrel%, EV, LA, SweetSpot%, distance, HR, XBH, hits). For
  hitters, the last-5-days row is highlighted as the key window.

Click a day row to open it: a player row lists every plate appearance (the
opposing pitcher or batter, inning, count, pitch, velo, result, xwOBA); a
team row lists each player's line for that window (click any column to
sort), and each player opens to their plate appearances. Add as many lookups
as you like to compare them; looking someone up again refreshes their entry.
Lookups don't affect the Batters/Pitchers tabs or ratings.

**Filters** split the day rows instantly, without re-downloading: pitcher
hand, batter hand, pitch type or group (fastballs, breaking, offspeed), count
(first pitch, hitter ahead, pitcher ahead, even, two strikes, full),
home/away, opponent, innings (1–3, 4–6, 7+), and times through the order.
Two **contact** filters, batted-ball type and minimum exit velo, narrow only
the contact columns and the PA list, so a 95+ mph filter doesn't distort K%
or AVG. Career and season rows are official totals and ignore filters.

If MLB's stats site doesn't respond, the lookup still shows the day rows and
says the totals didn't load; looking the player up again retries.

**Batted balls: All / 95+ mph** (Batters tab). The 95+ setting matches a
Savant search filtered to exit velo 95+: EV, LA, distance, barrels, HR, hits
and field outs come from hard-hit balls in play only, while Pitches and K
still count every pitch. "All batted balls" uses every ball in play, which
makes HardHit% meaningful. Foul balls never count as batted balls, even
though Statcast records exit velo on many of them.

## Workflow

1. **Batter Savant CSV** — upload a statcast search export for batters
   (event-level data). Repeated player rows are averaged into one line per
   player: Avg/Max EV, Avg LA, Barrel%, HardHit%, SweetSpot%, Avg Distance,
   plus raw counts over the full timeframe of the upload — pitches seen,
   batted-ball events, hard-hit balls (95+ mph), HR, XBH, Hits, Field Outs,
   and Strikeouts. Complete pitch-level or at-bat data works too:
   strikeouts and walks carry no launch data, so they add to the counts
   without diluting the averages. Both the cleaned column subset and the
   full raw Savant export work — extra columns are ignored. (With a
   batted-ball-only export, Pitches equals BBE by construction; upload
   all-pitch data to get true pitches seen.)
2. **Pitcher Savant CSV** — upload a statcast search export for pitchers
   (pitch-level data). Aggregated per pitcher: K%, BB%, Whiff%, CSW%,
   Avg Velo, EV Against, HardHit% Against, HR/Hits allowed.
3. **DK Salaries CSV** — upload the DraftKings lineup-builder template.
   Players are matched by name (handles "Last, First" vs "First Last",
   accents, and suffixes like Jr.) and get Salary, Position, Team, DK Avg
   points, and a **Value** column (rating per $1k of salary). A
   "DK slate only" checkbox filters to just the slate.
4. **Vegas tab** — an editable grid for manually entered Vegas data, one row
   per team side: game total (O/U), moneyline, implied team total, and the
   % of bets / % of handle on that side. "Build matchups from DK slate"
   prefills the team/opponent rows from the salary file's Game Info column.
   Leave Implied Total blank and it is estimated from the O/U and both
   moneylines (de-vigged win probability run through an inverted
   pythagorean expectation). Entries save automatically in the browser and
   join to players by DK team abbreviation: batters get their team's
   implied total, O/U, ML, Bets% and Handle%; pitchers get the same plus
   the opponent's implied total. Matching rating weights are available for
   Implied Team Total, Bets% and Handle% (batters) and Opp Implied Total
   and Moneyline (pitchers, inverted).

Click any player row to expand their full event history, sorted by date
(newest first). Pitcher history shows plate-appearance results.

## Rating system

The weights are a **10-point budget** per tab: spread up to 10 points
across the stats, and maxing one stat at 10 leaves nothing for the rest —
the sliders enforce it, and a "Points left" counter shows what remains.
Each weighted stat is min-max scaled 0–1 across the current player pool
(stats marked ↓, like EV Against, are inverted so lower is better), and
every weight point buys up to one rating point, so a fully allocated
budget rates players 0–10. All weights start at 0 — the rating stays
blank until points are assigned. Weights are saved in your browser and
ratings update live.

Other tools:

- Sortable columns (click a header, click again to reverse)
- Handedness splits: batters vs LHP/RHP, pitchers vs LHB/RHB
- Player search and minimum-sample filter (Min BBE / Min pitches)
- Everything auto-saves in the browser and reloads on the next visit:
  uploads and Vegas entries in IndexedDB (gigabyte-scale quota, so large
  raw Savant exports fit; falls back to localStorage where IndexedDB is
  unavailable, and data saved by older versions is migrated automatically),
  weights in localStorage. A failed save shows an alert instead of failing
  silently. `Clear data` wipes stored uploads. Storage is per browser and
  per site address — a different device, browser, or host URL starts empty.

## Notes on the stats

- **Barrel%** is the standard Statcast approximation from EV + LA
  (98 mph opens a 26–30° window that widens with velocity to 8–50° at 116+).
- **HardHit%** = batted balls at 95+ mph. If your Savant search is already
  filtered to hard-hit balls, this will read 100% by construction.
- **CSW%** = (called strikes + swinging strikes) / total pitches.
- **Whiff%** = swinging strikes / swings.
- **Chase%** = swings at pitches outside the zone / pitches outside the zone.
- **xwOBA** uses Savant's per-ball expected wOBA on balls in play and the
  actual wOBA value for walks, strikeouts and HBP, over Savant's wOBA
  denominator.

## Sample data

`sample-data/` contains example exports for testing:
`batters_savant_sample.csv` (cleaned columns),
`batters_savant_raw_sample.csv` (full raw Savant download — both work),
`pitchers_savant_sample.csv`, `DKSalaries_sample.csv`.
