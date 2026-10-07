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

  /* Value at the given fraction of a sorted copy (nearest rank). */
  function percentile(arr, frac) {
    if (!arr.length) return null;
    var sorted = arr.slice().sort(function (a, b) { return a - b; });
    var idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(frac * sorted.length) - 1));
    return sorted[idx];
  }

  function pct(part, whole) {
    return whole ? (part / whole) * 100 : null;
  }

  function ratio(part, whole) {
    return whole ? part / whole : null;
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
  var NON_AB_EVENTS = {
    walk: 1, intent_walk: 1, hit_by_pitch: 1, sac_fly: 1, sac_bunt: 1,
    sac_fly_double_play: 1, sac_bunt_double_play: 1, catcher_interf: 1, truncated_pa: 1
  };
  var TOTAL_BASES = { single: 1, double: 2, triple: 3, home_run: 4 };
  /* Outs recorded on the play; caught stealings and pickoffs aren't in
     pitch-level events, so IP can run slightly short. */
  var OUTS_ON_EVENT = {
    field_out: 1, strikeout: 1, force_out: 1, sac_fly: 1, sac_bunt: 1, fielders_choice_out: 1,
    other_out: 1, grounded_into_double_play: 2, double_play: 2, strikeout_double_play: 2,
    sac_fly_double_play: 2, sac_bunt_double_play: 2, triple_play: 3
  };

  /* A ball put in play. Statcast also records exit velo on many fouls, so
     pitch-level data must not count those as batted balls. Older Savant
     data used hit_into_play_score / hit_into_play_no_out. */
  function isBattedBall(r) {
    var d = r.description;
    if (d === undefined || d === "") return num(r.launch_speed) !== null;
    return d.indexOf("hit_into_play") === 0;
  }

  /* Spray direction from Savant's hit coordinates: "pull", "oppo" or
     "center" relative to the batter's side (15 degrees either side of
     straightaway center counts as center). */
  function sprayDirection(r) {
    var x = num(r.hc_x), y = num(r.hc_y);
    if (x === null || y === null || (r.stand !== "L" && r.stand !== "R")) return null;
    var angle = Math.atan2(x - 125.42, 198.27 - y) * 180 / Math.PI;
    if (r.stand === "L") angle = -angle;
    if (angle < -15) return "pull";
    if (angle > 15) return "oppo";
    return "center";
  }

  /* ---- Full stat line for one group of pitches (a player or a team).
     Volume, results and plate-discipline stats use every pitch / PA in
     rows; the contact block (BBE through FO) uses balls in play passing
     opts.contact, e.g. a minimum exit velo. Zones 1-9 are the strike zone,
     11-14 outside it. xwOBA uses Savant's per-ball estimate on balls in
     play and the actual wOBA value for walks, strikeouts and HBP; xBA is
     Savant's per-ball estimate over at-bats. ---- */
  function statLine(rows, opts) {
    var contactOk = (opts && opts.contact) || function () { return true; };
    var pa = 0, ab = 0, h = 0, singles = 0, doubles = 0, triples = 0, hrAll = 0, tb = 0;
    var k = 0, bb = 0, ibb = 0, hbp = 0, sf = 0, gidp = 0, outs = 0;
    var wobaNum = 0, xwobaNum = 0, denom = 0, xbaNum = 0, xbaSeen = false;
    var swings = 0, whiffs = 0, csw = 0, calledStrikes = 0;
    var zoneSeen = 0, inZone = 0, zSwings = 0, outZone = 0, chases = 0;
    var firstPitches = 0, firstStrikes = 0, firstSwings = 0;
    var bipAll = 0, hitsOnBip = 0, hrOnBip = 0;
    var velos = [], spins = [], evs = [], las = [], dists = [];
    var bbe = 0, hh = 0, barrels = 0, sweet = 0, hr = 0, xbh = 0, hits = 0, fieldOuts = 0;
    var gb = 0, ld = 0, fb = 0, pu = 0, typed = 0, hrFb = 0, pull = 0, oppo = 0, sprayed = 0;

    rows.forEach(function (r) {
      var e = r.events, d = r.description || "";
      var inPlay = isBattedBall(r);
      if (e) {
        pa++;
        if (!NON_AB_EVENTS[e]) ab++;
        if (HIT_EVENTS[e]) { h++; tb += TOTAL_BASES[e]; }
        if (e === "single") singles++;
        if (e === "double") doubles++;
        if (e === "triple") triples++;
        if (e === "home_run") hrAll++;
        if (e === "strikeout" || e === "strikeout_double_play") k++;
        if (e === "walk" || e === "intent_walk") bb++;
        if (e === "intent_walk") ibb++;
        if (e === "hit_by_pitch") hbp++;
        if (e === "sac_fly" || e === "sac_fly_double_play") sf++;
        if (e === "grounded_into_double_play") gidp++;
        outs += OUTS_ON_EVENT[e] || 0;
      }
      var den = num(r.woba_denom);
      if (den) {
        var wv = num(r.woba_value) || 0;
        var xw = num(r.estimated_woba_using_speedangle);
        denom += den;
        wobaNum += wv;
        xwobaNum += inPlay && xw !== null ? xw : wv;
      }
      var xb = num(r.estimated_ba_using_speedangle);
      if (inPlay && xb !== null) { xbaNum += xb; xbaSeen = true; }

      var swing = !!(SWING_DESCRIPTIONS[d] || d.indexOf("hit_into_play") === 0);
      if (swing) swings++;
      if (WHIFF_DESCRIPTIONS[d]) whiffs++;
      if (CSW_DESCRIPTIONS[d]) csw++;
      if (d === "called_strike") calledStrikes++;
      var z = num(r.zone);
      if (z !== null) {
        zoneSeen++;
        if (z >= 1 && z <= 9) {
          inZone++;
          if (swing) zSwings++;
        } else if (z >= 11) {
          outZone++;
          if (swing) chases++;
        }
      }
      if (r.balls !== undefined && +r.balls === 0 && +r.strikes === 0 && r.balls !== "") {
        firstPitches++;
        if (swing) firstSwings++;
        if (swing || d === "called_strike") firstStrikes++;
      }
      var velo = num(r.release_speed) !== null ? num(r.release_speed) : num(r.effective_speed);
      if (velo !== null) velos.push(velo);
      var spin = num(r.release_spin_rate);
      if (spin !== null) spins.push(spin);

      if (inPlay && e !== "sac_bunt" && e !== "sac_bunt_double_play") {
        bipAll++;
        if (HIT_EVENTS[e] && e !== "home_run") hitsOnBip++;
        if (e === "home_run") hrOnBip++;
      }

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
        if (e === "field_out") fieldOuts++;
        var t = r.bb_type;
        if (t) {
          typed++;
          if (t === "ground_ball") gb++;
          if (t === "line_drive") ld++;
          if (t === "fly_ball") { fb++; if (e === "home_run") hrFb++; }
          if (t === "popup") pu++;
        }
        var dir = sprayDirection(r);
        if (dir) {
          sprayed++;
          if (dir === "pull") pull++;
          if (dir === "oppo") oppo++;
        }
      }
    });

    var obpDen = ab + bb + hbp + sf;
    var obp = obpDen ? (h + bb + hbp) / obpDen : null;
    var slg = ab ? tb / ab : null;
    var babipDen = ab - k - hrAll + sf;
    var kPct = pct(k, pa), bbPct = pct(bb, pa);
    var line = {
      // Volume
      pitches: rows.length,
      pa: pa,
      ab: ab,
      pitches_per_pa: ratio(rows.length, pa),
      outs: outs,
      ip: outs ? Math.floor(outs / 3) + (outs % 3) / 10 : null,
      // Results (every PA)
      h: h,
      singles: singles,
      doubles: doubles,
      triples: triples,
      tb: tb,
      bb: bb,
      ibb: ibb,
      k: k,
      hbp: hbp,
      sf: sf,
      gidp: gidp,
      avg: ratio(h, ab),
      obp: obp,
      slg: slg,
      ops: obp !== null && slg !== null ? obp + slg : null,
      iso: slg !== null && ab ? slg - h / ab : null,
      babip: babipDen > 0 ? (h - hrAll) / babipDen : null,
      woba: denom ? wobaNum / denom : null,
      xwoba: denom ? xwobaNum / denom : null,
      xba: xbaSeen && ab ? xbaNum / ab : null,
      // Plate discipline
      k_pct: kPct,
      bb_pct: bbPct,
      k_minus_bb_pct: kPct !== null ? kPct - bbPct : null,
      swings: swings,
      whiffs: whiffs,
      called_strikes: calledStrikes,
      csw: csw,
      zone_pitches: inZone,
      out_zone_pitches: outZone,
      z_swings: zSwings,
      chases: chases,
      first_pitches: firstPitches,
      first_strikes: firstStrikes,
      first_swings: firstSwings,
      swing_pct: pct(swings, rows.length),
      whiff_pct: pct(whiffs, swings),
      contact_pct: swings ? ((swings - whiffs) / swings) * 100 : null,
      zone_pct: pct(inZone, zoneSeen),
      z_swing_pct: pct(zSwings, inZone),
      chase_pct: pct(chases, outZone),
      csw_pct: pct(csw, rows.length),
      first_strike_pct: pct(firstStrikes, firstPitches),
      first_swing_pct: pct(firstSwings, firstPitches),
      // Pitching
      avg_velo: avg(velos),
      max_velo: max(velos),
      avg_spin: avg(spins),
      k_per_9: outs ? (k * 27) / outs : null,
      bb_per_9: outs ? (bb * 27) / outs : null,
      hr_per_9: outs ? (hrAll * 27) / outs : null,
      // Contact (balls in play passing the contact filter)
      bbe: bbe,
      hh: hh,
      hardhit_pct: pct(hh, evs.length),
      barrels: barrels,
      barrel_pct: pct(barrels, evs.length),
      barrels_per_pa: pct(barrels, pa),
      hh_per_pa: pct(hh, pa),
      avg_ev: avg(evs),
      max_ev: max(evs),
      ev90: percentile(evs, 0.9),
      avg_la: avg(las),
      sweet_spots: sweet,
      sweetspot_pct: pct(sweet, las.length),
      avg_dist: avg(dists),
      max_dist: max(dists),
      hr: hr,
      xbh: xbh,
      hits: hits,
      field_outs: fieldOuts,
      // Batted-ball mix (same balls as the contact block)
      gb: gb,
      ld: ld,
      fb: fb,
      pu: pu,
      hr_on_fb: hrFb,
      pulled: pull,
      oppo: oppo,
      gb_pct: pct(gb, typed),
      ld_pct: pct(ld, typed),
      fb_pct: pct(fb, typed),
      pu_pct: pct(pu, typed),
      hr_per_fb: pct(hrFb, fb),
      pull_pct: pct(pull, sprayed),
      oppo_pct: pct(oppo, sprayed)
    };
    // Pitcher-side names for the same numbers (kept for saved weights).
    line.ev_against = line.avg_ev;
    line.hardhit_against_pct = line.hardhit_pct;
    line.hr_allowed = line.hr;
    line.hits_allowed = line.hits;
    return line;
  }

  /* One stat line per player_name. opts.contact narrows the contact block;
     each player's `events` are the rows their history lists. */
  function aggregate(rows, opts) {
    var byPlayer = {};
    rows.forEach(function (r) {
      var name = (r.player_name || "").trim();
      if (!name) return;
      (byPlayer[name] = byPlayer[name] || []).push(r);
    });
    var contact = opts && opts.contact;
    return Object.keys(byPlayer).map(function (name) {
      var playerRows = byPlayer[name];
      var line = statLine(playerRows, opts);
      line.name = name;
      line.id = playerRows[0].player_id || null;
      line.events = contact
        ? playerRows.filter(function (r) { return isBattedBall(r) && contact(r); })
        : playerRows;
      return line;
    });
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
        .filter(function (v) { return typeof v === "number" && isFinite(v); });
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
        if (typeof v !== "number" || !isFinite(v) || !range) return;
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
    aggregate: aggregate,
    computeRatings: computeRatings
  };
})(window);
