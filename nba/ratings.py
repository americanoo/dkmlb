"""Adjustable GPP player ratings for DraftKings NBA.

A rating is a slate-relative decision aid, not a points projection: every component
is scored 0-100 against the current slate, weighted by a contest preset, then a risk
penalty is subtracted. Median projection and ceiling are always reported alongside.
"""

import random
import zlib
from bisect import bisect_left, bisect_right

COMPONENTS = ["projection", "ceiling", "minutes", "role", "value", "leverage", "context", "reliability"]

# Starting heuristics, not proven optimal weights. Each totals 100.
PRESETS = {
    "gpp": dict(projection=22, ceiling=18, minutes=18, role=13, value=10, leverage=9, context=6, reliability=4),
    "single-entry": dict(projection=25, ceiling=16, minutes=20, role=14, value=10, leverage=6, context=5, reliability=4),
    "high-variance": dict(projection=18, ceiling=24, minutes=16, role=13, value=8, leverage=14, context=4, reliability=3),
}

# --prioritize scales these components, then everything is rescaled to 100.
PRIORITIES = {
    "projection": {"projection": 1.5, "minutes": 1.25, "reliability": 1.25},
    "leverage": {"leverage": 1.75, "ceiling": 1.25},
    "volatility": {"ceiling": 1.5, "leverage": 1.25, "reliability": 0.5},
}

TIERS = [(85, "Top-rated"), (70, "Strong"), (55, "Context-dependent"), (0, "Lower priority")]

SALARY_TIERS = [(8000, "8K+"), (6000, "6-8K"), (4000, "4-6K"), (0, "<4K")]
SIMS = 2000


# --- weights --------------------------------------------------------------

def normalize(w):
    total = sum(w.values())
    return {k: 100 * v / total for k, v in w.items()}


def build_weights(preset="gpp", prioritize=None, overrides=None, leverage_available=True):
    """Preset -> priority multipliers -> explicit overrides (others rescale to fill 100)."""
    w = dict(PRESETS[preset])
    if prioritize:
        w = normalize({k: v * PRIORITIES[prioritize].get(k, 1.0) for k, v in w.items()})
    overrides = overrides or {}
    for k, v in overrides.items():
        if k not in COMPONENTS or v < 0:
            raise ValueError(f"bad weight {k}={v}")
    fixed = sum(overrides.values())
    if fixed > 100:
        raise ValueError(f"weight overrides total {fixed} > 100")
    rest = {k: v for k, v in w.items() if k not in overrides}
    rest_total = sum(rest.values())
    w = {**{k: v * (100 - fixed) / rest_total for k, v in rest.items()}, **overrides} if rest_total else dict(overrides)
    if not leverage_available and w.get("leverage"):
        # No trustworthy ownership: never fabricate it. Move its weight to the core components.
        core = ["projection", "ceiling", "minutes", "role"]
        share, core_total = w["leverage"], sum(w[k] for k in core)
        for k in core:
            w[k] += share * w[k] / core_total
        w["leverage"] = 0.0
    return {k: round(w.get(k, 0.0), 2) for k in COMPONENTS}


# --- scoring helpers ------------------------------------------------------

def pct_ranks(vals):
    """Percentile rank 0-100, ties averaged."""
    n = len(vals)
    if n < 2:
        return [50.0] * n
    order = sorted(vals)
    return [100 * (bisect_left(order, v) + bisect_right(order, v) - 1) / 2 / (n - 1) for v in vals]


def pct_by_group(vals, groups, min_size=5):
    """Percentile within each group; groups too small for a fair comparison use the slate."""
    slate = pct_ranks(vals)
    out = list(slate)
    for g in set(groups):
        idx = [i for i, x in enumerate(groups) if x == g]
        if len(idx) >= min_size:
            for i, r in zip(idx, pct_ranks([vals[i] for i in idx])):
                out[i] = r
    return out


def rescale(vals):
    lo, hi = min(vals), max(vals)
    return [50.0 if hi == lo else 100 * (v - lo) / (hi - lo) for v in vals]


