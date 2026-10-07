/* DK MLB DFS Research — app shell: uploads, tables, sorting, expandable
   event history, weight editor, DK slate matching. */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ */
  /* Column + weight configuration                                       */
  /* ------------------------------------------------------------------ */

  var BATTER_COLUMNS = [
    { key: "name", label: "Player", type: "text" },
    { key: "team", label: "Team", type: "text", dk: true },
    { key: "position", label: "Pos", type: "text", dk: true },
    { key: "salary", label: "Salary", type: "money", dk: true },
    { key: "avgPoints", label: "DK Avg", type: "num1", dk: true },
    { key: "rating", label: "Rating", type: "num1" },
    { key: "value", label: "Value", type: "num2", dk: true },
    { key: "itt_eff", label: "Imp Tot", type: "num1", vegas: true },
    { key: "ou", label: "O/U", type: "num1", vegas: true },
    { key: "ml", label: "ML", type: "ml", vegas: true },
    { key: "bets", label: "Bets%", type: "pct", vegas: true },
    { key: "handle", label: "Handle%", type: "pct", vegas: true },
    { key: "pitches", label: "Pitches", type: "int" },
    { key: "bbe", label: "BBE", type: "int" },
    { key: "hh", label: "HH", type: "int" },
    { key: "avg_ev", label: "Avg EV", type: "num1" },
    { key: "max_ev", label: "Max EV", type: "num1" },
    { key: "avg_la", label: "Avg LA", type: "num1" },
    { key: "barrel_pct", label: "Barrel%", type: "pct" },
    { key: "hardhit_pct", label: "HardHit%", type: "pct" },
    { key: "sweetspot_pct", label: "SweetSpot%", type: "pct" },
    { key: "avg_dist", label: "Avg Dist", type: "num0" },
    { key: "hr", label: "HR", type: "int" },
    { key: "xbh", label: "XBH", type: "int" },
    { key: "hits", label: "Hits", type: "int" },
    { key: "field_outs", label: "FO", type: "int" },
    { key: "k", label: "K", type: "int" }
  ];

  var BATTER_WEIGHTS = [
    { key: "barrel_pct", label: "Barrel%", weight: 0 },
    { key: "hardhit_pct", label: "HardHit%", weight: 0 },
    { key: "hh", label: "Hard-Hit Balls", weight: 0 },
    { key: "avg_ev", label: "Avg EV", weight: 0 },
    { key: "hr", label: "Home Runs", weight: 0 },
    { key: "max_ev", label: "Max EV", weight: 0 },
    { key: "xbh", label: "Extra-Base Hits", weight: 0 },
    { key: "sweetspot_pct", label: "SweetSpot%", weight: 0 },
    { key: "avg_dist", label: "Avg Distance", weight: 0 },
    { key: "hits", label: "Hits", weight: 0 },
    { key: "k", label: "Strikeouts", weight: 0, invert: true },
    { key: "itt_eff", label: "Implied Team Total", weight: 0 },
    { key: "bets", label: "Bets% on team", weight: 0 },
    { key: "handle", label: "Handle% on team", weight: 0 }
  ];

  var PITCHER_COLUMNS = [
    { key: "name", label: "Player", type: "text" },
    { key: "team", label: "Team", type: "text", dk: true },
    { key: "position", label: "Pos", type: "text", dk: true },
    { key: "salary", label: "Salary", type: "money", dk: true },
    { key: "avgPoints", label: "DK Avg", type: "num1", dk: true },
    { key: "rating", label: "Rating", type: "num1" },
    { key: "value", label: "Value", type: "num2", dk: true },
    { key: "opp_itt", label: "Opp Imp Tot", type: "num1", vegas: true },
    { key: "ou", label: "O/U", type: "num1", vegas: true },
    { key: "ml", label: "ML", type: "ml", vegas: true },
    { key: "bets", label: "Bets%", type: "pct", vegas: true },
    { key: "handle", label: "Handle%", type: "pct", vegas: true },
    { key: "pitches", label: "Pitches", type: "int" },
    { key: "pa", label: "PA", type: "int" },
    { key: "k_pct", label: "K%", type: "pct" },
    { key: "bb_pct", label: "BB%", type: "pct" },
    { key: "whiff_pct", label: "Whiff%", type: "pct" },
    { key: "csw_pct", label: "CSW%", type: "pct" },
    { key: "avg_velo", label: "Avg Velo", type: "num1" },
    { key: "ev_against", label: "EV Against", type: "num1" },
    { key: "hardhit_against_pct", label: "HardHit% Agn", type: "pct" },
    { key: "hr_allowed", label: "HR Alwd", type: "int" },
    { key: "hits_allowed", label: "Hits Alwd", type: "int" }
  ];

  var PITCHER_WEIGHTS = [
    { key: "k_pct", label: "K%", weight: 0 },
    { key: "whiff_pct", label: "Whiff%", weight: 0 },
    { key: "csw_pct", label: "CSW%", weight: 0 },
    { key: "ev_against", label: "EV Against", weight: 0, invert: true },
    { key: "hardhit_against_pct", label: "HardHit% Against", weight: 0, invert: true },
    { key: "hr_allowed", label: "HR Allowed", weight: 0, invert: true },
    { key: "bb_pct", label: "BB%", weight: 0, invert: true },
    { key: "avg_velo", label: "Avg Velo", weight: 0 },
    { key: "opp_itt", label: "Opp Implied Total", weight: 0, invert: true },
    { key: "ml", label: "Moneyline (win odds)", weight: 0, invert: true }
  ];

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
    search: "",
    slateOnly: false,
    minSample: { batters: 1, pitchers: 1 },
    evFloor: loadPref("evFloor", 95),
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

  /* v3: weights are a shared 10-point budget per tab; the key bump
     discards weight sets saved under earlier schemes. */
  var WEIGHTS_KEY = "dkmlb_weights_v3_";
  var WEIGHT_BUDGET = 10;

  var weights = {
    batters: loadWeights("batters", BATTER_WEIGHTS),
    pitchers: loadWeights("pitchers", PITCHER_WEIGHTS)
  };

  function loadWeights(kind, defaults) {
    var list = defaults.map(function (d) { return Object.assign({}, d); });
    try {
      var saved = JSON.parse(localStorage.getItem(WEIGHTS_KEY + kind));
      if (saved) {
        list.forEach(function (w) {
          if (typeof saved[w.key] === "number") w.weight = saved[w.key];
        });
      }
    } catch (e) { /* ignore */ }
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
    var obj = {};
    weights[kind].forEach(function (w) { obj[w.key] = w.weight; });
    try { localStorage.setItem(WEIGHTS_KEY + kind, JSON.stringify(obj)); } catch (e) { /* ignore */ }
  }

  var DATA_KEYS = ["batters", "pitchers", "dk", "vegas", "lookup"];

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

  /* With an EV floor set, batted-ball stats and history come from balls in
     play at or above it (matching a Savant search filtered on exit velo),
     while Pitches, PA and K still count every pitch the batter saw. */
  function batterPlayers(rows) {
    var all = Stats.aggregateBatters(rows);
    var floor = state.evFloor;
    if (!floor) return all;
    var hard = rows.filter(function (r) {
      var ev = Stats.num(r.launch_speed);
      return Stats.isBattedBall(r) && ev !== null && ev >= floor;
    });
    var byName = {};
    all.forEach(function (p) { byName[p.name] = p; });
    var players = Stats.aggregateBatters(hard);
    players.forEach(function (p) {
      var a = byName[p.name];
      p.pitches = a.pitches;
      p.pa = a.pa;
      p.k = a.k;
    });
    return players;
  }

  function rebuild(kind) {
    var s = state[kind];
    var rows = splitFilter(kind, s.rows);
    s.players = kind === "batters" ? batterPlayers(rows) : Stats.aggregatePitchers(rows);
    if (state.dk.length) DK.matchSalaries(s.players, state.dk);
    Vegas.attach(s.players, state.vegas, kind);
    Stats.computeRatings(s.players, weights[kind]);
    render();
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

  function renderWeights(kind) {
    var panel = document.getElementById("weights-body");
    var html = '<div class="points-left">Points left: <b id="points-left">' +
      (WEIGHT_BUDGET - weightTotal(kind)) + "</b> / " + WEIGHT_BUDGET + "</div>";
    weights[kind].forEach(function (w, i) {
      html +=
        '<div class="weight-row">' +
        '<label for="w-' + i + '">' + esc(w.label) + (w.invert ? ' <span class="inv" title="Lower is better">↓</span>' : "") + "</label>" +
        '<input id="w-' + i + '" type="range" min="0" max="' + WEIGHT_BUDGET + '" step="1" value="' + w.weight + '" data-idx="' + i + '">' +
        '<span class="wval">' + w.weight + "</span>" +
        "</div>";
    });
    panel.innerHTML = html;
    panel.querySelectorAll("input[type=range]").forEach(function (input) {
      input.addEventListener("input", function () {
        var idx = parseInt(input.getAttribute("data-idx"), 10);
        var requested = parseInt(input.value, 10);
        var otherTotal = weightTotal(kind) - weights[kind][idx].weight;
        var allowed = Math.min(requested, WEIGHT_BUDGET - otherTotal);
        if (allowed !== requested) input.value = allowed;
        weights[kind][idx].weight = allowed;
        input.nextElementSibling.textContent = allowed;
        document.getElementById("points-left").textContent = WEIGHT_BUDGET - weightTotal(kind);
        saveWeights(kind);
        var s = state[kind];
        Stats.computeRatings(s.players, weights[kind]);
        renderTable(kind);
      });
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

  function renderTable(kind) {
    var cols = kind === "batters" ? BATTER_COLUMNS : PITCHER_COLUMNS;
    var s = state[kind];
    var players = visiblePlayers(kind);
    var hasDK = state.dk.length > 0;
    var hasVegas = state.vegas.length > 0;
    var showCols = cols.filter(function (c) {
      if (c.dk && !hasDK) return false;
      if (c.vegas && !hasVegas) return false;
      return true;
    });

    var html = "<thead><tr>";
    showCols.forEach(function (c) {
      var arrow = s.sortKey === c.key ? (s.sortDir === -1 ? " ▼" : " ▲") : "";
      html += '<th data-key="' + c.key + '">' + esc(c.label) + arrow + "</th>";
    });
    html += "</tr></thead><tbody>";

    players.forEach(function (p) {
      var expanded = s.expanded[p.name];
      html += '<tr class="player-row' + (expanded ? " open" : "") + '" data-name="' + esc(p.name) + '">';
      showCols.forEach(function (c) {
        var cls = c.type === "text" ? "t" : "n";
        if (c.key === "name") {
          html += '<td class="t name-cell"><span class="caret">' + (expanded ? "▾" : "▸") + "</span>" + esc(p.name) + "</td>";
        } else {
          html += '<td class="' + cls + '">' + esc(fmt(p[c.key], c.type)) + "</td>";
        }
      });
      html += "</tr>";
      if (expanded) {
        html += '<tr class="history-row"><td colspan="' + showCols.length + '">' + historyHTML(kind, p) + "</td></tr>";
      }
    });
    html += "</tbody>";
    if (!players.length) {
      html += '<tbody><tr><td colspan="' + showCols.length + '" class="empty">' +
        (s.rows.length ? "No players match the current filters." : "No data yet — pull from Savant or upload a Savant CSV above.") +
        "</td></tr></tbody>";
    }

    var table = document.getElementById("data-table");
    table.innerHTML = html;

    table.querySelectorAll("th").forEach(function (th) {
      th.addEventListener("click", function () {
        var key = th.getAttribute("data-key");
        if (s.sortKey === key) s.sortDir = -s.sortDir;
        else { s.sortKey = key; s.sortDir = -1; }
        renderTable(kind);
      });
    });
    table.querySelectorAll("tr.player-row").forEach(function (tr) {
      tr.addEventListener("click", function () {
        var name = tr.getAttribute("data-name");
        s.expanded[name] = !s.expanded[name];
        renderTable(kind);
      });
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
  function withProgress(el, label, promise) {
    var t0 = Date.now();
    setStatus(el, label + "…", "busy");
    var timer = setInterval(function () {
      api("progress").then(function (pr) {
        var secs = Math.round((Date.now() - t0) / 1000);
        var detail = pr.active && pr.total > 1 ? " — day " + Math.min(pr.done + 1, pr.total) + " of " + pr.total : "";
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
    batStart.value = loadPref("svBatStart", daysAgo(8));
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

  function windowRows(entry, days) {
    var from = windowStart(entry.end, days);
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
            ' title="' + esc(shortDate(windowStart(e.end, days)) + " – " + shortDate(e.end)) + '">' +
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
      var q = "&start=" + daysAgo(LOOKUP_DAYS - 1) + "&end=" + end + "&postseason=" + (post.checked ? 1 : 0);
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
        var saved = String(loadPref("dkSlate", ""));
        var classic = slates.filter(function (sl) { return /classic/i.test(sl.game_type); })
          .sort(function (a, b) { return (b.games || 0) - (a.games || 0); });
        var biggest = slates.slice().sort(function (a, b) { return (b.games || 0) - (a.games || 0); });
        var pick = slates.filter(function (sl) { return String(sl.id) === saved; })[0] ||
          slates.filter(function (sl) { return sl.main; })[0] || classic[0] || biggest[0];
        sel.innerHTML = slates.map(function (sl) {
          return '<option value="' + sl.id + '">' + esc(sl.label) + "</option>";
        }).join("");
        sel.value = String(pick.id);
        sel.disabled = false;
        loadBtn.disabled = false;
      }, function (e) {
        sel.innerHTML = '<option value="">Couldn\'t load slates</option>';
        setStatus(status, e.message + " You can still upload the salary CSV.", "error");
      });
    }

    loadBtn.addEventListener("click", function () {
      var id = sel.value;
      if (!id) return;
      var slate = slates.filter(function (sl) { return String(sl.id) === id; })[0];
      var label = slate ? slate.label : "the slate";
      loadBtn.disabled = true;
      setStatus(status, "Loading salaries for " + label + " from DraftKings…", "busy");
      var ct = slate && slate.contest_type_id ? "&ct=" + slate.contest_type_id : "";
      api("dk/salaries?id=" + id + ct).then(function (res) {
        var players = DK.parseSalaries(res.csv);
        if (!players.length) throw new Error("DraftKings' player list came back empty. Try another slate or upload the CSV.");
        state.dk = players;
        persistData("dk", state.dk);
        savePref("dkSlate", id);
        rebuildAll();
        setStatus(status, "Loaded " + players.length + " players from " + label + ".", "ok");
      }).catch(function (e) {
        setStatus(status, e.message, "error");
      }).then(function () { loadBtn.disabled = false; });
    });
    document.getElementById("dk-refresh").addEventListener("click", loadList);
    loadList();
  }

  function detectServer() {
    /* The local server only ever serves plain http; skip the probe on
       file:// and https hosts (GitHub Pages, the artifact link). */
    if (location.protocol !== "http:") {
      document.getElementById("savant-offline").hidden = false;
      return;
    }
    api("health").then(function () {
      state.api = true;
      document.getElementById("savant-panel").hidden = false;
      initDkSlates();
      if (state.tab === "lookup") renderLookup();
    }, function () {
      document.getElementById("savant-offline").hidden = false;
      if (state.tab === "lookup") renderLookup();
    });
  }

  /* ------------------------------------------------------------------ */
  /* Uploads + controls                                                  */
  /* ------------------------------------------------------------------ */

  var KEEP_COLUMNS = [
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
        rebuildAll();
      });
    });

    document.querySelectorAll(".tab").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.tab = btn.getAttribute("data-tab");
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
      var defaults = kind === "batters" ? BATTER_WEIGHTS : PITCHER_WEIGHTS;
      weights[kind] = defaults.map(function (d) { return Object.assign({}, d); });
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
      rebuildAll();
    });

    document.querySelectorAll(".ev-btn[data-floor]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.evFloor = parseInt(btn.getAttribute("data-floor"), 10) || 0;
        savePref("evFloor", state.evFloor);
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
    detectServer();
    updateSplitButtons();
    rebuildAll();
    restoreData().then(rebuildAll);
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
