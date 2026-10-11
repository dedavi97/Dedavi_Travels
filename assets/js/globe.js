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
  };
  var START_CENTER = [12, 46];        // Europe
  var ROTATE_DEG_PER_SEC = 2.5;       // gentle auto-rotation speed
  var CLUSTER_MAX_ZOOM = 5;           // above this zoom every pin is shown on its own
  var CLUSTER_RADIUS = 26;            // px: smaller = groups split sooner while zooming in
  var PLACE_ZOOM = 6.5;               // zoom used when flying to a single place
  var PROJECTION_KEY = "dt.projection";

  var map = null;
  var loaded = false;
  var onLoad = [];
  var projection = "globe";
  var rotating = false;
  var visible = false;
  var popup = null;
  var tooltip, toggleBtn;

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

  function buildStyle() {
    var isVisited = ["in", ["get", "id"], ["literal", visitedUnits()]];
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
          paint: { "fill-color": ["case", isVisited, byTone(COLORS.visited), byTone(COLORS.land)] } },
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
        { id: "land-hover", type: "fill", source: "countries", filter: ["==", ["get", "id"], ""],
          paint: { "fill-color": "#ffffff", "fill-opacity": 0.07 } },
        { id: "subdivisions", type: "line", source: "subdivisions",
          paint: {
            "line-color": "#ffffff",
            "line-opacity": ["interpolate", ["linear"], ["zoom"], 1, 0.06, 4, 0.14, 7, 0.22],
            "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.3, 6, 0.7],
          } },
        { id: "borders", type: "line", source: "countries",
          paint: {
            "line-color": ["case", isVisited, COLORS.visitedBorder, COLORS.border],
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

  function showTooltip(point, name) {
    tooltip.textContent = name;
    tooltip.style.left = point.x + "px";
    tooltip.style.top = point.y + "px";
    tooltip.hidden = false;
  }

  function hideTooltip() {
    tooltip.hidden = true;
    if (map) map.setFilter("land-hover", ["==", ["get", "id"], ""]);
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
    if (DT.reducedMotion) { map.setProjection(projectionSpec(name)); return; }

    var el = map.getContainer();
    el.classList.add("is-fading");
    setTimeout(function () {
      if (projection !== name) return; // toggled again mid-fade
      map.setProjection(projectionSpec(name));
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
    toggleBtn = DT.$("#projection-toggle");
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

    // Country name on hover (desktop) or tap (touch).
    function countryAt(e) {
      if (map.queryRenderedFeatures(e.point, { layers: ["pins"] }).length) return null;
      var f = map.queryRenderedFeatures(e.point, { layers: ["land"] })[0];
      return f ? f.properties : null;
    }
    map.on("mousemove", function (e) {
      var c = countryAt(e);
      if (!c) { hideTooltip(); return; }
      map.setFilter("land-hover", ["==", ["get", "id"], c.id]);
      showTooltip(e.point, c.name);
    });
    map.on("click", function (e) {
      var c = countryAt(e);
      if (c) showTooltip(e.point, c.name); else hideTooltip();
    });
    map.on("mouseout", hideTooltip);
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
      if (params.place) flyToPlace(params.place);
    },
    hide: function () {
      visible = false;
      if (tooltip) hideTooltip();
    },
  };
})();
