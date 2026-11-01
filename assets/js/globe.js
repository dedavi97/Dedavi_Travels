// Globe / flat map view (MapLibre GL JS). No basemap, no API keys: the style is
// built here from the local Natural Earth file data/geo/countries.geojson.

(function () {
  "use strict";

  var COLORS = {
    ocean: "#0c1426",
    land: ["#242b3b", "#272e3f", "#222939", "#292f40"],      // by country "tone" (0-3)
    visited: ["#7d6230", "#83672f", "#775d2d", "#86693a"],
    lake: "#0f1a30",
    river: "#20304f",
    border: "#3a4256",
    visitedBorder: "#a9843f",
    pin: "#f2b544",
    pinStroke: "#fff6e0",
    exploreVisited: "#b98f3c",  // brighter than "visited", still darker than the pins
    exploreLine: "#ffffff",
  };
  var START_CENTER = [12, 46];        // Europe
  var ROTATE_DEG_PER_SEC = 2.5;       // gentle auto-rotation speed
  var CLUSTER_MAX_ZOOM = 5;           // above this zoom every pin is shown on its own
  var CLUSTER_RADIUS = 26;            // px: smaller = groups split sooner while zooming in
  var PLACE_ZOOM = 6.5;               // zoom used when flying to a single place
  var PROJECTION_KEY = "dt.projection";
  var EXPLORE_DIM = 0.35;             // opacity of the other countries in Explore mode
  var EXPLORE_MAX_ZOOM = 9;
  var NO_HOVER = ["==", ["get", "id"], ""];

  var map = null;
  var loaded = false;
  var onLoad = [];
  var projection = "globe";
  var rotating = false;
  var visible = false;
  var popup = null;
  var tooltip, tooltipName, tooltipBtn, toggleBtn, backBtn, notice;
  var tooltipPinned = false;

  var exploring = null;      // ADM0_A3 of the explored country
  var exploreRequest = null; // the country being loaded (the latest request wins)
  var savedCamera = null;    // camera to restore on "World"
  var areaFiles = {};        // loaded data/geo/adm1/<unit>.json files
  var noticeTimer = null;

  // ---------------------------------------------------------------- style

  function graticule() {
    var features = [], lon, lat, line;
    for (lon = -180; lon < 180; lon += 20) {
      line = [];
      for (lat = -80; lat <= 80; lat += 4) line.push([lon, lat]);
      features.push({ type: "Feature", geometry: { type: "LineString", coordinates: line } });
    }
    for (lat = -60; lat <= 60; lat += 20) {
      line = [];
      for (lon = -180; lon <= 180; lon += 4) line.push([lon, lat]);
      features.push({ type: "Feature", geometry: { type: "LineString", coordinates: line } });
    }
    return { type: "FeatureCollection", features: features };
  }

  function placesGeoJson() {
    return {
      type: "FeatureCollection",
      features: DT.data.places.map(function (p) {
        return { type: "Feature", properties: { id: p.id }, geometry: { type: "Point", coordinates: [p.lon, p.lat] } };
      }),
    };
  }

  // Natural Earth units visited (Gibraltar, Monaco... light up on their own).
  function visitedUnits() {
    var seen = {};
    DT.data.places.forEach(function (p) { if (p.unit) seen[p.unit] = true; });
    return Object.keys(seen);
  }

  function projectionSpec(name) { return { type: name === "globe" ? "globe" : "mercator" }; }

  function byTone(colors) {
    return ["match", ["get", "tone"], 1, colors[1], 2, colors[2], 3, colors[3], colors[0]];
  }

  function isVisited() { return ["in", ["get", "id"], ["literal", visitedUnits()]]; }

  function landColor() { return ["case", isVisited(), byTone(COLORS.visited), byTone(COLORS.land)]; }

  function borderColor() { return ["case", isVisited(), COLORS.visitedBorder, COLORS.border]; }

  function buildStyle() {
    return {
      version: 8,
      projection: projectionSpec(projection),
      sky: {
        "sky-color": "#0a0f1d",
        "horizon-color": "#1b2a4a",
        "fog-color": "#0a0f1d",
        "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 0.55, 4, 0.3, 7, 0],
      },
      sources: {
        countries: { type: "geojson", data: "data/geo/countries.geojson" },
        subdivisions: { type: "geojson", data: "data/geo/subdivisions.geojson" },
        water: { type: "geojson", data: "data/geo/water.geojson" },
        graticule: { type: "geojson", data: graticule() },
        places: {
          type: "geojson",
          data: placesGeoJson(),
          cluster: true,
          clusterRadius: CLUSTER_RADIUS,
          clusterMaxZoom: CLUSTER_MAX_ZOOM,
        },
      },
      layers: [
        { id: "ocean", type: "background", paint: { "background-color": COLORS.ocean } },
        { id: "graticule", type: "line", source: "graticule",
          paint: { "line-color": "#ffffff", "line-opacity": 0.045, "line-width": 0.6 } },
        { id: "land", type: "fill", source: "countries",
          paint: { "fill-color": landColor() } },
        { id: "lakes", type: "fill", source: "water", filter: ["==", ["get", "kind"], "lake"],
          paint: { "fill-color": COLORS.lake } },
        { id: "rivers", type: "line", source: "water",
          filter: ["all", ["==", ["get", "kind"], "river"], ["<=", ["get", "rank"], ["+", ["zoom"], 2]]],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": COLORS.river,
            "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.4, 6, 1.2],
            "line-opacity": ["interpolate", ["linear"], ["zoom"], 1, 0.5, 5, 0.9],
          } },
        { id: "land-hover", type: "fill", source: "countries", filter: NO_HOVER,
          paint: { "fill-color": "#ffffff", "fill-opacity": 0.07 } },
        { id: "subdivisions", type: "line", source: "subdivisions",
          paint: {
            "line-color": "#ffffff",
            "line-opacity": ["interpolate", ["linear"], ["zoom"], 1, 0.06, 4, 0.14, 7, 0.22],
            "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.3, 6, 0.7],
          } },
        { id: "borders", type: "line", source: "countries",
          paint: {
            "line-color": borderColor(),
            "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.4, 6, 1],
          } },
        { id: "pins", type: "circle", source: "places", filter: ["!", ["has", "point_count"]],
          paint: {
            "circle-color": COLORS.pin,
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 4, 10, 7],
            "circle-stroke-color": COLORS.pinStroke,
            "circle-stroke-width": 1.5,
            "circle-pitch-alignment": "map",
          } },
      ],
    };
  }

  // ---------------------------------------------------------------- clusters
  // Cluster bubbles are HTML markers so their counts need no font server.

  var clusterMarkers = {};
  var clustersOnScreen = {};

  function clusterSize(count) { return count < 10 ? 28 : count < 50 ? 34 : 42; }

  function updateClusters() {
    var next = {};
    map.querySourceFeatures("places").forEach(function (f) {
      var props = f.properties;
      if (!props.cluster) return;
      var id = props.cluster_id;
      if (next[id]) return;
      var marker = clusterMarkers[id];
      if (!marker) {
        var el = document.createElement("button");
        var size = clusterSize(props.point_count);
        el.type = "button";
        el.className = "cluster";
        el.style.width = el.style.height = size + "px";
        el.textContent = props.point_count;
        el.setAttribute("aria-label", props.point_count + " places, zoom in");
        var lngLat = f.geometry.coordinates;
        el.addEventListener("click", function (ev) {
          ev.stopPropagation();
          stopRotation();
          map.getSource("places").getClusterExpansionZoom(id).then(function (zoom) {
            var opts = { center: lngLat, zoom: Math.min(zoom + 0.3, PLACE_ZOOM) };
            if (DT.reducedMotion) map.jumpTo(opts); else map.easeTo(opts);
          });
        });
        marker = clusterMarkers[id] = new maplibregl.Marker({ element: el, opacityWhenCovered: "0" }).setLngLat(lngLat);
      }
      next[id] = marker;
      if (!clustersOnScreen[id]) marker.addTo(map);
    });
    Object.keys(clustersOnScreen).forEach(function (id) {
      if (!next[id]) clustersOnScreen[id].remove();
    });
    clustersOnScreen = next;
  }

  // ---------------------------------------------------------------- popup & tooltip

  function popupHtml(p) {
    var where = p.territory
      ? DT.escape(p.territory) + ", " + DT.escape(p.country)
      : DT.escape(p.country || "Unknown") + (p.subdivision ? " · " + DT.escape(p.subdivision) : "");
    return '<div class="popup-title">' + DT.escape(p.name) + "</div>" +
      '<div class="popup-sub">' + DT.placeFlag(p) + "<span>" + where + "</span></div>";
  }

  function openPopup(p) {
    if (popup) popup.remove();
    popup = new maplibregl.Popup({ offset: 10, maxWidth: "260px", focusAfterOpen: false })
      .setLngLat([p.lon, p.lat])
      .setHTML(popupHtml(p))
      .addTo(map);
  }

  // exploreUnit: show the Explore button (the tooltip then stays put so it can be pressed).
  function showTooltip(point, name, exploreUnit) {
    tooltipName.textContent = name;
    tooltipPinned = !!exploreUnit;
    tooltip.classList.toggle("is-pinned", tooltipPinned);
    tooltipBtn.hidden = !exploreUnit;
    tooltipBtn.dataset.unit = exploreUnit || "";
    tooltip.hidden = false;
    // Keep it inside the map, the button above all.
    var box = tooltip.parentNode, w = tooltip.offsetWidth, h = tooltip.offsetHeight;
    tooltip.style.left = Math.max(0, Math.min(point.x, box.clientWidth - w - 20)) + "px";
    tooltip.style.top = Math.max(h / 2 + 4, Math.min(point.y, box.clientHeight - h / 2 - 4)) + "px";
  }

  function hideTooltip() {
    tooltip.hidden = true;
    tooltipPinned = false;
    if (map && loaded) {
      map.setFilter("land-hover", NO_HOVER);
      if (map.getLayer("explore-hover")) map.setFilter("explore-hover", NO_HOVER);
    }
  }

  function showNotice(text) {
    clearTimeout(noticeTimer);
    notice.textContent = text;
    notice.hidden = false;
    if (text) noticeTimer = setTimeout(hideNotice, 4000);
  }

  function hideNotice() {
    clearTimeout(noticeTimer);
    notice.hidden = true;
  }

  // ---------------------------------------------------------------- explore mode
  // A visited country filled with its first-level areas: the ones with a pin are lit.

  function isVisitedUnit(unit) { return visitedUnits().indexOf(unit) >= 0; }

  function loadAreas(unit) {
    if (areaFiles[unit]) return Promise.resolve(areaFiles[unit]);
    return fetch("data/geo/adm1/" + unit + ".json", { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error(unit + ": HTTP " + r.status);
      return r.json();
    }).then(function (data) {
      areaFiles[unit] = data;
      return data;
    });
  }

  function placesIn(unit) { return DT.data.places.filter(function (p) { return p.unit === unit; }); }

  // Countries can have far-away parts (French Guiana, Alaska, Hawaii): frame only the
  // parts with a pin. Pins just off a part (coastal snap) go with the nearest one.
  function exploreBounds(unit) {
    var parts = areaFiles[unit].parts;
    var chosen = {};
    placesIn(unit).forEach(function (p) {
      var best = -1, bestDist = Infinity;
      parts.forEach(function (b, i) {
        var dx = Math.max(b[0] - p.lon, 0, p.lon - b[2]);
        var dy = Math.max(b[1] - p.lat, 0, p.lat - b[3]);
        var dist = dx * dx + dy * dy;
        if (dist === 0) chosen[i] = true;
        if (dist < bestDist) { best = i; bestDist = dist; }
      });
      if (best >= 0) chosen[best] = true;
    });
    var picked = parts.filter(function (b, i) { return chosen[i]; });
    if (!picked.length) picked = parts;
    var west = Math.min.apply(null, picked.map(function (b) { return b[0]; }));
    var east = Math.max.apply(null, picked.map(function (b) { return b[2]; }));
    // Parts on both sides of the antimeridian: go the short way round.
    if (east - west > 180) {
      var lefts = picked.map(function (b) { return b[0] < 0 ? b[0] + 360 : b[0]; });
      var rights = picked.map(function (b) { return b[2] < 0 ? b[2] + 360 : b[2]; });
      west = Math.min.apply(null, lefts);
      east = Math.max.apply(null, rights);
    }
    return [
      [west, Math.min.apply(null, picked.map(function (b) { return b[1]; }))],
      [east, Math.max.apply(null, picked.map(function (b) { return b[3]; }))],
    ];
  }

  function fitExplore(animate) {
    var narrow = map.getContainer().clientWidth < 500;
    map.fitBounds(exploreBounds(exploring), {
      padding: narrow ? { top: 60, bottom: 30, left: 20, right: 20 } : { top: 70, bottom: 50, left: 60, right: 60 },
      maxZoom: EXPLORE_MAX_ZOOM,
      duration: animate && !DT.reducedMotion ? 1400 : 0,
    });
  }

  function applyExploreStyle(unit) {
    var isExplored = ["==", ["get", "id"], unit];
    // The explored country is drawn by its areas alone: its coarser world shape would
    // leave a second, mismatched coastline.
    map.setPaintProperty("land", "fill-opacity", ["case", isExplored, 0, EXPLORE_DIM]);
    map.setPaintProperty("borders", "line-opacity", ["case", isExplored, 0, EXPLORE_DIM]);
    map.setLayoutProperty("subdivisions", "visibility", "none");

    var lit = {};
    placesIn(unit).forEach(function (p) { if (p.adm1) lit[p.adm1] = true; });
    var source = map.getSource("explore-areas");
    if (source) {
      source.setData(areaFiles[unit]);
    } else {
      map.addSource("explore-areas", { type: "geojson", data: areaFiles[unit] });
      map.addLayer({ id: "explore-fill", type: "fill", source: "explore-areas", paint: {} }, "lakes");
      map.addLayer({ id: "explore-hover", type: "fill", source: "explore-areas", filter: NO_HOVER,
        paint: { "fill-color": "#ffffff", "fill-opacity": 0.1 } }, "lakes");
      map.addLayer({ id: "explore-line", type: "line", source: "explore-areas",
        paint: {
          "line-color": COLORS.exploreLine,
          "line-opacity": 0.28,
          "line-width": ["interpolate", ["linear"], ["zoom"], 2, 0.4, 8, 1],
        } }, "borders");
    }
    map.setPaintProperty("explore-fill", "fill-color",
      ["case", ["in", ["get", "id"], ["literal", Object.keys(lit)]], COLORS.exploreVisited, byTone(COLORS.land)]);
  }

  function clearExploreStyle() {
    ["explore-line", "explore-hover", "explore-fill"].forEach(function (id) {
      if (map.getLayer(id)) map.removeLayer(id);
    });
    if (map.getSource("explore-areas")) map.removeSource("explore-areas");
    map.setPaintProperty("land", "fill-opacity", 1);
    map.setPaintProperty("borders", "line-opacity", 1);
    map.setLayoutProperty("subdivisions", "visibility", "visible");
  }

  function enterExplore(unit) {
    if (unit === exploring || unit === exploreRequest || !isVisitedUnit(unit)) return;
    exploreRequest = unit;
    whenLoaded(function () {
      if (exploreRequest !== unit) return; // left the globe before the map was ready
      stopRotation();
      hideTooltip();
      showNotice("Loading areas…");
      clearTimeout(noticeTimer);
      loadAreas(unit).then(function () {
        if (exploreRequest !== unit) return; // left or changed country while loading
        exploreRequest = null;
        hideNotice();
        if (!savedCamera) {
          savedCamera = { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
        }
        if (popup) popup.remove();
        exploring = unit;
        applyExploreStyle(unit);
        backBtn.hidden = false;
        fitExplore(true);
      }).catch(function (err) {
        console.error(err);
        if (exploreRequest !== unit) return;
        exploreRequest = null;
        showNotice("Couldn't load the areas of this country.");
        if (!exploring) location.hash = "#/globe"; // stay in world view
      });
    });
  }

  function exitExplore(animate) {
    if (exploreRequest) hideNotice(); // "Loading..." only: a load error must stay readable
    exploreRequest = null;
    if (!exploring) return;
    exploring = null;
    backBtn.hidden = true;
    hideTooltip();
    if (popup) popup.remove();
    clearExploreStyle();
    var camera = savedCamera;
    savedCamera = null;
    if (animate && !DT.reducedMotion) map.easeTo(Object.assign({ duration: 1000 }, camera));
    else map.jumpTo(camera);
  }

  function onKeyDown(e) {
    if (e.key === "Escape" && exploring && visible) location.hash = "#/globe";
  }

  // ---------------------------------------------------------------- rotation

  function startRotation() {
    if (DT.reducedMotion || projection !== "globe") return;
    rotating = true;
    var last = null;
    function frame(ts) {
      if (!rotating) return;
      if (last !== null && visible) {
        var c = map.getCenter();
        c.lng -= ((ts - last) / 1000) * ROTATE_DEG_PER_SEC;
        map.setCenter(c);
      }
      last = ts;
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function stopRotation() { rotating = false; }

  // ---------------------------------------------------------------- projection toggle

  var ICON_GLOBE = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.8 3 2.8 15 0 18M12 3c-2.8 3-2.8 15 0 18"/></svg>';
  var ICON_FLAT = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 12h18M9 5v14M15 5v14"/></svg>';

  function updateToggle() {
    toggleBtn.innerHTML = projection === "globe" ? ICON_FLAT + "<span>Flat map</span>" : ICON_GLOBE + "<span>Globe</span>";
    toggleBtn.setAttribute("aria-label", projection === "globe" ? "Switch to flat map" : "Switch to globe");
  }

  // Crossfade between globe and flat map (MapLibre only morphs projections while zooming).
  var FADE_MS = 220;

  function setProjection(name) {
    projection = name;
    DT.store.set(PROJECTION_KEY, name);
    updateToggle();
    if (name !== "globe") stopRotation();
    hideTooltip();
    if (DT.reducedMotion) {
      map.setProjection(projectionSpec(name));
      if (exploring) fitExplore(false);
      return;
    }

    var el = map.getContainer();
    el.classList.add("is-fading");
    setTimeout(function () {
      if (projection !== name) return; // toggled again mid-fade
      map.setProjection(projectionSpec(name));
      if (exploring) fitExplore(false);
      requestAnimationFrame(function () { requestAnimationFrame(function () { el.classList.remove("is-fading"); }); });
    }, FADE_MS);
  }

  // ---------------------------------------------------------------- init

  function startZoom(el) {
    // Flat map: show roughly the whole world width.
    return Math.max(0, Math.log2((el.clientWidth || 512) / 512) + 0.3);
  }

  // Globe: zoom so the globe fills ~90% of the smaller side. The globe's on-screen size
  // depends on latitude and zoom in a non-trivial way, so measure it: the two equator
  // points 90 degrees east and west of the centre sit on the globe's visible edge.
  // One correction per rendered frame: projections are only refreshed on render.
  function fitGlobe(done, step) {
    step = step || 0;
    if (projection !== "globe") { done(); return; }
    var el = map.getContainer();
    var target = 0.9 * Math.min(el.clientWidth, el.clientHeight);
    var lng = map.getCenter().lng;
    var a = map.project([lng - 90, 0]), b = map.project([lng + 90, 0]);
    var d = Math.hypot(a.x - b.x, a.y - b.y);
    var dz = d && isFinite(d) ? Math.log2(target / d) : 0;
    if (Math.abs(dz) < 0.01 || step >= 8) { done(); return; }
    map.once("render", function () { fitGlobe(done, step + 1); });
    map.setZoom(map.getZoom() + dz);
  }

  function whenLoaded(fn) { if (loaded) fn(); else onLoad.push(fn); }

  function init(container) {
    tooltip = DT.$("#map-tooltip");
    tooltipName = DT.$("#map-tooltip-name");
    tooltipBtn = DT.$("#map-tooltip-explore");
    toggleBtn = DT.$("#projection-toggle");
    backBtn = DT.$("#explore-back");
    notice = DT.$("#map-notice");
    tooltipBtn.addEventListener("click", function () {
      location.hash = "#/globe?explore=" + encodeURIComponent(tooltipBtn.dataset.unit);
    });
    backBtn.addEventListener("click", function () { location.hash = "#/globe"; });
    document.addEventListener("keydown", onKeyDown);
    projection = DT.store.get(PROJECTION_KEY) === "mercator" ? "mercator" : "globe";
    updateToggle();

    var el = DT.$("#map");
    map = new maplibregl.Map({
      container: el,
      style: buildStyle(),
      center: START_CENTER,
      zoom: startZoom(el),
      minZoom: 0,
      maxZoom: 9,  // the simplified borders look blocky beyond this
      maxPitch: 0,
      dragRotate: false,
      touchPitch: false,
      attributionControl: false,
      fadeDuration: 0,
    });
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-left");
    map.addControl(new maplibregl.AttributionControl({
      compact: true,
      customAttribution: '<a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth</a> · ' +
        'Names © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    }), "bottom-right");

    toggleBtn.addEventListener("click", function () {
      setProjection(projection === "globe" ? "mercator" : "globe");
    });

    // Any user interaction stops the auto-rotation for good.
    ["mousedown", "touchstart", "wheel", "dragstart"].forEach(function (ev) {
      map.on(ev, stopRotation);
    });

    map.on("load", function () {
      fitGlobe(function () {
        loaded = true;
        startRotation();
        onLoad.splice(0).forEach(function (fn) { fn(); });
      });
    });
    map.on("render", function () {
      if (map.getSource("places") && map.isSourceLoaded("places")) updateClusters();
    });

    map.on("click", "pins", function (e) {
      stopRotation();
      var p = DT.placeById(e.features[0].properties.id);
      if (p) openPopup(p);
    });
    map.on("mouseenter", "pins", function () { map.getCanvas().style.cursor = "pointer"; hideTooltip(); });
    map.on("mouseleave", "pins", function () { map.getCanvas().style.cursor = ""; });

    // What is under the pointer: nothing over a pin, else an Explore area, else a country.
    function featureAt(e) {
      if (map.queryRenderedFeatures(e.point, { layers: ["pins"] }).length) return null;
      if (exploring) {
        var a = map.queryRenderedFeatures(e.point, { layers: ["explore-fill"] })[0];
        if (a) return { area: true, id: a.properties.id, name: a.properties.name };
      }
      var f = map.queryRenderedFeatures(e.point, { layers: ["land"] })[0];
      return f ? { area: false, id: f.properties.id, name: f.properties.name } : null;
    }
    function highlight(f) {
      map.setFilter("land-hover", f.area ? NO_HOVER : ["==", ["get", "id"], f.id]);
      if (map.getLayer("explore-hover")) map.setFilter("explore-hover", f.area ? ["==", ["get", "id"], f.id] : NO_HOVER);
    }
    // Hover: name only. A click on a visited country also offers Explore: entering
    // only from that button avoids accidental entries while moving the globe.
    map.on("mousemove", function (e) {
      if (tooltipPinned) return;
      var f = featureAt(e);
      if (!f) { hideTooltip(); return; }
      highlight(f);
      showTooltip(e.point, f.name);
    });
    map.on("click", function (e) {
      var f = featureAt(e);
      if (!f) { hideTooltip(); return; }
      highlight(f);
      showTooltip(e.point, f.name, !f.area && f.id !== exploring && isVisitedUnit(f.id) ? f.id : null);
    });
    map.on("mouseout", function () { if (!tooltipPinned) hideTooltip(); });
    map.on("movestart", function () { if (!tooltip.hidden) hideTooltip(); });
  }

  function flyToPlace(id) {
    var p = DT.placeById(id);
    if (!p) return;
    whenLoaded(function () {
      stopRotation();
      if (popup) popup.remove();
      var opts = { center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), PLACE_ZOOM) };
      map.once("moveend", function () { openPopup(p); });
      if (DT.reducedMotion) map.jumpTo(opts);
      else map.flyTo(Object.assign(opts, { speed: 1.4, curve: 1.5 }));
    });
  }

  DT.views.globe = {
    show: function (container, params) {
      visible = true;
      if (!map) init(container);
      else map.resize();
      if (params.explore && isVisitedUnit(params.explore)) {
        enterExplore(params.explore);
      } else {
        exitExplore(!params.place);
        if (params.place) flyToPlace(params.place);
      }
    },
    hide: function () {
      visible = false;
      if (tooltip) hideTooltip();
      if (map) exitExplore(false);
    },
  };
})();
