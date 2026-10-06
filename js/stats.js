/* Aggregation + rating engine for Savant event data. */
(function (global) {
  "use strict";

  function num(v) {
    if (v === undefined || v === null || v === "") return null;
    var n = parseFloat(v);
    return isNaN(n) ? null : n;
  }

  function avg(arr) {
    if (!arr.length) return null;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }

  function max(arr) {
    if (!arr.length) return null;
    return Math.max.apply(null, arr);
  }

  /* Statcast barrel approximation from exit velo + launch angle.
     At 98 mph the window is 26-30 degrees; it widens with velo until
     8-50 degrees at 116+ mph. */
  function isBarrel(ev, la) {
    if (ev === null || la === null || ev < 98) return false;
    var over = Math.min(ev - 98, 18);
    var low = Math.max(8, 26 - over);
    var high = Math.min(50, 30 + over * (20 / 18));
    return la >= low && la <= high;
  }

  var HIT_EVENTS = { single: 1, double: 1, triple: 1, home_run: 1 };
  var XBH_EVENTS = { double: 1, triple: 1, home_run: 1 };
  var SWING_DESCRIPTIONS = {
    foul: 1, foul_tip: 1, hit_into_play: 1, swinging_strike: 1,
    swinging_strike_blocked: 1, foul_bunt: 1, missed_bunt: 1, bunt_foul_tip: 1
  };
  var WHIFF_DESCRIPTIONS = { swinging_strike: 1, swinging_strike_blocked: 1, missed_bunt: 1 };
  var CSW_DESCRIPTIONS = { called_strike: 1, swinging_strike: 1, swinging_strike_blocked: 1 };

  /* A ball put in play. Statcast also records exit velo on many fouls, so
     pitch-level data must not count those as batted balls. Older Savant
     data used hit_into_play_score / hit_into_play_no_out. */
  function isBattedBall(r) {
    var d = r.description;
    if (d === undefined || d === "") return num(r.launch_speed) !== null;
    return d.indexOf("hit_into_play") === 0;
  }

  /* ---- Batters: rows are batted-ball events, or complete pitch-level /
     at-bat data (strikeouts/walks carry no launch data and don't dilute
     the averages). Counts cover the full timeframe of the upload. ---- */
  function aggregateBatters(rows) {
    var byPlayer = {};
    rows.forEach(function (r) {
      var name = (r.player_name || "").trim();
      if (!name) return;
      (byPlayer[name] = byPlayer[name] || []).push(r);
    });

    return Object.keys(byPlayer).map(function (name) {
      var evts = byPlayer[name];
      var evs = [], las = [], dists = [];
      var barrels = 0, sweetSpots = 0, hits = 0, hrs = 0, xbh = 0;
      var hardHits = 0;
      var fieldOuts = 0, ks = 0, pa = 0;

      evts.forEach(function (r) {
        if (isBattedBall(r)) {
          var ev = num(r.launch_speed);
          var la = num(r.launch_angle);
          var d = num(r.hit_distance_sc);
          if (ev !== null) {
            evs.push(ev);
            if (ev >= 95) hardHits++;
          }
          if (la !== null) {
            las.push(la);
            if (la >= 8 && la <= 32) sweetSpots++;
          }
          if (d !== null) dists.push(d);
          if (isBarrel(ev, la)) barrels++;
        }
        var e = r.events;
        if (e) pa++;
        if (HIT_EVENTS[e]) hits++;
        if (e === "home_run") hrs++;
        if (XBH_EVENTS[e]) xbh++;
        if (e === "field_out") fieldOuts++;
        if (e === "strikeout" || e === "strikeout_double_play") ks++;
      });

      var trackedEv = evs.length;
      return {
        name: name,
        events: evts,
        pitches: evts.length,
        pa: pa,
        bbe: trackedEv,
        avg_ev: avg(evs),
        max_ev: max(evs),
        avg_la: avg(las),
        barrel_pct: trackedEv ? (barrels / trackedEv) * 100 : null,
        hardhit_pct: trackedEv ? (hardHits / trackedEv) * 100 : null,
        sweetspot_pct: las.length ? (sweetSpots / las.length) * 100 : null,
        avg_dist: avg(dists),
        hh: hardHits,
        hits: hits,
        hr: hrs,
        xbh: xbh,
        field_outs: fieldOuts,
        k: ks
      };
    });
  }

  /* ---- Pitchers: rows are individual pitches ---- */
  function aggregatePitchers(rows) {
    var byPlayer = {};
    rows.forEach(function (r) {
      var name = (r.player_name || "").trim();
      if (!name) return;
      (byPlayer[name] = byPlayer[name] || []).push(r);
    });

    return Object.keys(byPlayer).map(function (name) {
      var evts = byPlayer[name];
      var pitches = evts.length;
      var pa = 0, k = 0, bb = 0, hr = 0, hitsAllowed = 0;
      var swings = 0, whiffs = 0, csw = 0;
      var velos = [], evAgainst = [], hardHitAgainst = 0;

      evts.forEach(function (r) {
        var e = r.events;
        if (e) {
          pa++;
          if (e === "strikeout" || e === "strikeout_double_play") k++;
          if (e === "walk") bb++;
          if (e === "home_run") hr++;
          if (HIT_EVENTS[e]) hitsAllowed++;
        }
        var d = r.description;
        if (SWING_DESCRIPTIONS[d]) swings++;
        if (WHIFF_DESCRIPTIONS[d]) whiffs++;
        if (CSW_DESCRIPTIONS[d]) csw++;
        var velo = num(r.effective_speed) !== null ? num(r.effective_speed) : num(r.release_speed);
        if (velo !== null) velos.push(velo);
        if (isBattedBall(r)) {
          var ev = num(r.launch_speed);
          if (ev !== null) {
            evAgainst.push(ev);
            if (ev >= 95) hardHitAgainst++;
          }
        }
      });

      return {
        name: name,
        events: evts,
        pitches: pitches,
        pa: pa,
        k_pct: pa ? (k / pa) * 100 : null,
        bb_pct: pa ? (bb / pa) * 100 : null,
        whiff_pct: swings ? (whiffs / swings) * 100 : null,
        csw_pct: pitches ? (csw / pitches) * 100 : null,
        avg_velo: avg(velos),
        ev_against: avg(evAgainst),
        hardhit_against_pct: evAgainst.length ? (hardHitAgainst / evAgainst.length) * 100 : null,
        hr_allowed: hr,
        hits_allowed: hitsAllowed
      };
    });
  }

  var NON_AB_EVENTS = {
    walk: 1, intent_walk: 1, hit_by_pitch: 1, sac_fly: 1, sac_bunt: 1,
    sac_fly_double_play: 1, sac_bunt_double_play: 1, catcher_interf: 1, truncated_pa: 1
  };
  var TOTAL_BASES = { single: 1, double: 2, triple: 3, home_run: 4 };

  /* ---- Full stat line for one group of pitches (a player or a team),
     used by the Lookup tab. Rate stats use every pitch / PA in rows; the
     contact block uses balls in play passing opts.contact (e.g. a minimum
     exit velo or batted-ball type). Zones 11-14 are outside the strike zone.
     xwOBA uses Savant's per-ball estimate on balls in play and the actual
     wOBA value for walks, strikeouts and HBP. ---- */
  function statLine(rows, opts) {
    var contactOk = (opts && opts.contact) || function () { return true; };
    var pa = 0, ab = 0, hitsAll = 0, tb = 0, k = 0, bb = 0;
    var wobaNum = 0, xwobaNum = 0, denom = 0;
    var swings = 0, whiffs = 0, csw = 0, outZone = 0, chases = 0;
    var velos = [], evs = [], las = [], dists = [];
    var bbe = 0, hh = 0, barrels = 0, sweet = 0, hr = 0, xbh = 0, hits = 0;

    rows.forEach(function (r) {
      var e = r.events, d = r.description || "";
      var inPlay = isBattedBall(r);
      if (e) {
        pa++;
        if (!NON_AB_EVENTS[e]) ab++;
        if (HIT_EVENTS[e]) { hitsAll++; tb += TOTAL_BASES[e]; }
        if (e === "strikeout" || e === "strikeout_double_play") k++;
        if (e === "walk" || e === "intent_walk") bb++;
      }
      var den = num(r.woba_denom);
      if (den) {
        var wv = num(r.woba_value) || 0;
        var xw = num(r.estimated_woba_using_speedangle);
        denom += den;
        wobaNum += wv;
        xwobaNum += inPlay && xw !== null ? xw : wv;
      }
      var swing = SWING_DESCRIPTIONS[d] || d.indexOf("hit_into_play") === 0;
      if (swing) swings++;
      if (WHIFF_DESCRIPTIONS[d]) whiffs++;
      if (CSW_DESCRIPTIONS[d]) csw++;
      var z = num(r.zone);
      if (z !== null && z >= 11) {
        outZone++;
        if (swing) chases++;
      }
      var velo = num(r.release_speed) !== null ? num(r.release_speed) : num(r.effective_speed);
      if (velo !== null) velos.push(velo);

      if (inPlay && contactOk(r)) {
        bbe++;
        var ev = num(r.launch_speed), la = num(r.launch_angle), dist = num(r.hit_distance_sc);
        if (ev !== null) {
          evs.push(ev);
          if (ev >= 95) hh++;
        }
        if (la !== null) {
          las.push(la);
          if (la >= 8 && la <= 32) sweet++;
        }
        if (dist !== null) dists.push(dist);
        if (isBarrel(ev, la)) barrels++;
        if (HIT_EVENTS[e]) hits++;
        if (XBH_EVENTS[e]) xbh++;
        if (e === "home_run") hr++;
      }
    });

    return {
      pitches: rows.length,
      pa: pa,
      avg: ab ? hitsAll / ab : null,
      slg: ab ? tb / ab : null,
      woba: denom ? wobaNum / denom : null,
      xwoba: denom ? xwobaNum / denom : null,
      k_pct: pa ? (k / pa) * 100 : null,
      bb_pct: pa ? (bb / pa) * 100 : null,
      whiff_pct: swings ? (whiffs / swings) * 100 : null,
      chase_pct: outZone ? (chases / outZone) * 100 : null,
      csw_pct: rows.length ? (csw / rows.length) * 100 : null,
      avg_velo: avg(velos),
      bbe: bbe,
      hh: hh,
      hardhit_pct: evs.length ? (hh / evs.length) * 100 : null,
      barrel_pct: evs.length ? (barrels / evs.length) * 100 : null,
      avg_ev: avg(evs),
      max_ev: max(evs),
      avg_la: avg(las),
      sweetspot_pct: las.length ? (sweet / las.length) * 100 : null,
      avg_dist: avg(dists),
      hr: hr,
      xbh: xbh,
      hits: hits
    };
  }

  /* ---- Rating: the weights are a 10-point budget. Each stat is min-max
     scaled 0-1 across the supplied player pool, and every weight point
     buys up to one rating point, so a fully allocated budget yields a
     0-10 rating. weightDefs: [{key, weight, invert}] ---- */
  function computeRatings(players, weightDefs) {
    var ranges = {};
    weightDefs.forEach(function (w) {
      if (!w.weight) return;
      var vals = players
        .map(function (p) { return p[w.key]; })
        .filter(function (v) { return v !== null && v !== undefined; });
      if (vals.length) {
        ranges[w.key] = { min: Math.min.apply(null, vals), max: Math.max.apply(null, vals) };
      }
    });

    players.forEach(function (p) {
      var totalW = 0, sum = 0;
      weightDefs.forEach(function (w) {
        if (!w.weight) return;
        var v = p[w.key];
        var range = ranges[w.key];
        if (v === null || v === undefined || !range) return;
        var span = range.max - range.min;
        var scaled = span === 0 ? 0.5 : (v - range.min) / span;
        if (w.invert) scaled = 1 - scaled;
        sum += scaled * w.weight;
        totalW += w.weight;
      });
      p.rating = totalW ? sum : null;
      p.value = p.rating !== null && p.salary ? (p.rating / p.salary) * 1000 : null;
    });
    return players;
  }

  global.Stats = {
    num: num,
    isBarrel: isBarrel,
    isBattedBall: isBattedBall,
    statLine: statLine,
    aggregateBatters: aggregateBatters,
    aggregatePitchers: aggregatePitchers,
    computeRatings: computeRatings
  };
})(window);
