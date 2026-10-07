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

- **Batters / Pitchers date ranges** (defaults: last 15 days for batters,
  last 30 for pitchers; 5d / 10d / 15d buttons set the batter range in one
  click) and **Include postseason**. One click pulls every
  pitch league-wide for each range, so batters get true pitches seen and
  pitchers get full pitch-level data. Up to 45 days per pull.
- Pulled days are cached in `server/cache/`, so a repeat or overlapping range
  only downloads the days it hasn't seen. The most recent two days are always
  re-downloaded, since Savant keeps correcting them after the games end.
- If Savant fails on a day, the pull stops with a message naming the day;
  the days that did load stay cached, so trying again is quick.

**DraftKings slate** (same panel): pick one of today's MLB Classic slates
(Main, Happy Hour, Night and so on; Showdown, Tiers and other single-game
formats are left out, whatever DraftKings names the full-slate format). When
the page opens, **today's slate loads by itself**: the one you picked earlier
today, else the Main slate, else the day's biggest (if today's slates have all
started, the next day's). Picking another slate in the list loads it straight
away, and **Reload salaries** fetches it again. A salary CSV you upload today
isn't replaced. No CSV download needed. The server reads the slate list
and player list from the same public pages DraftKings' own lobby and lineup
builder use (no login), and rebuilds them in the exact DKSalaries.csv
layout, so matching, Value and "Build matchups from DK slate" work just as
with an upload. If no Classic slate shows, the panel says whether DraftKings
has posted no MLB slates yet or only non-Classic ones. To see every slate
DraftKings lists and how each was classified, open
http://localhost:8000/api/dk/slates?all=1. These pages aren't an official API. The server
first sends a plain request, then a browser-style one, and if DraftKings'
player API still refuses, it downloads the slate's own "Export to CSV" file
instead. If every route is refused, the message names which ones and why;
the **DK Salaries CSV** upload keeps working either way.

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

**Batted balls: All / 95+ mph** (Batters tab). The server pulls every pitch,
not just hard-hit balls. "All batted balls" (the default) uses every ball in
play, so HardHit% is meaningful and the HH count can be read against PA. The
95+ setting narrows the contact stats (EV, LA, distance, barrels, HR, hits,
field outs, batted-ball mix) to hard-hit balls, like a Savant search filtered
to exit velo 95+, while volume, results and plate-discipline stats still
count every pitch. Foul balls never count as batted balls, even though
Statcast records exit velo on many of them.

## Columns & formulas

**Columns & formulas** (Batters and Pitchers tabs) opens the full stat
catalog: about 90 stats per tab in seven groups: Slate & Vegas, Volume (Pitches,
PA, AB, P/PA, IP), Results (H, 1B, 2B, 3B, TB, BB, IBB, K, HBP, SF, GIDP,
AVG, OBP, SLG, OPS, ISO, BABIP, wOBA, xwOBA, xBA), Plate discipline (K%,
BB%, K−BB%, Swing%, Whiff%, Contact%, Zone%, Z-Swing%, Chase%, CSW%,
first-pitch swing/strike%), Contact quality (BBE, HH, HardHit%, HH/PA%,
Barrels, Barrel%, Barrel/PA%, Avg/Max EV, EV90, LA, SweetSpot%, distance,
HR, XBH, hits, FO), Batted-ball mix (GB/LD/FB/PU%, HR/FB, Pull%, Oppo%) and,
for pitchers, Velo, Max Velo, Spin, K/9, BB/9, HR/9. Every rate has its raw
count beside it (Swings and Whiffs next to Whiff%, Chases next to Chase%, GB
next to GB%…). Each stat has an **Off / On / Split** choice: Split shows the
stat plus its own column for each split window (see below). Hover a name for
its definition; the grey text beside it is its short table header. Choices
are saved per tab.

Some stats need Savant columns that older pulls and cleaned CSVs don't have
(wOBA/xwOBA, xBA, zone and chase stats, Pull/Oppo, Spin). When the loaded data
lacks them, those headers are marked ⚠ and a notice above the table offers
**Re-pull now**. If the page says the stats server is running older code,
close its Terminal window and start it again so updates take effect.

