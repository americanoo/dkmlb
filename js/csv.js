/* Minimal RFC-4180-ish CSV parser. Handles quoted fields, embedded commas,
   embedded newlines, doubled quotes, and a UTF-8 BOM. */
(function (global) {
  "use strict";

  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    var rows = [];
    var row = [];
    var field = "";
    var inQuotes = false;
    var i = 0;
    var len = text.length;

    while (i < len) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
          } else {
            inQuotes = false;
            i++;
          }
        } else {
          field += c;
          i++;
        }
      } else if (c === '"') {
        inQuotes = true;
        i++;
      } else if (c === ",") {
        row.push(field);
        field = "";
        i++;
      } else if (c === "\r") {
        i++;
      } else if (c === "\n") {
        row.push(field);
        field = "";
        rows.push(row);
        row = [];
        i++;
      } else {
        field += c;
        i++;
      }
    }
    if (field !== "" || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  /* Parse a CSV whose first row is the header. Returns array of objects. */
  function parseCSVObjects(text) {
    var rows = parseCSV(text);
    if (!rows.length) return [];
    var header = rows[0].map(function (h) { return h.trim(); });
    var out = [];
    for (var r = 1; r < rows.length; r++) {
      var cells = rows[r];
      if (cells.length === 1 && cells[0] === "") continue;
      var obj = {};
      for (var c = 0; c < header.length; c++) {
        obj[header[c]] = cells[c] !== undefined ? cells[c] : "";
      }
      out.push(obj);
    }
    return out;
  }

  global.CSV = { parse: parseCSV, parseObjects: parseCSVObjects };
})(window);
