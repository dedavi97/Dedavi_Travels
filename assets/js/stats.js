// Stats view: summary cards, country ranking, extreme points, farthest place from home,
// and a collapsible country → subdivision / territory → places list.

(function () {
  "use strict";

  var HOME = { name: "Turin", lat: 45.0703, lon: 7.6869 };

  // 193 UN member states + 2 observer states (Vatican, Palestine), as ISO 3166-1 alpha-2.
  var UN_STATES = ("AF AL DZ AD AO AG AR AM AU AT AZ BS BH BD BB BY BE BZ BJ BT BO BA BW BR BN BG BF BI " +
    "CV KH CM CA CF TD CL CN CO KM CG CD CR CI HR CU CY CZ DK DJ DM DO EC EG SV GQ ER EE SZ ET FJ FI FR " +
    "GA GM GE DE GH GR GD GT GN GW GY HT HN HU IS IN ID IR IQ IE IL IT JM JP JO KZ KE KI KP KR KW KG LA " +
    "LV LB LS LR LY LI LT LU MG MW MY MV ML MT MH MR MU MX FM MD MC MN ME MA MZ MM NA NR NP NL NZ NI NE " +
    "NG MK NO OM PK PW PA PG PY PE PH PL PT QA RO RU RW KN LC VC WS SM ST SA SN RS SC SL SG SK SI SB SO " +
    "ZA SS ES LK SD SR SE CH SY TJ TZ TH TL TG TO TT TN TR TM TV UG UA AE GB US UY UZ VU VE VN YE ZM ZW " +
    "VA PS").split(" ");
  var IT_REGIONS = 20;
  var US_STATES = 50; // District of Columbia is shown but not counted

  var rendered = false;

  function distinct(list, fn) {
    var seen = {};
    list.forEach(function (x) { var v = fn(x); if (v) seen[v] = true; });
    return Object.keys(seen);
  }

  function byName(a, b) { return a.name.localeCompare(b.name, "en"); }

  // ---------------------------------------------------------------- pieces

  function card(value, label, total) {
    var bar = total ? '<div class="card-bar"><span style="width:' + Math.min(100, (value / total) * 100).toFixed(1) + '%"></span></div>' : "";
    return '<div class="card"><div class="card-value">' + value +
      (total ? " <small>/ " + total + "</small>" : "") + '</div><div class="card-label">' + label + "</div>" + bar + "</div>";
  }

  function percentCard(pct, label) {
    return '<div class="card"><div class="card-value">' + pct.toFixed(1) + '<small>%</small></div><div class="card-label">' +
      label + '</div><div class="card-bar"><span style="width:' + pct.toFixed(1) + '%"></span></div></div>';
  }

  function fact(label, p, extra) {
    return '<a class="fact" href="' + DT.placeLink(p) + '"><div class="fact-label">' + label + "</div>" +
      '<div class="fact-place">' + DT.placeFlag(p) + "<span>" + DT.escape(p.name) + "</span></div>" +
      '<div class="fact-extra">' + extra + "</div></a>";
  }

  function coord(v, pos, neg) { return Math.abs(v).toFixed(2) + "° " + (v >= 0 ? pos : neg); }

  function placeList(places) {
    return '<ul class="places">' + places.slice().sort(byName).map(function (p) {
      return '<li><a href="' + DT.placeLink(p) + '">' + DT.escape(p.name) + "</a></li>";
    }).join("") + "</ul>";
  }

  // Group a country's places: territories and subdivisions get their own sub-section,
  // the rest are listed directly.
  function countryBlock(c) {
    var groups = {}, direct = [];
    c.places.forEach(function (p) {
      var key = p.territory ? "t:" + p.territory : p.subdivision ? "s:" + p.subdivision : null;
      if (!key) { direct.push(p); return; }
      (groups[key] = groups[key] || { name: p.territory || p.subdivision, territory: !!p.territory, flag: p.territory_iso2, places: [] }).places.push(p);
    });
    var sub = Object.keys(groups).map(function (k) { return groups[k]; })
      .sort(function (a, b) { return (a.territory - b.territory) || byName(a, b); })
      .map(function (g) {
        return "<details><summary>" + (g.territory ? DT.flag(g.flag) : "") +
          '<span class="name">' + DT.escape(g.name) + "</span>" +
          (g.territory ? '<span class="tag">Territory</span>' : "") +
          '<span class="count">' + g.places.length + "</span></summary>" + placeList(g.places) + "</details>";
      }).join("");
    return "<details><summary>" + DT.flag(c.iso2) + '<span class="name">' + DT.escape(c.name) +
      '</span><span class="count">' + c.places.length + "</span></summary>" +
      (sub ? '<div class="group">' + sub + "</div>" : "") + (direct.length ? placeList(direct) : "") + "</details>";
  }

  // ---------------------------------------------------------------- render

  function render(el) {
    var places = DT.data.places;
    if (!places.length) {
      el.innerHTML = '<div class="page"><h1>Stats</h1><p class="muted">No places yet.</p></div>';
      return;
    }

    // countries (by sovereignty)
    var countries = {};
    places.forEach(function (p) {
      var key = p.country || "Unknown";
      (countries[key] = countries[key] || { name: key, iso2: p.country_iso2, places: [] }).places.push(p);
    });
    var countryList = Object.keys(countries).map(function (k) { return countries[k]; })
      .sort(function (a, b) { return (b.places.length - a.places.length) || byName(a, b); });

    var nCountries = countryList.filter(function (c) { return c.name !== "Unknown"; }).length;
    var nTerritories = distinct(places, function (p) { return p.territory; }).length;
    var nContinents = distinct(places, function (p) { return p.continent; }).length;
    var nUn = distinct(places, function (p) { return UN_STATES.indexOf(p.country_iso2) >= 0 ? p.country_iso2 : null; }).length;
    var nItRegions = distinct(places, function (p) { return p.country_iso2 === "IT" ? p.subdivision : null; }).length;
    var nUsStates = distinct(places, function (p) {
      return p.country_iso2 === "US" && p.subdivision !== "District of Columbia" ? p.subdivision : null;
    }).length;

    // extremes & farthest from home
    function extreme(fn) { return places.reduce(function (best, p) { return fn(p) > fn(best) ? p : best; }); }
    var north = extreme(function (p) { return p.lat; });
    var south = extreme(function (p) { return -p.lat; });
    var east = extreme(function (p) { return p.lon; });
    var west = extreme(function (p) { return -p.lon; });
    function dist(p) { return DT.haversineKm(HOME.lat, HOME.lon, p.lat, p.lon); }
    var farthest = extreme(dist);

    var top = countryList.filter(function (c) { return c.name !== "Unknown"; }).slice(0, 10);
    var max = top.length ? top[0].places.length : 1;

    el.innerHTML =
      '<div class="page">' +
        "<h1>Stats</h1>" +
        '<p class="lead">Every place on the map, counted by country (by sovereignty) and region.</p>' +
        '<div class="cards">' +
          card(places.length, "Places") +
          card(nCountries, "Countries") +
          card(nTerritories, "Territories") +
          card(nContinents, "Continents") +
          percentCard((nUn / UN_STATES.length) * 100, "of the " + UN_STATES.length + " UN states (" + nUn + ")") +
          card(nItRegions, "Italian regions", IT_REGIONS) +
          card(nUsStates, "US states", US_STATES) +
        "</div>" +

        "<h2>Top countries</h2>" +
        '<div class="panel ranking">' + top.map(function (c) {
          return '<div class="rank-row"><div class="rank-name">' + DT.flag(c.iso2) + "<span>" + DT.escape(c.name) + "</span></div>" +
            '<div class="rank-track"><div class="rank-fill" style="width:' + ((c.places.length / max) * 100).toFixed(1) + '%"></div></div>' +
            '<div class="rank-count">' + c.places.length + "</div></div>";
        }).join("") + "</div>" +

        "<h2>Extreme points</h2>" +
        '<div class="facts">' +
          fact("Northernmost", north, coord(north.lat, "N", "S")) +
          fact("Southernmost", south, coord(south.lat, "N", "S")) +
          fact("Easternmost", east, coord(east.lon, "E", "W")) +
          fact("Westernmost", west, coord(west.lon, "E", "W")) +
          fact("Farthest from " + HOME.name, farthest, DT.formatNumber(dist(farthest)) + " km as the crow flies") +
        "</div>" +

        "<h2>All places</h2>" +
        '<div class="panel tree">' + countryList.map(countryBlock).join("") + "</div>" +
      "</div>";
  }

  DT.views.stats = {
    show: function (el) {
      if (!rendered) { render(el); rendered = true; }
    },
  };
})();
