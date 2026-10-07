/* Every stat the Batters and Pitchers tabs can show, in display order.
   type picks the formatting; lower marks stats where a smaller number is
   better (the default direction when the stat is added to a rating);
   dk / vegas columns only appear once salaries / Vegas lines exist. */
(function (global) {
  "use strict";

  var GROUPS = ["Slate & Vegas", "Volume", "Results", "Plate discipline", "Contact quality",
    "Batted-ball mix", "Pitching"];

  function S(key, label, type, group, desc, extra) {
    var s = { key: key, label: label, type: type, group: group, desc: desc };
    if (extra) for (var k in extra) s[k] = extra[k];
    return s;
  }

  var SLATE = "Slate & Vegas", VOL = "Volume", RES = "Results", DISC = "Plate discipline",
    CON = "Contact quality", MIX = "Batted-ball mix", PIT = "Pitching";

  function slateStats(side) {
    var list = [
      S("team", "Team", "text", SLATE, "DraftKings team", { dk: true, text: true }),
      S("position", "Pos", "text", SLATE, "DraftKings position(s)", { dk: true, text: true }),
      S("salary", "Salary", "money", SLATE, "DraftKings salary", { dk: true }),
      S("avgPoints", "DK Avg", "num1", SLATE, "DraftKings average fantasy points per game", { dk: true }),
      S("rating", "Rating", "num1", SLATE, "Your 0–10 rating from the weights panel", { noFormula: true }),
      S("value", "Value", "num2", SLATE, "Rating per $1,000 of salary", { dk: true, noFormula: true })
    ];
    if (side === "batters") {
      list.push(S("itt_eff", "Imp Tot", "num1", SLATE, "Team implied run total (Vegas tab)", { vegas: true }));
    } else {
      list.push(S("opp_itt", "Opp Imp Tot", "num1", SLATE, "Opponent's implied run total (Vegas tab)", { vegas: true, lower: true }));
      list.push(S("itt_eff", "Team Imp Tot", "num1", SLATE, "Own team's implied run total (Vegas tab)", { vegas: true }));
    }
    list.push(
      S("ou", "O/U", "num1", SLATE, "Game total (over/under)", { vegas: true, lower: side === "pitchers" }),
      S("ml", "ML", "ml", SLATE, "Team moneyline", { vegas: true, lower: side === "pitchers" }),
      S("bets", "Bets%", "pct", SLATE, "Share of bets on the team", { vegas: true }),
      S("handle", "Handle%", "pct", SLATE, "Share of money on the team", { vegas: true })
    );
    return list;
  }

  var BATTERS = slateStats("batters").concat([
    S("pitches", "Pitches", "int", VOL, "Pitches seen"),
    S("pa", "PA", "int", VOL, "Plate appearances"),
    S("ab", "AB", "int", VOL, "At-bats"),
    S("pitches_per_pa", "P/PA", "num2", VOL, "Pitches seen per plate appearance"),

    S("h", "H", "int", RES, "Hits, all plate appearances"),
    S("singles", "1B", "int", RES, "Singles"),
    S("doubles", "2B", "int", RES, "Doubles"),
    S("triples", "3B", "int", RES, "Triples"),
    S("tb", "TB", "int", RES, "Total bases"),
    S("bb", "BB", "int", RES, "Walks (including intentional)"),
    S("ibb", "IBB", "int", RES, "Intentional walks"),
    S("k", "K", "int", RES, "Strikeouts", { lower: true }),
    S("hbp", "HBP", "int", RES, "Hit by pitch"),
    S("sf", "SF", "int", RES, "Sacrifice flies"),
    S("gidp", "GIDP", "int", RES, "Grounded into double plays", { lower: true }),
    S("avg", "AVG", "avg3", RES, "Batting average"),
    S("obp", "OBP", "avg3", RES, "On-base percentage"),
    S("slg", "SLG", "avg3", RES, "Slugging percentage"),
    S("ops", "OPS", "avg3", RES, "OBP + SLG"),
    S("iso", "ISO", "avg3", RES, "Isolated power (SLG − AVG)"),
    S("babip", "BABIP", "avg3", RES, "Batting average on balls in play"),
    S("woba", "wOBA", "avg3", RES, "Weighted on-base average"),
    S("xwoba", "xwOBA", "avg3", RES, "Expected wOBA from exit velo and launch angle"),
    S("xba", "xBA", "avg3", RES, "Expected batting average"),

    S("k_pct", "K%", "pct", DISC, "Strikeouts per PA", { lower: true }),
    S("bb_pct", "BB%", "pct", DISC, "Walks per PA"),
    S("k_minus_bb_pct", "K−BB%", "pct", DISC, "K% minus BB%", { lower: true }),
    S("swings", "Swings", "int", DISC, "Swings"),
    S("swing_pct", "Swing%", "pct", DISC, "Swings per pitch"),
    S("whiffs", "Whiffs", "int", DISC, "Swinging strikes", { lower: true }),
    S("whiff_pct", "Whiff%", "pct", DISC, "Whiffs per swing", { lower: true }),
    S("contact_pct", "Contact%", "pct", DISC, "Contact per swing"),
    S("zone_pitches", "Zone Pitches", "int", DISC, "Pitches seen in the strike zone"),
    S("zone_pct", "Zone%", "pct", DISC, "Share of pitches seen in the zone"),
    S("z_swings", "Z-Swings", "int", DISC, "Swings at pitches in the zone"),
    S("z_swing_pct", "Z-Swing%", "pct", DISC, "Swings at pitches in the zone"),
    S("out_zone_pitches", "O-Zone Pitches", "int", DISC, "Pitches seen outside the zone"),
    S("chases", "Chases", "int", DISC, "Swings at pitches outside the zone", { lower: true }),
    S("chase_pct", "Chase%", "pct", DISC, "Swings at pitches outside the zone", { lower: true }),
    S("called_strikes", "Called Strikes", "int", DISC, "Called strikes taken", { lower: true }),
    S("csw", "CSW", "int", DISC, "Called strikes + whiffs", { lower: true }),
    S("csw_pct", "CSW%", "pct", DISC, "Called strikes + whiffs per pitch", { lower: true }),
    S("first_pitches", "1st Pitches", "int", DISC, "First pitches (0-0 counts) seen"),
    S("first_swings", "1st-Pitch Swings", "int", DISC, "Swings at 0-0 pitches"),
    S("first_swing_pct", "1st-Pitch Swing%", "pct", DISC, "Swings at 0-0 pitches"),

    S("bbe", "BBE", "int", CON, "Balls in play"),
    S("hh", "HH", "int", CON, "Hard-hit balls (95+ mph)"),
    S("hardhit_pct", "HardHit%", "pct", CON, "Hard-hit balls per ball in play"),
    S("hh_per_pa", "HH/PA%", "pct", CON, "Hard-hit balls per plate appearance"),
    S("barrels", "Barrels", "int", CON, "Barrels (ideal exit velo + launch angle)"),
    S("barrel_pct", "Barrel%", "pct", CON, "Barrels per ball in play"),
    S("barrels_per_pa", "Barrel/PA%", "pct", CON, "Barrels per plate appearance"),
    S("avg_ev", "Avg EV", "num1", CON, "Average exit velocity"),
    S("max_ev", "Max EV", "num1", CON, "Hardest-hit ball"),
    S("ev90", "EV90", "num1", CON, "90th-percentile exit velocity"),
    S("avg_la", "Avg LA", "num1", CON, "Average launch angle"),
    S("sweet_spots", "Sweet Spots", "int", CON, "Balls hit at 8–32° launch angle"),
    S("sweetspot_pct", "SweetSpot%", "pct", CON, "Balls hit at 8–32° launch angle"),
    S("avg_dist", "Avg Dist", "num0", CON, "Average distance"),
    S("max_dist", "Max Dist", "num0", CON, "Longest ball"),
    S("hr", "HR", "int", CON, "Home runs"),
    S("xbh", "XBH", "int", CON, "Extra-base hits"),
    S("hits", "Hits", "int", CON, "Hits on balls in play counted here"),
    S("field_outs", "FO", "int", CON, "Field outs", { lower: true }),

    S("gb", "GB", "int", MIX, "Ground balls"),
    S("gb_pct", "GB%", "pct", MIX, "Ground balls per ball in play", { lower: true }),
    S("ld", "LD", "int", MIX, "Line drives"),
    S("ld_pct", "LD%", "pct", MIX, "Line drives per ball in play"),
    S("fb", "FB", "int", MIX, "Fly balls"),
    S("fb_pct", "FB%", "pct", MIX, "Fly balls per ball in play"),
    S("pu", "PU", "int", MIX, "Pop-ups", { lower: true }),
    S("pu_pct", "PU%", "pct", MIX, "Pop-ups per ball in play", { lower: true }),
    S("hr_on_fb", "HR on FB", "int", MIX, "Home runs on fly balls"),
    S("hr_per_fb", "HR/FB", "pct", MIX, "Home runs per fly ball"),
    S("pulled", "Pulled", "int", MIX, "Balls hit to the pull side"),
    S("pull_pct", "Pull%", "pct", MIX, "Balls hit to the pull side"),
    S("oppo", "Oppo", "int", MIX, "Balls hit the opposite way"),
    S("oppo_pct", "Oppo%", "pct", MIX, "Balls hit the opposite way")
  ]);

  var PITCHERS = slateStats("pitchers").concat([
    S("pitches", "Pitches", "int", VOL, "Pitches thrown"),
    S("pa", "BF", "int", VOL, "Batters faced"),
    S("ab", "AB", "int", VOL, "At-bats against"),
    S("pitches_per_pa", "P/BF", "num2", VOL, "Pitches per batter faced", { lower: true }),
    S("outs", "Outs", "int", VOL, "Outs recorded on plays"),
    S("ip", "IP", "num1", VOL, "Innings pitched (from outs on plays)"),

    S("h", "H", "int", RES, "Hits allowed", { lower: true }),
    S("singles", "1B", "int", RES, "Singles allowed", { lower: true }),
    S("doubles", "2B", "int", RES, "Doubles allowed", { lower: true }),
    S("triples", "3B", "int", RES, "Triples allowed", { lower: true }),
    S("tb", "TB", "int", RES, "Total bases allowed", { lower: true }),
    S("bb", "BB", "int", RES, "Walks allowed", { lower: true }),
    S("ibb", "IBB", "int", RES, "Intentional walks", { lower: true }),
    S("k", "K", "int", RES, "Strikeouts"),
    S("hbp", "HBP", "int", RES, "Hit batters", { lower: true }),
    S("sf", "SF", "int", RES, "Sacrifice flies allowed", { lower: true }),
    S("gidp", "GIDP", "int", RES, "Double plays induced"),
    S("avg", "AVG Agn", "avg3", RES, "Batting average against", { lower: true }),
    S("obp", "OBP Agn", "avg3", RES, "On-base percentage against", { lower: true }),
    S("slg", "SLG Agn", "avg3", RES, "Slugging against", { lower: true }),
    S("ops", "OPS Agn", "avg3", RES, "OPS against", { lower: true }),
    S("iso", "ISO Agn", "avg3", RES, "Isolated power against", { lower: true }),
    S("babip", "BABIP Agn", "avg3", RES, "BABIP against", { lower: true }),
    S("woba", "wOBA Agn", "avg3", RES, "wOBA against", { lower: true }),
    S("xwoba", "xwOBA Agn", "avg3", RES, "Expected wOBA against", { lower: true }),
    S("xba", "xBA Agn", "avg3", RES, "Expected batting average against", { lower: true }),

    S("k_pct", "K%", "pct", DISC, "Strikeouts per batter faced"),
    S("bb_pct", "BB%", "pct", DISC, "Walks per batter faced", { lower: true }),
    S("k_minus_bb_pct", "K−BB%", "pct", DISC, "K% minus BB%"),
    S("swings", "Swings", "int", DISC, "Swings induced"),
    S("swing_pct", "Swing%", "pct", DISC, "Swings per pitch"),
    S("whiffs", "Whiffs", "int", DISC, "Swinging strikes"),
    S("whiff_pct", "Whiff%", "pct", DISC, "Whiffs per swing"),
    S("contact_pct", "Contact%", "pct", DISC, "Contact allowed per swing", { lower: true }),
    S("zone_pitches", "Zone Pitches", "int", DISC, "Pitches in the strike zone"),
    S("zone_pct", "Zone%", "pct", DISC, "Pitches in the strike zone"),
    S("z_swings", "Z-Swings", "int", DISC, "Swings at pitches in the zone"),
    S("z_swing_pct", "Z-Swing%", "pct", DISC, "Swings at pitches in the zone"),
    S("out_zone_pitches", "O-Zone Pitches", "int", DISC, "Pitches outside the zone"),
    S("chases", "Chases", "int", DISC, "Swings at pitches outside the zone"),
    S("chase_pct", "Chase%", "pct", DISC, "Swings at pitches outside the zone"),
    S("called_strikes", "Called Strikes", "int", DISC, "Called strikes"),
    S("csw", "CSW", "int", DISC, "Called strikes + whiffs"),
    S("csw_pct", "CSW%", "pct", DISC, "Called strikes + whiffs per pitch"),
    S("first_pitches", "1st Pitches", "int", DISC, "First pitches (0-0 counts)"),
    S("first_strikes", "1st-Pitch Strikes", "int", DISC, "0-0 pitches for strikes (called, swung at, fouled or in play)"),
    S("first_strike_pct", "F-Strike%", "pct", DISC, "0-0 pitches for strikes"),

    S("bbe", "BBE", "int", CON, "Balls in play allowed"),
    S("hh", "HH", "int", CON, "Hard-hit balls allowed (95+ mph)", { lower: true }),
    S("hardhit_against_pct", "HardHit% Agn", "pct", CON, "Hard-hit balls per ball in play", { lower: true }),
    S("hh_per_pa", "HH/BF%", "pct", CON, "Hard-hit balls allowed per batter faced", { lower: true }),
    S("barrels", "Barrels", "int", CON, "Barrels allowed", { lower: true }),
    S("barrel_pct", "Barrel% Agn", "pct", CON, "Barrels per ball in play", { lower: true }),
    S("barrels_per_pa", "Barrel/BF%", "pct", CON, "Barrels per batter faced", { lower: true }),
    S("ev_against", "EV Agn", "num1", CON, "Average exit velocity allowed", { lower: true }),
    S("max_ev", "Max EV Agn", "num1", CON, "Hardest-hit ball allowed", { lower: true }),
    S("ev90", "EV90 Agn", "num1", CON, "90th-percentile exit velocity allowed", { lower: true }),
    S("avg_la", "LA Agn", "num1", CON, "Average launch angle allowed"),
    S("sweet_spots", "Sweet Spots", "int", CON, "Balls allowed at 8–32° launch angle", { lower: true }),
    S("sweetspot_pct", "SweetSpot% Agn", "pct", CON, "Balls allowed at 8–32° launch angle", { lower: true }),
    S("avg_dist", "Avg Dist Agn", "num0", CON, "Average distance allowed", { lower: true }),
    S("max_dist", "Max Dist Agn", "num0", CON, "Longest ball allowed", { lower: true }),
    S("hr_allowed", "HR Alwd", "int", CON, "Home runs allowed", { lower: true }),
    S("xbh", "XBH Alwd", "int", CON, "Extra-base hits allowed", { lower: true }),
    S("hits_allowed", "Hits Alwd", "int", CON, "Hits allowed on balls in play", { lower: true }),
    S("field_outs", "FO", "int", CON, "Field outs"),

    S("gb", "GB", "int", MIX, "Ground balls allowed"),
    S("gb_pct", "GB%", "pct", MIX, "Ground balls per ball in play"),
    S("ld", "LD", "int", MIX, "Line drives allowed", { lower: true }),
    S("ld_pct", "LD%", "pct", MIX, "Line drives per ball in play", { lower: true }),
    S("fb", "FB", "int", MIX, "Fly balls allowed", { lower: true }),
    S("fb_pct", "FB%", "pct", MIX, "Fly balls per ball in play", { lower: true }),
    S("pu", "PU", "int", MIX, "Pop-ups induced"),
    S("pu_pct", "PU%", "pct", MIX, "Pop-ups per ball in play"),
    S("hr_on_fb", "HR on FB", "int", MIX, "Home runs on fly balls", { lower: true }),
    S("hr_per_fb", "HR/FB", "pct", MIX, "Home runs per fly ball", { lower: true }),
    S("pulled", "Pulled", "int", MIX, "Balls pulled by hitters"),
    S("pull_pct", "Pull%", "pct", MIX, "Balls pulled by hitters"),
    S("oppo", "Oppo", "int", MIX, "Balls hit the opposite way"),
    S("oppo_pct", "Oppo%", "pct", MIX, "Balls hit the opposite way"),

    S("avg_velo", "Velo", "num1", PIT, "Average release speed"),
    S("max_velo", "Max Velo", "num1", PIT, "Fastest pitch"),
    S("avg_spin", "Spin", "num0", PIT, "Average spin rate (rpm)"),
    S("k_per_9", "K/9", "num2", PIT, "Strikeouts per 9 innings"),
    S("bb_per_9", "BB/9", "num2", PIT, "Walks per 9 innings", { lower: true }),
    S("hr_per_9", "HR/9", "num2", PIT, "Home runs per 9 innings", { lower: true })
  ]);

  /* The columns each tab showed before the chooser existed. */
  var DEFAULT_COLUMNS = {
    batters: ["team", "position", "salary", "avgPoints", "rating", "value", "itt_eff", "ou", "ml", "bets", "handle",
      "pitches", "bbe", "hh", "avg_ev", "max_ev", "avg_la", "barrel_pct", "hardhit_pct", "sweetspot_pct",
      "avg_dist", "hr", "xbh", "hits", "field_outs", "k"],
    pitchers: ["team", "position", "salary", "avgPoints", "rating", "value", "opp_itt", "ou", "ml", "bets", "handle",
      "pitches", "pa", "k_pct", "bb_pct", "whiff_pct", "csw_pct", "avg_velo", "ev_against",
      "hardhit_against_pct", "hr_allowed", "hits_allowed"]
  };

  /* Stats listed in the rating panel until you change the list. */
  var DEFAULT_RATED = {
    batters: ["barrel_pct", "hardhit_pct", "hh", "avg_ev", "hr", "max_ev", "xbh", "sweetspot_pct", "avg_dist",
      "hits", "k", "itt_eff", "bets", "handle"],
    pitchers: ["k_pct", "whiff_pct", "csw_pct", "ev_against", "hardhit_against_pct", "hr_allowed", "bb_pct",
      "avg_velo", "opp_itt", "ml"]
  };

  global.Catalog = {
    groups: GROUPS,
    stats: { batters: BATTERS, pitchers: PITCHERS },
    defaultColumns: DEFAULT_COLUMNS,
    defaultRated: DEFAULT_RATED
  };
})(window);