def salary_tier(salary):
    return next(name for floor, name in SALARY_TIERS if salary >= floor)


def position_group(positions):
    pos = set(positions.split("/"))
    if pos & {"PG", "SG"} and "C" not in pos:
        return "G"
    return "C" if "C" in pos else "F"


def tier(rating):
    return next(name for floor, name in TIERS if rating >= floor)


def simulate(p, n=SIMS):
    """Estimated DK outcome distribution: minutes ~ N(projected, recent spread) x a per-minute
    rate drawn from the player's recent games (recentred on the projected rate).
    Independent draws, so it ignores game-script correlation; treat the tails as estimates."""
    rng = random.Random(zlib.crc32(p["dk_id"].encode()))
    samples = p.get("_rate_samples") or [p["fp_per_min"]]
    centre = sum(samples) / len(samples)
    scale = p["fp_per_min"] / centre if centre else 1.0
    sd = max(p.get("min_sd_l10", 0.0), 2.0)
    out = []
    for _ in range(n):
        minutes = min(max(rng.gauss(p["proj_min"], sd), 0.0), 48.0)
        out.append(minutes * rng.choice(samples) * scale)
    return sorted(out)


def quantile(sorted_vals, q):
    return sorted_vals[min(int(q / 100 * len(sorted_vals)), len(sorted_vals) - 1)]


# --- risk -----------------------------------------------------------------

def risk_flags(p, blowout_spread=10.0):
    """(reason, severity 0-1). Each source of uncertainty is counted once, and minutes volatility
    is left out because the MINUTES component already scores it."""
    flags = []
    status = (p.get("dk_status") or "").upper()
    if status in ("Q", "GTD", "D"):
        flags.append((f"unresolved {status} tag", 1.0))
    elif p.get("injury") and p["injury"] not in ("Active", ""):
        flags.append((f"ESPN injury status: {p['injury']}", 0.5))
    spread = p.get("team_spread")
    if spread is not None and abs(spread) >= blowout_spread and p["proj_min"] >= 28:
        flags.append((f"blowout exposure (spread {spread:+g})", 0.5))
    return flags


# --- rating ---------------------------------------------------------------

