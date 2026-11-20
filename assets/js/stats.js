// Stats view: summary cards, country ranking, extreme points, farthest place from home,
// trips (if any), and a collapsible country → subdivision / territory → places list.

(function () {
  "use strict";

  var HOME = DT.HOME;

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
  var EARTH_KM = 40075;   // equator
  var MOON_KM = 384400;   // average Earth–Moon distance

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

  // ---------------------------------------------------------------- trips

  function tripFact(label, t, extra) {
    return '<a class="fact" href="' + DT.tripLink(t) + '"><div class="fact-label">' + label + "</div>" +
      '<div class="fact-place"><span>' + DT.escape(t.name) + "</span></div>" +
      '<div class="fact-extra">' + extra + "</div></a>";
  }

  function plainFact(label, value, extra) {
    return '<div class="fact"><div class="fact-label">' + label + '</div><div class="fact-place"><span>' + value +
      '</span></div><div class="fact-extra">' + extra + "</div></div>";
  }

  function modeName(m) { return DT.MODES[m].icon + " " + DT.MODES[m].label; }

  function legs(n) { return n + (n === 1 ? " leg" : " legs"); }

  function best(list, fn) { return list.reduce(function (b, x) { return fn(x) > fn(b) ? x : b; }); }

  function tripRow(t) {
    return '<a class="trip-row" href="' + DT.tripLink(t) + '"><span class="trip-row-name">' + DT.escape(t.name) + "</span>" +
      '<span class="trip-row-year">' + (t.year != null ? DT.escape(t.year) : "") + "</span>" +
      '<span class="trip-row-modes">' + DT.modeIcons(t) + "</span>" +
      '<span class="trip-row-km">' + DT.formatNumber(DT.tripStats(t).onSite) + " km</span></a>";
  }

  function tripsSection(trips) {
    var rows = trips.map(function (t) { return { trip: t, stats: DT.tripStats(t) }; });
    // Distance by transport and CO2 use every km; trip sizes and records use the km on
    // the trips only, so the flights to get there don't make far trips look bigger.
    var totalKm = 0, onSiteKm = 0, byMode = {}, onSiteByMode = {}, onSiteLegsByMode = {}, legsByMode = {}, years = {};
    rows.forEach(function (r) {
      totalKm += r.stats.km;
      onSiteKm += r.stats.onSite;
      Object.keys(r.stats.byMode).forEach(function (m) { byMode[m] = (byMode[m] || 0) + r.stats.byMode[m]; });
      Object.keys(r.stats.onSiteByMode).forEach(function (m) { onSiteByMode[m] = (onSiteByMode[m] || 0) + r.stats.onSiteByMode[m]; });
      r.trip.legs.forEach(function (l) {
        legsByMode[l.mode] = (legsByMode[l.mode] || 0) + 1;
        if (!l.transfer) onSiteLegsByMode[l.mode] = (onSiteLegsByMode[l.mode] || 0) + 1;
      });
      if (r.trip.year != null) {
        var y = years[r.trip.year] = years[r.trip.year] || { year: r.trip.year, trips: 0, km: 0 };
        y.trips++;
        y.km += r.stats.onSite;
      }
    });
    var modes = DT.MODE_ORDER.filter(function (m) { return byMode[m] != null; });
    var onSiteModes = DT.MODE_ORDER.filter(function (m) { return onSiteByMode[m] != null; });
    var longestTrip = best(rows, function (r) { return r.stats.onSite; });
    var mostCountries = best(rows, function (r) { return r.stats.countries.length; });
    var longestLeg = best(rows, function (r) { return r.stats.longest.km; }).stats.longest;
    var longestLegTrip = best(rows, function (r) { return r.stats.longest.km; }).trip;
    var topKm = onSiteModes.length ? best(onSiteModes, function (m) { return onSiteByMode[m]; }) : null;
    var topLegs = onSiteModes.length ? best(onSiteModes, function (m) { return onSiteLegsByMode[m]; }) : null;

    var inTrip = {};
    trips.forEach(function (t) { t.stops.forEach(function (s) { if (!s.missing) inTrip[s.place_id] = true; }); });
    var covered = DT.data.places.filter(function (p) { return inTrip[p.id]; }).length;

    function share(km) { return totalKm ? (km / totalKm) * 100 : 0; }

    var co2Total = 0;
    var co2Rows = modes.map(function (m) {
      var kg = byMode[m] * DT.MODES[m].co2;
      co2Total += kg;
      return "<tr><td>" + modeName(m) + "</td><td>" + DT.formatNumber(byMode[m]) + " km</td><td>" + DT.formatNumber(kg) + " kg</td></tr>";
    }).join("");

    var yearList = Object.keys(years).map(function (k) { return years[k]; }).sort(function (a, b) { return b.year - a.year; });
    var maxYearKm = Math.max.apply(null, yearList.map(function (y) { return y.km; }).concat([1]));

    return "<h2>Trips</h2>" +
      '<div class="cards">' +
        card(trips.length, trips.length === 1 ? "Trip" : "Trips") +
        card(DT.formatNumber(onSiteKm), "km on the trips") +
        card(DT.formatNumber(totalKm - onSiteKm), "km getting there and back") +
        card((totalKm / EARTH_KM).toFixed(2), "times around the Earth, all km") +
        percentCard(Math.min(100, (totalKm / MOON_KM) * 100), "of the way to the Moon") +
        percentCard(DT.data.places.length ? (covered / DT.data.places.length) * 100 : 0,
          "of the places are part of a trip (" + covered + ")") +
      "</div>" +

      '<h3 class="sub">Distance by transport (all km)</h3>' +
      '<div class="panel pad">' +
        '<div class="share-bar" aria-hidden="true">' + modes.map(function (m) {
          return '<span class="share-' + m + '" style="width:' + share(byMode[m]).toFixed(2) + '%"></span>';
        }).join("") + "</div>" +
        '<ul class="share-legend">' + modes.map(function (m) {
          return '<li><span class="share-dot share-' + m + '"></span><span>' + modeName(m) + '</span><span class="muted">' +
            DT.formatNumber(byMode[m]) + " km · " + share(byMode[m]).toFixed(0) + "% · " + legs(legsByMode[m]) + "</span></li>";
        }).join("") + "</ul></div>" +

      '<h3 class="sub">Records</h3>' +
      '<div class="facts">' +
        tripFact("Longest trip", longestTrip.trip, DT.formatNumber(longestTrip.stats.onSite) + " km on the trip") +
        tripFact("Most countries", mostCountries.trip, mostCountries.stats.countries.length + (mostCountries.stats.countries.length === 1 ? " country" : " countries")) +
        tripFact("Longest single leg", longestLegTrip, DT.escape(longestLeg.from.name) + " → " + DT.escape(longestLeg.to.name) +
          " · " + modeName(longestLeg.mode) + " · " + DT.formatNumber(longestLeg.km) + " km") +
        (topKm ? plainFact("Most used on the trips, by distance", modeName(topKm), DT.formatNumber(onSiteByMode[topKm]) + " km") +
          plainFact("Most used on the trips, by legs", modeName(topLegs), legs(onSiteLegsByMode[topLegs])) : "") +
      "</div>" +

      (yearList.length ? '<h3 class="sub">By year (km on the trips)</h3><div class="panel ranking">' + yearList.map(function (y) {
        return '<div class="rank-row year-row"><div class="rank-name"><span>' + DT.escape(y.year) + "</span></div>" +
          '<div class="rank-track"><div class="rank-fill" style="width:' + ((y.km / maxYearKm) * 100).toFixed(1) + '%"></div></div>' +
          '<div class="rank-count">' + y.trips + (y.trips === 1 ? " trip" : " trips") + " · " + DT.formatNumber(y.km) + " km</div></div>";
      }).join("") + "</div>" : "") +

      '<h3 class="sub">Estimated CO₂</h3>' +
      '<div class="panel pad"><table class="co2"><thead><tr><th>Transport</th><th>Distance</th><th>CO₂e</th></tr></thead><tbody>' +
        co2Rows + "</tbody><tfoot><tr><td>Total</td><td>" + DT.formatNumber(totalKm) + " km</td><td>" +
        DT.formatNumber(co2Total) + " kg</td></tr></tfoot></table>" +
        '<p class="footnote muted">A rough estimate: straight-line distances times average factors per passenger-km from the ' +
        DT.escape(DT.CO2_SOURCE) + ". The car counts the whole car (as if travelling alone); flights include the extra " +
        "effect of emissions at high altitude.</p></div>" +

      '<h3 class="sub">All trips</h3>' +
      '<div class="panel trip-table">' + DT.sortTrips(trips).map(tripRow).join("") + "</div>";
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

        '<div id="stats-trips">' + (DT.data.trips.length ? tripsSection(DT.data.trips) : "") + "</div>" +

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
