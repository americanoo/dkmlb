# DK MLB DFS Research

A zero-dependency static site for DraftKings MLB DFS research built around
Baseball Savant statcast exports and the DraftKings salary CSV.

Open `index.html` in a browser (no server or build step needed), or host the
repo on GitHub Pages.

## Workflow

1. **Batter Savant CSV** — upload a statcast search export for batters
   (event-level data). Repeated player rows are averaged into one line per
   player: Avg/Max EV, Avg LA, Barrel%, HardHit%, SweetSpot%, Avg Distance,
   plus raw counts — hard-hit balls (total and trailing 5/10/15-day windows,
   measured back from the most recent game date in the file), HR, XBH, Hits,
   Field Outs, and Strikeouts. Complete at-bat data works too: strikeouts and
   walks carry no launch data, so they add to the counts without diluting the
   averages. Both the cleaned column subset and the full raw Savant export
   work — extra columns are ignored.
2. **Pitcher Savant CSV** — upload a statcast search export for pitchers
   (pitch-level data). Aggregated per pitcher: K%, BB%, Whiff%, CSW%,
   Avg Velo, EV Against, HardHit% Against, HR/Hits allowed.
3. **DK Salaries CSV** — upload the DraftKings lineup-builder template.
   Players are matched by name (handles "Last, First" vs "First Last",
   accents, and suffixes like Jr.) and get Salary, Position, Team, DK Avg
   points, and a **Value** column (rating per $1k of salary). A
   "DK slate only" checkbox filters to just the slate.

Click any player row to expand their full event history, sorted by date
(newest first). Pitcher history shows plate-appearance results.

## Rating system

Every stat in the weights panel has a weight from 0–10. Each weighted stat
is min-max scaled to 0–100 across the current player pool (stats marked ↓,
like EV Against, are inverted so lower is better), then combined as a
weighted average into a single 0–100 rating. Adjust the sliders to match
your own priorities — weights are saved in your browser and ratings update
live.

Other tools:

- Sortable columns (click a header, click again to reverse)
- Handedness splits: batters vs LHP/RHP, pitchers vs LHB/RHB
- Player search and minimum-sample filter (Min BBE / Min pitches)
- Uploaded data persists in the browser between visits (`Clear data` wipes it)

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
