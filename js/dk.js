/* DraftKings salary CSV import + Savant<->DK name matching.
   The DK lineup-builder template pads the sheet with instruction rows and
   empty columns; the real table starts at the row containing
   "Position, Name + ID, Name, ID, Roster Position, Salary, Game Info, ...". */
(function (global) {
  "use strict";

  function parseDKSalaries(text) {
    var rows = CSV.parse(text);
    var headerRowIdx = -1, offset = -1;
    for (var r = 0; r < rows.length; r++) {
      var idx = rows[r].indexOf("Position");
      if (idx !== -1 && rows[r].indexOf("Salary") > idx) {
        headerRowIdx = r;
        offset = idx;
        break;
      }
    }
    if (headerRowIdx === -1) return [];

    var header = rows[headerRowIdx].slice(offset).map(function (h) { return h.trim(); });
    var players = [];
    for (var i = headerRowIdx + 1; i < rows.length; i++) {
      var cells = rows[i].slice(offset);
      if (!cells.length || !cells[0]) continue;
      var p = {};
      for (var c = 0; c < header.length; c++) p[header[c]] = cells[c] !== undefined ? cells[c] : "";
      if (!p.Name) continue;
      players.push({
        position: p.Position,
        name: p.Name,
        id: p.ID,
        rosterPosition: p["Roster Position"],
        salary: parseInt(p.Salary, 10) || null,
        gameInfo: p["Game Info"],
        team: p.TeamAbbrev,
        avgPoints: parseFloat(p.AvgPointsPerGame) || null
      });
    }
    return players;
  }

  var SUFFIXES = { jr: 1, sr: 1, ii: 1, iii: 1, iv: 1, v: 1 };

  /* "Tatis Jr., Fernando" / "Fernando Tatis Jr." -> "fernando tatis" */
  function normalizeName(name) {
    if (!name) return "";
    name = name.trim();
    var comma = name.indexOf(",");
    if (comma !== -1) {
      name = name.slice(comma + 1).trim() + " " + name.slice(0, comma).trim();
    }
    name = name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[.'`’]/g, "")
      .replace(/-/g, " ");
    var parts = name.split(/\s+/).filter(function (w) { return w && !SUFFIXES[w]; });
    return parts.join(" ");
  }

  /* Attach DK slate info onto aggregated players (matched by name).
     Returns count of matches. */
  function matchSalaries(players, dkPlayers) {
    var byName = {};
    dkPlayers.forEach(function (d) {
      var key = normalizeName(d.name);
      if (!byName[key]) byName[key] = d;
    });
    var matched = 0;
    players.forEach(function (p) {
      var d = byName[normalizeName(p.name)];
      if (d) {
        matched++;
        p.salary = d.salary;
        p.position = d.position;
        p.rosterPosition = d.rosterPosition;
        p.team = d.team;
        p.gameInfo = d.gameInfo;
        p.avgPoints = d.avgPoints;
        p.onSlate = true;
      } else {
        p.salary = null;
        p.position = null;
        p.rosterPosition = null;
        p.team = null;
        p.gameInfo = null;
        p.avgPoints = null;
        p.onSlate = false;
      }
    });
    return matched;
  }

  global.DK = {
    parseSalaries: parseDKSalaries,
    normalizeName: normalizeName,
    matchSalaries: matchSalaries
  };
})(window);