**Split columns** give a stat its own columns for **Career, this season,
and the last 15, 10 and 5 days** (and optionally vs L / vs R): choose
**Split** on the stat, and tick the windows you want in the **Split windows**
row at the top of the panel. wOBA, HH, GB%, FB% and Barrels start split all
five ways. In the table they sit under one heading, e.g. **HH** over
Car · '26 · 15d · 10d · 5d.

Career (Statcast era, 2015 on) and season numbers come from Baseball Savant's
season leaderboards (expected stats, exit velocity & barrels, batted ball),
loaded by the stats server: one small file per season per leaderboard, past
seasons saved permanently, the current season refreshed twice a day, and
loaded automatically once a day. Career wOBA/xwOBA are PA-weighted across
seasons; HH and Barrels are summed; GB%/FB%/LD%/PU% are weighted by balls in
play. Players are matched by Savant player ID (name as a fallback). Stats
available this way: PA, wOBA, xwOBA, BBE, HH, HardHit%, Barrels, Barrel%,
Avg/Max EV, Avg LA, GB%, FB%, LD%, PU%. If Savant leaves a stat out of its
leaderboards, the status line says so and those columns stay blank (⚠).
Season leaderboards cover the regular season; Savant's barrel and hard-hit
counts are its official ones, while the day windows use this site's
calculations from pitch data.
**Split every stat that's on** and **Remove all splits** do it in bulk. Day windows
count back from the most recent game in the loaded data, so pull at least
15 days (the batter pull now defaults to 15; a notice appears when the data
is shorter than a window). Split columns ignore the table's vs LHP/RHP
buttons, sort like any stat, can be rated, and work in formulas as
`hh__l5`, `woba__l15`, `woba__vsR`. The Lookup tab's day rows use the same
rule (windows end on the latest game, or yesterday), so the numbers match.

**Formula stats** turn any combination into your own column. Examples:
`hh + barrels * 2 - k`, `hh / pa * 100`,
`z(barrel_pct) + z(hh_per_pa) + itt_eff`. Formulas use the stat names shown
in the reference list (click to insert), + − * / ^, parentheses,
comparisons (1 if true, 0 if not), and min, max, avg, if, nz, round, abs,
sqrt, ln, clamp. Pool functions compare a player with everyone on the tab:
z (standard score), pctl (percentile 0–100), rank (1 = highest), scale (0–1).
A missing stat leaves the result blank unless wrapped in nz(). The formula is
checked as you type, with a preview of the highest values, and a formula can
use earlier formula stats. Formula stats sort like any column and can be
added to the rating.

**Rating weights** now cover any stat: use "Add a stat to your rating" (any
catalog stat or formula stat), flip ↑/↓ for whether higher or lower is
better, and ✕ to drop one. The 10-point budget is unchanged, and weights set
in the previous version carry over.

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
ratings update live. The weights live in a collapsible **Rating weights**
bar above the table; its summary line shows points left and the rated
stats, and it remembers whether you left it open.

Other tools:

- **One line per player, no sideways scrolling.** Headers are short
  (Sal, FPPG, HH%, Brl, mxEV, SwSp%…; hover any header for its full name and
  definition), cells drop the % sign, and column widths follow their
  contents. When columns don't fit, the font tightens a little, and if they
  still don't fit, the right-most columns are left off with a note naming
  them. Put what matters most on the left.
- **Move columns** by dragging a header sideways (drag a split heading like
  **HH** to move all its windows together), or focus a header and press
  Alt+← / Alt+→. The order is saved per tab; **Reset column order** in the
  Columns panel undoes it.
- **Team and Pos** show for every player, not just ones on the loaded slate:
  DraftKings' team and position once salaries load, otherwise the team from
  the player's latest game and MLB's listed position (outfielders as OF)
  via the stats server, refreshed every few days. Pitchers without a DK
  listing show SP or RP from whether they started most of their games.
  Salary is always a column; it's blank until a slate's salaries load.
- Sortable columns (click a header, click again to reverse; Enter/Space
  also works from the keyboard)
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
