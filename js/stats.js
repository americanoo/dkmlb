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

  function dayNum(dateStr) {
    if (!dateStr) return null;
    var t = Date.parse(dateStr + "T00:00:00Z");
    return isNaN(t) ? null : Math.floor(t / 86400000);
  }

  /* ---- Batters: rows are batted-ball events, or complete at-bat data
     (strikeouts/walks carry no launch data and don't dilute the averages).
     Hard-hit counts are also bucketed into trailing 5/10/15-day windows,
     measured back from the most recent game date in the upload. ---- */
  function aggregateBatters(rows) {
    var byPlayer = {};
    var maxDay = null;
    rows.forEach(function (r) {
      var name = (r.player_name || "").trim();
      if (!name) return;
      (byPlayer[name] = byPlayer[name] || []).push(r);
      var d = dayNum(r.game_date);
      if (d !== null && (maxDay === null || d > maxDay)) maxDay = d;
    });

    return Object.keys(byPlayer).map(function (name) {
      var evts = byPlayer[name];
      var evs = [], las = [], dists = [];
      var barrels = 0, sweetSpots = 0, hits = 0, hrs = 0, xbh = 0;
      var hardHits = 0, hh5 = 0, hh10 = 0, hh15 = 0;
      var fieldOuts = 0, ks = 0, pa = 0;

      evts.forEach(function (r) {
        var ev = num(r.launch_speed);
        var la = num(r.launch_angle);
        var d = num(r.hit_distance_sc);
        if (ev !== null) {
          evs.push(ev);
          if (ev >= 95) {
            hardHits++;
            var day = dayNum(r.game_date);
            if (day !== null && maxDay !== null) {
              var back = maxDay - day;
              if (back < 5) hh5++;
              if (back < 10) hh10++;
              if (back < 15) hh15++;
            }
          }
        }
        if (la !== null) {
          las.push(la);
          if (la >= 8 && la <= 32) sweetSpots++;
        }
        if (d !== null) dists.push(d);
        if (isBarrel(ev, la)) barrels++;
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
        hh5: hh5,
        hh10: hh10,
        hh15: hh15,
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
        if (d === "hit_into_play") {
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

  /* ---- Rating: weighted average of each stat min-max scaled to 0-100
     across the supplied player pool. weightDefs: [{key, weight, invert}] ---- */
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
        var scaled = span === 0 ? 50 : ((v - range.min) / span) * 100;
        if (w.invert) scaled = 100 - scaled;
        sum += scaled * w.weight;
        totalW += w.weight;
      });
      p.rating = totalW ? sum / totalW : null;
      p.value = p.rating !== null && p.salary ? (p.rating / p.salary) * 1000 : null;
    });
    return players;
  }

  global.Stats = {
    num: num,
    isBarrel: isBarrel,
    aggregateBatters: aggregateBatters,
    aggregatePitchers: aggregatePitchers,
    computeRatings: computeRatings
  };
})(window);
