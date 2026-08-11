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
    { key: "bbe", label: "BBE", type: "int" },
    { key: "hh", label: "HH", type: "int" },
    { key: "hh5", label: "HH 5d", type: "int" },
    { key: "hh10", label: "HH 10d", type: "int" },
    { key: "hh15", label: "HH 15d", type: "int" },
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
    { key: "barrel_pct", label: "Barrel%", weight: 10 },
    { key: "hardhit_pct", label: "HardHit%", weight: 9 },
    { key: "avg_ev", label: "Avg EV", weight: 8 },
    { key: "hr", label: "Home Runs", weight: 7 },
    { key: "hh5", label: "Hard Hits last 5d", weight: 7 },
    { key: "hh", label: "Hard Hits total", weight: 6 },
    { key: "max_ev", label: "Max EV", weight: 6 },
    { key: "xbh", label: "Extra-Base Hits", weight: 6 },
    { key: "sweetspot_pct", label: "SweetSpot%", weight: 5 },
    { key: "avg_dist", label: "Avg Distance", weight: 4 },
    { key: "hits", label: "Hits", weight: 3 },
    { key: "k", label: "Strikeouts", weight: 0, invert: true }
  ];

  var PITCHER_COLUMNS = [
    { key: "name", label: "Player", type: "text" },
    { key: "team", label: "Team", type: "text", dk: true },
    { key: "position", label: "Pos", type: "text", dk: true },
    { key: "salary", label: "Salary", type: "money", dk: true },
    { key: "avgPoints", label: "DK Avg", type: "num1", dk: true },
    { key: "rating", label: "Rating", type: "num1" },
    { key: "value", label: "Value", type: "num2", dk: true },
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
    { key: "k_pct", label: "K%", weight: 10 },
    { key: "whiff_pct", label: "Whiff%", weight: 9 },
    { key: "csw_pct", label: "CSW%", weight: 8 },
    { key: "ev_against", label: "EV Against", weight: 7, invert: true },
    { key: "hardhit_against_pct", label: "HardHit% Against", weight: 6, invert: true },
    { key: "hr_allowed", label: "HR Allowed", weight: 6, invert: true },
    { key: "bb_pct", label: "BB%", weight: 5, invert: true },
    { key: "avg_velo", label: "Avg Velo", weight: 4 }
  ];

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */

  var state = {
    tab: "batters",
    batters: { rows: [], players: [], sortKey: "rating", sortDir: -1, split: "all", expanded: {} },
    pitchers: { rows: [], players: [], sortKey: "rating", sortDir: -1, split: "all", expanded: {} },
    dk: [],
    search: "",
    slateOnly: false,
    minSample: { batters: 1, pitchers: 1 }
  };

  var weights = {
    batters: loadWeights("batters", BATTER_WEIGHTS),
    pitchers: loadWeights("pitchers", PITCHER_WEIGHTS)
  };

  function loadWeights(kind, defaults) {
    try {
      var saved = JSON.parse(localStorage.getItem("dkmlb_weights_" + kind));
      if (saved) {
        return defaults.map(function (d) {
          var s = saved[d.key];
          return { key: d.key, label: d.label, invert: d.invert, weight: typeof s === "number" ? s : d.weight };
        });
      }
    } catch (e) { /* ignore */ }
    return defaults.map(function (d) { return Object.assign({}, d); });
  }

  function saveWeights(kind) {
    var obj = {};
    weights[kind].forEach(function (w) { obj[w.key] = w.weight; });
    try { localStorage.setItem("dkmlb_weights_" + kind, JSON.stringify(obj)); } catch (e) { /* ignore */ }
  }

  function persistData(key, rows) {
    try { localStorage.setItem("dkmlb_" + key, JSON.stringify(rows)); } catch (e) { /* quota - skip */ }
  }

  function restoreData() {
    ["batters", "pitchers", "dk"].forEach(function (key) {
      try {
        var raw = localStorage.getItem("dkmlb_" + key);
        if (!raw) return;
        var rows = JSON.parse(raw);
        if (key === "dk") state.dk = rows;
        else state[key].rows = rows;
      } catch (e) { /* ignore */ }
    });
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

  function rebuild(kind) {
    var s = state[kind];
    var rows = splitFilter(kind, s.rows);
    s.players = kind === "batters" ? Stats.aggregateBatters(rows) : Stats.aggregatePitchers(rows);
    if (state.dk.length) DK.matchSalaries(s.players, state.dk);
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
      var matched = 0;
      state[state.tab].players.forEach(function (pl) { if (pl.onSlate) matched++; });
      dkStatus = d + " DK players · " + matched + " matched on this tab";
    }
    document.getElementById("status-dk").textContent = dkStatus;
  }

  function renderWeights(kind) {
    var panel = document.getElementById("weights-body");
    var html = "";
    weights[kind].forEach(function (w, i) {
      html +=
        '<div class="weight-row">' +
        '<label for="w-' + i + '">' + esc(w.label) + (w.invert ? ' <span class="inv" title="Lower is better">↓</span>' : "") + "</label>" +
        '<input id="w-' + i + '" type="range" min="0" max="10" step="1" value="' + w.weight + '" data-idx="' + i + '">' +
        '<span class="wval">' + w.weight + "</span>" +
        "</div>";
    });
    panel.innerHTML = html;
    panel.querySelectorAll("input[type=range]").forEach(function (input) {
      input.addEventListener("input", function () {
        var idx = parseInt(input.getAttribute("data-idx"), 10);
        weights[kind][idx].weight = parseInt(input.value, 10);
        input.nextElementSibling.textContent = input.value;
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
    var showCols = cols.filter(function (c) { return !c.dk || hasDK; });

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
      html += '<tbody><tr><td colspan="' + showCols.length + '" class="empty">No data — upload a Savant CSV above.</td></tr></tbody>';
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
    if (kind === "pitchers") {
      var paOnly = evts.filter(function (r) { return r.events; });
      if (paOnly.length) evts = paOnly;
    }
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
    restoreData();

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
      ["batters", "pitchers", "dk"].forEach(function (k) { localStorage.removeItem("dkmlb_" + k); });
      state.batters.rows = [];
      state.pitchers.rows = [];
      state.dk = [];
      rebuildAll();
    });

    updateSplitButtons();
    rebuildAll();
  }

  function updateSplitButtons() {
    var kind = state.tab;
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
