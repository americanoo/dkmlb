# DK MLB DFS Research

A zero-dependency static site for DraftKings MLB DFS research built around
Baseball Savant statcast exports and the DraftKings salary CSV.

Open `index.html` in a browser (no server or build step needed), or host the
repo on GitHub Pages.

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

Every stat in the weights panel has a weight from 0–10, and all weights
start at 0 — the rating stays blank until you raise the stats you care
about. Each weighted stat is min-max scaled across the current player pool
(stats marked ↓, like EV Against, are inverted so lower is better), then
combined as a weighted average into a single 1–10 rating (worst 1, best
10). Weights are saved in your browser and ratings update live.

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

## Sample data

`sample-data/` contains example exports for testing:
`batters_savant_sample.csv` (cleaned columns),
`batters_savant_raw_sample.csv` (full raw Savant download — both work),
`pitchers_savant_sample.csv`, `DKSalaries_sample.csv`.
