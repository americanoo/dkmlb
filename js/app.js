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

  function allStats(kind) {
    return Catalog.stats[kind].concat(customDefs(kind));
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
    Catalog.stats[kind].forEach(function (st) { if (ratable(st)) vars[st.key.toLowerCase()] = st.key; });
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

  function rebuild(kind) {
    var s = state[kind];
    var rows = splitFilter(kind, s.rows);
    var contact = kind === "batters" && state.evFloor ? evFloorContact() : null;
    s.players = Stats.aggregate(rows, { contact: contact });
    if (state.dk.length) DK.matchSalaries(s.players, state.dk);
    Vegas.attach(s.players, state.vegas, kind);
    applyCustom(kind, s.players);
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
    if (isVegas || isLookup) document.getElementById("cols-panel").hidden = true;
    else renderColsPanel();
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

  /* Stats grouped for <select> menus: [[group, [defs]], ...]. */
  function groupedStats(kind, filter) {
    var groups = Catalog.groups.concat([MY_FORMULAS]);
    var all = allStats(kind);
    return groups.map(function (g) {
      return [g, all.filter(function (st) { return st.group === g && filter(st); })];
    }).filter(function (pair) { return pair[1].length; });
  }

  function recomputeRatings(kind) {
    Stats.computeRatings(state[kind].players, weights[kind]);
    renderTable(kind);
  }

  function renderWeights(kind) {
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

  function renderTable(kind) {
    var s = state[kind];
    var players = visiblePlayers(kind);
    var hasDK = state.dk.length > 0;
    var hasVegas = state.vegas.length > 0;
    var shown = {};
    visibleCols[kind].forEach(function (k) { shown[k] = true; });
    var showCols = [{ key: "name", label: "Player", type: "text" }].concat(allStats(kind).filter(function (c) {
      if (!shown[c.key]) return false;
      if (c.dk && !hasDK) return false;
      if (c.vegas && !hasVegas) return false;
      return true;
    }));

    var html = "<thead><tr>";
    showCols.forEach(function (c) {
      var arrow = s.sortKey === c.key ? (s.sortDir === -1 ? " ▼" : " ▲") : "";
      html += '<th data-key="' + c.key + '"' + (c.desc ? ' title="' + esc(c.desc) + '"' : "") +
        (c.custom ? ' class="custom-col"' : "") + ">" + esc(c.label) + arrow + "</th>";
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
        var biggest = slates.slice().sort(function (a, b) { return (b.games || 0) - (a.games || 0); });
        var pick = slates.filter(function (sl) { return String(sl.id) === saved; })[0] ||
          slates.filter(function (sl) { return sl.main; })[0] || biggest[0];
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
    visibleCols[kind].forEach(function (k) { shown[k] = true; });
    var all = allStats(kind);
    document.getElementById("cols-count").textContent =
      all.filter(function (st) { return shown[st.key]; }).length + " of " + all.length + " stats shown";
    document.getElementById("cols-groups").innerHTML = groupedStats(kind, function () { return true; })
      .map(function (pair) {
        return '<fieldset class="col-group"><legend>' + esc(pair[0]) +
          ' <button type="button" class="link-btn" data-group-on="' + esc(pair[0]) + '">all</button>' +
          ' <button type="button" class="link-btn" data-group-off="' + esc(pair[0]) + '">none</button></legend>' +
          pair[1].map(function (st) {
            var note = st.dk ? " · needs DK salaries" : st.vegas ? " · needs Vegas data" : "";
            return '<label class="col-check" title="' + esc((st.desc || "") + note) + '"><input type="checkbox" data-col="' +
              esc(st.key) + '"' + (shown[st.key] ? " checked" : "") + "> " + esc(st.label) + "</label>";
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
          : mode === "all" ? allStats(kind).map(function (st) { return st.key; }) : [];
        setColumns(kind, keys);
      });
    });
    var groupsBox = document.getElementById("cols-groups");
    groupsBox.addEventListener("change", function (ev) {
      var kind = statsTab();
      var key = ev.target.getAttribute("data-col");
      if (!kind || !key) return;
      var keys = visibleCols[kind].filter(function (k) { return k !== key; });
      if (ev.target.checked) keys.push(key);
      setColumns(kind, keys);
    });
    groupsBox.addEventListener("click", function (ev) {
      var kind = statsTab();
      var on = ev.target.getAttribute("data-group-on"), off = ev.target.getAttribute("data-group-off");
      if (!kind || (!on && !off)) return;
      var groupKeys = allStats(kind).filter(function (st) { return st.group === (on || off); })
        .map(function (st) { return st.key; });
      var keys = visibleCols[kind].filter(function (k) { return groupKeys.indexOf(k) === -1; });
      setColumns(kind, on ? keys.concat(groupKeys) : keys);
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
