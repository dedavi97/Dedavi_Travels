// About view: what the site is, how it works, data freshness and credits.

(function () {
  "use strict";

  var rendered = false;

  function render(el) {
    var s = DT.data.status || {};
    var status = s.status === "error"
      ? '<span class="status-error">Last update failed</span>'
      : s.status === "ok" ? '<span class="status-ok">Working</span>' : "—";

    el.innerHTML =
      '<div class="page about">' +
        "<h1>About</h1>" +
        '<p class="lead">A map of every place I have visited.</p>' +

        "<h2>What it is</h2>" +
        "<p>Each pin is a place I have been to. Countries and territories I have visited are highlighted on the map, " +
        "and the Stats page counts them by country, region and continent.</p>" +

        "<h2>How it works</h2>" +
        "<p>I keep my travels on a Google My Maps map. Twice a month this site automatically reads the latest version " +
        "of that map, finds the English name of each place and works out which country and region it belongs to. " +
        "New pins appear here on their own: there is nothing to update by hand.</p>" +

        "<h2>Who made it</h2>" +
        '<p>Davide — <a href="https://github.com/dedavi97" target="_blank" rel="noopener">github.com/dedavi97</a></p>' +

        "<h2>Data</h2>" +
        '<div class="panel pad"><dl class="info-list">' +
          "<dt>Version</dt><dd>v" + DT.escape(APP_VERSION) + "</dd>" +
          "<dt>Places</dt><dd>" + DT.data.places.length + "</dd>" +
          "<dt>Last check</dt><dd>" + DT.formatDate(s.last_check) + "</dd>" +
          "<dt>Last change</dt><dd>" + DT.formatDate(s.last_data_change) + "</dd>" +
          "<dt>Sync status</dt><dd>" + status + "</dd>" +
        "</dl></div>" +

        "<h2>Credits</h2>" +
        "<ul>" +
          '<li>Place names: © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>, via Nominatim</li>' +
          '<li>Country borders: <a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth</a> (public domain)</li>' +
          '<li>Map rendering: <a href="https://maplibre.org/" target="_blank" rel="noopener">MapLibre GL JS</a></li>' +
          '<li>Flags: <a href="https://flagicons.lipis.dev/" target="_blank" rel="noopener">flag-icons</a></li>' +
          '<li>Font: <a href="https://rsms.me/inter/" target="_blank" rel="noopener">Inter</a></li>' +
        "</ul>" +
      "</div>";
  }

  DT.views.about = {
    show: function (el) {
      if (!rendered) { render(el); rendered = true; }
    },
  };
})();
