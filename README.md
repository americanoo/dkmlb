# dkmlb
dk mlb dfs

## NBA (DraftKings classic)

```
pip install -r nba/requirements.txt   # PuLP + HiGHS, for the lineup optimizer
python3 nba/rate.py                    # rate the main slate, build 3 legal lineups, log to nba/logs/
python3 nba/rate.py --preset high-variance --weight ceiling=26 --lineups 10
python3 nba/review.py                  # calibrate logged ratings against actual results
python3 nba/rate.py --assume-out "Player Name"   # late-news scenario; --assume-in to reverse
python3 nba/board.py board.html 155078 "Wed Oct 21 · Main (11 games)" --pick6   # slate board page, with Pick6 tab
python3 nba/pick6.py --size 3        # score today's Pick6 lines; logs them to nba/logs/
python3 nba/pick6.py --review        # grade logged Pick6 picks against box scores
```

- `nba/dk_nba.py`: DK slate + salaries, ESPN rosters/injuries/game logs/Vegas lines, minutes x FP/min projection
- `nba/ratings.py`: slate-relative 0-100 components, contest presets, adjustable weights, risk penalty
- `nba/injuries.py`: moves an absent player's minutes and usage to teammates (only what their recent baselines don't already reflect), blended with actual with/without splits
- `nba/pick6.py`: pulls DraftKings Pick6 lines, scores each against its price (DK-implied chance moved by our model and real hit rates), builds entries from Pick6's payout table, and grades logged picks
- `nba/lineups.py`: exact optimizer for DK roster/salary rules, lineup ceiling, correlation and risk notes
- `nba/review.py`: projection/minutes error, ceiling hit rate, rating quality by salary tier

Ratings are a decision aid, not a projection. LEVERAGE stays off unless you supply an ownership CSV.
