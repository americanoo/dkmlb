# dkmlb
dk mlb dfs

## NBA (DraftKings classic)

```
pip install -r nba/requirements.txt   # PuLP + HiGHS, for the lineup optimizer
python3 nba/rate.py                    # rate the main slate, build 3 legal lineups, log to nba/logs/
python3 nba/rate.py --preset high-variance --weight ceiling=26 --lineups 10
python3 nba/review.py                  # calibrate logged ratings against actual results
```

- `nba/dk_nba.py`: DK slate + salaries, ESPN rosters/injuries/game logs/Vegas lines, minutes x FP/min projection
- `nba/ratings.py`: slate-relative 0-100 components, contest presets, adjustable weights, risk penalty
- `nba/lineups.py`: exact optimizer for DK roster/salary rules, lineup ceiling, correlation and risk notes
- `nba/review.py`: projection/minutes error, ceiling hit rate, rating quality by salary tier

Ratings are a decision aid, not a projection. LEVERAGE stays off unless you supply an ownership CSV.
