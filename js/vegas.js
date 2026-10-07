/* Manually entered Vegas data: one row per team side of a matchup.
   Row shape: { team, opp, ou, ml, itt, bets, handle }
   - ou:    game total (over/under), shared by both sides
   - ml:    american moneyline for the team
   - itt:   implied team total (manual; estimated from ou + both MLs if blank)
   - bets:  % of bets on this side, handle: % of money on this side */
(function (global) {
  "use strict";

  function normTeam(s) {
    return (s || "").trim().toUpperCase();
  }

  function toNum(v) {
    if (v === undefined || v === null || v === "") return null;
    var n = parseFloat(v);
    return isNaN(n) ? null : n;
  }

  /* American moneyline -> raw win probability (with vig). */
  function mlProb(ml) {
    if (ml === null) return null;
    if (ml < 0) return -ml / (-ml + 100);
    return 100 / (ml + 100);
  }

  function rowsByTeam(rows) {
    var map = {};
    rows.forEach(function (r) {
      var t = normTeam(r.team);
      if (t) map[t] = r;
    });
    return map;
  }

  /* Estimate implied team total by inverting the pythagorean win-prob
     relationship (exponent 1.83): p = R^1.83 / (R^1.83 + A^1.83), with
     R + A = game total and p the de-vigged moneyline win probability. */
  function estimateITT(row, byTeam) {
    var ou = toNum(row.ou);
    var ml = toNum(row.ml);
    if (ou === null || ml === null) return null;
    var oppRow = byTeam[normTeam(row.opp)];
    var oppMl = oppRow ? toNum(oppRow.ml) : null;
    if (oppMl === null) return null;
    var pRaw = mlProb(ml);
    var pOpp = mlProb(oppMl);
    if (!pRaw || !pOpp) return null;
    var p = pRaw / (pRaw + pOpp);
    var x = Math.pow(p / (1 - p), 1 / 1.83);
    return ou * (x / (1 + x));
  }

  /* Manual implied total wins; otherwise the estimate. */
  function effectiveITT(row, byTeam) {
    var manual = toNum(row.itt);
    if (manual !== null) return manual;
    return estimateITT(row, byTeam);
  }

  /* Build two rows per game from DK salary data (Game Info: "MIL@SD ..."). */
  function buildFromDK(dkPlayers) {
    var games = {};
    dkPlayers.forEach(function (p) {
      var m = /^([A-Z]{2,4})@([A-Z]{2,4})\b/.exec((p.gameInfo || "").trim());
      if (m) games[m[1] + "@" + m[2]] = { away: m[1], home: m[2] };
    });
    var rows = [];
    Object.keys(games).sort().forEach(function (key) {
      var g = games[key];
      rows.push({ team: g.away, opp: g.home, ou: "", ml: "", itt: "", bets: "", handle: "" });
      rows.push({ team: g.home, opp: g.away, ou: "", ml: "", itt: "", bets: "", handle: "" });
    });
    return rows;
  }

  /* Attach Vegas numbers to aggregated players (players carry a DK team
     abbreviation once salaries are matched).
     Batters get their own side; pitchers additionally get the opponent's
     implied total, which is the number that matters for them. */
  function attach(players, rows, kind) {
    var byTeam = rowsByTeam(rows);
    players.forEach(function (p) {
      p.ou = null; p.ml = null; p.itt_eff = null; p.opp_itt = null;
      p.bets = null; p.handle = null;
      var row = p.team ? byTeam[normTeam(p.team)] : null;
      if (!row) return;
      p.ou = toNum(row.ou);
      p.ml = toNum(row.ml);
      p.itt_eff = effectiveITT(row, byTeam);
      p.bets = toNum(row.bets);
      p.handle = toNum(row.handle);
      if (kind === "pitchers") {
        var oppRow = byTeam[normTeam(row.opp)];
        if (oppRow) p.opp_itt = effectiveITT(oppRow, byTeam);
      }
    });
  }

  global.Vegas = {
    normTeam: normTeam,
    estimateITT: estimateITT,
    effectiveITT: effectiveITT,
    buildFromDK: buildFromDK,
    attach: attach
  };
})(window);
