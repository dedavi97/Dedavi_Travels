// Hidden trips editor (#/trips-editor), loaded on demand by trips.js. It edits a copy of
// data/itineraries.json kept as a draft in this browser and exports the whole file;
// Davide uploads it to GitHub by hand. It cannot write anything to the site itself.

(function () {
  "use strict";

  var DRAFT_KEY = "dt.tripsDraft";
  var DATA_FOLDER_URL = "https://github.com/dedavi97/Dedavi_Travels/tree/main/data";
  var FILE_NAME = "itineraries.json";
  var SEARCH_LIMIT = 8;
  var ICON_DELETE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';

  var root = null;
  var live = null;     // { revision, trips } as published
  var draft = null;    // { baseRevision, base, trips, deleted, exported? }
  var editingId = null;
  var map = null, route = null, mapLoaded = false;
  var dragFrom = null;
  var lastExport = null; // { revision, picker } for the upload steps box

  // ---------------------------------------------------------------- helpers

  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function find(list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
  function $(sel) { return root.querySelector(sel); }
  function esc(s) { return DT.escape(s); }

  function fetchLive() {
    return fetch("data/" + FILE_NAME + "?t=" + Date.now(), { cache: "no-store" }).then(function (r) {
      if (r.status === 404) return { revision: 0, trips: [] };
      if (!r.ok) throw new Error(FILE_NAME + ": HTTP " + r.status);
      return r.json().then(function (j) {
        return {
          revision: Number.isInteger(j.revision) ? j.revision : 0,
          trips: Array.isArray(j.trips) ? j.trips.filter(function (t) { return t && t.id; }) : [],
        };
      });
    });
  }

  function freshDraft() {
    return { baseRevision: live.revision, base: clone(live.trips), trips: clone(live.trips), deleted: [] };
  }

  function loadDraft() {
    try {
      var d = JSON.parse(DT.store.get(DRAFT_KEY));
      return d && Array.isArray(d.trips) && Array.isArray(d.base) ? d : null;
    } catch (e) { return null; }
  }

  // Only a draft with something in it is kept: an untouched one is just the live file.
  function saveDraft() {
    if (!draft.exported && same(draft.trips, draft.base)) DT.store.remove(DRAFT_KEY);
    else DT.store.set(DRAFT_KEY, JSON.stringify(draft));
    renderStatus();
  }

  function editing() { return editingId ? find(draft.trips, editingId) : null; }

  function slug(s) {
    return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "trip";
  }

  function newId(name) {
    var id;
    do { id = slug(name) + "-" + Math.random().toString(36).slice(2, 6); } while (find(draft.trips, id) || find(live.trips, id));
    return id;
  }

  function stopFromPlace(p) {
    return { place_id: p.id, name: p.name, original_name: p.original_name, lat: p.lat, lon: p.lon,
      country: p.country, country_iso2: p.country_iso2 };
  }

  function validate(t) {
    var errors = [];
    if (!String(t.name || "").trim()) errors.push("The name is missing.");
    if (t.year != null && !(Number.isInteger(t.year) && t.year >= 1900 && t.year <= 2100)) errors.push("The year must be between 1900 and 2100.");
    if (t.stops.length < 2) errors.push("A trip needs at least 2 stops.");
    t.legs.forEach(function (l, i) { if (!l || !DT.MODES[l.mode]) errors.push("Leg " + (i + 1) + " has no transport."); });
    return errors;
  }

  // ---------------------------------------------------------------- merge (stale draft)
  // Three-way, by trip id: base = the published trips the draft started from.

  function merge() {
    var base = draft.base, theirs = live.trips, out = [], conflicts = [];
    draft.trips.forEach(function (mine) {
      var b = find(base, mine.id), l = find(theirs, mine.id);
      var changedHere = !b || !same(mine, b);
      if (!l) {
        if (!changedHere) return; // deleted on the site, untouched here
        out.push(mine);
        return;
      }
      if (!changedHere) { out.push(l); return; }
      if ((!b || !same(l, b)) && !same(mine, l)) conflicts.push(mine.name);
      out.push(mine);
    });
    theirs.forEach(function (l) {
      if (!find(draft.trips, l.id) && draft.deleted.indexOf(l.id) < 0) out.push(l);
    });
    return { trips: out, conflicts: conflicts };
  }

  function applyMerge(result) {
    draft.trips = result.trips;
    draft.base = clone(live.trips);
    draft.baseRevision = live.revision;
    draft.deleted = draft.deleted.filter(function (id) { return find(live.trips, id); });
    if (editingId && !find(draft.trips, editingId)) editingId = null;
    saveDraft();
  }

  // Once the exported file is published: drop the draft, or (if it was edited after the
  // export) continue from the exported file. Returns true if the draft was cleared.
  function settleExport() {
    if (!draft.exported || live.revision < draft.exported.revision) return false;
    if (same(draft.trips, draft.exported.trips)) {
      DT.store.remove(DRAFT_KEY);
      draft = freshDraft();
      lastExport = null;
      showNotice("ok", "Your export (revision " + live.revision + ") is published. The draft in this browser was cleared.");
      return true;
    }
    draft.base = draft.exported.trips;
    draft.baseRevision = draft.exported.revision;
    draft.deleted = draft.deleted.filter(function (id) { return find(draft.base, id); });
    delete draft.exported;
    saveDraft();
    return false;
  }

  // Decide what to do with a saved draft now that the published file is known.
  function reconcile() {
    var saved = loadDraft();
    if (!saved) { draft = freshDraft(); return; }
    draft = saved;
    draft.deleted = draft.deleted || [];
    if (settleExport()) return;
    if (live.revision > draft.baseRevision) {
      if (same(draft.trips, draft.base)) { draft = freshDraft(); saveDraft(); return; }
      askMerge();
    }
  }

  function askMerge(then) {
    var result = merge();
    openDialog(
      "<h2>The published trips have changed</h2>" +
      "<p>Your draft started from revision " + draft.baseRevision + ", the site now has revision " + live.revision + ".</p>" +
      "<p><strong>Merge</strong> keeps your changes and adds what changed on the site. " +
      "<strong>Discard draft</strong> throws your changes away and starts from the site.</p>" +
      (result.conflicts.length ? '<p class="ed-warn">Changed in both places, your version will be kept: ' +
        result.conflicts.map(esc).join(", ") + ".</p>" : ""),
      [
        { label: "Discard draft", action: function () {
          DT.store.remove(DRAFT_KEY);
          draft = freshDraft();
          editingId = null;
          renderAll();
          showNotice("ok", "Draft discarded: you are editing revision " + live.revision + ".");
        } },
        { label: "Merge", primary: true, action: function () {
          applyMerge(result);
          renderAll();
          showNotice("ok", "Merged with revision " + live.revision + "." + (result.conflicts.length
            ? " Kept your version of: " + result.conflicts.map(esc).join(", ") + "." : ""));
          if (then) then();
        } },
      ]);
  }

  // ---------------------------------------------------------------- dialog & notices

  function openDialog(html, buttons) {
    var dlg = $("#ed-dialog");
    dlg.innerHTML = '<div class="ed-dialog-body">' + html + '</div><div class="ed-dialog-actions"></div>';
    var actions = dlg.querySelector(".ed-dialog-actions");
    buttons.forEach(function (b) {
      var el = document.createElement("button");
      el.type = "button";
      el.className = "btn" + (b.primary ? " btn-primary" : "");
      el.textContent = b.label;
      el.addEventListener("click", function () { dlg.close(); if (b.action) b.action(); });
      actions.appendChild(el);
      if (b.primary) setTimeout(function () { el.focus(); });
    });
    if (dlg.open) dlg.close();
    dlg.showModal();
  }

  function showNotice(kind, html) {
    $("#ed-notice").innerHTML = html ? '<div class="ed-box ed-' + kind + '">' + html + "</div>" : "";
  }

  function renderStatus() {
    var parts = ["Published revision <strong>" + live.revision + "</strong>"];
    if (draft.exported) parts.push("exported revision " + draft.exported.revision + " is waiting to be uploaded");
    if (!same(draft.trips, draft.exported ? draft.exported.trips : draft.base)) parts.push("draft with changes not exported yet (kept in this browser)");
    $("#ed-status").innerHTML = parts.join(" · ");
  }

  // ---------------------------------------------------------------- trip list

  function tripState(t) {
    var l = find(live.trips, t.id);
    return !l ? "new" : same(l, t) ? "" : "changed";
  }

  function renderList() {
    var trips = DT.sortTrips(draft.trips);
    $("#ed-side").innerHTML =
      '<div class="ed-side-head"><h2>Trips (' + trips.length + ")</h2>" +
        '<button class="btn btn-primary" type="button" data-act="new">+ New trip</button></div>' +
      (trips.length ? '<ul class="ed-trips">' + trips.map(function (t) {
        var st = tripState(t), errors = validate(t);
        return '<li class="ed-trip" data-id="' + esc(t.id) + '">' +
          '<button class="ed-trip-main" type="button" data-act="edit">' +
            '<span class="ed-trip-name">' + esc(t.name || "(no name)") +
              (st ? ' <span class="ed-tag">' + st + "</span>" : "") +
              (errors.length ? ' <span class="ed-tag ed-tag-warn">incomplete</span>' : "") + "</span>" +
            '<span class="muted">' + (t.year != null ? esc(t.year) + " · " : "") + t.stops.length + " stops · " +
              DT.formatNumber(DT.tripStats(t).km) + " km " + DT.modeIcons(t) + "</span>" +
          "</button>" +
          '<button class="ed-icon" type="button" data-act="delete" aria-label="Delete ' + esc(t.name) + '" title="Delete">' + ICON_DELETE + '</button>' +
          "</li>";
      }).join("") + "</ul>" : '<p class="muted">No trips yet. Press <strong>New trip</strong> to add the first one.</p>');
    if (route) route.clear();
  }

  function deleteTrip(id) {
    var t = find(draft.trips, id);
    if (!t) return;
    openDialog("<h2>Delete this trip?</h2><p><strong>" + esc(t.name || "(no name)") + "</strong> will disappear from the site " +
      "after you save the file and upload it.</p>", [
      { label: "Cancel" },
      { label: "Delete", primary: true, action: function () {
        draft.trips = draft.trips.filter(function (x) { return x.id !== id; });
        if ((find(draft.base, id) || find(live.trips, id)) && draft.deleted.indexOf(id) < 0) draft.deleted.push(id);
        if (editingId === id) editingId = null;
        saveDraft();
        renderSide();
      } },
    ]);
  }

  // The id follows the name until the trip has been exported once, then it never changes.
  function idIsFree(id) {
    return !find(live.trips, id) && !find(draft.base, id) && !(draft.exported && find(draft.exported.trips, id));
  }

  function newTrip() {
    var t = { id: newId("trip"), name: "", year: null, stops: [], legs: [] };
    draft.trips.push(t);
    saveDraft();
    edit(t.id);
    setTimeout(function () { var n = $("#ed-name"); if (n) n.focus(); });
  }

  // ---------------------------------------------------------------- trip form

  function edit(id) {
    editingId = id;
    renderSide();
    fitTrip();
  }

  function renderSide() {
    if (editing()) renderForm(); else { editingId = null; renderList(); }
    renderPreview();
  }

  function renderForm() {
    var t = editing();
    $("#ed-side").innerHTML =
      '<div class="ed-side-head"><button class="btn" type="button" data-act="back">← All trips</button>' +
        '<button class="ed-icon" type="button" data-act="delete-current" aria-label="Delete this trip" title="Delete">' + ICON_DELETE + '</button></div>' +
      '<label class="ed-field"><span>Name</span><input id="ed-name" type="text" maxlength="80" autocomplete="off" value="' + esc(t.name) + '"></label>' +
      '<label class="ed-field ed-field-year"><span>Year <em class="muted">(optional)</em></span><input id="ed-year" type="number" min="1900" max="2100" step="1" value="' +
        (t.year != null ? esc(t.year) : "") + '"></label>' +
      '<div class="ed-field"><span>Stops</span><ol class="ed-stops" id="ed-stops"></ol></div>' +
      '<div class="ed-field ed-search"><span>Add a stop</span>' +
        '<input id="ed-search" type="search" placeholder="Search a place (English or original name)" autocomplete="off">' +
        '<ul class="ed-results" id="ed-results"></ul>' +
        '<p class="muted ed-hint">…or click a pin on the map. A place can be added more than once (round trips).</p></div>' +
      '<div id="ed-errors"></div>';
    renderStops();
  }

  function renderStops() {
    var t = editing();
    var html = "";
    t.stops.forEach(function (s, i) {
      if (i > 0) {
        var leg = t.legs[i - 1] || {}, km = DT.haversineKm(t.stops[i - 1].lat, t.stops[i - 1].lon, s.lat, s.lon);
        html += '<li class="ed-leg" data-leg="' + (i - 1) + '"><div class="ed-modes" role="group" aria-label="Transport for leg ' + i + '">' +
          DT.MODE_ORDER.map(function (m) {
            return '<button type="button" class="ed-mode" data-mode="' + m + '" aria-pressed="' + (leg.mode === m) + '" title="' +
              DT.MODES[m].label + '">' + DT.MODES[m].icon + "</button>";
          }).join("") + '</div><span class="muted">' + DT.formatNumber(km) + " km</span></li>";
      }
      html += '<li class="ed-stop" draggable="true" data-stop="' + i + '">' +
        '<span class="ed-grip" aria-hidden="true" title="Drag to reorder">⋮⋮</span>' +
        '<span class="ed-num">' + (i + 1) + "</span>" +
        '<span class="ed-stop-name">' + DT.flag(s.country_iso2) + "<span>" + esc(s.name) + "</span>" +
          (s.missing ? ' <span class="ed-tag ed-tag-warn" title="This pin is no longer on the map">missing pin</span>' : "") + "</span>" +
        '<button class="ed-icon" type="button" data-act="up" aria-label="Move up"' + (i === 0 ? " disabled" : "") + ">↑</button>" +
        '<button class="ed-icon" type="button" data-act="down" aria-label="Move down"' + (i === t.stops.length - 1 ? " disabled" : "") + ">↓</button>" +
        '<button class="ed-icon" type="button" data-act="remove" aria-label="Remove ' + esc(s.name) + '">✕</button></li>';
    });
    $("#ed-stops").innerHTML = html || '<li class="muted ed-empty">No stops yet.</li>';
    var errors = validate(t);
    $("#ed-errors").innerHTML = errors.length ? '<ul class="ed-errors">' + errors.map(function (e) { return "<li>" + esc(e) + "</li>"; }).join("") + "</ul>" : "";
  }

  function changed() {
    saveDraft();
    renderStops();
    renderPreview();
  }

  function addStop(p) {
    var t = editing();
    if (!t) return;
    t.stops.push(stopFromPlace(p));
    if (t.stops.length > 1) t.legs.push({ mode: t.legs.length ? t.legs[t.legs.length - 1].mode : "train" });
    changed();
  }

  function removeStop(i) {
    var t = editing();
    t.stops.splice(i, 1);
    // Keep the leg arriving at the removed stop; the first/last stop only has one.
    if (t.legs.length) t.legs.splice(Math.min(i, t.legs.length - 1), 1);
    changed();
  }

  function moveStop(from, to) {
    var t = editing();
    if (to < 0 || to >= t.stops.length || from === to) return;
    t.stops.splice(to, 0, t.stops.splice(from, 1)[0]);
    changed();
  }

  function search(q) {
    var box = $("#ed-results");
    q = q.trim().toLowerCase();
    if (!q) { box.innerHTML = ""; return; }
    var norm = function (s) { return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(); };
    var nq = norm(q);
    var hits = DT.data.places.filter(function (p) {
      return norm(p.name).indexOf(nq) >= 0 || norm(p.original_name).indexOf(nq) >= 0;
    }).sort(function (a, b) {
      var sa = norm(a.name).indexOf(nq) === 0 || norm(a.original_name).indexOf(nq) === 0 ? 0 : 1;
      var sb = norm(b.name).indexOf(nq) === 0 || norm(b.original_name).indexOf(nq) === 0 ? 0 : 1;
      return (sa - sb) || a.name.localeCompare(b.name, "en");
    }).slice(0, SEARCH_LIMIT);
    box.innerHTML = hits.length ? hits.map(function (p) {
      return '<li><button type="button" data-place="' + esc(p.id) + '">' + DT.placeFlag(p) + "<span>" + esc(p.name) + "</span>" +
        (p.original_name && p.original_name !== p.name ? ' <span class="muted">' + esc(p.original_name) + "</span>" : "") +
        ' <span class="muted">· ' + esc(p.country || "") + "</span></button></li>";
    }).join("") : '<li class="muted ed-empty">No place found.</li>';
  }

  // ---------------------------------------------------------------- map & preview

  function initMap() {
    map = new maplibregl.Map({
      container: $("#ed-map"),
      style: DT.mapStyle({ projection: "mercator", cluster: false }),
      center: [12, 46],
      zoom: 3,
      maxZoom: 9,
      maxPitch: 0,
      dragRotate: false,
      touchPitch: false,
      attributionControl: false,
      fadeDuration: 0,
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-left");
    map.addControl(new maplibregl.AttributionControl({ compact: true,
      customAttribution: '<a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth</a>' }), "bottom-right");
    route = new DT.TripRoute(map, {
      before: "pins",
      onStopClick: function (s) {
        var p = !s.missing && DT.placeById(s.place_id);
        if (p && editing()) addStop(p);
      },
    });
    map.on("load", function () {
      mapLoaded = true;
      renderPreview();
      fitTrip();
    });
    map.on("click", "pins", function (e) {
      var p = DT.placeById(e.features[0].properties.id);
      if (!p) return;
      if (editing()) addStop(p);
      else $("#ed-map-hint").textContent = p.name + " — open or create a trip to add it.";
    });
    map.on("mousemove", "pins", function (e) {
      map.getCanvas().style.cursor = "pointer";
      var p = DT.placeById(e.features[0].properties.id);
      if (p) $("#ed-map-hint").textContent = p.name + (editing() ? " — click to add it as a stop" : "");
    });
    map.on("mouseleave", "pins", function () {
      map.getCanvas().style.cursor = "";
      $("#ed-map-hint").textContent = mapHint();
    });
  }

  function mapHint() { return editing() ? "Click a pin to add it as the next stop." : "Open or create a trip to add stops."; }

  function fitTrip() {
    var t = editing();
    if (!mapLoaded || !t || !t.stops.length) return;
    map.fitBounds(DT.tripBounds(t), { padding: 50, maxZoom: 7, duration: 0 });
  }

  function renderPreview() {
    if (!root) return;
    $("#ed-map-hint").textContent = mapHint();
    var t = editing(), box = $("#ed-preview");
    if (mapLoaded) {
      if (t && t.stops.length) route.draw({ stops: t.stops, legs: t.legs.map(function (l) { return { mode: l.mode || "train" }; }) }, false);
      else route.clear();
    }
    if (!t || t.stops.length < 2) {
      box.innerHTML = t ? '<p class="muted">Add at least 2 stops to see the trip stats.</p>' : "";
      return;
    }
    box.innerHTML = '<h3 class="sub">Preview</h3><div class="ed-card">' + DT.tripCardHtml(t) + "</div>";
  }

  // ---------------------------------------------------------------- export

  function startExport() {
    var bad = draft.trips.filter(function (t) { return validate(t).length; });
    if (bad.length) {
      openDialog("<h2>Some trips are incomplete</h2><p>Fix them before saving:</p><ul>" + bad.map(function (t) {
        return "<li><strong>" + esc(t.name || "(no name)") + "</strong>: " + validate(t).map(esc).join(" ") + "</li>";
      }).join("") + "</ul>", [{ label: "OK", primary: true }]);
      return;
    }
    // Check the site again: someone (another device) may have published in the meantime.
    fetchLive().then(function (l) {
      live = l;
      settleExport();
      renderStatus();
      renderSide();
      if (live.revision > draft.baseRevision) { askMerge(startExport); return; }
      summary();
    }).catch(function (err) {
      console.error(err);
      showNotice("warn", "Couldn't check the published file. Check your connection and try again.");
    });
  }

  function summary() {
    var added = 0, modified = 0, unchanged = 0;
    draft.trips.forEach(function (t) {
      var l = find(live.trips, t.id);
      if (!l) added++; else if (same(l, t)) unchanged++; else modified++;
    });
    var deleted = live.trips.filter(function (l) { return !find(draft.trips, l.id); });
    var revision = live.revision + 1;
    openDialog("<h2>Save the trips file</h2>" +
      '<table class="ed-summary"><tr><td>Trips in the file</td><td>' + draft.trips.length + "</td></tr>" +
        "<tr><td>Unchanged</td><td>" + unchanged + "</td></tr>" +
        "<tr><td>Added</td><td>" + added + "</td></tr>" +
        "<tr><td>Modified</td><td>" + modified + "</td></tr>" +
        "<tr><td>Deleted</td><td>" + deleted.length + "</td></tr></table>" +
      (deleted.length ? '<p class="ed-warn">Will be deleted: ' + deleted.map(function (t) { return esc(t.name); }).join(", ") + "</p>" : "") +
      (added + modified + deleted.length === 0 ? '<p class="muted">Nothing changed compared with the site.</p>' : "") +
      "<p>The file will be revision <strong>" + revision + "</strong> (the site has " + live.revision + ").</p>",
      [{ label: "Cancel" }, { label: "Save file", primary: true, action: function () { exportFile(revision); } }]);
  }

  function exportFile(revision) {
    var file = { schema: 1, revision: revision, updated: new Date().toISOString().replace(/\.\d+Z$/, "Z"), trips: draft.trips };
    var text = JSON.stringify(file, null, 2) + "\n";
    var saved;
    if (window.showSaveFilePicker) {
      saved = window.showSaveFilePicker({
        suggestedName: FILE_NAME,
        types: [{ description: "JSON file", accept: { "application/json": [".json"] } }],
      }).then(function (handle) {
        return handle.createWritable().then(function (w) {
          return w.write(text).then(function () { return w.close(); });
        }).then(function () { return { picker: true, name: handle.name }; });
      }).catch(function (err) {
        if (err && err.name === "AbortError") return null; // cancelled
        console.warn("Save dialog not available, downloading instead:", err);
        download(text);
        return { picker: false };
      });
    } else {
      download(text);
      saved = Promise.resolve({ picker: false });
    }
    saved.then(function (how) {
      if (!how) return;
      draft.exported = { revision: revision, trips: clone(draft.trips) };
      saveDraft();
      lastExport = { revision: revision, how: how };
      showUploadSteps();
    });
  }

  function download(text) {
    var url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    var a = document.createElement("a");
    a.href = url;
    a.download = FILE_NAME;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  function showUploadSteps() {
    var e = lastExport, wrongName = e.how.picker && e.how.name !== FILE_NAME;
    showNotice("ok",
      "<strong>Saved: " + FILE_NAME + ", revision " + e.revision + ".</strong> Now put it on the site:" +
      (!e.how.picker || wrongName ? '<p class="ed-warn">The file must be named exactly <strong>' + FILE_NAME +
        "</strong> (not “itineraries (1).json”). " + (wrongName ? "You saved it as “" + esc(e.how.name) + "”: rename it."
        : "Check your Downloads folder and rename it if needed.") + "</p>" : "") +
      "<ol>" +
        '<li>Open the <a href="' + DATA_FOLDER_URL + '" target="_blank" rel="noopener">data folder of the repository on GitHub</a>.</li>' +
        "<li>Click <strong>Add file</strong> → <strong>Upload files</strong>.</li>" +
        "<li>Drop <strong>" + FILE_NAME + "</strong> into the page.</li>" +
        "<li>Click <strong>Commit changes</strong>.</li>" +
      "</ol>" +
      "<p>The site updates in about 1–2 minutes. Then reopen this editor (or press the button) and check that " +
        "<em>Published revision</em> says " + e.revision + ". Until then your draft stays in this browser.</p>" +
      '<button class="btn" type="button" data-act="recheck">Check the published revision</button>');
  }

  function recheck() {
    fetchLive().then(function (l) {
      live = l;
      showNotice("", "");
      reconcile();
      renderAll();
      if (lastExport && live.revision < lastExport.revision) {
        showUploadSteps();
        $("#ed-notice").insertAdjacentHTML("afterbegin", '<div class="ed-box ed-warn">Still revision ' + live.revision +
          " on the site. GitHub can take a couple of minutes: try again shortly.</div>");
      }
    }).catch(function (err) { console.error(err); });
  }

  // ---------------------------------------------------------------- page

  function renderAll() {
    renderStatus();
    renderSide();
    fitTrip();
  }

  function bind() {
    root.addEventListener("click", function (e) {
      var btn = e.target.closest("button");
      if (!btn || !root.contains(btn)) return;
      var act = btn.dataset.act, li = btn.closest("[data-id]"), stop = btn.closest("[data-stop]");
      if (act === "new") newTrip();
      else if (act === "edit") edit(li.dataset.id);
      else if (act === "delete") deleteTrip(li.dataset.id);
      else if (act === "delete-current") deleteTrip(editingId);
      else if (act === "back") { editingId = null; renderSide(); }
      else if (act === "export") startExport();
      else if (act === "recheck") recheck();
      else if (act === "up") moveStop(+stop.dataset.stop, +stop.dataset.stop - 1);
      else if (act === "down") moveStop(+stop.dataset.stop, +stop.dataset.stop + 1);
      else if (act === "remove") removeStop(+stop.dataset.stop);
      else if (btn.dataset.mode) {
        editing().legs[+btn.closest("[data-leg]").dataset.leg] = { mode: btn.dataset.mode };
        changed();
      } else if (btn.dataset.place) {
        addStop(DT.placeById(btn.dataset.place));
        var s = $("#ed-search");
        s.value = "";
        search("");
        s.focus();
      }
    });
    root.addEventListener("input", function (e) {
      var t = editing();
      if (e.target.id === "ed-search") { search(e.target.value); return; }
      if (!t) return;
      if (e.target.id === "ed-name") {
        t.name = e.target.value;
        if (idIsFree(t.id) && t.name.trim() && t.id.lastIndexOf(slug(t.name) + "-", 0) !== 0) editingId = t.id = newId(t.name);
      } else if (e.target.id === "ed-year") t.year = e.target.value === "" ? null : Math.round(Number(e.target.value));
      else return;
      saveDraft();
      renderStops();
      renderPreview();
    });
    root.addEventListener("keydown", function (e) {
      if (e.target.id === "ed-search" && e.key === "Enter") {
        var first = $("#ed-results button");
        if (first) { e.preventDefault(); first.click(); }
      }
    });
    // Drag to reorder (desktop); the arrow buttons do the same on touch screens.
    root.addEventListener("dragstart", function (e) {
      var li = e.target.closest && e.target.closest(".ed-stop");
      if (!li) return;
      dragFrom = +li.dataset.stop;
      li.classList.add("is-dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(dragFrom));
    });
    root.addEventListener("dragover", function (e) {
      if (dragFrom === null || !e.target.closest(".ed-stop")) return;
      e.preventDefault();
    });
    root.addEventListener("drop", function (e) {
      var li = e.target.closest(".ed-stop");
      if (dragFrom === null || !li) return;
      e.preventDefault();
      var from = dragFrom;
      dragFrom = null;
      moveStop(from, +li.dataset.stop);
    });
    root.addEventListener("dragend", function () {
      dragFrom = null;
      var d = root.querySelector(".is-dragging");
      if (d) d.classList.remove("is-dragging");
    });
  }

  function build(el) {
    root = el;
    el.innerHTML =
      '<div class="page editor">' +
        '<header class="ed-head"><div><h1>Trips editor</h1><p class="muted" id="ed-status">Loading…</p></div>' +
          '<button class="btn btn-primary" type="button" data-act="export" disabled>Save file…</button></header>' +
        '<div id="ed-notice"></div>' +
        '<div class="ed-body">' +
          '<div class="ed-side" id="ed-side"></div>' +
          '<div class="ed-main"><div class="ed-map" id="ed-map"></div><p class="muted ed-hint" id="ed-map-hint"></p>' +
            '<div id="ed-preview"></div></div>' +
        "</div>" +
        '<dialog class="ed-dialog" id="ed-dialog"></dialog>' +
      "</div>";
    bind();
    initMap();
  }

  function open() {
    fetchLive().then(function (l) {
      live = l;
      reconcile();
      root.querySelector('[data-act="export"]').disabled = false;
      renderAll();
    }).catch(function (err) {
      console.error(err);
      $("#ed-status").textContent = "Couldn't read the published trips. Check your connection and reload the page.";
    });
  }

  DT.tripsEditor = {
    show: function (el) {
      if (!root) build(el);
      else if (map) map.resize();
      open();
    },
    hide: function () {
      var dlg = root && $("#ed-dialog");
      if (dlg && dlg.open) dlg.close();
    },
  };
})();
