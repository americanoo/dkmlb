/* DK MLB DFS Research — app shell: uploads, tables, sorting, expandable
   event history, weight editor, DK slate matching. */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */

  var state = {
    tab: "batters",
    batters: { rows: [], players: [], sortKey: "rating", sortDir: -1, split: "all", expanded: {} },
    pitchers: { rows: [], players: [], sortKey: "rating", sortDir: -1, split: "all", expanded: {} },
    dk: [],
    vegas: [],
    lookup: { entries: [], expanded: {}, filters: loadPref("lkFilters", {}), sort: { key: "pa", dir: -1 } },
    leaders: { batters: null, pitchers: null },
    search: "",
    slateOnly: false,
    minSample: { batters: 1, pitchers: 1 },
    /* 0 = every ball in play; 95 narrows the contact stats to hard-hit balls. */
    evFloor: loadPref("evFloorV2", 0),
    api: false
  };

  function loadPref(key, fallback) {
    try {
      var prefs = JSON.parse(localStorage.getItem("dkmlb_prefs")) || {};
      return prefs[key] !== undefined ? prefs[key] : fallback;
    } catch (e) { return fallback; }
  }

  function savePref(key, value) {
    try {
      var prefs = JSON.parse(localStorage.getItem("dkmlb_prefs")) || {};
      prefs[key] = value;
      localStorage.setItem("dkmlb_prefs", JSON.stringify(prefs));
    } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ */
  /* Stat catalog, chosen columns, formula stats, rating weights         */
  /* ------------------------------------------------------------------ */

  var CUSTOM_FORMATS = [["num1", "1 decimal"], ["num2", "2 decimals"], ["num0", "Whole number"],
    ["pct", "Percent"], ["avg3", ".000 (like AVG)"]];
  var MY_FORMULAS = "My formulas";

  var custom = { batters: loadCustom("batters"), pitchers: loadCustom("pitchers") };

  function loadCustom(kind) {
    var list = loadPref("custom_" + kind, []);
    return Array.isArray(list)
      ? list.filter(function (c) { return c && c.key && c.name && c.formula; })
        .map(function (c) { return { key: c.key, name: c.name, formula: c.formula, format: c.format || "num2" }; })
      : [];
  }

  function saveCustom(kind) {
    savePref("custom_" + kind, custom[kind].map(function (c) {
      return { key: c.key, name: c.name, formula: c.formula, format: c.format };
    }));
  }

  function customDefs(kind) {
    return custom[kind].map(function (c) {
      return { key: c.key, label: c.name, type: c.format, group: MY_FORMULAS, desc: c.formula, custom: true };
    });
  }

  /* Savant columns a stat needs beyond the basics. Data loaded before these
     columns were pulled (or a cleaned CSV) leaves the stat blank. */
  var NEEDS = {
    woba: "woba_denom", xwoba: "woba_denom", xba: "estimated_ba_using_speedangle",
    zone_pitches: "zone", zone_pct: "zone", z_swings: "zone", z_swing_pct: "zone",
    out_zone_pitches: "zone", chases: "zone", chase_pct: "zone",
    pulled: "hc_x", pull_pct: "hc_x", oppo: "hc_x", oppo_pct: "hc_x",
    avg_spin: "release_spin_rate"
  };
  var MIN_SERVER_VERSION = 7;

  /* Data columns the loaded rows don't carry at all. */
  function missingColumns(kind) {
    var rows = state[kind].rows;
    var missing = {};
    if (!rows.length) return missing;
    var sample = rows[0];
    Object.keys(NEEDS).map(function (k) { return NEEDS[k]; }).forEach(function (col) {
      if (!(col in sample)) missing[col] = true;
    });
    return missing;
  }

  /* True when a column can't be computed from the loaded data. */
  function defMissing(def, missing) {
    if (def.split && LEADER_DIMS[def.dim]) {
      var lb = state.leaders[statsTab() || "batters"];
      return !lb || lb.missing.indexOf(LEADER_FIELD[def.base]) !== -1;
    }
    var key = def.split ? def.base : def.key;
    return !!(NEEDS[key] && missing[NEEDS[key]]);
  }

  /* Split columns: a stat recomputed over part of a player's rows, keyed
     "<stat>__<dim>" (e.g. woba__l5, hh__vsR). Day windows count back from
     the most recent game in the loaded data. Computed from all of a
     player's rows, independent of the table's vs LHP/RHP filter. */
  var SPLITS_GROUP = "Splits";
  var WINDOW_DAYS = { l15: 15, l10: 10, l5: 5 };
  /* Career (Statcast era) and season come from Baseball Savant's season
     leaderboards via the stats server; these stats exist there. Pitcher-side
     names map to the same leaderboard fields. */
  var LEADER_FIELD = {
    pa: "pa", woba: "woba", xwoba: "xwoba", bbe: "bbe", hh: "hh", hardhit_pct: "hardhit_pct",
    hardhit_against_pct: "hardhit_pct", barrels: "barrels", barrel_pct: "barrel_pct", avg_ev: "avg_ev",
    ev_against: "avg_ev", max_ev: "max_ev", avg_la: "avg_la", gb_pct: "gb_pct", fb_pct: "fb_pct",
    ld_pct: "ld_pct", pu_pct: "pu_pct"
  };
  var LEADER_DIMS = { career: true, season: true };
  var SPLIT_DIMS = {
    batters: [["career", "career (Statcast era, 2015 on)", "Career"], ["season", "this season", "Season"],
      ["l15", "last 15 days", "15d"], ["l10", "last 10 days", "10d"], ["l5", "last 5 days", "5d"],
      ["vsL", "vs LHP", "vs L"], ["vsR", "vs RHP", "vs R"]],
    pitchers: [["career", "career (Statcast era, 2015 on)", "Career"], ["season", "this season", "Season"],
      ["l15", "last 15 days", "15d"], ["l10", "last 10 days", "10d"], ["l5", "last 5 days", "5d"],
      ["vsL", "vs LHB", "vs L"], ["vsR", "vs RHB", "vs R"]]
  };
  var DEFAULT_SPLIT_STATS = ["woba", "hh", "gb_pct", "fb_pct", "barrels"];
  var splits = { batters: loadSplits("batters"), pitchers: loadSplits("pitchers") };

  /* v2 adds Career and Season and starts with wOBA, HH, GB%, FB% and
     Barrels split five ways; stats split under v1 are kept. */
  function loadSplits(kind) {
    var valid = SPLIT_DIMS[kind].map(function (d) { return d[0]; });
    var v = loadPref("splits2_" + kind, null);
    if (v) {
      return {
        dims: (v.dims || []).filter(function (d) { return valid.indexOf(d) !== -1; }),
        stats: Array.isArray(v.stats) ? v.stats : []
      };
    }
    var old = loadPref("splits_" + kind, null) || {};
    var stats = DEFAULT_SPLIT_STATS.slice();
    (old.stats || []).forEach(function (k) { if (stats.indexOf(k) === -1) stats.push(k); });
    return { dims: ["career", "season", "l15", "l10", "l5"], stats: stats };
  }

  /* First and last game dates in a set of rows (ISO strings). */
  function dateSpan(rows) {
    var lo = null, hi = null;
    rows.forEach(function (r) {
      var d = r.game_date;
      if (!d) return;
      if (lo === null || d < lo) lo = d;
      if (hi === null || d > hi) hi = d;
    });
    return { start: lo, end: hi, days: lo ? Math.round((Date.parse(hi) - Date.parse(lo)) / 86400000) + 1 : 0 };
  }

  function saveSplits(kind) {
    savePref("splits2_" + kind, splits[kind]);
  }

  function splitKey(stat, dim) {
    return stat + "__" + dim;
  }

  function splittable(st) {
    return !st.text && !st.noFormula && !st.dk && !st.vegas && !st.custom && !st.split;
  }

  function splitDefs(kind) {
    var out = [];
    splits[kind].stats.forEach(function (stat) {
      var base = Catalog.stats[kind].filter(function (st) { return st.key === stat; })[0];
      if (!base) return;
      var end = state[kind].span && state[kind].span.end;
      var lb = state.leaders[kind];
      SPLIT_DIMS[kind].forEach(function (d) {
        if (splits[kind].dims.indexOf(d[0]) === -1) return;
        if (LEADER_DIMS[d[0]] && !LEADER_FIELD[stat]) return;
        var when = WINDOW_DAYS[d[0]] && end ? " (ending " + shortDate(end) + ")" :
          d[0] === "season" && lb ? " (" + lb.season_year + ")" : d[0] === "career" && lb ? " (" + lb.career_years + ")" : "";
        var short = d[0] === "season" && lb ? String(lb.season_year) : d[2];
        out.push({
          key: splitKey(stat, d[0]), label: base.label + " " + short, type: base.type, group: SPLITS_GROUP,
          desc: base.label + ", " + d[1] + when + (base.desc ? ": " + base.desc : ""), lower: base.lower,
          split: true, base: stat, dim: d[0]
        });
      });
    });
    return out;
  }

  function splitRowFilter(kind, dim) {
    if (WINDOW_DAYS[dim]) {
      var end = state[kind].span && state[kind].span.end;
      if (!end) return function () { return false; };
      var from = new Date(end + "T00:00:00Z");
      from.setUTCDate(from.getUTCDate() - (WINDOW_DAYS[dim] - 1));
      var cutoff = from.toISOString().slice(0, 10);
      return function (r) { return r.game_date >= cutoff; };
    }
    var hand = dim === "vsL" ? "L" : "R";
    return kind === "batters"
      ? function (r) { return r.p_throws === hand; }
      : function (r) { return r.stand === hand; };
  }

  function applySplits(kind, players, rows, contact) {
    var sp = splits[kind];
    if (!sp.stats.length || !sp.dims.length) return;
    var defs = {};
    Catalog.stats[kind].forEach(function (st) { defs[st.key] = st; });
    sp.dims.forEach(function (dim) {
      if (LEADER_DIMS[dim]) {
        applyLeaderSplit(kind, dim, players);
        return;
      }
      var lines = {};
      Stats.aggregate(rows.filter(splitRowFilter(kind, dim)), { contact: contact })
        .forEach(function (l) { lines[l.name] = l; });
      players.forEach(function (p) {
        var line = lines[p.name];
        sp.stats.forEach(function (stat) {
          var v = line ? line[stat] : null;
          // No plate appearances in the split: counts are 0, rates are blank.
          if (!line && defs[stat] && defs[stat].type === "int") v = 0;
          p[splitKey(stat, dim)] = typeof v === "number" ? v : null;
        });
      });
    });
  }

  function applyLeaderSplit(kind, dim, players) {
    var lb = state.leaders[kind];
    var table = lb && lb[dim];
    var byName = null;
    players.forEach(function (p) {
      var rec = table ? table[p.id] : null;
      if (table && !rec) {
        if (!byName) {
          byName = {};
          Object.keys(table).forEach(function (id) { byName[DK.normalizeName(table[id].name)] = table[id]; });
        }
        rec = byName[DK.normalizeName(p.name)];
      }
      splits[kind].stats.forEach(function (stat) {
        var field = LEADER_FIELD[stat];
        if (!field) return;
        var v = rec ? rec[field] : null;
        p[splitKey(stat, dim)] = typeof v === "number" ? v : null;
      });
    });
  }

  function allStats(kind) {
    return Catalog.stats[kind].concat(splitDefs(kind), customDefs(kind));
  }

  function statDef(kind, key) {
    return allStats(kind).filter(function (st) { return st.key === key; })[0] || null;
  }

  function ratable(st) {
    return !st.text && !st.noFormula;
  }

  /* Names a formula may use: every numeric stat, plus formula stats listed
     before it (a formula can build on an earlier one). */
  function formulaVars(kind, upto) {
    var vars = {};
    Catalog.stats[kind].concat(splitDefs(kind))
      .forEach(function (st) { if (ratable(st)) vars[st.key.toLowerCase()] = st.key; });
    custom[kind].slice(0, upto === undefined ? custom[kind].length : upto)
      .forEach(function (c) { vars[c.key.toLowerCase()] = c.key; });
    return vars;
  }

  function applyCustom(kind, players) {
    custom[kind].forEach(function (c, i) {
      try {
        Formula.apply(Formula.compile(c.formula, formulaVars(kind, i)), players, c.key);
        c.error = null;
      } catch (e) {
        c.error = e.message;
        players.forEach(function (p) { p[c.key] = null; });
      }
    });
  }

  var visibleCols = { batters: loadCols("batters"), pitchers: loadCols("pitchers") };

  function loadCols(kind) {
    var saved = loadPref("cols_" + kind, null);
    return Array.isArray(saved) ? saved : Catalog.defaultColumns[kind].slice();
  }

  function saveCols(kind) {
    savePref("cols_" + kind, visibleCols[kind]);
  }

  /* Weights are a shared 10-point budget per tab over a list of stats you
     choose. v4 stores the list; v3 stored weights for a fixed list. */
  var WEIGHTS_KEY = "dkmlb_weights_v4_";
  var OLD_WEIGHTS_KEY = "dkmlb_weights_v3_";
  var WEIGHT_BUDGET = 10;

  var weights = {
    batters: loadWeights("batters"),
    pitchers: loadWeights("pitchers")
  };

  function defaultWeights(kind) {
    return Catalog.defaultRated[kind].map(function (key) {
      var def = statDef(kind, key);
      return { key: key, weight: 0, invert: !!(def && def.lower) };
    });
  }

  function loadWeights(kind) {
    var list = null;
    try { list = JSON.parse(localStorage.getItem(WEIGHTS_KEY + kind)); } catch (e) { /* ignore */ }
    if (!Array.isArray(list)) {
      list = defaultWeights(kind);
      try {
        var old = JSON.parse(localStorage.getItem(OLD_WEIGHTS_KEY + kind));
        if (old) list.forEach(function (w) { if (typeof old[w.key] === "number") w.weight = old[w.key]; });
      } catch (e) { /* ignore */ }
    }
    list = list.filter(function (w) { return w && typeof w.key === "string"; })
      .map(function (w) { return { key: w.key, weight: +w.weight || 0, invert: !!w.invert }; });
    /* Enforce the budget even against hand-edited storage. */
    var spent = 0;
    list.forEach(function (w) {
      w.weight = Math.max(0, Math.min(w.weight, WEIGHT_BUDGET - spent));
      spent += w.weight;
    });
    return list;
  }

  function weightTotal(kind) {
    return weights[kind].reduce(function (t, w) { return t + w.weight; }, 0);
  }

  function saveWeights(kind) {
    try { localStorage.setItem(WEIGHTS_KEY + kind, JSON.stringify(weights[kind])); } catch (e) { /* ignore */ }
  }

  var DATA_KEYS = ["batters", "pitchers", "dk", "vegas", "lookup", "leaders"];

  function persistData(key, rows) {
    Store.set("dkmlb_" + key, rows).catch(function (e) {
      alert("Could not save " + key + " data for next visit (" + (e && e.message ? e.message : e) +
        "). The data still works for this session; you may need to re-upload after a refresh.");
    });
  }

  /* Restore saved data (async). Data saved by older versions in localStorage
     is migrated into the main store on first load. */
  function restoreData() {
    return Promise.all(DATA_KEYS.map(function (key) {
      var full = "dkmlb_" + key;
      return Store.get(full).then(function (rows) {
        if (rows === undefined && Store.backend === "IndexedDB") {
          var legacy = localStorage.getItem(full);
          if (legacy) {
            try { rows = JSON.parse(legacy); } catch (e) { rows = undefined; }
            if (rows !== undefined) {
              Store.set(full, rows).then(function () { localStorage.removeItem(full); });
            }
          }
        }
        if (rows === undefined) return;
        if (key === "dk") state.dk = rows;
        else if (key === "vegas") state.vegas = rows;
        else if (key === "lookup") state.lookup.entries = rows.filter(function (e) { return e && e.v === 3; });
        else if (key === "leaders") state.leaders = { batters: rows.batters || null, pitchers: rows.pitchers || null };
        else state[key].rows = rows;
      }).catch(function () { /* unreadable entry - start empty */ });
    }));
  }

  /* ------------------------------------------------------------------ */
  /* Aggregation pipeline                                                */
  /* ------------------------------------------------------------------ */

  function splitFilter(kind, rows) {
    var split = state[kind].split;
    if (split === "all") return rows;
    var hand = split === "vsL" ? "L" : "R";
    if (kind === "batters") {
      return rows.filter(function (r) { return r.p_throws === hand; });
    }
    return rows.filter(function (r) { return r.stand === hand; });
  }

  /* With an EV floor set, the contact block and history use balls in play
     at or above it (matching a Savant search filtered on exit velo), while
     volume, results and plate-discipline stats count every pitch. */
  function evFloorContact() {
    var floor = state.evFloor;
    return function (r) {
      var ev = Stats.num(r.launch_speed);
      return ev !== null && ev >= floor;
    };
  }

  /* ---- Team and position for players DraftKings doesn't list (or before
     salaries load). Team comes from the player's latest game; position
     from MLB via the stats server, and for pitchers from whether they
     started most of their games. ---- */
  var PEOPLE_KEY = "dkmlb_people";
  var PEOPLE_MAX_AGE = 3;
  var people = loadPeople();
  var peopleAsked = {};
  var peopleTimer = null;

  function loadPeople() {
    try { return JSON.parse(localStorage.getItem(PEOPLE_KEY)) || {}; } catch (e) { return {}; }
  }

  function fillPlayerInfo(kind, players, rows) {
    var info = {};
    rows.forEach(function (r) {
      var name = r.player_name;
      if (!name) return;
      var i = info[name] || (info[name] = { last: r, games: {} });
      if ((r.game_date || "") >= (i.last.game_date || "")) i.last = r;
      var game = r.game_pk || r.game_date;  // pulled data has no game_pk; a pitcher works one game a day
      if (kind === "pitchers" && game) {
        var inning = +r.inning || 99;
        if (!(game in i.games) || inning < i.games[game]) i.games[game] = inning;
      }
    });
    players.forEach(function (p) {
      var i = info[p.name];
      if (!p.id && i) p.id = (kind === "batters" ? i.last.batter : i.last.pitcher) || null;
      var person = p.id ? people[p.id] : null;
      if (!p.team) {
        var r = i && i.last, team = null;
        if (r && r.inning_topbot) team = (kind === "batters") === (r.inning_topbot === "Top") ? r.away_team : r.home_team;
        p.team = team || (person && person.team) || null;
      }
      if (!p.position) {
        var pos = person && person.pos;
        if (kind === "pitchers" && i && (!pos || pos === "P" || pos === "TWP")) {
          var games = 0, starts = 0;
          Object.keys(i.games).forEach(function (g) { games++; if (i.games[g] === 1) starts++; });
          if (games) pos = starts * 2 >= games ? "SP" : "RP";
        }
        p.position = pos || null;
      }
    });
  }

  function queuePeople() {
    if (!state.api || (state.serverVersion || 0) < 7) return;
    clearTimeout(peopleTimer);
    peopleTimer = setTimeout(fetchPeople, 300);
  }

  function fetchPeople() {
    var today = isoDate(new Date());
    var need = [];
    ["batters", "pitchers"].forEach(function (kind) {
      state[kind].players.forEach(function (p) {
        var id = p.id ? String(p.id) : "";
        if (!/^\d+$/.test(id) || peopleAsked[id]) return;
        var known = people[id];
        if (known && known.t && (Date.parse(today) - Date.parse(known.t)) / 86400000 < PEOPLE_MAX_AGE) return;
        peopleAsked[id] = true;
        need.push(id);
      });
    });
    if (!need.length) return;
    var calls = [];
    for (var n = 0; n < need.length; n += 400) calls.push(api("people?ids=" + need.slice(n, n + 400).join(",")));
    Promise.all(calls).then(function (results) {
      results.forEach(function (res) {
        Object.keys(res.people || {}).forEach(function (id) {
          people[id] = { pos: res.people[id].pos, team: res.people[id].team, t: today };
        });
      });
      try { localStorage.setItem(PEOPLE_KEY, JSON.stringify(people)); } catch (e) { /* ignore */ }
      rebuildAll();
    }, function () { /* positions are a nice-to-have */ });
  }

  function rebuild(kind) {
    var s = state[kind];
    var rows = splitFilter(kind, s.rows);
    var contact = kind === "batters" && state.evFloor ? evFloorContact() : null;
    s.players = Stats.aggregate(rows, { contact: contact });
    s.span = dateSpan(s.rows);
    applySplits(kind, s.players, s.rows, contact);
    if (state.dk.length) DK.matchSalaries(s.players, state.dk);
    fillPlayerInfo(kind, s.players, s.rows);
    Vegas.attach(s.players, state.vegas, kind);
    applyCustom(kind, s.players);
    Stats.computeRatings(s.players, weights[kind]);
    render();
    queuePeople();
  }

  function rebuildAll() {
    rebuild("batters");
    rebuild("pitchers");
  }

  /* ------------------------------------------------------------------ */
  /* Formatting                                                          */
  /* ------------------------------------------------------------------ */

  function fmt(v, type) {
    if (v === null || v === undefined || v === "") return "—";
    switch (type) {
      case "money": return "$" + Number(v).toLocaleString();
      case "pct": return Number(v).toFixed(1) + "%";
      case "num0": return Number(v).toFixed(0);
      case "num1": return Number(v).toFixed(1);
      case "num2": return Number(v).toFixed(2);
      case "ml": return Number(v) > 0 ? "+" + Number(v) : String(Number(v));
      case "avg3": return Number(v) >= 1 ? Number(v).toFixed(3) : Number(v).toFixed(3).replace(/^0/, "");
      case "int": return String(v);
      default: return String(v);
    }
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */

  function render() {
    var kind = state.tab;
    renderStatusBar();
    var isVegas = kind === "vegas";
    var isLookup = kind === "lookup";
    document.getElementById("main-data").style.display = isVegas || isLookup ? "none" : "";
    document.getElementById("vegas-panel").style.display = isVegas ? "" : "none";
    document.getElementById("lookup-panel").style.display = isLookup ? "" : "none";
    document.querySelector(".controls").style.display = isVegas || isLookup ? "none" : "";
    if (isVegas || isLookup) document.getElementById("cols-panel").hidden = true;
    else renderColsPanel();
    renderDataNote();
    if (isVegas) {
      renderVegas();
      return;
    }
    if (isLookup) {
      renderLookup();
      return;
    }
    renderWeights(kind);
    renderTable(kind);
  }

  /* Explain blank stat columns when the loaded data lacks their columns. */
  /* Longest day window in use that's longer than the loaded data. */
  function shortWindow(kind) {
    var span = state[kind].span;
    if (!span || !span.days || !splits[kind].stats.length) return null;
    var longest = 0;
    splits[kind].dims.forEach(function (d) { if (WINDOW_DAYS[d] > longest) longest = WINDOW_DAYS[d]; });
    return longest > span.days ? longest : null;
  }

  function renderDataNote() {
    var note = document.getElementById("data-note");
    var kind = statsTab();
    var missing = kind ? missingColumns(kind) : {};
    var tooShort = kind ? shortWindow(kind) : null;
    if (kind && needsLeaders(kind) && !state.leaders[kind] && !Object.keys(missing).length && !state.api &&
        state[kind].rows.length) {
      note.innerHTML = "<span>Career and season columns come from Baseball Savant's season leaderboards through the " +
        "local stats server. Start it (start-server.command) and open http://localhost:8000 to fill them.</span>";
      note.hidden = false;
      return;
    }
    if (kind && tooShort && !Object.keys(missing).length) {
      var span = state[kind].span;
      note.innerHTML = "<span>Your " + kind + " data covers " + span.days + " day" + (span.days === 1 ? "" : "s") + " (" +
        esc(shortDate(span.start)) + " – " + esc(shortDate(span.end)) + "), so day-window columns longer than that " +
        "show the same games as the whole table. Pull at least " + tooShort + " days to fill the " + tooShort + "-day columns" +
        (kind === "batters" ? " (the 15d button sets it)." : ".") + "</span>";
      note.hidden = false;
      return;
    }
    if (!kind || !Object.keys(missing).length) {
      note.hidden = true;
      return;
    }
    var names = [];
    [["woba_denom", ["wOBA", "xwOBA"]], ["estimated_ba_using_speedangle", ["xBA"]],
      ["zone", ["Zone%", "Z-Swing%", "Chase%"]], ["hc_x", ["Pull%", "Oppo%"]], ["release_spin_rate", ["Spin"]]]
      .forEach(function (pair) {
        if (pair[0] === "release_spin_rate" && !statDef(kind, "avg_spin")) return;
        if (missing[pair[0]]) names = names.concat(pair[1]);
      });
    if (!names.length) { note.hidden = true; return; }
    var list = names.length > 1 ? names.slice(0, -1).join(", ") + " and " + names[names.length - 1] : names[0];
    var canPull = state.api && state.serverCurrent;
    note.innerHTML = "<span>The loaded " + kind + " data is missing the Savant columns behind " + esc(list) +
      ", so those columns are blank (marked ⚠). " +
      (canPull ? "Pull again to fill them in." :
        state.api ? "Restart the stats server first (it's running older code), then pull again." :
        "Start the stats server and pull from Savant, or upload a full (uncleaned) Savant export.") + "</span>" +
      (canPull ? '<button type="button" id="data-note-pull" class="upload-btn as-button">Re-pull now</button>' : "");
    note.hidden = false;
    var btn = document.getElementById("data-note-pull");
    if (btn) btn.addEventListener("click", function () {
      document.getElementById("sv-pull").click();
      note.hidden = true;
    });
  }

  function renderStatusBar() {
    var b = state.batters.rows.length;
    var p = state.pitchers.rows.length;
    var d = state.dk.length;
    document.getElementById("status-batters").textContent =
      b ? b.toLocaleString() + " batter events · " + state.batters.players.length + " players" : "no data";
    document.getElementById("status-pitchers").textContent =
      p ? p.toLocaleString() + " pitcher events · " + state.pitchers.players.length + " players" : "no data";
    var dkStatus = "no salaries";
    if (d) {
      var tabKind = state.tab === "pitchers" ? "pitchers" : "batters";
      var matched = 0;
      state[tabKind].players.forEach(function (pl) { if (pl.onSlate) matched++; });
      dkStatus = d + " DK players · " + matched + " matched";
    }
    document.getElementById("status-dk").textContent = dkStatus;
    var v = state.vegas.length;
    document.getElementById("status-vegas").textContent =
      v ? v + " Vegas team rows" : "no vegas data";
  }

  /* Stats grouped for <select> menus: [[group, [defs]], ...]. */
  function groupedStats(kind, filter) {
    var groups = Catalog.groups.concat([SPLITS_GROUP, MY_FORMULAS]);
    var all = allStats(kind);
    return groups.map(function (g) {
      return [g, all.filter(function (st) { return st.group === g && filter(st); })];
    }).filter(function (pair) { return pair[1].length; });
  }

  function recomputeRatings(kind) {
    Stats.computeRatings(state[kind].players, weights[kind]);
    renderTable(kind);
  }

  function renderWeightsSummary(kind) {
    var rated = weights[kind].filter(function (w) { return w.weight > 0; }).map(function (w) {
      var def = statDef(kind, w.key);
      return (def ? def.label : w.key) + " " + w.weight;
    });
    document.getElementById("weights-summary").textContent = "· " + (WEIGHT_BUDGET - weightTotal(kind)) + " of " +
      WEIGHT_BUDGET + " points left" + (rated.length ? " · " + rated.join(", ") : " · no stats rated yet");
  }

  function renderWeights(kind) {
    renderWeightsSummary(kind);
    var panel = document.getElementById("weights-body");
    var html = '<div class="points-left">Points left: <b id="points-left">' +
      (WEIGHT_BUDGET - weightTotal(kind)) + "</b> / " + WEIGHT_BUDGET + "</div>";
    weights[kind].forEach(function (w, i) {
      var def = statDef(kind, w.key);
      var label = def ? def.label : w.key + " (removed)";
      html +=
        '<div class="weight-row">' +
        '<label for="w-' + i + '" title="' + esc(def ? def.desc : "") + '">' + esc(label) + "</label>" +
        '<button type="button" class="dir-btn' + (w.invert ? " on" : "") + '" data-dir="' + i + '" aria-pressed="' + w.invert +
        '" title="' + (w.invert ? "Lower is better (click to flip)" : "Higher is better (click to flip)") + '">' + (w.invert ? "↓" : "↑") + "</button>" +
        '<input id="w-' + i + '" type="range" min="0" max="' + WEIGHT_BUDGET + '" step="1" value="' + w.weight + '" data-idx="' + i + '">' +
        '<span class="wval">' + w.weight + "</span>" +
        '<button type="button" class="rm-btn" data-rm="' + i + '" title="Remove from rating" aria-label="Remove ' + esc(label) + ' from rating">✕</button>' +
        "</div>";
    });
    var listed = {};
    weights[kind].forEach(function (w) { listed[w.key] = true; });
    var options = groupedStats(kind, function (st) { return ratable(st) && !listed[st.key]; });
    html += '<label class="add-stat"><span>Add a stat to your rating</span><select id="add-weight"><option value="">Choose a stat…</option>' +
      options.map(function (pair) {
        return '<optgroup label="' + esc(pair[0]) + '">' + pair[1].map(function (st) {
          return '<option value="' + esc(st.key) + '">' + esc(st.label) + "</option>";
        }).join("") + "</optgroup>";
      }).join("") + "</select></label>";
    panel.innerHTML = html;

    panel.querySelectorAll("input[type=range]").forEach(function (input) {
      input.addEventListener("input", function () {
        var idx = parseInt(input.getAttribute("data-idx"), 10);
        var requested = parseInt(input.value, 10);
        var otherTotal = weightTotal(kind) - weights[kind][idx].weight;
        var allowed = Math.min(requested, WEIGHT_BUDGET - otherTotal);
        if (allowed !== requested) input.value = allowed;
        weights[kind][idx].weight = allowed;
        input.parentNode.querySelector(".wval").textContent = allowed;
        document.getElementById("points-left").textContent = WEIGHT_BUDGET - weightTotal(kind);
        renderWeightsSummary(kind);
        saveWeights(kind);
        recomputeRatings(kind);
      });
    });
    panel.querySelectorAll("[data-dir]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var w = weights[kind][+btn.getAttribute("data-dir")];
        w.invert = !w.invert;
        saveWeights(kind);
        renderWeights(kind);
        recomputeRatings(kind);
      });
    });
    panel.querySelectorAll("[data-rm]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        weights[kind].splice(+btn.getAttribute("data-rm"), 1);
        saveWeights(kind);
        renderWeights(kind);
        recomputeRatings(kind);
      });
    });
    document.getElementById("add-weight").addEventListener("change", function () {
      var def = statDef(kind, this.value);
      if (!def) return;
      weights[kind].push({ key: def.key, weight: 0, invert: !!def.lower });
      saveWeights(kind);
      renderWeights(kind);
    });
  }

  function visiblePlayers(kind) {
    var s = state[kind];
    var minKey = kind === "batters" ? "bbe" : "pitches";
    var minVal = state.minSample[kind];
    var q = state.search.toLowerCase();
    var list = s.players.filter(function (p) {
      if (p[minKey] < minVal) return false;
      if (state.slateOnly && !p.onSlate) return false;
      if (q && p.name.toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    var key = s.sortKey, dir = s.sortDir;
    list.sort(function (a, b) {
      var va = a[key], vb = b[key];
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (typeof va === "string") return va.localeCompare(vb) * dir;
      return (va - vb) * dir;
    });
    return list;
  }

  /* ---- Player table: one line per player, headers on one line ----
     Columns keep your order (drag a header to move it). Widths come from
     the text they hold; when they don't fit the window the table first
     tightens its font, then leaves off columns from the right end. */
  var SPLIT_SUB = { career: "Car", l15: "15d", l10: "10d", l5: "5d", vsL: "vL", vsR: "vR" };
  var FIT_STEPS = [{ font: 12.5, pad: 6 }, { font: 12, pad: 5 }, { font: 11.5, pad: 4 }, { font: 11, pad: 4 }, { font: 10.5, pad: 3 }];
  var NAME_MAX = 150;
  var NAME_COL = { key: "name", label: "Player", abbr: "Player", type: "text", desc: "Click a player for game-by-game history" };

  function splitSub(kind, dim) {
    if (dim === "season") {
      var lb = state.leaders[kind];
      return lb && lb.season_year ? "'" + String(lb.season_year).slice(-2) : "Szn";
    }
    return SPLIT_SUB[dim] || dim;
  }

  function baseAbbr(kind, key) {
    var def = Catalog.stats[kind].filter(function (st) { return st.key === key; })[0];
    return def ? def.abbr || def.label : key;
  }

  /* Header text: split columns show their window under the stat's name. */
  function headText(kind, c) {
    return c.split ? splitSub(kind, c.dim) : c.abbr || c.label;
  }

  /* Table cells drop the % sign (the header has it) to save width. */
  function cellText(v, type) {
    if (type === "pct" && v !== null && v !== undefined && v !== "") return Number(v).toFixed(1);
    return fmt(v, type);
  }

  function loadOrder(kind) {
    var o = loadPref("order_" + kind, null);
    return Array.isArray(o) ? o : null;
  }

  /* Saved order first; columns it doesn't mention go after the column
     they follow by default. */
  function applyOrder(kind, cols) {
    var saved = loadOrder(kind);
    if (!saved) return cols;
    var byKey = {};
    cols.forEach(function (c) { byKey[c.key] = c; });
    var out = [];
    saved.forEach(function (k) { if (byKey[k] && out.indexOf(byKey[k]) === -1) out.push(byKey[k]); });
    cols.forEach(function (c, i) {
      if (out.indexOf(c) !== -1) return;
      var at = 0;
      for (var j = i - 1; j >= 0; j--) {
        var idx = out.indexOf(cols[j]);
        if (idx !== -1) { at = idx + 1; break; }
      }
      out.splice(at, 0, c);
    });
    return out;
  }

  /* Every column the table would show, in display order, before fitting. */
  function tableCols(kind) {
    var hasDK = state.dk.length > 0;
    var hasVegas = state.vegas.length > 0;
    var shown = {};
    visibleCols[kind].concat(splits[kind].stats).forEach(function (k) { shown[k] = true; });  // a split stat shows its own column too
    var splitsOf = {};
    splitDefs(kind).forEach(function (d) { (splitsOf[d.base] = splitsOf[d.base] || []).push(d); });
    var ordered = [];
    Catalog.stats[kind].forEach(function (st) {
      if (shown[st.key]) ordered.push(st);
      (splitsOf[st.key] || []).forEach(function (d) { ordered.push(d); });
    });
    ordered = ordered.concat(customDefs(kind).filter(function (c) { return shown[c.key]; }));
    return applyOrder(kind, [NAME_COL].concat(ordered.filter(function (c) {
      if (c.dk && !hasDK && !c.always) return false;
      if (c.vegas && !hasVegas) return false;
      return true;
    })));
  }

  /* Move columns (a header, or a split group) in front of another column
     (null = to the end). Columns not shown right now keep their place. */
  function moveColumns(kind, keys, beforeKey) {
    var order = tableCols(kind).map(function (c) { return c.key; });
    var moving = order.filter(function (k) { return keys.indexOf(k) !== -1; });
    var rest = order.filter(function (k) { return keys.indexOf(k) === -1; });
    var at = beforeKey === null ? rest.length : rest.indexOf(beforeKey);
    if (at < 0) at = rest.length;
    var next = rest.slice(0, at).concat(moving, rest.slice(at));
    if (next.join("|") === order.join("|")) return false;
    var prev = loadOrder(kind) || [];
    prev.forEach(function (k, i) {
      if (next.indexOf(k) !== -1) return;
      var pos = 0;
      for (var j = i - 1; j >= 0; j--) {
        var idx = next.indexOf(prev[j]);
        if (idx !== -1) { pos = idx + 1; break; }
      }
      next.splice(pos, 0, k);
    });
    savePref("order_" + kind, next);
    renderTable(kind);
    return true;
  }

  function resetOrder(kind) {
    savePref("order_" + kind, null);
    renderTable(kind);
  }

  var measureCtx = null, measureFont = "", measureCache = {}, measureCount = 0;
  function textWidth(text, font) {
    if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
    var key = font + "|" + text;
    var w = measureCache[key];
    if (w === undefined) {
      if (measureFont !== font) { measureCtx.font = font; measureFont = font; }
      if (++measureCount > 50000) { measureCache = {}; measureCount = 0; }
      w = measureCache[key] = measureCtx.measureText(text).width;
    }
    return w;
  }

  /* Natural width of each column at FIT_STEPS[0]'s font size, without
     padding. Text width scales with font size, so smaller steps scale it. */
  function naturalWidths(kind, cols, players, missing) {
    var s = state[kind];
    var fam = getComputedStyle(document.body).fontFamily;
    var size = FIT_STEPS[0].font;
    var cell = size + "px " + fam, bold = "600 " + size + "px " + fam;
    return cols.map(function (c) {
      var head = headText(kind, c) + (s.sortKey === c.key ? " ▼" : "") +
        (c.key !== "name" && defMissing(c, missing) ? " ⚠" : "");
      var w = textWidth(head, bold);
      if (c.key === "name") {
        var longest = 0;
        players.forEach(function (p) { longest = Math.max(longest, textWidth(p.name, bold)); });
        w = Math.max(w, Math.min(longest + 18, NAME_MAX));
      } else {
        players.forEach(function (p) { w = Math.max(w, textWidth(cellText(p[c.key], c.type), cell)); });
      }
      return w * 1.06 + 2;  // canvas ignores tabular digits; leave a little room
    });
  }

  /* Runs of adjacent split columns of the same stat share a group header. */
  function headerGroups(cols) {
    var groups = [];
    cols.forEach(function (c, i) {
      var last = groups[groups.length - 1];
      if (c.split && last && last.base === c.base && last.end === i - 1) last.end = i;
      else groups.push({ base: c.split ? c.base : null, start: i, end: i });
    });
    return groups;
  }

  /* Pixel widths for cols[0..n) at a step, widening split groups whose
     stat name is wider than their columns. */
  function stepWidths(kind, cols, natural, step, n) {
    var scale = step.font / FIT_STEPS[0].font;
    var widths = natural.slice(0, n).map(function (w) { return Math.ceil(w * scale) + 2 * step.pad; });
    var fam = getComputedStyle(document.body).fontFamily;
    headerGroups(cols.slice(0, n)).forEach(function (g) {
      if (!g.base) return;
      var need = textWidth(baseAbbr(kind, g.base), "600 " + (step.font - 0.5) + "px " + fam) * 1.06 + 2 * step.pad + 2;
      var have = 0;
      for (var i = g.start; i <= g.end; i++) have += widths[i];
      if (have >= need) return;
      var add = Math.ceil((need - have) / (g.end - g.start + 1));
      for (var j = g.start; j <= g.end; j++) widths[j] += add;
    });
    return widths;
  }

  function sum(list) {
    return list.reduce(function (t, v) { return t + v; }, 0);
  }

  function fitColumns(kind, cols, players, missing, avail) {
    var natural = naturalWidths(kind, cols, players, missing);
    if (!avail) return { step: FIT_STEPS[0], n: cols.length, widths: stepWidths(kind, cols, natural, FIT_STEPS[0], cols.length) };
    for (var i = 0; i < FIT_STEPS.length; i++) {
      var w = stepWidths(kind, cols, natural, FIT_STEPS[i], cols.length);
      if (sum(w) <= avail) return { step: FIT_STEPS[i], n: cols.length, widths: w };
    }
    var step = FIT_STEPS[FIT_STEPS.length - 1];
    var n = cols.length;
    var widths;
    do {
      n--;
      widths = stepWidths(kind, cols, natural, step, n);
    } while (n > 2 && sum(widths) > avail);
    return { step: step, n: n, widths: widths };
  }

  function renderTable(kind) {
    var s = state[kind];
    var players = visiblePlayers(kind);
    var wrap = document.getElementById("data-table");
    var missing = missingColumns(kind);
    var allCols = tableCols(kind);
    var fit = fitColumns(kind, allCols, players, missing, Math.max(0, wrap.clientWidth - 2));
    var cols = allCols.slice(0, fit.n);
    var dropped = allCols.slice(fit.n);
    var groups = headerGroups(cols);
    var twoRows = groups.some(function (g) { return g.base; });

    var html = "";
    if (dropped.length) {
      var names = dropped.map(function (c) { return c.label; });
      html += '<p class="fit-note">' + dropped.length + " column" + (dropped.length === 1 ? "" : "s") +
        " didn't fit at this width: " + esc(names.slice(0, 8).join(", ") + (names.length > 8 ? ", …" : "")) +
        ". Drag the ones you need to the left, hide some in Columns &amp; formulas, or widen the window.</p>";
    }
    html += '<table class="ptable" style="font-size:' + fit.step.font + "px;--pad:" + fit.step.pad + 'px"><colgroup>' +
      fit.widths.map(function (w) { return '<col style="width:' + w + 'px">'; }).join("") + "</colgroup><thead><tr>";

    function headCell(c, extra) {
      var arrow = s.sortKey === c.key ? (s.sortDir === -1 ? " ▼" : " ▲") : "";
      var absent = c.key !== "name" && defMissing(c, missing);
      var tip = c.label + (c.desc && c.desc !== c.label ? " — " + c.desc : "") +
        (absent ? " — not in the loaded data: pull from Savant again (or upload a full, uncleaned Savant export)" : "") +
        "\nClick to sort · drag to move";
      var cls = ["ph", extra || "", c.key === "name" ? "name" : "", c.custom ? "custom-col" : "", c.split ? "split-col" : "",
        absent ? "missing-col" : "", s.sortKey === c.key ? "sorted" : "", c.type === "text" ? "t" : ""].join(" ").replace(/\s+/g, " ").trim();
      return '<th scope="col" tabindex="0" class="' + cls + '" data-key="' + esc(c.key) + '" title="' + esc(tip) +
        '" aria-sort="' + (s.sortKey === c.key ? (s.sortDir === -1 ? "descending" : "ascending") : "none") + '"' +
        (twoRows && !c.split ? ' rowspan="2"' : "") + ">" + esc(headText(kind, c)) + (absent ? " ⚠" : "") + arrow + "</th>";
    }

    groups.forEach(function (g) {
      if (!g.base) { html += headCell(cols[g.start]); return; }
      var members = cols.slice(g.start, g.end + 1);
      var full = (Catalog.stats[kind].filter(function (st) { return st.key === g.base; })[0] || {}).label || g.base;
      html += '<th scope="colgroup" tabindex="0" class="pg" colspan="' + members.length + '" data-keys="' +
        esc(members.map(function (c) { return c.key; }).join(",")) + '" title="' +
        esc(full + ": " + members.map(function (c) { return headText(kind, c); }).join(", ") + "\nDrag to move these columns together") +
        '">' + esc(baseAbbr(kind, g.base)) + "</th>";
    });
    html += "</tr>";
    if (twoRows) {
      html += '<tr class="sub-row">';
      cols.forEach(function (c) { if (c.split) html += headCell(c, "sub"); });
      html += "</tr>";
    }
    html += "</thead><tbody>";

    players.forEach(function (p, i) {
      var expanded = s.expanded[p.name];
      html += '<tr class="prow' + (i % 2 ? " alt" : "") + (expanded ? " open" : "") + '" tabindex="0" aria-expanded="' + !!expanded +
        '" data-name="' + esc(p.name) + '">';
      cols.forEach(function (c) {
        if (c.key === "name") {
          html += '<td class="pc name" title="' + esc(p.name) + '"><span class="caret">' + (expanded ? "▾" : "▸") + "</span>" +
            esc(p.name) + "</td>";
        } else {
          html += '<td class="pc' + (c.type === "text" ? " t" : "") + '">' + esc(cellText(p[c.key], c.type)) + "</td>";
        }
      });
      html += "</tr>";
      if (expanded) html += '<tr class="phist"><td colspan="' + cols.length + '">' + historyHTML(kind, p) + "</td></tr>";
    });
    html += "</tbody></table>";
    if (!players.length) {
      html += '<p class="empty">' +
        (s.rows.length ? "No players match the current filters." : "No data yet — pull from Savant or upload a Savant CSV above.") + "</p>";
    }
    /* Re-rendering (sorting, or data arriving in the background) keeps
       keyboard focus on the same header or player. */
    var focused = document.activeElement && wrap.contains(document.activeElement) ? document.activeElement : null;
    var focusSel = !focused ? null
      : focused.hasAttribute("data-keys") ? 'th[data-keys="' + CSS.escape(focused.getAttribute("data-keys")) + '"]'
      : focused.hasAttribute("data-key") ? 'th[data-key="' + CSS.escape(focused.getAttribute("data-key")) + '"]'
      : focused.hasAttribute("data-name") ? '.prow[data-name="' + CSS.escape(focused.getAttribute("data-name")) + '"]' : null;
    wrap.innerHTML = html;
    if (focusSel) {
      var again = wrap.querySelector(focusSel);
      if (again) again.focus({ preventScroll: true });
    }
    wrap.setAttribute("data-width", wrap.clientWidth);
    if (twoRows) {
      var first = wrap.querySelector("thead tr");
      wrap.querySelector(".ptable").style.setProperty("--h1", first.getBoundingClientRect().height + "px");
    }
  }

  /* Sorting, expanding and moving columns on the player table (one set of
     listeners for every render). Drag a header (or a split group's name)
     sideways to move it; Alt+←/→ moves the focused header. */
  function initPlayerGrid() {
    var wrap = document.getElementById("data-table");
    var drag = null;
    var suppressClick = false;

    function headKeys(th) {
      return th.hasAttribute("data-keys") ? th.getAttribute("data-keys").split(",") : [th.getAttribute("data-key")];
    }

    function refocus(keys) {
      var el = keys.length > 1
        ? wrap.querySelector('th[data-keys="' + CSS.escape(keys.join(",")) + '"]')
        : wrap.querySelector('th[data-key="' + CSS.escape(keys[0]) + '"]');
      if (el) el.focus();
    }

    function act(target) {
      var kind = statsTab();
      if (!kind) return;
      var s = state[kind];
      var head = target.closest("th[data-key]");
      if (head) {
        var key = head.getAttribute("data-key");
        if (s.sortKey === key) s.sortDir = -s.sortDir;
        else { s.sortKey = key; s.sortDir = key === "name" ? 1 : -1; }
        renderTable(kind);
        refocus([key]);
        return;
      }
      var row = target.closest(".prow");
      if (row) {
        var name = row.getAttribute("data-name");
        s.expanded[name] = !s.expanded[name];
        renderTable(kind);
        var same = wrap.querySelector('.prow[data-name="' + CSS.escape(name) + '"]');
        if (same) same.focus();
      }
    }

    wrap.addEventListener("click", function (ev) {
      if (suppressClick) { suppressClick = false; return; }
      act(ev.target);
    });
    wrap.addEventListener("keydown", function (ev) {
      var th = ev.target.closest && ev.target.closest("th[data-key], th[data-keys]");
      if (th && ev.altKey && (ev.key === "ArrowLeft" || ev.key === "ArrowRight")) {
        var kind = statsTab();
        if (!kind) return;
        ev.preventDefault();
        var keys = headKeys(th);
        var cols = tableCols(kind);
        /* Step over a whole split group at a time, unless moving one
           column of a group among its neighbors. */
        var units = th.classList.contains("sub")
          ? cols.map(function (c) { return [c.key]; })
          : headerGroups(cols).map(function (g) { return cols.slice(g.start, g.end + 1).map(function (c) { return c.key; }); });
        var at = -1;
        units.forEach(function (u, i) { if (u.indexOf(keys[0]) !== -1) at = i; });
        var moved = ev.key === "ArrowLeft"
          ? at > 0 && moveColumns(kind, keys, units[at - 1][0])
          : at !== -1 && at < units.length - 1 && moveColumns(kind, keys, at + 2 < units.length ? units[at + 2][0] : null);
        if (moved) refocus(keys);
        return;
      }
      if (ev.key !== "Enter" && ev.key !== " ") return;
      if (!ev.target.closest("th[data-key], .prow")) return;
      ev.preventDefault();
      act(ev.target);
    });

    /* Header cells left to right (the lower header row for split columns). */
    function slots(skip) {
      var list = [];
      wrap.querySelectorAll("th[data-key]").forEach(function (th) {
        var key = th.getAttribute("data-key");
        if (skip.indexOf(key) !== -1) return;
        var r = th.getBoundingClientRect();
        list.push({ key: key, left: r.left, right: r.right });
      });
      return list.sort(function (a, b) { return a.left - b.left; });
    }

    wrap.addEventListener("pointerdown", function (ev) {
      if (ev.button !== 0) return;
      var th = ev.target.closest("th[data-key], th[data-keys]");
      if (!th) return;
      drag = { th: th, keys: headKeys(th), x: ev.clientX, id: ev.pointerId, on: false, before: null };
    });
    wrap.addEventListener("pointermove", function (ev) {
      if (!drag || ev.pointerId !== drag.id) return;
      if (!drag.on) {
        if (Math.abs(ev.clientX - drag.x) < 6) return;
        drag.on = true;
        try { drag.th.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
        wrap.classList.add("col-dragging");
        drag.keys.forEach(function (k) {
          var el = wrap.querySelector('th[data-key="' + CSS.escape(k) + '"]');
          if (el) el.classList.add("dragged");
        });
        drag.th.classList.add("dragged");
        drag.marker = document.createElement("div");
        drag.marker.className = "drop-marker";
        drag.ghost = document.createElement("div");
        drag.ghost.className = "drag-ghost";
        drag.ghost.textContent = drag.th.textContent.replace(/ [▲▼]$/, "");
        wrap.appendChild(drag.marker);
        document.body.appendChild(drag.ghost);
        drag.list = slots(drag.keys);
      }
      ev.preventDefault();
      var list = drag.list, x = null;
      drag.before = null;
      for (var i = 0; i < list.length; i++) {
        if (ev.clientX < (list[i].left + list[i].right) / 2) { drag.before = list[i].key; x = list[i].left; break; }
      }
      if (x === null) x = list.length ? list[list.length - 1].right : drag.x;
      var box = wrap.getBoundingClientRect();
      var table = wrap.querySelector(".ptable").getBoundingClientRect();
      drag.marker.style.left = (x - box.left - 1) + "px";
      drag.marker.style.top = (table.top - box.top) + "px";
      drag.marker.style.height = Math.min(table.height, window.innerHeight) + "px";
      drag.ghost.style.left = (ev.clientX + 12) + "px";
      drag.ghost.style.top = (ev.clientY + 12) + "px";
    });
    function end(ev) {
      if (!drag || ev.pointerId !== drag.id) return;
      var d = drag;
      drag = null;
      if (!d.on) return;
      wrap.classList.remove("col-dragging");
      if (d.marker) d.marker.remove();
      if (d.ghost) d.ghost.remove();
      wrap.querySelectorAll("th.dragged").forEach(function (el) { el.classList.remove("dragged"); });
      suppressClick = true;
      setTimeout(function () { suppressClick = false; }, 0);
      var kind = statsTab();
      if (ev.type === "pointerup" && kind && moveColumns(kind, d.keys, d.before)) refocus(d.keys);
    }
    wrap.addEventListener("pointerup", end);
    wrap.addEventListener("pointercancel", end);

    /* Refit when the window width changes. */
    var timer = null;
    window.addEventListener("resize", function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        var kind = statsTab();
        if (kind && String(wrap.clientWidth) !== wrap.getAttribute("data-width")) renderTable(kind);
      }, 120);
    });
  }

  /* Event history shown under an expanded player row, sorted by date. */
  function historyHTML(kind, p) {
    var evts = p.events.slice();
    /* Pitch-level data: list plate-appearance results, not every pitch. */
    var paOnly = evts.filter(function (r) { return r.events; });
    if (paOnly.length) evts = paOnly;
    evts.sort(function (a, b) {
      return (b.game_date || "").localeCompare(a.game_date || "");
    });

    var cols = kind === "batters"
      ? [
          ["game_date", "Date"], ["events", "Result"], ["bb_type", "Batted Ball"],
          ["launch_speed", "EV"], ["launch_angle", "LA"], ["hit_distance_sc", "Dist"],
          ["pitch_type", "Pitch"], ["p_throws", "vs"], ["matchup", "Game"], ["count", "Count"]
        ]
      : [
          ["game_date", "Date"], ["events", "Result"], ["description", "Description"],
          ["pitch_name", "Pitch"], ["effective_speed", "Velo"], ["launch_speed", "EV"],
          ["stand", "vs"], ["matchup", "Game"], ["count", "Count"]
        ];

    var html = '<div class="history"><table><thead><tr>';
    cols.forEach(function (c) { html += "<th>" + esc(c[1]) + "</th>"; });
    html += "</tr></thead><tbody>";
    evts.forEach(function (r) {
      html += "<tr>";
      cols.forEach(function (c) {
        var v;
        if (c[0] === "matchup") v = (r.away_team || "?") + " @ " + (r.home_team || "?");
        else if (c[0] === "count") v = (r.balls || "0") + "-" + (r.strikes || "0");
        else if (c[0] === "events" || c[0] === "description" || c[0] === "bb_type") v = (r[c[0]] || "").replace(/_/g, " ");
        else v = r[c[0]];
        html += "<td>" + esc(v === "" || v === undefined || v === null ? "—" : v) + "</td>";
      });
      html += "</tr>";
    });
    html += "</tbody></table></div>";
    return html;
  }

  /* ------------------------------------------------------------------ */
  /* Vegas editor: editable grid of manually entered matchup data        */
  /* ------------------------------------------------------------------ */

  var VEGAS_FIELDS = [
    { key: "team", label: "Team", kind: "text", ph: "e.g. LAD" },
    { key: "opp", label: "Opp", kind: "text", ph: "e.g. KC" },
    { key: "ou", label: "O/U", kind: "number", step: "0.5", ph: "8.5" },
    { key: "ml", label: "Moneyline", kind: "number", step: "5", ph: "-150" },
    { key: "itt", label: "Implied Total", kind: "number", step: "0.1", ph: "auto" },
    { key: "bets", label: "Bets %", kind: "number", step: "1", ph: "55" },
    { key: "handle", label: "Handle %", kind: "number", step: "1", ph: "62" }
  ];

  function persistVegas() {
    persistData("vegas", state.vegas);
  }

  function vegasChanged() {
    persistVegas();
    rebuild("batters");
    rebuild("pitchers");
  }

  function renderVegas() {
    var table = document.getElementById("vegas-table");
    var byTeam = {};
    state.vegas.forEach(function (r) {
      var t = Vegas.normTeam(r.team);
      if (t) byTeam[t] = r;
    });

    var html = "<thead><tr>";
    VEGAS_FIELDS.forEach(function (f) { html += "<th>" + esc(f.label) + "</th>"; });
    html += "<th>Est. Implied</th><th></th></tr></thead><tbody>";

    state.vegas.forEach(function (row, i) {
      html += "<tr>";
      VEGAS_FIELDS.forEach(function (f) {
        html +=
          '<td><input class="vegas-input ' + (f.kind === "text" ? "vt" : "vn") + '" type="' + f.kind +
          '"' + (f.step ? ' step="' + f.step + '"' : "") +
          ' data-row="' + i + '" data-key="' + f.key + '" value="' + esc(row[f.key]) +
          '" placeholder="' + f.ph + '"></td>';
      });
      var est = Vegas.estimateITT(row, byTeam);
      html += '<td class="n est">' + (est === null ? "—" : est.toFixed(2)) + "</td>";
      html += '<td><button class="ghost-btn del-row" data-row="' + i + '" title="Delete row">✕</button></td>';
      html += "</tr>";
    });
    html += "</tbody>";
    if (!state.vegas.length) {
      html += '<tbody><tr><td colspan="' + (VEGAS_FIELDS.length + 2) +
        '" class="empty">No matchups yet — build them from the DK slate or add rows manually.</td></tr></tbody>';
    }
    table.innerHTML = html;

    table.querySelectorAll("input.vegas-input").forEach(function (input) {
      input.addEventListener("change", function () {
        var r = parseInt(input.getAttribute("data-row"), 10);
        var key = input.getAttribute("data-key");
        state.vegas[r][key] = key === "team" || key === "opp"
          ? Vegas.normTeam(input.value)
          : input.value.trim();
        vegasChanged();
      });
    });
    table.querySelectorAll("button.del-row").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.vegas.splice(parseInt(btn.getAttribute("data-row"), 10), 1);
        vegasChanged();
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Local stats server (pybaseball): Savant pulls + player lookup        */
  /* ------------------------------------------------------------------ */

  function api(path) {
    return fetch("api/" + path, { cache: "no-store" }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) throw new Error(body.error || "The stats server returned an error (" + r.status + ").");
        return body;
      });
    }, function () {
      throw new Error("Can't reach the local stats server. Is it still running?");
    });
  }

  function rowsFromPayload(payload) {
    var cols = payload.columns;
    return payload.rows.map(function (arr) {
      var o = {};
      for (var i = 0; i < cols.length; i++) o[cols[i]] = arr[i] == null ? "" : String(arr[i]);
      return o;
    });
  }

  function isoDate(d) {
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day;
  }

  function daysAgo(n) {
    var d = new Date();
    d.setDate(d.getDate() - n);
    return isoDate(d);
  }

  function shortDate(iso) {
    var p = (iso || "").split("-");
    if (p.length !== 3) return iso || "";
    return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+p[1] - 1] +
      " " + (+p[2]) + ", " + p[0];
  }

  function setStatus(el, text, tone) {
    el.textContent = text;
    el.className = "sv-status" + (tone ? " " + tone : "");
  }

  /* Run a server request while showing the server's day-by-day progress. */
  function withProgress(el, label, promise, unit) {
    var t0 = Date.now();
    setStatus(el, label + "…", "busy");
    var timer = setInterval(function () {
      api("progress").then(function (pr) {
        var secs = Math.round((Date.now() - t0) / 1000);
        var detail = pr.active && pr.total > 1 ? " — " + (unit || "day") + " " + Math.min(pr.done + 1, pr.total) + " of " + pr.total : "";
        setStatus(el, label + detail + " · " + secs + "s", "busy");
      }).catch(function () { /* keep the last message */ });
    }, 800);
    return promise.then(function (v) { clearInterval(timer); return v; },
      function (e) { clearInterval(timer); throw e; });
  }

  function initSavantPanel() {
    var batStart = document.getElementById("sv-bat-start");
    var batEnd = document.getElementById("sv-bat-end");
    var pitStart = document.getElementById("sv-pit-start");
    var pitEnd = document.getElementById("sv-pit-end");
    var post = document.getElementById("sv-post");
    var today = isoDate(new Date());
    batStart.value = loadPref("svBatStart", daysAgo(14));
    pitStart.value = loadPref("svPitStart", daysAgo(30));
    batEnd.value = today;
    pitEnd.value = today;
    post.checked = loadPref("svPost", true);
    [batStart, batEnd, pitStart, pitEnd].forEach(function (i) { i.max = today; });
    document.querySelectorAll("[data-bat-days]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        batStart.value = daysAgo(+btn.getAttribute("data-bat-days") - 1);
        batEnd.value = today;
      });
    });

    document.getElementById("sv-pull").addEventListener("click", function () {
      var btn = this;
      var status = document.getElementById("sv-status");
      if (!batStart.value || !pitStart.value) {
        setStatus(status, "Pick a start date for batters and pitchers.", "error");
        return;
      }
      savePref("svBatStart", batStart.value);
      savePref("svPitStart", pitStart.value);
      savePref("svPost", post.checked);
      var ps = post.checked ? 1 : 0;
      var summary = [];
      btn.disabled = true;

      function pull(role, start, end) {
        var kind = role === "batter" ? "batters" : "pitchers";
        var q = "league?role=" + role + "&start=" + start + "&end=" + (end || today) + "&postseason=" + ps;
        return withProgress(status, "Pulling " + kind + " from Baseball Savant", api(q)).then(function (payload) {
          var rows = rowsFromPayload(payload);
          state[kind].rows = rows;
          state[kind].expanded = {};
          persistData(kind, rows);
          rebuild(kind);
          var names = {};
          rows.forEach(function (r) { names[r.player_name] = 1; });
          summary.push(rows.length.toLocaleString() + " pitches for " + Object.keys(names).length + " " + kind +
            " (" + shortDate(payload.start) + " – " + shortDate(payload.end) + ")");
        });
      }

      pull("batter", batStart.value, batEnd.value)
        .then(function () { return pull("pitcher", pitStart.value, pitEnd.value); })
        .then(function () { setStatus(status, "Loaded " + summary.join(" and ") + ".", "ok"); },
          function (e) {
            setStatus(status, (summary.length ? "Loaded " + summary[0] + ", but pitchers failed: " : "") + e.message, "error");
          })
        .then(function () { btn.disabled = false; });
    });
  }

  /* ---- Lookup tab: player or team. Career and season come from MLB's
     official totals; Statcast detail covers only the last 15 days, split
     into 15/10/5-day windows, so nothing season-long is downloaded. ---- */

  var TEAM_NAMES = {
    ATH: "Athletics", ATL: "Atlanta Braves", AZ: "Arizona Diamondbacks", BAL: "Baltimore Orioles",
    BOS: "Boston Red Sox", CHC: "Chicago Cubs", CIN: "Cincinnati Reds", CLE: "Cleveland Guardians",
    COL: "Colorado Rockies", CWS: "Chicago White Sox", DET: "Detroit Tigers", HOU: "Houston Astros",
    KC: "Kansas City Royals", LAA: "Los Angeles Angels", LAD: "Los Angeles Dodgers", MIA: "Miami Marlins",
    MIL: "Milwaukee Brewers", MIN: "Minnesota Twins", NYM: "New York Mets", NYY: "New York Yankees",
    PHI: "Philadelphia Phillies", PIT: "Pittsburgh Pirates", SD: "San Diego Padres", SEA: "Seattle Mariners",
    SF: "San Francisco Giants", STL: "St. Louis Cardinals", TB: "Tampa Bay Rays", TEX: "Texas Rangers",
    TOR: "Toronto Blue Jays", WSH: "Washington Nationals"
  };
  var TEAM_CODES = Object.keys(TEAM_NAMES).sort(function (a, b) {
    return TEAM_NAMES[a].localeCompare(TEAM_NAMES[b]);
  });

  var PITCH_GROUPS = {
    fastball: ["FF", "SI", "FC", "FA"],
    breaking: ["SL", "ST", "SV", "CU", "KC", "CS"],
    offspeed: ["CH", "FS", "FO", "SC", "KN", "EP"]
  };

  /* Each filter: options as [value, label]; "" means no filter. contact
     filters narrow only the contact block (balls in play). */
  var LOOKUP_FILTERS = [
    { key: "pthrows", label: "Pitcher throws", options: [["", "Either"], ["L", "Left (LHP)"], ["R", "Right (RHP)"]] },
    { key: "stand", label: "Batter stands", options: [["", "Either"], ["L", "Left (LHB)"], ["R", "Right (RHB)"]] },
    { key: "pitch", label: "Pitch type", options: [["", "All pitches"], ["g:fastball", "Fastballs (4-seam, sinker, cutter)"],
      ["g:breaking", "Breaking (slider, sweeper, curve)"], ["g:offspeed", "Offspeed (changeup, splitter)"],
      ["FF", "4-Seam"], ["SI", "Sinker"], ["FC", "Cutter"], ["SL", "Slider"], ["ST", "Sweeper"],
      ["CU", "Curveball"], ["KC", "Knuckle curve"], ["CH", "Changeup"], ["FS", "Splitter"]] },
    { key: "count", label: "Count", options: [["", "Any count"], ["first", "First pitch (0-0)"],
      ["ahead", "Hitter ahead"], ["behind", "Pitcher ahead"], ["even", "Even"], ["two", "Two strikes"], ["full", "Full (3-2)"]] },
    { key: "venue", label: "Home / away", options: [["", "Both"], ["home", "Home"], ["away", "Away"]] },
    { key: "opp", label: "Opponent", options: [["", "Any team"]] },
    { key: "inning", label: "Innings", options: [["", "All innings"], ["1-3", "1st–3rd"], ["4-6", "4th–6th"], ["7+", "7th +"]] },
    { key: "tto", label: "Times through order", options: [["", "Any"], ["1", "1st time"], ["2", "2nd time"], ["3", "3rd+ time"]] },
    { key: "bb", label: "Batted ball", contact: true, options: [["", "All"], ["ground_ball", "Ground balls"],
      ["line_drive", "Line drives"], ["fly_ball", "Fly balls"], ["popup", "Pop-ups"]] },
    { key: "minev", label: "Min exit velo", contact: true, number: true }
  ];
  TEAM_CODES.forEach(function (c) { LOOKUP_FILTERS[5].options.push([c, TEAM_NAMES[c]]); });

  var LK_RESULTS_BAT = [
    { key: "pitches", label: "Pitches", type: "int" }, { key: "pa", label: "PA", type: "int" },
    { key: "avg", label: "AVG", type: "avg3" }, { key: "obp", label: "OBP", type: "avg3" },
    { key: "slg", label: "SLG", type: "avg3" }, { key: "ops", label: "OPS", type: "avg3" },
    { key: "woba", label: "wOBA", type: "avg3" }, { key: "xwoba", label: "xwOBA", type: "avg3" },
    { key: "k_pct", label: "K%", type: "pct" }, { key: "bb_pct", label: "BB%", type: "pct" },
    { key: "whiff_pct", label: "Whiff%", type: "pct" }, { key: "chase_pct", label: "Chase%", type: "pct" }
  ];
  var LK_RESULTS_PIT = [
    { key: "pitches", label: "Pitches", type: "int" }, { key: "pa", label: "BF", type: "int" },
    { key: "ip", label: "IP", type: "text" }, { key: "era", label: "ERA", type: "num2" },
    { key: "whip", label: "WHIP", type: "num2" },
    { key: "k_pct", label: "K%", type: "pct" }, { key: "bb_pct", label: "BB%", type: "pct" },
    { key: "whiff_pct", label: "Whiff%", type: "pct" }, { key: "csw_pct", label: "CSW%", type: "pct" },
    { key: "chase_pct", label: "Chase%", type: "pct" }, { key: "avg", label: "AVG", type: "avg3" },
    { key: "woba", label: "wOBA", type: "avg3" }, { key: "xwoba", label: "xwOBA", type: "avg3" },
    { key: "avg_velo", label: "Velo", type: "num1" }
  ];
  var LK_CONTACT_BAT = [
    { key: "bbe", label: "BBE", type: "int" }, { key: "hh", label: "HH", type: "int" },
    { key: "hardhit_pct", label: "HardHit%", type: "pct" }, { key: "barrel_pct", label: "Barrel%", type: "pct" },
    { key: "avg_ev", label: "Avg EV", type: "num1" }, { key: "max_ev", label: "Max EV", type: "num1" },
    { key: "avg_la", label: "Avg LA", type: "num1" }, { key: "sweetspot_pct", label: "SweetSpot%", type: "pct" },
    { key: "avg_dist", label: "Avg Dist", type: "num0" }, { key: "hr", label: "HR", type: "int" },
    { key: "xbh", label: "XBH", type: "int" }, { key: "hits", label: "Hits", type: "int" }
  ];
  var LK_CONTACT_PIT = [
    { key: "bbe", label: "BBE", type: "int" }, { key: "hh", label: "HH", type: "int" },
    { key: "hardhit_pct", label: "HardHit%", type: "pct" }, { key: "barrel_pct", label: "Barrel%", type: "pct" },
    { key: "avg_ev", label: "Avg EV", type: "num1" }, { key: "hr", label: "HR", type: "int" },
    { key: "hits", label: "Hits", type: "int" }
  ];
  var HISTORY_LIMIT = 400;
  var LOOKUP_DAYS = 15;
  var WINDOWS = [15, 10, 5];
  var ENTRY_VERSION = 3;

  /* First date inside an N-day window ending on `end` (both ISO dates). */
  function windowStart(end, days) {
    var d = new Date(end + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - (days - 1));
    return d.toISOString().slice(0, 10);
  }

  /* Day windows end on the latest game in the data, or yesterday if the
     player hasn't played since (today's games usually haven't happened yet),
     matching the day-window split columns on the Batters/Pitchers tabs. */
  function windowEnd(entry) {
    var yesterday = windowStart(entry.end, 2);
    var last = dateSpan(entry.rows).end;
    return last && last > yesterday ? last : yesterday;
  }

  function windowRows(entry, days) {
    var from = windowStart(windowEnd(entry), days);
    return entry.rows.filter(function (r) { return r.game_date >= from; });
  }

  function lkFilters() {
    return state.lookup.filters;
  }

  function battingTeam(r) {
    return r.inning_topbot === "Top" ? r.away_team : r.home_team;
  }

  function pitchingTeam(r) {
    return r.inning_topbot === "Top" ? r.home_team : r.away_team;
  }

  /* Situation filters: narrow every stat. side decides what home/away and
     opponent mean (the batting team's view or the pitching team's view). */
  function situationFilter(side) {
    var f = lkFilters();
    var pitchSet = null;
    if (f.pitch) {
      pitchSet = {};
      (f.pitch.indexOf("g:") === 0 ? PITCH_GROUPS[f.pitch.slice(2)] : [f.pitch])
        .forEach(function (t) { pitchSet[t] = 1; });
    }
    return function (r) {
      if (f.pthrows && r.p_throws !== f.pthrows) return false;
      if (f.stand && r.stand !== f.stand) return false;
      if (pitchSet && !pitchSet[r.pitch_type]) return false;
      if (f.count) {
        var b = +r.balls, s = +r.strikes;
        if (f.count === "first" && !(b === 0 && s === 0)) return false;
        if (f.count === "ahead" && !(b > s)) return false;
        if (f.count === "behind" && !(s > b)) return false;
        if (f.count === "even" && b !== s) return false;
        if (f.count === "two" && s !== 2) return false;
        if (f.count === "full" && !(b === 3 && s === 2)) return false;
      }
      if (f.venue || f.opp) {
        var battingHome = r.inning_topbot === "Bot";
        var isHome = side === "batting" ? battingHome : !battingHome;
        if (f.venue === "home" && !isHome) return false;
        if (f.venue === "away" && isHome) return false;
        if (f.opp && (side === "batting" ? pitchingTeam(r) : battingTeam(r)) !== f.opp) return false;
      }
      if (f.inning) {
        var inn = +r.inning;
        if (f.inning === "1-3" && !(inn >= 1 && inn <= 3)) return false;
        if (f.inning === "4-6" && !(inn >= 4 && inn <= 6)) return false;
        if (f.inning === "7+" && !(inn >= 7)) return false;
      }
      if (f.tto) {
        var t = +r.n_thruorder_pitcher;
        if (f.tto === "3" ? t < 3 : t !== +f.tto) return false;
      }
      return true;
    };
  }

  function contactFilter() {
    var f = lkFilters();
    var minEv = f.minev === "" || f.minev === undefined ? null : parseFloat(f.minev);
    return function (r) {
      if (f.bb && r.bb_type !== f.bb) return false;
      if (minEv !== null && !isNaN(minEv)) {
        var ev = Stats.num(r.launch_speed);
        if (ev === null || ev < minEv) return false;
      }
      return true;
    };
  }

  function contactFiltersActive() {
    var f = lkFilters();
    return !!(f.bb || (f.minev !== "" && f.minev !== undefined));
  }

  function filterSummary() {
    var f = lkFilters();
    var parts = [];
    LOOKUP_FILTERS.forEach(function (def) {
      var v = f[def.key];
      if (v === "" || v === undefined) return;
      if (def.number) { parts.push(def.label + " " + v + "+ mph"); return; }
      var opt = def.options.filter(function (o) { return o[0] === v; })[0];
      if (opt) parts.push(def.label + ": " + opt[1]);
    });
    return parts;
  }

  function renderFilterFields() {
    var box = document.getElementById("lk-filter-fields");
    var f = lkFilters();
    box.innerHTML = LOOKUP_FILTERS.map(function (def) {
      var id = "lkf-" + def.key;
      var field;
      if (def.number) {
        field = '<input type="number" id="' + id + '" data-filter="' + def.key + '" min="0" max="125" step="1" placeholder="e.g. 95" value="' +
          esc(f[def.key] || "") + '">';
      } else {
        field = '<select id="' + id + '" data-filter="' + def.key + '">' + def.options.map(function (o) {
          return '<option value="' + esc(o[0]) + '"' + ((f[def.key] || "") === o[0] ? " selected" : "") + ">" + esc(o[1]) + "</option>";
        }).join("") + "</select>";
      }
      return '<label class="filter-field' + (def.contact ? " contact" : "") + '"><span>' + esc(def.label) +
        (def.contact ? ' <em title="Narrows the contact columns and the PA list only">contact</em>' : "") +
        "</span>" + field + "</label>";
    }).join("");
    box.querySelectorAll("[data-filter]").forEach(function (el) {
      el.addEventListener(el.tagName === "SELECT" ? "change" : "input", function () {
        f[el.getAttribute("data-filter")] = el.value.trim();
        savePref("lkFilters", f);
        renderLookupResults();
      });
    });
  }

  function lookupCols(side) {
    return side === "batting"
      ? { results: LK_RESULTS_BAT, contact: LK_CONTACT_BAT }
      : { results: LK_RESULTS_PIT, contact: LK_CONTACT_PIT };
  }

  function statCells(line, cols) {
    return cols.results.concat(cols.contact).map(function (c) {
      var v = line ? line[c.key] : null;
      return '<td class="n">' + esc(fmt(v === undefined ? null : v, c.type)) + "</td>";
    }).join("");
  }

  function groupHeader(cols, lead, tail) {
    return '<tr class="group-row"><th colspan="' + lead + '"></th>' +
      '<th colspan="' + cols.results.length + '" class="grp">Results · every pitch & PA matching the filters</th>' +
      '<th colspan="' + cols.contact.length + '" class="grp contact-grp">Contact · balls in play' +
      (contactFiltersActive() ? " (contact filters on)" : "") + "</th>" +
      (tail ? '<th colspan="' + tail + '"></th>' : "") + "</tr>";
  }

  function lookupHistoryHTML(rows, side) {
    var contactOn = contactFiltersActive();
    var ok = contactFilter();
    var list = rows.filter(function (r) {
      return contactOn ? Stats.isBattedBall(r) && ok(r) : !!r.events;
    }).slice().reverse();
    var total = list.length;
    list = list.slice(0, HISTORY_LIMIT);
    var oppLabel = side === "batting" ? "Pitcher" : "Batter";
    var cols = [["game_date", "Date"], ["opp_team", "Opp"], ["opp_player", oppLabel], ["inning", "Inn"],
      ["count", "Count"], ["pitch_name", "Pitch"], ["release_speed", "Velo"], ["events", "Result"],
      ["bb_type", "Batted ball"], ["launch_speed", "EV"], ["launch_angle", "LA"], ["hit_distance_sc", "Dist"],
      ["estimated_woba_using_speedangle", "xwOBA"]];
    var html = '<div class="history">';
    if (!total) return html + '<p class="hint">No ' + (contactOn ? "balls in play" : "plate appearances") +
      " match the filters.</p></div>";
    if (total > HISTORY_LIMIT) html += '<p class="hint">Showing the latest ' + HISTORY_LIMIT + " of " + total.toLocaleString() + ".</p>";
    html += "<table><thead><tr>" + cols.map(function (c) { return "<th>" + c[1] + "</th>"; }).join("") + "</tr></thead><tbody>";
    list.forEach(function (r) {
      html += "<tr>" + cols.map(function (c) {
        var v;
        if (c[0] === "opp_team") v = (side === "batting" ? pitchingTeam(r) : battingTeam(r)) || "";
        else if (c[0] === "count") v = (r.balls || "0") + "-" + (r.strikes || "0");
        else if (c[0] === "events" || c[0] === "bb_type") v = (r[c[0]] || "").replace(/_/g, " ");
        else if (c[0] === "estimated_woba_using_speedangle") v = r[c[0]] ? fmt(r[c[0]], "avg3") : "";
        else v = r[c[0]];
        return "<td>" + esc(v === "" || v === undefined || v === null ? "—" : v) + "</td>";
      }).join("") + "</tr>";
    });
    return html + "</tbody></table></div>";
  }

  function entryLabel(e) {
    if (e.kind === "team") return (TEAM_NAMES[e.team] || e.team);
    return e.name;
  }

  /* A team row expands into each player's line, sortable by any column. */
  function teamBreakdownHTML(prefix, side, rows, cols) {
    var byName = {};
    rows.forEach(function (r) { (byName[r.player_name] = byName[r.player_name] || []).push(r); });
    var contact = contactFilter();
    var sort = state.lookup.sort;
    var players = Object.keys(byName).map(function (name) {
      var line = Stats.statLine(byName[name], { contact: contact });
      line.name = name;
      line.rows = byName[name];
      return line;
    });
    players.sort(function (a, b) {
      var va = a[sort.key], vb = b[sort.key];
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (typeof va === "string") return va.localeCompare(vb) * sort.dir;
      return (va - vb) * sort.dir;
    });
    var all = cols.results.concat(cols.contact);
    var html = '<div class="breakdown"><table class="data-grid"><thead>' + groupHeader(cols, 1, 0) + "<tr>" +
      '<th data-sort="name">' + (side === "batting" ? "Batter" : "Pitcher") + (sort.key === "name" ? (sort.dir < 0 ? " ▼" : " ▲") : "") + "</th>" +
      all.map(function (c) {
        return '<th data-sort="' + c.key + '">' + esc(c.label) + (sort.key === c.key ? (sort.dir < 0 ? " ▼" : " ▲") : "") + "</th>";
      }).join("") + "</tr></thead><tbody>";
    players.forEach(function (p) {
      var key = prefix + "|" + p.name;
      var open = state.lookup.expanded[key];
      html += '<tr class="player-row sub' + (open ? " open" : "") + '" data-key="' + esc(key) + '">' +
        '<td class="t name-cell"><span class="caret">' + (open ? "▾" : "▸") + "</span>" + esc(p.name) + "</td>" +
        statCells(p, cols) + "</tr>";
      if (open) {
        html += '<tr class="history-row"><td colspan="' + (all.length + 1) + '">' + lookupHistoryHTML(p.rows, side) + "</td></tr>";
      }
    });
    return html + "</tbody></table></div>";
  }

  function renderLookupResults() {
    var out = document.getElementById("lookup-results");
    var entries = state.lookup.entries;
    document.getElementById("lk-filters").hidden = !entries.length;
    var summary = filterSummary();
    var html = "";
    if (entries.length) {
      html += '<p class="filter-summary">' + (summary.length
        ? "<b>Filtered:</b> " + summary.map(esc).join(" · ") + ". Filters apply to the last 15/10/5-day rows; " +
          "career and season are MLB's official totals."
        : "No filters. Career and season are MLB's official totals; the day rows are Statcast.") + "</p>";
    }
    ["batting", "pitching"].forEach(function (side) {
      var list = entries.filter(function (e) { return e.side === side; });
      if (!list.length) return;
      var cols = lookupCols(side);
      var situation = situationFilter(side);
      var contact = contactFilter();
      var span = cols.results.length + cols.contact.length + 2;
      html += '<h2 class="lookup-head">' + (side === "batting" ? "Batting" : "Pitching") + "</h2>";
      html += '<div class="table-wrap"><table class="data-grid lookup-table"><thead>' + groupHeader(cols, 1, 1) +
        "<tr><th>Window</th>" +
        cols.results.concat(cols.contact).map(function (c) { return "<th>" + esc(c.label) + "</th>"; }).join("") +
        "<th></th></tr></thead>";
      list.forEach(function (e) {
        html += "<tbody class=\"entry\">";
        html += '<tr class="entry-row"><td colspan="' + (span - 1) + '"><span class="entry-name">' + esc(entryLabel(e)) + "</span>" +
          '<span class="chip' + (e.kind === "team" ? " team" : "") + '">' + (e.kind === "team" ? "Team " + e.side : (side === "batting" ? "Batter" : "Pitcher")) + "</span>" +
          '<span class="muted entry-note">Statcast through ' + esc(shortDate(e.end)) + "</span></td>" +
          '<td><button class="ghost-btn del-row" data-remove="' + esc(e.key) + '" title="Remove">✕</button></td></tr>';

        if (e.totals) {
          if (e.kind === "player") {
            html += '<tr class="totals-row"><td class="t win">Career <span class="muted">MLB</span></td>' +
              statCells(e.totals.career, cols) + "<td></td></tr>";
          }
          html += '<tr class="totals-row"><td class="t win">' + esc(e.totals.season_year) + ' season <span class="muted">MLB</span></td>' +
            statCells(e.totals.season, cols) + "<td></td></tr>";
        } else {
          html += '<tr class="totals-row"><td class="t win muted" colspan="' + span + '">Career and season totals didn\'t load' +
            (e.totalsError ? " — " + esc(e.totalsError) : "") + " Look the player up again to retry.</td></tr>";
        }

        WINDOWS.forEach(function (days) {
          var rows = windowRows(e, days).filter(situation);
          var line = Stats.statLine(rows, { contact: contact });
          var key = e.key + "|" + days;
          var open = state.lookup.expanded[key];
          var focus = side === "batting" && days === 5;
          html += '<tr class="player-row window-row' + (open ? " open" : "") + (focus ? " focus" : "") + '" data-key="' + esc(key) + '"' +
            ' title="' + esc(shortDate(windowStart(windowEnd(e), days)) + " – " + shortDate(windowEnd(e))) + '">' +
            '<td class="t win"><span class="caret">' + (open ? "▾" : "▸") + "</span>Last " + days + " days" +
            (focus ? ' <span class="focus-tag">key for hitters</span>' : "") + "</td>" +
            statCells(line, cols) + "<td></td></tr>";
          if (open) {
            html += '<tr class="history-row"><td colspan="' + span + '">' +
              (e.kind === "team" ? teamBreakdownHTML(key, side, rows, cols) : lookupHistoryHTML(rows, side)) + "</td></tr>";
          }
        });
        html += "</tbody>";
      });
      html += "</table></div>";
    });
    if (!entries.length && state.api) {
      html = '<p class="empty-note">Look up a player or a whole team. Add as many as you like to compare them, ' +
        "then use the filters to split the recent days by pitch type, count, handedness and more.</p>";
    }
    out.innerHTML = html;

    out.querySelectorAll("tr.player-row").forEach(function (tr) {
      tr.addEventListener("click", function (ev) {
        ev.stopPropagation();
        var key = tr.getAttribute("data-key");
        state.lookup.expanded[key] = !state.lookup.expanded[key];
        renderLookupResults();
      });
    });
    out.querySelectorAll("th[data-sort]").forEach(function (th) {
      th.addEventListener("click", function () {
        var key = th.getAttribute("data-sort");
        var sort = state.lookup.sort;
        if (sort.key === key) sort.dir = -sort.dir;
        else { sort.key = key; sort.dir = key === "name" ? 1 : -1; }
        renderLookupResults();
      });
    });
    out.querySelectorAll("button[data-remove]").forEach(function (btn) {
      btn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        var key = btn.getAttribute("data-remove");
        state.lookup.entries = state.lookup.entries.filter(function (e) { return e.key !== key; });
        persistData("lookup", state.lookup.entries);
        renderLookupResults();
      });
    });
  }

  function renderLookup() {
    document.getElementById("lookup-offline").hidden = state.api;
    document.getElementById("lookup-form").hidden = !state.api;
    renderLookupResults();
  }

  function addLookupEntry(entry, status) {
    state.lookup.entries = state.lookup.entries.filter(function (e) { return e.key !== entry.key; });
    state.lookup.entries.unshift(entry);
    persistData("lookup", state.lookup.entries);
    var what = entryLabel(entry) + (entry.kind === "team" ? " " + entry.side : "");
    setStatus(status, entry.totalsError
      ? "Loaded the last " + LOOKUP_DAYS + " days for " + what + ", but career/season totals didn't load: " + entry.totalsError
      : "Loaded " + what + ": career and season totals plus " + entry.rows.length.toLocaleString() +
        " pitches from the last " + LOOKUP_DAYS + " days.", entry.totalsError ? "error" : "ok");
    renderLookupResults();
  }

  function initLookup() {
    var form = document.getElementById("lookup-form");
    var nameInput = document.getElementById("lk-name");
    var role = document.getElementById("lk-role");
    var teamSel = document.getElementById("lk-team");
    var side = document.getElementById("lk-side");
    var post = document.getElementById("lk-post");
    var status = document.getElementById("lk-status");
    var cands = document.getElementById("lk-candidates");
    var scope = "player";

    teamSel.innerHTML = TEAM_CODES.map(function (c) {
      return '<option value="' + c + '">' + esc(TEAM_NAMES[c]) + "</option>";
    }).join("");
    teamSel.value = loadPref("lkTeam", "NYY");
    post.checked = loadPref("lkPost", true);
    renderFilterFields();

    form.querySelectorAll("[data-scope]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        scope = btn.getAttribute("data-scope");
        form.querySelectorAll("[data-scope]").forEach(function (b) {
          var on = b === btn;
          b.classList.toggle("active", on);
          b.setAttribute("aria-checked", on ? "true" : "false");
        });
        form.querySelector(".scope-player").hidden = scope !== "player";
        form.querySelector(".scope-team").hidden = scope !== "team";
        cands.innerHTML = "";
      });
    });

    document.getElementById("lk-reset-filters").addEventListener("click", function () {
      state.lookup.filters = {};
      savePref("lkFilters", {});
      renderFilterFields();
      renderLookupResults();
    });

    /* Statcast for the recent window and MLB totals, requested together;
       a totals failure still keeps the Statcast rows. */
    function load(base, statcastPath, totalsPath, label) {
      var end = isoDate(new Date());
      // One extra day: windows can end yesterday, so 15 days reach back 15 days from then.
      var q = "&start=" + daysAgo(LOOKUP_DAYS) + "&end=" + end + "&postseason=" + (post.checked ? 1 : 0);
      var totals = api(totalsPath).then(null, function (e) { return { error: e.message }; });
      return withProgress(status, label, api(statcastPath + q)).then(function (payload) {
        return totals.then(function (t) {
          var rows = rowsFromPayload(payload);
          if (!rows.length && t.error) {
            setStatus(status, "No recent Statcast data for " + base.name + ", and " + t.error, "error");
            return;
          }
          if (base.kind === "player" && rows.length && rows[0].player_name) {
            var parts = rows[0].player_name.split(", ");
            base.name = parts.length === 2 ? parts[1] + " " + parts[0] : rows[0].player_name;
          }
          base.v = ENTRY_VERSION;
          base.start = payload.start;
          base.end = payload.end;
          base.rows = rows;
          base.totals = t.error ? null : t;
          base.totalsError = t.error || null;
          addLookupEntry(base, status);
        });
      }).catch(function (e) { setStatus(status, e.message, "error"); });
    }

    function fetchPlayer(c) {
      cands.innerHTML = "";
      var sd = role.value;
      var r = sd === "batting" ? "batter" : "pitcher";
      load({ key: "player:" + sd + ":" + c.id, kind: "player", side: sd, id: c.id, name: c.name },
        "player?id=" + c.id + "&role=" + r, "totals?kind=player&id=" + c.id + "&side=" + sd,
        "Pulling " + c.name + " from Baseball Savant and MLB");
    }

    function fetchTeam() {
      var team = teamSel.value, sd = side.value;
      savePref("lkTeam", team);
      load({ key: "team:" + sd + ":" + team, kind: "team", side: sd, team: team, name: TEAM_NAMES[team] },
        "team?team=" + team + "&side=" + sd, "totals?kind=team&team=" + team + "&side=" + sd,
        "Pulling " + TEAM_NAMES[team] + " " + sd + " from Baseball Savant and MLB");
    }

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      cands.innerHTML = "";
      savePref("lkPost", post.checked);
      if (scope === "team") {
        fetchTeam();
        return;
      }
      var name = nameInput.value.trim();
      if (!name) {
        setStatus(status, "Type a player's name to look up.", "error");
        nameInput.focus();
        return;
      }
      setStatus(status, "Searching for " + name + "…", "busy");
      api("players?name=" + encodeURIComponent(name)).then(function (res) {
        var results = res.results || [];
        if (!results.length) {
          setStatus(status, "No MLB player found matching “" + name + "”. Check the spelling, or try the last name only.", "error");
          return;
        }
        if (results.length === 1) {
          fetchPlayer(results[0]);
          return;
        }
        setStatus(status, results.length + " players match “" + name + "”. Pick one:", "");
        cands.innerHTML = results.map(function (c, i) {
          return '<button type="button" class="ghost-btn" data-i="' + i + '">' + esc(c.name) +
            (c.years ? ' <span class="muted">' + esc(c.years) + "</span>" : "") + "</button>";
        }).join("");
        cands.querySelectorAll("button").forEach(function (b) {
          b.addEventListener("click", function () { fetchPlayer(results[+b.getAttribute("data-i")]); });
        });
      }).catch(function (e) { setStatus(status, e.message, "error"); });
    });
  }

  /* ---- DraftKings slates: the server turns DK's slate data into the same
     DKSalaries.csv layout the upload button reads. ---- */
  function initDkSlates() {
    var sel = document.getElementById("dk-slate");
    var status = document.getElementById("dk-status");
    var loadBtn = document.getElementById("dk-load");
    var slates = [];

    function slateDay(sl) {
      var t = sl.start ? new Date(sl.start) : null;
      return t && !isNaN(t) ? isoDate(t) : isoDate(new Date());
    }

    /* Today's slates (or the next day that has any): the one you picked
       today, else the Main slate, else the biggest. */
    function defaultSlate() {
      var today = isoDate(new Date());
      var days = slates.map(slateDay).sort();
      var day = days.indexOf(today) !== -1 ? today : days[0];
      var pool = slates.filter(function (sl) { return slateDay(sl) === day; });
      var loaded = loadPref("dkLoaded", null);
      var mine = loaded && loaded.day === today ? String(loaded.id) : "";
      var biggest = pool.slice().sort(function (a, b) { return (b.games || 0) - (a.games || 0); });
      return pool.filter(function (sl) { return String(sl.id) === mine; })[0] ||
        pool.filter(function (sl) { return sl.main; })[0] || biggest[0];
    }

    function loadSalaries(id, auto) {
      var slate = slates.filter(function (sl) { return String(sl.id) === String(id); })[0];
      var label = slate ? slate.label : "the slate";
      loadBtn.disabled = true;
      setStatus(status, "Loading salaries for " + label + " from DraftKings…", "busy");
      var ct = slate && slate.contest_type_id ? "&ct=" + slate.contest_type_id : "";
      return api("dk/salaries?id=" + id + ct).then(function (res) {
        var players = DK.parseSalaries(res.csv);
        if (!players.length) throw new Error("DraftKings' player list came back empty. Try another slate or upload the CSV.");
        state.dk = players;
        persistData("dk", state.dk);
        savePref("dkLoaded", { id: String(id), day: isoDate(new Date()), label: label });
        rebuildAll();
        setStatus(status, "Loaded " + players.length + " players from " + label + (auto ? " (today's slate, loaded automatically)." : "."), "ok");
      }).catch(function (e) {
        setStatus(status, e.message, "error");
      }).then(function () { loadBtn.disabled = false; });
    }

    function loadList() {
      sel.disabled = true;
      loadBtn.disabled = true;
      sel.innerHTML = '<option value="">Loading today\'s slates…</option>';
      api("dk/slates").then(function (res) {
        slates = res.slates || [];
        if (!slates.length) {
          var others = res.other_types || {};
          var otherText = Object.keys(others).map(function (t) { return others[t] + " " + t; }).join(", ");
          sel.innerHTML = '<option value="">No Classic slate posted yet</option>';
          setStatus(status, res.total
            ? "DraftKings lists " + res.total + " MLB slate" + (res.total === 1 ? "" : "s") + " right now, but none are Classic (" +
              otherText + "). The next Classic slate usually appears the day before, once game times are set — click Refresh list later."
            : "DraftKings hasn't posted any MLB slates yet. Slates usually appear the day before, once game times are set — " +
              "click Refresh list later.", "");
          return;
        }
        setStatus(status, "", "");
        var pick = defaultSlate();
        sel.innerHTML = slates.map(function (sl) {
          return '<option value="' + sl.id + '">' + esc(sl.label) + "</option>";
        }).join("");
        sel.value = String(pick.id);
        sel.disabled = false;
        loadBtn.disabled = false;
        /* Load today's slate on its own unless today's salaries (from a
           slate or an uploaded CSV) are already in. */
        var loaded = loadPref("dkLoaded", null);
        if (!state.dk.length || !loaded || loaded.day !== isoDate(new Date())) loadSalaries(pick.id, true);
        else if (loaded.label) setStatus(status, "Salaries from " + loaded.label + " are loaded.", "ok");
      }, function (e) {
        sel.innerHTML = '<option value="">Couldn\'t load slates</option>';
        setStatus(status, e.message + " You can still upload the salary CSV.", "error");
      });
    }

    sel.addEventListener("change", function () { if (sel.value) loadSalaries(sel.value, false); });
    loadBtn.addEventListener("click", function () { if (sel.value) loadSalaries(sel.value, false); });
    document.getElementById("dk-refresh").addEventListener("click", loadList);
    restoredPromise.then(loadList);
  }

  /* ---- Career and season numbers (Savant season leaderboards) ---- */
  var leaderLoading = {};
  var leaderMessages = {};

  /* One status line covering both tabs' career/season loads. */
  function showLeaderStatus(kind, text, tone) {
    leaderMessages[kind] = { text: text, tone: tone };
    var parts = ["batters", "pitchers"].filter(function (k) { return leaderMessages[k]; });
    var worst = parts.some(function (k) { return leaderMessages[k].tone === "error"; }) ? "error"
      : parts.some(function (k) { return leaderMessages[k].tone === "busy"; }) ? "busy" : "ok";
    setStatus(document.getElementById("lb-status"), parts.map(function (k) { return leaderMessages[k].text; }).join(" "), worst);
  }
  var restoredPromise = Promise.resolve();
  var LEADER_LABELS = {
    pa: "PA", woba: "wOBA", xwoba: "xwOBA", bbe: "BBE", hh: "HH", barrels: "Barrels", avg_ev: "Avg EV",
    max_ev: "Max EV", avg_la: "Avg LA", gb_pct: "GB%", fb_pct: "FB%", ld_pct: "LD%", pu_pct: "PU%"
  };

  function needsLeaders(kind) {
    return splits[kind].stats.some(function (st) { return LEADER_FIELD[st]; }) &&
      splits[kind].dims.some(function (d) { return LEADER_DIMS[d]; });
  }

  function loadLeaders(kind, force) {
    if (!state.api || !state.serverCurrent || leaderLoading[kind] || !needsLeaders(kind)) return Promise.resolve();
    var lb = state.leaders[kind];
    if (!force && lb && lb.fetched === isoDate(new Date())) return Promise.resolve();
    var status = document.createElement("p");  // progress text, mirrored into the shared line
    var mirror = setInterval(function () { if (status.textContent) showLeaderStatus(kind, status.textContent, "busy"); }, 500);
    leaderLoading[kind] = true;
    var role = kind === "batters" ? "batter" : "pitcher";
    return withProgress(status, "Loading career and season numbers for " + kind + " from Savant's leaderboards",
      api("leaders?role=" + role), "file")
      .then(function (data) {
        state.leaders[kind] = data;
        persistData("leaders", state.leaders);
        rebuild(kind);
        var missing = data.missing.map(function (f) { return LEADER_LABELS[f] || f; });
        showLeaderStatus(kind, "Career (" + data.career_years + ") and " + data.season_year + " season numbers loaded for " + kind + "." +
          (missing.length ? " Savant's leaderboards didn't include " + missing.join(", ") + ", so those Career/Season columns stay blank." : "") +
          (data.failed_count ? " " + data.failed_count + " leaderboard download" + (data.failed_count === 1 ? "" : "s") +
            " failed, so career totals may be partial; they'll retry tomorrow." : ""),
          missing.length || data.failed_count ? "error" : "ok");
      }, function (e) {
        showLeaderStatus(kind, "Career/season numbers for " + kind + " didn't load: " + e.message, "error");
      })
      .then(function () {
        clearInterval(mirror);
        leaderLoading[kind] = false;
      });
  }

  function loadAllLeaders() {
    return loadLeaders("batters").then(function () { return loadLeaders("pitchers"); });
  }

  function detectServer() {
    /* The local server only ever serves plain http; skip the probe on
       file:// and https hosts (GitHub Pages, the artifact link). */
    if (location.protocol !== "http:") {
      document.getElementById("savant-offline").hidden = false;
      return;
    }
    api("health").then(function (health) {
      state.api = true;
      state.serverCurrent = (health.version || 0) >= MIN_SERVER_VERSION;
      state.serverVersion = health.version || 0;
      restoredPromise.then(queuePeople);
      if (state.serverCurrent) restoredPromise.then(loadAllLeaders);
      if (!state.serverCurrent) {
        setStatus(document.getElementById("sv-status"), "The stats server is still running older code. Close its Terminal " +
          "window and double-click start-server.command again (or run ./start-server.command) so new stats come through.", "error");
      }
      renderDataNote();
      document.getElementById("savant-panel").hidden = false;
      initDkSlates();
      if (state.tab === "lookup") renderLookup();
    }, function () {
      document.getElementById("savant-offline").hidden = false;
      if (state.tab === "lookup") renderLookup();
    });
  }

  /* ------------------------------------------------------------------ */
  /* Columns & formulas panel                                            */
  /* ------------------------------------------------------------------ */

  var formulaEdit = null; // index of the formula stat being edited

  function statsTab() {
    return state.tab === "batters" || state.tab === "pitchers" ? state.tab : null;
  }

  function setColsPanel(open) {
    var panel = document.getElementById("cols-panel");
    panel.hidden = !open;
    document.getElementById("cols-toggle").setAttribute("aria-expanded", open ? "true" : "false");
    if (open) renderColsPanel();
  }

  function renderColsPanel() {
    var kind = statsTab();
    var panel = document.getElementById("cols-panel");
    if (!kind) { panel.hidden = true; return; }
    if (panel.hidden) return;
    document.getElementById("cols-title").textContent =
      "Columns & formulas · " + (kind === "batters" ? "Batters" : "Pitchers");
    var shown = {};
    visibleCols[kind].concat(splits[kind].stats).forEach(function (k) { shown[k] = true; });
    var all = allStats(kind).filter(function (st) { return !st.split; });
    var splitCount = splitDefs(kind).length;
    document.getElementById("cols-count").textContent =
      all.filter(function (st) { return shown[st.key]; }).length + " of " + all.length + " stats shown" +
      (splitCount ? " + " + splitCount + " split column" + (splitCount === 1 ? "" : "s") : "");
    renderSplitsBox(kind);
    var split = {};
    splits[kind].stats.forEach(function (k) { split[k] = true; });
    document.getElementById("cols-groups").innerHTML = groupedStats(kind, function (st) { return !st.split; })
      .map(function (pair) {
        return '<fieldset class="col-group"><legend>' + esc(pair[0]) +
          ' <button type="button" class="link-btn" data-group-on="' + esc(pair[0]) + '">all on</button>' +
          ' <button type="button" class="link-btn" data-group-off="' + esc(pair[0]) + '">all off</button></legend>' +
          pair[1].map(function (st) {
            var note = st.dk && !st.always ? " · needs DK salaries" : st.vegas ? " · needs Vegas data" : "";
            var mode = split[st.key] && splittable(st) ? "split" : shown[st.key] ? "on" : "off";
            var opts = [["off", "Off"], ["on", "On"]];
            if (splittable(st)) opts.push(["split", "Split"]);
            var abbr = st.abbr && st.abbr !== st.label ? ' <span class="abbr">' + esc(st.abbr) + "</span>" : "";
            return '<div class="col-item' + (mode !== "off" ? " is-on" : "") + '" title="' + esc((st.desc || "") + note) + '">' +
              '<span class="col-name">' + esc(st.label) + abbr + "</span>" +
              '<span class="seg" role="radiogroup" aria-label="' + esc(st.label) + '">' + opts.map(function (o) {
                return '<label><input type="radio" name="col-' + esc(st.key) + '" value="' + o[0] + '" data-col="' + esc(st.key) + '"' +
                  (mode === o[0] ? " checked" : "") + "><span>" + o[1] + "</span></label>";
              }).join("") + "</span></div>";
          }).join("") + "</fieldset>";
      }).join("");
    renderFormulaList(kind);
    renderFormulaVars(kind);
    var fmtSel = document.getElementById("ff-format");
    if (!fmtSel.options.length) {
      fmtSel.innerHTML = CUSTOM_FORMATS.map(function (f) {
        return '<option value="' + f[0] + '">' + esc(f[1]) + "</option>";
      }).join("");
      fmtSel.value = "num1";
    }
  }

  function renderSplitsBox(kind) {
    var sp = splits[kind];
    var lb = state.leaders[kind];
    document.getElementById("split-dims").innerHTML = SPLIT_DIMS[kind].map(function (d) {
      var name = d[0] === "season" && lb && lb.season_year ? String(lb.season_year) : d[2];
      return '<label class="col-check split-dim" title="' + esc(d[1]) + '"><input type="checkbox" data-dim="' + d[0] + '"' +
        (sp.dims.indexOf(d[0]) !== -1 ? " checked" : "") + "> " + esc(name) + "</label>";
    }).join("");
  }

  /* Off / On / Split for one stat in the Columns panel. */
  function setStatMode(kind, key, mode) {
    visibleCols[kind] = visibleCols[kind].filter(function (k) { return k !== key; });
    if (mode !== "off") visibleCols[kind].push(key);
    saveCols(kind);
    var wasSplit = splits[kind].stats.indexOf(key) !== -1;
    if ((mode === "split") !== wasSplit) {
      splits[kind].stats = splits[kind].stats.filter(function (k) { return k !== key; });
      if (mode === "split") splits[kind].stats.push(key);
      splitsChanged(kind);
    } else {
      renderTable(kind);
      renderColsPanel();
    }
    var again = document.querySelector('#cols-groups input[name="col-' + CSS.escape(key) + '"][value="' + mode + '"]');
    if (again) again.focus();
  }

  /* After the split setup changes: drop ratings on split columns that no
     longer exist, then recompute. */
  function splitsChanged(kind) {
    saveSplits(kind);
    var live = {};
    splitDefs(kind).forEach(function (d) { live[d.key] = true; });
    weights[kind] = weights[kind].filter(function (w) { return w.key.indexOf("__") === -1 || live[w.key]; });
    saveWeights(kind);
    rebuild(kind);
    renderColsPanel();
    loadLeaders(kind);
  }

  function setColumns(kind, keys) {
    visibleCols[kind] = keys;
    saveCols(kind);
    renderTable(kind);
    renderColsPanel();
  }

  function renderFormulaList(kind) {
    var box = document.getElementById("formula-list");
    if (!custom[kind].length) {
      box.innerHTML = '<p class="hint">No formula stats on this tab yet.</p>';
      return;
    }
    box.innerHTML = custom[kind].map(function (c, i) {
      var fmtName = (CUSTOM_FORMATS.filter(function (f) { return f[0] === c.format; })[0] || ["", ""])[1];
      return '<div class="formula-item' + (formulaEdit === i ? " editing" : "") + '"><span class="fi-name">' + esc(c.name) +
        '</span><code class="fi-formula">' + esc(c.formula) + '</code><span class="muted fi-meta">' + esc(c.key) + " · " +
        esc(fmtName) + "</span>" +
        (c.error ? '<span class="fi-error">Not working: ' + esc(c.error) + "</span>" : "") +
        '<span class="fi-actions"><button type="button" class="ghost-btn" data-edit="' + i + '">Edit</button>' +
        '<button type="button" class="ghost-btn" data-del="' + i + '">Delete</button></span></div>';
    }).join("");
  }

  function renderFormulaVars(kind) {
    var q = document.getElementById("ff-search").value.trim().toLowerCase();
    var upto = formulaEdit === null ? custom[kind].length : formulaEdit;
    var allowed = formulaVars(kind, upto);
    var groups = groupedStats(kind, function (st) {
      if (!allowed[st.key.toLowerCase()]) return false;
      return !q || st.key.toLowerCase().indexOf(q) !== -1 || st.label.toLowerCase().indexOf(q) !== -1;
    });
    document.getElementById("ff-vars").innerHTML = groups.length ? groups.map(function (pair) {
      return '<div class="ff-group"><span class="ff-group-name">' + esc(pair[0]) + "</span>" + pair[1].map(function (st) {
        return '<button type="button" class="var-chip" data-insert="' + esc(st.key) + '" title="' + esc(st.desc || "") + '"><code>' +
          esc(st.key) + "</code> " + esc(st.label) + "</button>";
      }).join("") + "</div>";
    }).join("") : '<p class="hint">No stat matches “' + esc(q) + "”.</p>";
  }

  function insertIntoFormula(text) {
    var ta = document.getElementById("ff-formula");
    var start = ta.selectionStart || 0, end = ta.selectionEnd || 0;
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    var paren = text.indexOf("(");
    var caret = paren === -1 ? start + text.length : start + paren + 1;
    ta.focus();
    ta.setSelectionRange(caret, caret);
    checkFormula();
  }

  /* Compile the formula being typed and preview it on the current players. */
  function checkFormula() {
    var kind = statsTab();
    var out = document.getElementById("ff-check");
    var text = document.getElementById("ff-formula").value;
    if (!kind) return null;
    if (!text.trim()) { setStatus(out, "", ""); return null; }
    var compiled;
    try {
      compiled = Formula.compile(text, formulaVars(kind, formulaEdit === null ? custom[kind].length : formulaEdit));
    } catch (e) {
      setStatus(out, e.message + (typeof e.pos === "number" ? " (at character " + (e.pos + 1) + ")" : ""), "error");
      return null;
    }
    var players = state[kind].players;
    if (!players.length) {
      setStatus(out, "The formula is valid. Pull or upload data to see its values.", "ok");
      return compiled;
    }
    Formula.apply(compiled, players, "__preview");
    var fmtType = document.getElementById("ff-format").value;
    var withValue = players.filter(function (p) { return p.__preview !== null; });
    var top = withValue.slice().sort(function (a, b) { return b.__preview - a.__preview; }).slice(0, 3)
      .map(function (p) { return p.name + " " + fmt(p.__preview, fmtType); });
    players.forEach(function (p) { delete p.__preview; });
    if (withValue.length) {
      setStatus(out, "Works: " + withValue.length + " of " + players.length + " players get a value. Highest: " +
        top.join(", ") + ".", "ok");
    } else {
      setStatus(out, "The formula is valid, but no player has every stat it needs. Wrap stats that can be blank in nz().", "error");
    }
    return compiled;
  }

  function resetFormulaForm() {
    formulaEdit = null;
    document.getElementById("ff-name").value = "";
    document.getElementById("ff-formula").value = "";
    document.getElementById("ff-format").value = "num1";
    document.getElementById("ff-save").textContent = "Add formula stat";
    document.getElementById("ff-cancel").hidden = true;
    setStatus(document.getElementById("ff-check"), "", "");
  }

  function customKey(kind, name) {
    var base = "c_" + (name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "stat");
    var key = base, n = 2;
    var taken = function (k) { return custom[kind].some(function (c) { return c.key === k; }) || statDef(kind, k); };
    while (taken(key)) key = base + "_" + n++;
    return key;
  }

  function initColsPanel() {
    document.getElementById("cols-toggle").addEventListener("click", function () {
      setColsPanel(document.getElementById("cols-panel").hidden);
    });
    document.getElementById("cols-done").addEventListener("click", function () { setColsPanel(false); });
    document.querySelectorAll("[data-cols]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var kind = statsTab();
        if (!kind) return;
        var mode = btn.getAttribute("data-cols");
        var keys = mode === "default"
          ? Catalog.defaultColumns[kind].concat(custom[kind].map(function (c) { return c.key; }))
          : mode === "all" ? allStats(kind).filter(function (st) { return !st.split; }).map(function (st) { return st.key; }) : [];
        if (mode !== "all") {
          var before = splits[kind].stats.join();
          splits[kind].stats = mode === "default" ? DEFAULT_SPLIT_STATS.slice() : [];
          if (splits[kind].stats.join() !== before) {
            visibleCols[kind] = keys;
            saveCols(kind);
            splitsChanged(kind);
            return;
          }
        }
        setColumns(kind, keys);
      });
    });
    var groupsBox = document.getElementById("cols-groups");
    groupsBox.addEventListener("change", function (ev) {
      var kind = statsTab();
      var key = ev.target.getAttribute("data-col");
      if (!kind || !key || !ev.target.checked) return;
      setStatMode(kind, key, ev.target.value);
    });
    groupsBox.addEventListener("click", function (ev) {
      var kind = statsTab();
      var on = ev.target.getAttribute("data-group-on"), off = ev.target.getAttribute("data-group-off");
      if (!kind || (!on && !off)) return;
      var groupKeys = allStats(kind).filter(function (st) { return st.group === (on || off); })
        .map(function (st) { return st.key; });
      var keys = visibleCols[kind].filter(function (k) { return groupKeys.indexOf(k) === -1; });
      if (off && splits[kind].stats.some(function (k) { return groupKeys.indexOf(k) !== -1; })) {
        splits[kind].stats = splits[kind].stats.filter(function (k) { return groupKeys.indexOf(k) === -1; });
        visibleCols[kind] = keys;
        saveCols(kind);
        splitsChanged(kind);
        return;
      }
      setColumns(kind, on ? keys.concat(groupKeys) : keys);
    });

    document.getElementById("split-dims").addEventListener("change", function (ev) {
      var kind = statsTab();
      var dim = ev.target.getAttribute("data-dim");
      if (!kind || !dim) return;
      var dims = splits[kind].dims.filter(function (d) { return d !== dim; });
      if (ev.target.checked) dims.push(dim);
      splits[kind].dims = SPLIT_DIMS[kind].map(function (d) { return d[0]; })
        .filter(function (d) { return dims.indexOf(d) !== -1; });
      splitsChanged(kind);
    });
    document.getElementById("split-visible").addEventListener("click", function () {
      var kind = statsTab();
      if (!kind) return;
      var shown = {};
      visibleCols[kind].forEach(function (k) { shown[k] = true; });
      Catalog.stats[kind].forEach(function (st) {
        if (shown[st.key] && splittable(st) && splits[kind].stats.indexOf(st.key) === -1) splits[kind].stats.push(st.key);
      });
      splitsChanged(kind);
    });
    document.getElementById("split-clear").addEventListener("click", function () {
      var kind = statsTab();
      if (!kind) return;
      splits[kind].stats = [];
      splitsChanged(kind);
    });
    document.getElementById("order-reset").addEventListener("click", function () {
      var kind = statsTab();
      if (kind) resetOrder(kind);
    });

    var form = document.getElementById("formula-form");
    ["ff-formula", "ff-format"].forEach(function (id) {
      document.getElementById(id).addEventListener("input", checkFormula);
    });
    document.getElementById("ff-search").addEventListener("input", function () {
      var kind = statsTab();
      if (kind) renderFormulaVars(kind);
    });
    document.getElementById("cols-panel").addEventListener("click", function (ev) {
      var chip = ev.target.closest ? ev.target.closest("[data-insert]") : null;
      if (chip) insertIntoFormula(chip.getAttribute("data-insert"));
    });
    document.getElementById("ff-cancel").addEventListener("click", function () {
      resetFormulaForm();
      renderColsPanel();
    });
    document.getElementById("formula-list").addEventListener("click", function (ev) {
      var kind = statsTab();
      if (!kind) return;
      var edit = ev.target.getAttribute("data-edit"), del = ev.target.getAttribute("data-del");
      if (edit !== null) {
        var c = custom[kind][+edit];
        formulaEdit = +edit;
        document.getElementById("ff-name").value = c.name;
        document.getElementById("ff-formula").value = c.formula;
        document.getElementById("ff-format").value = c.format;
        document.getElementById("ff-save").textContent = "Save changes";
        document.getElementById("ff-cancel").hidden = false;
        renderColsPanel();
        checkFormula();
        document.getElementById("ff-formula").focus();
      } else if (del !== null) {
        var gone = custom[kind][+del];
        if (!confirm("Delete the formula stat “" + gone.name + "”? Formulas that use " + gone.key + " will stop working.")) return;
        custom[kind].splice(+del, 1);
        visibleCols[kind] = visibleCols[kind].filter(function (k) { return k !== gone.key; });
        weights[kind] = weights[kind].filter(function (w) { return w.key !== gone.key; });
        saveCustom(kind);
        saveCols(kind);
        saveWeights(kind);
        resetFormulaForm();
        rebuild(kind);
        renderColsPanel();
      }
    });
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var kind = statsTab();
      if (!kind) return;
      var out = document.getElementById("ff-check");
      var name = document.getElementById("ff-name").value.trim();
      var formula = document.getElementById("ff-formula").value.trim();
      var format = document.getElementById("ff-format").value;
      if (!name) {
        setStatus(out, "Give the stat a name; it becomes the column header.", "error");
        document.getElementById("ff-name").focus();
        return;
      }
      var clash = custom[kind].some(function (c, i) { return i !== formulaEdit && c.name.toLowerCase() === name.toLowerCase(); });
      if (clash) {
        setStatus(out, "You already have a formula stat named “" + name + "”.", "error");
        return;
      }
      if (!checkFormula()) {
        if (!formula) setStatus(out, "Type a formula.", "error");
        return;
      }
      if (formulaEdit !== null) {
        var c = custom[kind][formulaEdit];
        c.name = name;
        c.formula = formula;
        c.format = format;
      } else {
        var key = customKey(kind, name);
        custom[kind].push({ key: key, name: name, formula: formula, format: format });
        visibleCols[kind].push(key);
        saveCols(kind);
      }
      saveCustom(kind);
      resetFormulaForm();
      rebuild(kind);
      renderColsPanel();
      setStatus(out, "Saved “" + name + "”. It's in the table and can be added to your rating.", "ok");
    });
  }

  /* ------------------------------------------------------------------ */
  /* Uploads + controls                                                  */
  /* ------------------------------------------------------------------ */

  var KEEP_COLUMNS = [
    "inning_topbot", "n_thruorder_pitcher", "zone", "woba_value", "woba_denom",
    "estimated_woba_using_speedangle", "estimated_ba_using_speedangle", "hc_x", "hc_y",
    "release_spin_rate", "opp_player",
    "pitch_type", "pitch_name", "game_date", "player_name", "events", "description",
    "stand", "p_throws", "home_team", "away_team", "bb_type", "balls", "strikes",
    "outs_when_up", "inning", "hit_distance_sc", "launch_speed", "launch_angle",
    "effective_speed", "release_speed"
  ];

  /* Keep only the useful columns so raw full-column Savant exports work too. */
  function cleanRows(objs) {
    return objs.map(function (o) {
      var r = {};
      KEEP_COLUMNS.forEach(function (k) { if (o[k] !== undefined) r[k] = o[k]; });
      return r;
    });
  }

  function handleFile(input, cb) {
    var file = input.files && input.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () { cb(reader.result, file.name); input.value = ""; };
    reader.readAsText(file);
  }

  function init() {
    document.getElementById("file-batters").addEventListener("change", function () {
      handleFile(this, function (text) {
        var rows = cleanRows(CSV.parseObjects(text));
        state.batters.rows = rows;
        state.batters.expanded = {};
        persistData("batters", rows);
        rebuild("batters");
      });
    });
    document.getElementById("file-pitchers").addEventListener("change", function () {
      handleFile(this, function (text) {
        var rows = cleanRows(CSV.parseObjects(text));
        state.pitchers.rows = rows;
        state.pitchers.expanded = {};
        persistData("pitchers", rows);
        rebuild("pitchers");
      });
    });
    document.getElementById("file-dk").addEventListener("change", function () {
      handleFile(this, function (text) {
        state.dk = DK.parseSalaries(text);
        persistData("dk", state.dk);
        savePref("dkLoaded", { id: "csv", day: isoDate(new Date()), label: "your uploaded salary CSV" });
        rebuildAll();
      });
    });

    document.querySelectorAll(".tab").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.tab = btn.getAttribute("data-tab");
        if (formulaEdit !== null) resetFormulaForm();
        document.querySelectorAll(".tab").forEach(function (b) { b.classList.toggle("active", b === btn); });
        updateSplitButtons();
        render();
      });
    });

    document.querySelectorAll(".split-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state[state.tab].split = btn.getAttribute("data-split");
        updateSplitButtons();
        rebuild(state.tab);
      });
    });

    document.getElementById("search").addEventListener("input", function () {
      state.search = this.value.trim();
      renderTable(state.tab);
    });
    document.getElementById("slate-only").addEventListener("change", function () {
      state.slateOnly = this.checked;
      renderTable(state.tab);
    });
    document.getElementById("min-sample").addEventListener("input", function () {
      var v = parseInt(this.value, 10);
      state.minSample[state.tab] = isNaN(v) ? 1 : v;
      renderTable(state.tab);
    });
    document.getElementById("reset-weights").addEventListener("click", function () {
      var kind = state.tab;
      weights[kind] = defaultWeights(kind);
      saveWeights(kind);
      Stats.computeRatings(state[kind].players, weights[kind]);
      render();
    });
    document.getElementById("clear-data").addEventListener("click", function () {
      if (!confirm("Clear all uploaded data stored in this browser?")) return;
      DATA_KEYS.forEach(function (k) {
        Store.del("dkmlb_" + k);
        localStorage.removeItem("dkmlb_" + k);
      });
      state.batters.rows = [];
      state.pitchers.rows = [];
      state.dk = [];
      state.vegas = [];
      state.lookup.entries = [];
      state.leaders = { batters: null, pitchers: null };
      rebuildAll();
    });

    document.querySelectorAll(".ev-btn[data-floor]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.evFloor = parseInt(btn.getAttribute("data-floor"), 10) || 0;
        savePref("evFloorV2", state.evFloor);
        state.batters.expanded = {};
        updateSplitButtons();
        rebuild("batters");
      });
    });

    document.getElementById("vegas-from-dk").addEventListener("click", function () {
      if (!state.dk.length) {
        alert("Upload the DK Salaries CSV first — matchups are read from its Game Info column.");
        return;
      }
      var built = Vegas.buildFromDK(state.dk);
      var existing = {};
      state.vegas.forEach(function (r) { existing[Vegas.normTeam(r.team)] = true; });
      built.forEach(function (r) {
        if (!existing[Vegas.normTeam(r.team)]) state.vegas.push(r);
      });
      vegasChanged();
    });
    document.getElementById("vegas-add-row").addEventListener("click", function () {
      state.vegas.push({ team: "", opp: "", ou: "", ml: "", itt: "", bets: "", handle: "" });
      persistVegas();
      renderVegas();
    });
    document.getElementById("vegas-clear").addEventListener("click", function () {
      if (!confirm("Remove all Vegas rows?")) return;
      state.vegas = [];
      vegasChanged();
    });

    document.getElementById("storage-backend").textContent = Store.backend;
    initSavantPanel();
    initLookup();
    initColsPanel();
    initPlayerGrid();
    var wp = document.getElementById("weights-panel");
    wp.open = !!loadPref("weightsOpen", false);
    wp.addEventListener("toggle", function () { savePref("weightsOpen", wp.open); });
    detectServer();
    updateSplitButtons();
    rebuildAll();
    restoredPromise = restoreData().then(rebuildAll);
  }

  function updateSplitButtons() {
    var kind = state.tab;
    if (kind === "vegas" || kind === "lookup") return;
    document.getElementById("ev-floor").style.display = kind === "batters" ? "" : "none";
    document.querySelectorAll(".ev-btn[data-floor]").forEach(function (btn) {
      btn.classList.toggle("active", (parseInt(btn.getAttribute("data-floor"), 10) || 0) === state.evFloor);
    });
    var labels = kind === "batters"
      ? { all: "All", vsL: "vs LHP", vsR: "vs RHP" }
      : { all: "All", vsL: "vs LHB", vsR: "vs RHB" };
    document.querySelectorAll(".split-btn").forEach(function (btn) {
      var split = btn.getAttribute("data-split");
      btn.textContent = labels[split];
      btn.classList.toggle("active", state[kind].split === split);
    });
    document.getElementById("min-sample").value = state.minSample[kind];
    document.getElementById("min-sample-label").textContent = kind === "batters" ? "Min BBE" : "Min pitches";
  }

  document.addEventListener("DOMContentLoaded", init);
})();
