// Core: data loading, hash router (#/globe, #/stats, #/about) and shared helpers.
// Views (globe.js, stats.js, about.js) register themselves on DT.views.

var DT = (function () {
  "use strict";

  var ROUTES = ["globe", "stats", "about"];
  var DEFAULT_ROUTE = "globe";

  var DT = {
    views: {},
    data: null, // { places: [...], status: {...} }
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  };

  // ---------------------------------------------------------------- helpers

  DT.$ = function (sel, root) { return (root || document).querySelector(sel); };

  DT.escape = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };

  // SVG flag (flag-icons). Emoji flags are avoided: Windows shows letters instead.
  DT.flag = function (iso2) {
    if (!iso2 || !/^[A-Za-z]{2}$/.test(iso2)) return '<span class="flag flag-none" aria-hidden="true"></span>';
    return '<span class="flag fi fi-' + iso2.toLowerCase() + '" aria-hidden="true"></span>';
  };

  // The flag of the most specific unit: a territory's own flag (e.g. Gibraltar), else the country's.
  DT.placeFlag = function (p) { return DT.flag(p.territory_iso2 || p.country_iso2); };

  DT.haversineKm = function (lat1, lon1, lat2, lon2) {
    var R = 6371.0088, rad = Math.PI / 180;
    var dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  };

  DT.formatNumber = function (n) { return Math.round(n).toLocaleString("en-GB"); };

  DT.formatDate = function (iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d)) return "—";
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) +
      ", " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  };

  // localStorage can throw (private mode, blocked cookies in iframes): never let it break the page.
  DT.store = {
    get: function (key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } },
    set: function (key, value) { try { window.localStorage.setItem(key, value); } catch (e) { /* ignore */ } },
  };

  DT.placeById = function (id) {
    var list = DT.data ? DT.data.places : [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  };

  DT.placeLink = function (p) { return "#/globe?place=" + encodeURIComponent(p.id); };

  // ---------------------------------------------------------------- data

  function fetchJson(url) {
    return fetch(url, { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error(url + ": HTTP " + r.status);
      return r.json();
    });
  }

  function load() {
    showState("loading");
    return Promise.all([
      fetchJson("data/places.json"),
      fetchJson("data/sync_status.json").catch(function () { return {}; }),
    ]).then(function (res) {
      DT.data = { places: res[0].places || [], status: res[1] || {} };
      showState(null);
      route();
    }).catch(function (err) {
      console.error(err);
      showState("error");
    });
  }

  function showState(which) {
    DT.$("#state-loading").hidden = which !== "loading";
    DT.$("#state-error").hidden = which !== "error";
    if (which) ROUTES.forEach(function (r) { DT.$("#view-" + r).hidden = true; });
  }

  // ---------------------------------------------------------------- router

  function parseHash() {
    var h = location.hash.replace(/^#\/?/, "");
    var parts = h.split("?");
    var name = ROUTES.indexOf(parts[0]) >= 0 ? parts[0] : DEFAULT_ROUTE;
    var params = {};
    (parts[1] || "").split("&").forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf("=");
      var k = decodeURIComponent(i < 0 ? kv : kv.slice(0, i));
      params[k] = i < 0 ? "" : decodeURIComponent(kv.slice(i + 1));
    });
    return { name: name, params: params };
  }

  var current = null;

  function route() {
    if (!DT.data) return;
    var r = parseHash();
    ROUTES.forEach(function (name) {
      DT.$("#view-" + name).hidden = name !== r.name;
      var tab = DT.$('.tab[data-route="' + name + '"]');
      if (name === r.name) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    });
    if (current && current !== r.name && DT.views[current].hide) DT.views[current].hide();
    current = r.name;
    DT.views[r.name].show(DT.$("#view-" + r.name), r.params);
  }

  DT.start = function () {
    DT.$("#footer-version").textContent = "v" + APP_VERSION;
    DT.$("#retry").addEventListener("click", load);
    window.addEventListener("hashchange", route);
    load();
  };

  return DT;
})();
