// Trips (itineraries from data/itineraries.json): shared helpers, per-trip stats and
// the animated route drawn on a MapLibre map (globe Trips mode and the editor preview).
// The hidden editor (#/trips-editor) lives in trips-editor.js, loaded only when opened.

(function () {
  "use strict";

  // Kilograms of CO2e per passenger-km, from one source: UK Government (DESNZ)
  // "Greenhouse gas reporting: conversion factors 2025", flat file, Business travel:
  //   train = Rail, National rail                               0.03546
  //   car   = Cars (by size), Average car, Unknown fuel, per km 0.16725 (whole car: as if alone)
  //   plane = Flights, International to/from non-UK, Average passenger, With RF  0.14253
  //   ferry = Ferry, Average (all passenger)                    0.1127
  //   bus   = Bus, Coach                                        0.02776
  // https://www.gov.uk/government/publications/greenhouse-gas-reporting-conversion-factors-2025
  DT.CO2_SOURCE = "UK Government GHG conversion factors 2025 (DESNZ)";
  var MODES = {
    train: { icon: "🚆", label: "Train", co2: 0.03546 },
    car: { icon: "🚗", label: "Car", co2: 0.16725 },
    plane: { icon: "✈️", label: "Plane", co2: 0.14253 },
    ferry: { icon: "⛴️", label: "Ferry", co2: 0.1127 },
    bus: { icon: "🚌", label: "Bus", co2: 0.02776 },
  };
  DT.MODE_ORDER = ["train", "car", "plane", "ferry", "bus"];
  DT.MODES = MODES;

  // Line look per mode. Dash lengths are in line widths (MapLibre).
  var LINE = {
    train: { color: "#f2b544", dash: null },
    car: { color: "#f2b544", dash: [2.4, 1.6] },
    plane: { color: "#f8d999", dash: [0.1, 1.9], opacity: 0.9 },
    ferry: { color: "#f2b544", dash: [5, 2.5] },
    bus: { color: "#f2b544", dash: [1.2, 1.2] },
  };
  var LINE_WIDTH = 2.6;

  // ---------------------------------------------------------------- data

  function isNum(v) { return typeof v === "number" && isFinite(v); }

  // Keep only well-formed trips: a broken hand-uploaded file must never break the site.
  DT.validTrips = function (json) {
    if (!json || !Array.isArray(json.trips)) return [];
    return json.trips.filter(function (t) {
      return t && t.id && t.name && Array.isArray(t.stops) && t.stops.length >= 2 &&
        Array.isArray(t.legs) && t.legs.length === t.stops.length - 1 &&
        t.stops.every(function (s) { return s && isNum(s.lat) && isNum(s.lon); }) &&
        t.legs.every(function (l) { return l && MODES[l.mode]; });
    });
  };

  DT.sortTrips = function (trips) {
    return trips.slice().sort(function (a, b) {
      var ya = isNum(a.year) ? a.year : -Infinity, yb = isNum(b.year) ? b.year : -Infinity;
      return (yb - ya) || String(a.name).localeCompare(String(b.name), "en");
    });
  };

  DT.tripById = function (id) {
    var list = DT.data ? DT.data.trips : [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  };

  DT.tripLink = function (t) { return "#/globe?trip=" + encodeURIComponent(t.id); };

  DT.tripsWithPlace = function (placeId) {
    return DT.sortTrips((DT.data ? DT.data.trips : []).filter(function (t) {
      return t.stops.some(function (s) { return s.place_id === placeId && !s.missing; });
    }));
  };

  // Country of a stop: stored in the stop (so it survives pin changes), else from its pin.
  function stopCountry(s) {
    var p = s.missing ? null : DT.placeById(s.place_id);
    var name = s.country || (p && p.country);
    return name ? { name: name, iso2: s.country_iso2 || (p && p.country_iso2) } : null;
  }

  function stopKey(s) { return s.place_id || s.lat.toFixed(4) + "," + s.lon.toFixed(4); }

  DT.tripStats = function (trip) {
    var byMode = {}, legs = [], km = 0;
    trip.legs.forEach(function (leg, i) {
      var a = trip.stops[i], b = trip.stops[i + 1];
      var d = DT.haversineKm(a.lat, a.lon, b.lat, b.lon);
      legs.push({ from: a, to: b, mode: leg.mode, km: d });
      byMode[leg.mode] = (byMode[leg.mode] || 0) + d;
      km += d;
    });
    var countries = {}, places = {};
    trip.stops.forEach(function (s) {
      var c = stopCountry(s);
      if (c && !countries[c.name]) countries[c.name] = c;
      places[stopKey(s)] = true;
    });
    var farthest = null;
    trip.stops.forEach(function (s) {
      var d = DT.haversineKm(DT.HOME.lat, DT.HOME.lon, s.lat, s.lon);
      if (!farthest || d > farthest.km) farthest = { stop: s, km: d };
    });
    var longest = legs.reduce(function (best, l) { return !best || l.km > best.km ? l : best; }, null);
    return {
      km: km,
      byMode: byMode,
      legs: legs,
      longest: longest,
      stops: Object.keys(places).length,
      countries: Object.keys(countries).map(function (k) { return countries[k]; }),
      farthest: farthest,
    };
  };

  // Stop positions with longitudes unwrapped so every leg goes the short way round.
  function unwrapped(stops) {
    var out = [];
    stops.forEach(function (s, i) {
      var lon = s.lon;
      if (i) {
        var prev = out[i - 1][0];
        while (lon - prev > 180) lon -= 360;
        while (lon - prev < -180) lon += 360;
      }
      out.push([lon, s.lat]);
    });
    return out;
  }

  DT.tripBounds = function (trip) {
    var pts = unwrapped(trip.stops);
    var lons = pts.map(function (p) { return p[0]; }), lats = pts.map(function (p) { return p[1]; });
    return [[Math.min.apply(null, lons), Math.min.apply(null, lats)], [Math.max.apply(null, lons), Math.max.apply(null, lats)]];
  };

  // ---------------------------------------------------------------- html pieces

  DT.modeIcons = function (trip) {
    var used = {};
    trip.legs.forEach(function (l) { used[l.mode] = true; });
    return DT.MODE_ORDER.filter(function (m) { return used[m]; }).map(function (m) {
      return '<span title="' + MODES[m].label + '">' + MODES[m].icon + "</span>";
    }).join("");
  };

  function legendSwatch(mode) {
    var l = LINE[mode], w = 2;
    var dash = l.dash ? ' stroke-dasharray="' + l.dash.map(function (d) { return Math.max(d * w, 0.1); }).join(" ") + '"' : "";
    return '<svg class="legend-line" viewBox="0 0 28 6" aria-hidden="true"><line x1="2" y1="3" x2="26" y2="3" stroke="' +
      l.color + '" stroke-width="' + w + '" stroke-linecap="' + (mode === "plane" ? "round" : "butt") + '"' + dash + "/></svg>";
  }

  // Card body with the per-trip stats.
  DT.tripCardHtml = function (trip) {
    var s = DT.tripStats(trip);
    var modes = DT.MODE_ORDER.filter(function (m) { return s.byMode[m] != null; });
    var place = function (stop) { return DT.escape(stop.name); };
    return '<div class="trip-card-km"><strong>' + DT.formatNumber(s.km) + "</strong> km</div>" +
      '<ul class="trip-modes">' + modes.map(function (m) {
        return "<li>" + legendSwatch(m) + "<span>" + MODES[m].icon + " " + MODES[m].label + '</span><span class="muted">' +
          DT.formatNumber(s.byMode[m]) + " km</span></li>";
      }).join("") + "</ul>" +
      '<dl class="trip-facts">' +
        "<dt>Stops</dt><dd>" + s.stops + "</dd>" +
        "<dt>Countries</dt><dd>" + s.countries.length + "</dd>" +
        "<dt>Longest leg</dt><dd>" + place(s.longest.from) + " → " + place(s.longest.to) + ' <span class="muted">' + DT.formatNumber(s.longest.km) + " km</span></dd>" +
        "<dt>Farthest from " + DT.escape(DT.HOME.name) + "</dt><dd>" + place(s.farthest.stop) + ' <span class="muted">' + DT.formatNumber(s.farthest.km) + " km</span></dd>" +
      "</dl>" +
      '<p class="trip-note muted">Straight lines between stops, not the real roads or routes.</p>';
  };

  // ---------------------------------------------------------------- route on a map

  var ANIM_MIN_MS = 2000, ANIM_MAX_MS = 4000;

  // opts: { before: layer id to insert under, onStopClick(stop), onStopHover(stop or null, lngLat) }
  DT.TripRoute = function (map, opts) {
    this.map = map;
    this.opts = opts || {};
    this.markers = [];
    this.frame = null;
  };

  DT.TripRoute.prototype._ensureLayers = function () {
    var map = this.map, before = this.opts.before;
    if (map.getSource("trip-legs")) return;
    map.addSource("trip-legs", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    // Dark edge for contrast; not under the plane's dots, which would turn them into a dashed track.
    map.addLayer({ id: "trip-casing", type: "line", source: "trip-legs", filter: ["!=", ["get", "mode"], "plane"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#0a0f1d", "line-opacity": 0.55, "line-width": LINE_WIDTH + 3 } }, before);
    DT.MODE_ORDER.forEach(function (m) {
      var paint = { "line-color": LINE[m].color, "line-width": LINE_WIDTH, "line-opacity": LINE[m].opacity || 1 };
      if (LINE[m].dash) paint["line-dasharray"] = LINE[m].dash;
      map.addLayer({ id: "trip-line-" + m, type: "line", source: "trip-legs", filter: ["==", ["get", "mode"], m],
        layout: { "line-cap": m === "plane" ? "round" : "butt", "line-join": "round" }, paint: paint }, before);
    });
  };

  DT.TripRoute.prototype.clear = function () {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.markers.forEach(function (m) { m.marker.remove(); });
    this.markers = [];
    var map = this.map;
    ["trip-casing"].concat(DT.MODE_ORDER.map(function (m) { return "trip-line-" + m; })).forEach(function (id) {
      if (map.getLayer(id)) map.removeLayer(id);
    });
    if (map.getSource("trip-legs")) map.removeSource("trip-legs");
  };

  // Draws the trip; with animate the legs appear one by one, then onDone() is called.
  DT.TripRoute.prototype.draw = function (trip, animate, onDone) {
    var self = this, map = this.map;
    this.clear();
    this._ensureLayers();
    var pts = unwrapped(trip.stops);

    // One marker per distinct place, numbered with every visit ("1 · 8" for a round trip).
    var byKey = {};
    trip.stops.forEach(function (s, i) {
      var key = stopKey(s);
      if (!byKey[key]) {
        byKey[key] = { stop: s, nums: [], first: i };
        self.markers.push(byKey[key]);
      }
      byKey[key].nums.push(i + 1);
    });
    this.markers.forEach(function (m) {
      var el = document.createElement("button");
      el.type = "button";
      el.className = "trip-stop" + (m.stop.missing ? " is-missing" : "");
      el.textContent = m.nums.join(" · ");
      el.setAttribute("aria-label", "Stop " + m.nums.join(" and ") + ": " + m.stop.name + (m.stop.missing ? " (pin no longer on the map)" : ""));
      el.title = m.stop.name;
      el.addEventListener("click", function (ev) {
        ev.stopPropagation();
        if (self.opts.onStopClick) self.opts.onStopClick(m.stop);
      });
      if (self.opts.onStopHover) {
        el.addEventListener("mouseenter", function () { self.opts.onStopHover(m.stop, pts[m.first]); });
        el.addEventListener("mouseleave", function () { self.opts.onStopHover(null); });
      }
      m.el = el;
      m.marker = new maplibregl.Marker({ element: el }).setLngLat(pts[m.first]);
    });

    var legs = trip.legs.map(function (l, i) { return { mode: l.mode, a: pts[i], b: pts[i + 1] }; });
    function render(progressLegs) {
      var features = [];
      legs.forEach(function (l, i) {
        var f = Math.max(0, Math.min(1, progressLegs - i));
        if (f <= 0) return;
        var end = [l.a[0] + (l.b[0] - l.a[0]) * f, l.a[1] + (l.b[1] - l.a[1]) * f];
        features.push({ type: "Feature", properties: { mode: l.mode }, geometry: { type: "LineString", coordinates: [l.a, end] } });
      });
      map.getSource("trip-legs").setData({ type: "FeatureCollection", features: features });
      self.markers.forEach(function (m) {
        if (!m.shown && progressLegs >= m.first) { m.shown = true; m.marker.addTo(map); }
      });
    }

    if (!animate) {
      render(legs.length);
      if (onDone) onDone();
      return;
    }
    // Leg time grows with distance, but gently: short legs stay visible.
    var weights = legs.map(function (l) { return Math.sqrt(Math.max(DT.haversineKm(l.a[1], l.a[0], l.b[1], l.b[0]), 20)); });
    var total = weights.reduce(function (a, b) { return a + b; }, 0);
    var duration = Math.min(ANIM_MAX_MS, Math.max(ANIM_MIN_MS, 600 * legs.length));
    var start = null;
    render(0);
    function step(ts) {
      if (start === null) start = ts;
      var t = Math.min(1, (ts - start) / duration) * total;
      var p = 0;
      while (p < legs.length && t >= weights[p]) { t -= weights[p]; p++; }
      var progress = p < legs.length ? p + t / weights[p] : legs.length;
      render(progress);
      if (progress < legs.length) {
        self.frame = requestAnimationFrame(step);
      } else {
        self.frame = null;
        if (onDone) onDone();
      }
    }
    this.frame = requestAnimationFrame(step);
  };

  // ---------------------------------------------------------------- hidden editor (lazy)

  var editorPromise = null;

  function loadEditor() {
    if (!editorPromise) {
      editorPromise = new Promise(function (resolve, reject) {
        var s = document.createElement("script");
        s.src = "assets/js/trips-editor.js?v=" + encodeURIComponent(APP_VERSION);
        s.onload = resolve;
        s.onerror = function () { editorPromise = null; reject(new Error("trips-editor.js failed to load")); };
        document.head.appendChild(s);
      });
    }
    return editorPromise;
  }

  DT.views["trips-editor"] = {
    show: function (el, params) {
      loadEditor().then(function () { DT.tripsEditor.show(el, params); }).catch(function (err) {
        console.error(err);
        el.innerHTML = '<div class="page"><h1>Trips editor</h1><p>Couldn\'t load the editor. Check your connection and reload.</p></div>';
      });
    },
    hide: function () { if (DT.tripsEditor) DT.tripsEditor.hide(); },
  };
})();