def rate_players(players, weights, ceiling_pct=85, risk_strength=10.0, ownership=None):
    """Adds sims, ceiling, components, risk and rating to each rateable player; returns them sorted."""
    pool = [p for p in players if p.get("proj_fp", 0) > 0]
    for p in pool:
        p["_sims"] = simulate(p)
        p["ceiling"] = round(quantile(p["_sims"], ceiling_pct), 1)
        p["sal_tier"] = salary_tier(p["salary"])
        p["pos_group"] = position_group(p["positions"])
        p["own"] = ownership.get(p["dk_id"], ownership.get(p["name"])) if ownership else None

    def col(f):
        return [f(p) for p in pool]

    sal_tiers, pos_groups = col(lambda p: p["sal_tier"]), col(lambda p: p["pos_group"])
    comps = {
        "projection": pct_ranks(col(lambda p: p["proj_fp"])),
        # Raw ceiling across the slate, blended with ceiling per $1K so cheap upside registers.
        "ceiling": [0.6 * a + 0.4 * b for a, b in zip(
            pct_ranks(col(lambda p: p["ceiling"])),
            pct_ranks(col(lambda p: p["ceiling"] / p["salary"])))],
        # Certainty folded in: a stable 34 beats an uncertain 28-36 with the same median.
        "minutes": pct_ranks(col(lambda p: p["proj_min"] - 0.5 * p.get("min_sd_l10", 0))),
        "value": pct_by_group(col(lambda p: p["proj_fp"] / (p["salary"] / 1000)), sal_tiers),
    }
    # ROLE, within position group. Usage already contains FGA/FTA/TOV, so shot attempts aren't
    # counted again; AST and REB per minute stand in for potential assists and rebound chances
    # (tracking data lives on stats.nba.com, which blocks cloud IPs).
    usage = pct_by_group(col(lambda p: p["usage_per_min"]), pos_groups)
    role_parts = [
        (0.40, usage),
        (0.20, pct_by_group(col(lambda p: p["ast_per_min"]), pos_groups)),
        (0.20, pct_by_group(col(lambda p: p["reb_per_min"]), pos_groups)),
        (0.10, pct_by_group(col(lambda p: p["stocks_per_min"]), pos_groups)),
        (0.10, pct_ranks(col(lambda p: p["usage_l10"] - p["usage_per_min"]))),  # role change
    ]
    comps["role"] = [sum(w * part[i] for w, part in role_parts) for i in range(len(pool))]

    have_lines = [p.get("implied_total") is not None for p in pool]
    if any(have_lines):
        implied = pct_ranks(col(lambda p: p["implied_total"] if p.get("implied_total") is not None else 0))
        close = pct_ranks(col(lambda p: -abs(p["team_spread"]) if p.get("team_spread") is not None else -99))
        comps["context"] = [0.6 * a + 0.4 * b if ok else 50.0 for a, b, ok in zip(implied, close, have_lines)]
    else:
        comps["context"] = [50.0] * len(pool)

    # How representative the inputs are: sample size and how much is from the current season.
    comps["reliability"] = pct_ranks(col(
        lambda p: 0.6 * min(p["gp"], 30) / 30 + 0.4 * min(p.get("gp_current", 0), 10) / 10))

    if ownership and all(p["own"] is not None for p in pool):
        lev = [c - o for c, o in zip(pct_ranks(col(lambda p: p["ceiling"])), pct_ranks(col(lambda p: p["own"])))]
        comps["leverage"] = rescale(lev)
    else:
        comps["leverage"] = [None] * len(pool)

    season_started = any(p.get("gp_current", 0) for p in pool)
    for i, p in enumerate(pool):
        p["comp"] = {k: (None if comps[k][i] is None else round(comps[k][i], 1)) for k in COMPONENTS}
        raw = sum(weights[k] / 100 * (p["comp"][k] or 0) for k in COMPONENTS)
        p["risk_flags"] = risk_flags(p)
        p["risk_penalty"] = round(risk_strength * min(1.0, sum(s for _, s in p["risk_flags"])), 1)
        p["raw_rating"] = round(raw, 1)
        p["rating"] = round(max(raw - p["risk_penalty"], 0.0), 1)
        p["tier"] = tier(p["rating"])
        p["positives"], p["risks"], p["notes"] = explain(p, weights, season_started)
    return sorted(pool, key=lambda p: p["rating"], reverse=True)


LABELS = {
    "projection": "median projection", "ceiling": "ceiling", "minutes": "secure minutes",
    "role": "role/usage", "value": "salary value", "leverage": "leverage",
    "context": "game environment", "reliability": "stable inputs",
}


def explain(p, weights, season_started):
    c = p["comp"]
    strong = sorted((k for k in COMPONENTS if c[k] is not None and c[k] >= 70 and weights[k] > 0),
                    key=lambda k: weights[k] * c[k], reverse=True)
    positives = [f"{LABELS[k]} {c[k]:.0f}" for k in strong[:3]]

    risks = [reason for reason, _ in p["risk_flags"]]
    if c["minutes"] <= 25:
        risks.append(f"minutes {p['proj_min']:.0f} (sd {p.get('min_sd_l10', 0):.0f})")
    if c["reliability"] <= 25:
        risks.append("thin or stale sample")
    if season_started and p.get("gp_current", 0) == 0:
        risks.append("no current-season games (prior-season data)")

    notes = []
    raw = p["raw_rating"] or 1
    if c["leverage"] is not None and weights["leverage"] * c["leverage"] / 100 > 0.25 * raw:
        notes.append("rating leans on leverage")
    if p.get("min_sd_l10", 0) >= 6:
        notes.append(f"volatile minutes (sd {p['min_sd_l10']:.0f})")
    if p.get("stocks_fp_share", 0) >= 0.25:
        notes.append(f"{p['stocks_fp_share']:.0%} of FP from steals/blocks")
    return positives, risks, notes
