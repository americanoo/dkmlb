/* Formula language for user-defined stat columns.

   Expressions: numbers, stat keys, + - * / ^, parentheses, comparisons
   (> < >= <= == !=, giving 1 or 0) and functions:
     min(a, b, ...)  max(...)  avg(...)   — missing values are skipped
     abs(x) sqrt(x) ln(x) log10(x) floor(x) ceil(x) round(x[, digits])
     pow(x, y)  clamp(x, lo, hi)  if(cond, a, b)  nz(x[, fallback=0])
   Pool functions compare a player to everyone on the tab; their argument
   must be a stat key:
     z(stat)      standard score (0 = average, +1 = one SD above)
     pctl(stat)   percentile 0-100 (100 = best value in the pool)
     rank(stat)   1 = highest value
     scale(stat)  0-1 between the pool's lowest and highest value
   A missing stat makes the result missing unless nz() supplies a value;
   dividing by zero gives a missing value. Text is parsed here and never
   run as code. */
(function (global) {
  "use strict";

  function FormulaError(message, pos) {
    this.message = message;
    this.pos = pos;
  }
  FormulaError.prototype = Object.create(Error.prototype);
  FormulaError.prototype.name = "FormulaError";

  var FUNCTIONS = {
    min: { min: 1 }, max: { min: 1 }, avg: { min: 1 },
    abs: { min: 1, max: 1 }, sqrt: { min: 1, max: 1 }, ln: { min: 1, max: 1 }, log10: { min: 1, max: 1 },
    floor: { min: 1, max: 1 }, ceil: { min: 1, max: 1 }, round: { min: 1, max: 2 },
    pow: { min: 2, max: 2 }, clamp: { min: 3, max: 3 }, "if": { min: 3, max: 3 }, nz: { min: 1, max: 2 }
  };
  var POOL_FUNCTIONS = { z: 1, pctl: 1, rank: 1, scale: 1 };

  function tokenize(text) {
    var tokens = [];
    var i = 0;
    while (i < text.length) {
      var c = text[i];
      if (/\s/.test(c)) { i++; continue; }
      var start = i;
      if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(text[i + 1] || ""))) {
        while (i < text.length && /[0-9.]/.test(text[i])) i++;
        var raw = text.slice(start, i);
        if (!/^(\d+\.?\d*|\.\d+)$/.test(raw)) throw new FormulaError("“" + raw + "” isn't a number", start);
        tokens.push({ t: "num", v: parseFloat(raw), pos: start });
        continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        while (i < text.length && /[A-Za-z0-9_]/.test(text[i])) i++;
        tokens.push({ t: "id", v: text.slice(start, i), pos: start });
        continue;
      }
      var two = text.slice(i, i + 2);
      if (two === ">=" || two === "<=" || two === "==" || two === "!=") {
        tokens.push({ t: "op", v: two, pos: start });
        i += 2;
        continue;
      }
      if ("+-*/^()<>,".indexOf(c) !== -1) {
        tokens.push({ t: c === "(" || c === ")" || c === "," ? c : "op", v: c, pos: start });
        i++;
        continue;
      }
      throw new FormulaError("Unexpected character “" + c + "”", start);
    }
    tokens.push({ t: "end", pos: text.length });
    return tokens;
  }

  /* Recursive-descent parser producing a small AST. vars maps a lowercase
     name to the canonical stat key. */
  function parse(text, vars) {
    var tokens = tokenize(text);
    var p = 0;
    var used = {}, poolUsed = {};

    function peek() { return tokens[p]; }
    function next() { return tokens[p++]; }
    function expect(type, what) {
      var tok = next();
      if (tok.t !== type) throw new FormulaError("Expected " + what, tok.pos);
      return tok;
    }

    function comparison() {
      var left = additive();
      var tok = peek();
      if (tok.t === "op" && [">", "<", ">=", "<=", "==", "!="].indexOf(tok.v) !== -1) {
        next();
        return { k: "bin", op: tok.v, a: left, b: additive() };
      }
      return left;
    }
    function additive() {
      var node = term();
      while (peek().t === "op" && (peek().v === "+" || peek().v === "-")) {
        var op = next().v;
        node = { k: "bin", op: op, a: node, b: term() };
      }
      return node;
    }
    function term() {
      var node = unary();
      while (peek().t === "op" && (peek().v === "*" || peek().v === "/")) {
        var op = next().v;
        node = { k: "bin", op: op, a: node, b: unary() };
      }
      return node;
    }
    function unary() {
      if (peek().t === "op" && (peek().v === "-" || peek().v === "+")) {
        var op = next().v;
        var arg = unary();
        return op === "-" ? { k: "neg", a: arg } : arg;
      }
      return power();
    }
    function power() {
      var base = primary();
      if (peek().t === "op" && peek().v === "^") {
        next();
        return { k: "bin", op: "^", a: base, b: unary() };
      }
      return base;
    }
    function variable(tok) {
      var name = tok.v.toLowerCase();
      var key = Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : null;
      if (!key) throw new FormulaError("Unknown stat “" + tok.v + "”. Pick one from the list below.", tok.pos);
      used[key] = true;
      return key;
    }
    function primary() {
      var tok = next();
      if (tok.t === "num") return { k: "num", v: tok.v };
      if (tok.t === "(") {
        var inner = comparison();
        expect(")", "a closing “)”");
        return inner;
      }
      if (tok.t === "id") {
        var name = tok.v.toLowerCase();
        if (peek().t === "(") {
          next();
          if (POOL_FUNCTIONS[name]) {
            var hint = name + "( ) takes one stat name, like " + name + "(hh)";
            var argTok = next();
            if (argTok.t !== "id") throw new FormulaError(hint, argTok.pos);
            var key = variable(argTok);
            poolUsed[key] = true;
            if (next().t !== ")") throw new FormulaError(hint, argTok.pos);
            return { k: "pool", fn: name, key: key };
          }
          var spec = FUNCTIONS[name];
          if (!spec) throw new FormulaError("Unknown function “" + tok.v + "”", tok.pos);
          var args = [];
          if (peek().t !== ")") {
            args.push(comparison());
            while (peek().t === ",") { next(); args.push(comparison()); }
          }
          expect(")", "a closing “)” for " + name + "(");
          if (args.length < spec.min || (spec.max && args.length > spec.max)) {
            throw new FormulaError(name + "() takes " + (spec.max === spec.min ? spec.min : spec.min + (spec.max ? "–" + spec.max : " or more")) +
              " value" + ((spec.max || 2) > 1 ? "s" : ""), tok.pos);
          }
          return { k: "fn", fn: name, args: args };
        }
        return { k: "var", key: variable(tok) };
      }
      if (tok.t === "end") throw new FormulaError("The formula ends too soon", tok.pos);
      throw new FormulaError("Unexpected “" + (tok.v || tok.t) + "”", tok.pos);
    }

    if (!text.trim()) throw new FormulaError("Type a formula", 0);
    var ast = comparison();
    if (peek().t !== "end") throw new FormulaError("Unexpected “" + (peek().v || peek().t) + "”", peek().pos);
    return { ast: ast, vars: Object.keys(used), poolVars: Object.keys(poolUsed) };
  }

  function finite(v) {
    return typeof v === "number" && isFinite(v) ? v : null;
  }

  function evalNode(node, row, pools) {
    switch (node.k) {
      case "num": return node.v;
      case "var": return finite(row[node.key]);
      case "neg": {
        var v = evalNode(node.a, row, pools);
        return v === null ? null : -v;
      }
      case "pool": return poolValue(node, row, pools);
      case "bin": {
        var a = evalNode(node.a, row, pools), b = evalNode(node.b, row, pools);
        if (a === null || b === null) return null;
        switch (node.op) {
          case "+": return a + b;
          case "-": return a - b;
          case "*": return a * b;
          case "/": return b === 0 ? null : a / b;
          case "^": return finite(Math.pow(a, b));
          case ">": return a > b ? 1 : 0;
          case "<": return a < b ? 1 : 0;
          case ">=": return a >= b ? 1 : 0;
          case "<=": return a <= b ? 1 : 0;
          case "==": return a === b ? 1 : 0;
          case "!=": return a !== b ? 1 : 0;
        }
        return null;
      }
      case "fn": return callFn(node, row, pools);
    }
    return null;
  }

  function callFn(node, row, pools) {
    if (node.fn === "if") {
      var cond = evalNode(node.args[0], row, pools);
      if (cond === null) return null;
      return evalNode(cond ? node.args[1] : node.args[2], row, pools);
    }
    if (node.fn === "nz") {
      var v0 = evalNode(node.args[0], row, pools);
      if (v0 !== null) return v0;
      return node.args[1] ? evalNode(node.args[1], row, pools) : 0;
    }
    var vals = node.args.map(function (a) { return evalNode(a, row, pools); });
    if (node.fn === "min" || node.fn === "max" || node.fn === "avg") {
      var present = vals.filter(function (v) { return v !== null; });
      if (!present.length) return null;
      if (node.fn === "min") return Math.min.apply(null, present);
      if (node.fn === "max") return Math.max.apply(null, present);
      return present.reduce(function (s, v) { return s + v; }, 0) / present.length;
    }
    if (vals.some(function (v) { return v === null; })) return null;
    var x = vals[0];
    switch (node.fn) {
      case "abs": return Math.abs(x);
      case "sqrt": return x < 0 ? null : Math.sqrt(x);
      case "ln": return x <= 0 ? null : Math.log(x);
      case "log10": return x <= 0 ? null : Math.log(x) / Math.LN10;
      case "floor": return Math.floor(x);
      case "ceil": return Math.ceil(x);
      case "round": {
        var f = Math.pow(10, vals[1] || 0);
        return Math.round(x * f) / f;
      }
      case "pow": return finite(Math.pow(x, vals[1]));
      case "clamp": return Math.min(Math.max(x, vals[1]), vals[2]);
    }
    return null;
  }

  /* Pool summaries are built once per evaluation pass. */
  function buildPool(players, key) {
    var vals = players.map(function (pl) { return finite(pl[key]); })
      .filter(function (v) { return v !== null; });
    var sorted = vals.slice().sort(function (a, b) { return a - b; });
    var n = vals.length;
    var mean = n ? vals.reduce(function (s, v) { return s + v; }, 0) / n : null;
    var sd = n > 1 ? Math.sqrt(vals.reduce(function (s, v) { return s + (v - mean) * (v - mean); }, 0) / (n - 1)) : null;
    return { sorted: sorted, mean: mean, sd: sd };
  }

  function countBelow(sorted, v) {
    var lo = 0, hi = sorted.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (sorted[mid] < v) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function poolValue(node, row, pools) {
    var v = finite(row[node.key]);
    var pool = pools[node.key];
    if (v === null || !pool || !pool.sorted.length) return null;
    var s = pool.sorted, n = s.length;
    switch (node.fn) {
      case "z": return pool.sd ? (v - pool.mean) / pool.sd : 0;
      case "scale": return s[n - 1] === s[0] ? 0.5 : (v - s[0]) / (s[n - 1] - s[0]);
      case "pctl": {
        if (n === 1) return 100;
        var below = countBelow(s, v);
        var equal = countBelow(s, v + 1e-12) - below;
        return ((below + (equal - 1) / 2) / (n - 1)) * 100;
      }
      case "rank": return n - countBelow(s, v + 1e-12) + 1;
    }
    return null;
  }

  /* Compute one formula for every player; result stored on player[key]. */
  function apply(compiled, players, key) {
    var pools = {};
    compiled.poolVars.forEach(function (k) { pools[k] = buildPool(players, k); });
    players.forEach(function (pl) {
      var v = evalNode(compiled.ast, pl, pools);
      pl[key] = finite(v);
    });
  }

  global.Formula = {
    compile: parse,
    apply: apply,
    FormulaError: FormulaError,
    FUNCTION_NAMES: Object.keys(FUNCTIONS).concat(Object.keys(POOL_FUNCTIONS))
  };
})(window);
