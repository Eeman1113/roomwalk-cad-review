/* RoomWalk CAD check — review tool.
   No build step, no dependencies. Reviews live in localStorage and leave as CSV. */

(function () {
  "use strict";

  var KEY = "roomwalk-cad-review.v1";
  var $ = function (id) { return document.getElementById(id); };

  /* The failure modes are the ones the reader measurably has, from
     reader/docs/READER-ACCURACY.md — not a generic list. */
  var FLAGS = [
    ["room_missing", "A room on the plan is missing from the CAD"],
    ["rooms_merged", "Two or more rooms are drawn as one space"],
    ["extra_space", "The CAD invents a room that is not on the plan"],
    ["wrong_name", "A room name is wrong or garbled"],
    ["wrong_size", "A printed size is wrong, or no size was carried over"],
    ["wall_place", "A wall is in the wrong place"],
    ["opening_missing", "A door or window is missing"],
    ["opening_spurious", "A door or window is drawn where there is none"],
    ["wrong_scale", "The whole drawing is at the wrong scale"],
    ["geometry_broken", "Spaces overlap, or the outline is broken"],
    ["other", "Something else — see my notes"]
  ];
  var FLAGKEYS = FLAGS.map(function (f) { return f[0]; });

  var data = null, cases = [], cur = 0;
  var state = { checker: "", reviews: {}, ui: { mode: "side", lock: true, opacity: 75, flip: "plan", review: true, index: true, wheel: "auto", theme: null } };
  var svgCache = {}, svgSeq = 0;
  var views = { A: null, B: null };
  var fitZ = { A: 1, B: 1 };
  var saveTimer = null;

  /* ---------------- storage ---------------- */

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return;
      var o = JSON.parse(raw);
      if (o && typeof o === "object") {
        state.checker = o.checker || "";
        state.reviews = o.reviews || {};
        if (o.ui) for (var k in o.ui) if (o.ui[k] !== undefined) state.ui[k] = o.ui[k];
      }
    } catch (e) { /* corrupt or blocked storage must not stop the tool */ }
  }

  function markDirty() {
    var f = $("savedFlag");
    f.classList.add("dirty");
    $("savedText").textContent = "Saving…";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 120);
  }

  function save() {
    var f = $("savedFlag"), t = $("savedText");
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      f.classList.remove("dirty");
      var d = new Date();
      t.textContent = "Saved " + String(d.getHours()).padStart(2, "0") + ":" +
        String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0");
    } catch (e) {
      f.classList.add("dirty");
      t.textContent = "NOT SAVED — this browser is blocking storage. Export the CSV now.";
    }
  }

  function review(id) {
    if (!state.reviews[id]) state.reviews[id] = { verdict: "", flags: [], notes: "", at: "" };
    return state.reviews[id];
  }

  function isReviewed(id) {
    var r = state.reviews[id];
    return !!(r && (r.verdict || (r.flags && r.flags.length) || (r.notes && r.notes.trim())));
  }

  /* ---------------- index list ---------------- */

  var filter = "all";

  function matches(c) {
    var q = $("search").value.trim().toLowerCase();
    if (q) {
      var hay = (c.block + " " + c.floor + " flat " + c.flat + " " + c.id + " " + c.split).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    if (filter === "todo") return !isReviewed(c.id);
    if (filter === "done") return isReviewed(c.id);
    if (filter === "failed") return !c.ok;
    return true;
  }

  function renderIndex() {
    var list = $("indexList"), html = [], shown = 0, lastBlock = null;
    for (var i = 0; i < cases.length; i++) {
      var c = cases[i];
      if (!matches(c)) continue;
      shown++;
      if (c.block !== lastBlock) {
        lastBlock = c.block;
        html.push('<div class="grouphd">' + esc(c.block) + "</div>");
      }
      var r = state.reviews[c.id];
      var dot = r && r.verdict ? " v-" + r.verdict : "";
      html.push(
        '<button class="row' + (c.ok ? "" : " failcase") + '" data-i="' + i + '" aria-current="' + (i === cur) + '">' +
        '<span class="n">' + String(i + 1).padStart(2, "0") + "</span>" +
        '<span><span class="nm">' + esc(c.floor.replace("-", " ")) + " · flat " + esc(c.flat) + "</span>" +
        '<br><span class="sub">' + esc(c.ok ? c.split : "no CAD · " + c.split) + "</span></span>" +
        '<span class="dot' + dot + '" title="' + (r && r.verdict ? esc(r.verdict) : "not reviewed") + '"></span>' +
        "</button>"
      );
    }
    list.innerHTML = html.join("");
    $("indexCount").textContent = shown === cases.length
      ? cases.length + " cases · " + cases.filter(function (c) { return !c.ok; }).length + " with no CAD"
      : shown + " of " + cases.length + " shown";
    var el = list.querySelector('[aria-current="true"]');
    if (el) el.scrollIntoView({ block: "nearest" });
  }

  function renderProgress() {
    var done = cases.filter(function (c) { return isReviewed(c.id); }).length;
    $("progressText").textContent = done + " of " + cases.length + " reviewed";
    $("progressBar").style.width = (done / cases.length * 100).toFixed(1) + "%";
    var verd = { good: 0, minor: 0, unusable: 0 };
    cases.forEach(function (c) { var r = state.reviews[c.id]; if (r && r.verdict) verd[r.verdict]++; });
    $("statusCount").textContent = verd.good + " good · " + verd.minor + " minor · " +
      verd.unusable + " unusable · " + (cases.length - done) + " left";
  }

  /* ---------------- the two panes ---------------- */

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function planLayer(c) {
    return '<img src="plans/' + encodeURIComponent(c.id) + '.png" width="' + c.W + '" height="' + c.H +
      '" alt="Brochure floor plan for ' + esc(c.block) + " flat " + esc(c.flat) + '" draggable="false">';
  }

  function cadBox(c, svgText, standalone, opacity) {
    var vb = c.overlay.viewBox, s = c.overlay.sc, n = ++svgSeq;
    // Pattern ids repeat between instances; make them unique so two copies on
    // the page cannot steal each other's hatches.
    var t = svgText.replace(/id="(pAnsi|pNet)"/g, 'id="$1-' + n + '"')
      .replace(/url\(#(pAnsi|pNet)\)/g, "url(#$1-" + n + ")");
    return '<div class="cadlayer' + (standalone ? " sheet" : "") + '" style="left:' + (vb[0] * s) + "px;top:" +
      (vb[1] * s) + "px;width:" + (vb[2] * s) + "px;height:" + (vb[3] * s) + "px" +
      (opacity != null ? ";opacity:" + opacity : "") + '">' + t + "</div>";
  }

  function failBox(c) {
    return '<div class="failwrap"><div class="failpanel"><div class="mark">No CAD produced</div>' +
      "<p>The reader got this far and then stopped, so there is no drawing to compare. " +
      "That is itself a result worth recording.</p><p><code>" + esc(c.error) + "</code></p>" +
      '<p class="note">Stage: ' + esc(c.stage === "read" ? "reading the image" : "building the drawing") +
      " · split: " + esc(c.split) + "</p></div></div>";
  }

  /* A 400 dpi PNG costs ~W*H*4 bytes once decoded — far more than it does on
     disk — so the old one is dropped explicitly rather than left for whenever
     the collector gets round to it. Replacing innerHTML alone detaches the
     node but Chrome can hold the decoded bitmap while the image object lives. */
  function setCanvas(p, html) {
    var el = cv(p);
    Array.prototype.forEach.call(el.querySelectorAll("img"), function (img) {
      img.removeAttribute("src");
      img.removeAttribute("srcset");
    });
    el.innerHTML = html;
  }

  /* Only the current case and one neighbour are kept; everything else is let
     go, so walking 40 cases does not accumulate 40 drawings in memory. */
  function releaseFar() {
    var keep = {};
    [cur - 1, cur, cur + 1].forEach(function (i) {
      if (cases[i]) keep[cases[i].id] = true;
    });
    Object.keys(svgCache).forEach(function (k) {
      if (!keep[k]) delete svgCache[k];
    });
  }

  var prefetchImg = null;

  function landSvg(id, text) {
    if (svgCache[id] !== null && svgCache[id] !== undefined) return;
    svgCache[id] = text;
    if (cases[cur] && cases[cur].id === id) { paintPanes(); fitAll(); }
  }


  function prefetchNeighbour() {
    var n = cases[cur + 1];
    if (!n) { prefetchImg = null; return; }
    // One image object at a time: the previous prefetch becomes unreachable.
    prefetchImg = new Image();
    prefetchImg.decoding = "async";
    prefetchImg.src = "plans/" + encodeURIComponent(n.id) + ".png";
    if (n.ok && svgCache[n.id] === undefined) {
      svgCache[n.id] = null;
      fetch("cad/" + encodeURIComponent(n.id) + ".svg")
        .then(function (r) { return r.ok ? r.text() : Promise.reject(new Error(r.status)); })
        .then(function (t) { landSvg(n.id, t); })
        .catch(function () { landSvg(n.id, ""); });
    }
  }

  function paintPanes() {
    var c = cases[cur], mode = state.ui.mode;
    var panes = $("panes");
    panes.classList.toggle("single", mode !== "side");

    var svg = c.ok ? svgCache[c.id] : null;
    var op = state.ui.opacity / 100;

    // The "no CAD" message must not be zoomed with the drawing it stands in for.
    Array.prototype.forEach.call(document.querySelectorAll(".failwrap"), function (el) { el.remove(); });
    if (!c.ok && mode === "side") vp("B").insertAdjacentHTML("beforeend", failBox(c));

    if (mode === "side") {
      $("hdA").textContent = "Brochure plan";
      $("metaA").textContent = c.W + " × " + c.H + " px · 400 dpi";
      setCanvas("A", '<div class="sheetbox" style="width:' + c.W + "px;height:" + c.H + 'px">' + planLayer(c) + "</div>");
      $("hdB").textContent = "Generated CAD";
      $("metaB").textContent = c.ok ? "vector SVG · mm · walls 250/125 mm" : "not produced";
      setCanvas("B", c.ok && svg
        ? '<div class="box" style="width:' + c.W + "px;height:" + c.H + 'px">' + cadBox(c, svg, true, null) + "</div>"
        : "");
    } else if (mode === "overlay") {
      $("hdA").textContent = "Plan with the CAD laid over it";
      $("metaA").textContent = c.ok ? "registered by the reader's own scale, " + c.overlay.sc.toFixed(2) + " px per inch" : "no CAD to overlay";
      setCanvas("A", '<div class="sheetbox" style="width:' + c.W + "px;height:" + c.H + 'px">' +
        planLayer(c) + (c.ok && svg ? cadBox(c, svg, false, op) : "") + "</div>");
      // The hidden pane must not keep the previous case's drawing alive.
      setCanvas("B", "");
    } else {
      var showCad = state.ui.flip === "cad" && c.ok;
      $("hdA").textContent = showCad ? "Generated CAD" : "Brochure plan";
      $("metaA").textContent = "press Space to swap";
      setCanvas("A", showCad
        ? '<div class="box" style="width:' + c.W + "px;height:" + c.H + 'px">' + cadBox(c, svg, true, null) + "</div>"
        : '<div class="sheetbox" style="width:' + c.W + "px;height:" + c.H + 'px">' + planLayer(c) + "</div>");
      setCanvas("B", "");
    }
    applyView("A"); applyView("B");
  }

  function vp(p) { return $("vp" + p); }
  function cv(p) { return $("cv" + p); }

  function computeFit(p) {
    var c = cases[cur], r = vp(p).getBoundingClientRect();
    if (!r.width || !r.height) return 1;
    return Math.min(r.width / c.W, r.height / c.H) * 0.97;
  }

  function fit(p) {
    var c = cases[cur], r = vp(p).getBoundingClientRect(), z = computeFit(p);
    fitZ[p] = z;
    views[p] = { z: z, x: (r.width - c.W * z) / 2, y: (r.height - c.H * z) / 2 };
  }

  function fitAll() {
    dropRects();
    fit("A");
    // Locked panes must share one transform exactly, or the same wall sits at
    // two different screen positions and the comparison is worthless.
    if (state.ui.lock) { fitZ.B = fitZ.A; views.B = { z: views.A.z, x: views.A.x, y: views.A.y }; }
    else fit("B");
    applyView("A"); applyView("B"); readZoom();
  }

  /* One rAF write per frame, never one per event. A trackpad fires many small
     wheel events inside a single frame; transforming on each one is what made a
     page like this unusable on an Intel Iris Plus 645. */
  var writeQueued = false, gestureTimer = null;
  var rectCache = { A: null, B: null };

  function vpRect(p) {
    if (!rectCache[p]) rectCache[p] = vp(p).getBoundingClientRect();
    return rectCache[p];
  }

  function dropRects() { rectCache.A = null; rectCache.B = null; }

  function applyView(p) {
    var v = views[p];
    if (!v) return;
    cv(p).style.transform = "translate(" + v.x + "px," + v.y + "px) scale(" + v.z + ")";
  }

  function scheduleWrite() {
    if (writeQueued) return;
    writeQueued = true;
    requestAnimationFrame(function () {
      writeQueued = false;
      applyView("A"); applyView("B"); readZoom();
    });
  }

  /* will-change pins a compositor layer in video memory, which is the wrong
     trade when the GPU shares ~1 GB with everything else, so it is on only
     while a gesture is actually running. Nothing animates when idle. */
  function gestureOn() {
    cv("A").classList.add("gesturing");
    cv("B").classList.add("gesturing");
    if (gestureTimer) clearTimeout(gestureTimer);
    gestureTimer = setTimeout(gestureOff, 350);
  }

  function gestureOff() {
    if (gestureTimer) { clearTimeout(gestureTimer); gestureTimer = null; }
    cv("A").classList.remove("gesturing");
    cv("B").classList.remove("gesturing");
    dropRects();
  }

  function readZoom() {
    var v = views[state.ui.mode === "side" ? "A" : "A"];
    $("zoomRead").textContent = v ? Math.round(v.z * 100) + "%" : "";
  }

  function mirror(from) {
    if (!state.ui.lock) return;
    var other = from === "A" ? "B" : "A";
    views[other] = { z: views[from].z, x: views[from].x, y: views[from].y };
  }

  function zoomAt(p, factor, cx, cy) {
    var v = views[p];
    if (!v) return;
    var lo = Math.min(0.05, fitZ[p] * 0.3), hi = 40;
    var z2 = Math.max(lo, Math.min(hi, v.z * factor));
    var k = z2 / v.z;
    v.x = cx - (cx - v.x) * k;
    v.y = cy - (cy - v.y) * k;
    v.z = z2;
    mirror(p); scheduleWrite();
  }

  function panBy(p, dx, dy) {
    var v = views[p];
    if (!v) return;
    v.x += dx;
    v.y += dy;
    mirror(p); scheduleWrite();
  }

  function zoomCentre(factor) {
    var p = "A", r = vp(p).getBoundingClientRect();
    zoomAt(p, factor, r.width / 2, r.height / 2);
  }

  function oneToOne() {
    ["A", "B"].forEach(function (p) {
      var v = views[p], r = vp(p).getBoundingClientRect();
      if (!v) return;
      var cxw = (r.width / 2 - v.x) / v.z, cyw = (r.height / 2 - v.y) / v.z;
      v.z = 1; v.x = r.width / 2 - cxw; v.y = r.height / 2 - cyw;
      applyView(p);
    });
    readZoom();
  }

  /* Telling a mouse from a trackpad. A wheel notch is few, large and quantised:
     integer deltaY, |deltaY| >= 50, no horizontal component, or a non-pixel
     deltaMode. A trackpad streams many small, often fractional deltas and
     usually some deltaX. The verdict is latched briefly so one odd event in the
     middle of a gesture cannot flip modes and jerk the drawing. */
  var wheelLatch = "mouse", wheelLatchUntil = 0, wheelSeen = null;

  function detectDevice(e) {
    var now = performance.now();
    if (now < wheelLatchUntil) { wheelLatchUntil = now + 350; return wheelLatch; }
    var mouse = e.deltaMode !== 0 ||
      (e.deltaX === 0 && e.deltaY === Math.round(e.deltaY) && Math.abs(e.deltaY) >= 50);
    wheelLatch = mouse ? "mouse" : "trackpad";
    wheelLatchUntil = now + 350;
    if (wheelSeen !== wheelLatch) { wheelSeen = wheelLatch; paintWheelHint(); }
    return wheelLatch;
  }

  /* Heuristics are never perfect, so the guess is overridable and remembered. */
  function wheelZooms(e) {
    if (state.ui.wheel === "zoom") return true;
    if (state.ui.wheel === "pan") return false;
    return detectDevice(e) === "mouse";
  }

  function setWheelMode(m) {
    state.ui.wheel = m;
    markDirty();
    paintWheelHint();
  }

  function paintWheelHint() {
    var m = state.ui.wheel;
    var b = $("wheelBtn");
    if (b) {
      b.textContent = "Wheel: " + (m === "auto"
        ? "auto (" + (wheelSeen === "trackpad" ? "panning" : "zoom") + ")"
        : m === "zoom" ? "zoom" : "pan");
      b.title = "What a plain scroll does. Auto reads the device; click to pin it.";
    }
    var zooms = m === "zoom" || (m === "auto" && wheelSeen !== "trackpad");
    var h = document.querySelector(".vphint");
    if (h) h.textContent = zooms
      ? "pinch or scroll to zoom \u00b7 drag to pan"
      : "pinch to zoom \u00b7 two fingers to pan";
    var f = $("gestureKeys");
    if (f) f.textContent = zooms ? "scroll or pinch zooms" : "pinch zooms, two fingers pan";
  }

  function wireViewport(p) {
    var el = vp(p), drag = null;

    /* A plain wheel event means "zoom" from a mouse and "pan" from a trackpad,
       and the browser does not say which fired it — see wheelZooms(). ctrlKey
       always zooms, which covers a trackpad pinch and cmd/ctrl+scroll on both.
       Both are prevented, so the page never scrolls and the back-swipe gesture
       can never throw away someone's place mid-review. */
    el.addEventListener("wheel", function (e) {
      e.preventDefault();
      var u = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      gestureOn();
      var pinch = e.ctrlKey;
      if (pinch || wheelZooms(e)) {
        var r = vpRect(p);
        // A pinch sends many small events where a wheel sends few large ones,
        // so a notch-sized step under a pinch feels violent.
        var step = pinch ? 0.009 : 0.0022;
        zoomAt(p, Math.exp(-e.deltaY * u * step), e.clientX - r.left, e.clientY - r.top);
      } else {
        panBy(p, -e.deltaX * u, -e.deltaY * u);
      }
    }, { passive: false });

    el.addEventListener("pointerdown", function (e) {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      el.setPointerCapture(e.pointerId);
      el.classList.add("dragging");
      gestureOn();
      drag = { x: e.clientX, y: e.clientY };
    });

    el.addEventListener("pointermove", function (e) {
      if (!drag || !views[p]) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag = { x: e.clientX, y: e.clientY };
      gestureOn();
      panBy(p, dx, dy);
    });

    function end(e) {
      if (!drag) return;
      drag = null;
      el.classList.remove("dragging");
      gestureOff();
      try { el.releasePointerCapture(e.pointerId); } catch (err) { }
    }
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("dblclick", function () { fitAll(); });
  }

  /* ---------------- the review form ---------------- */

  function buildTicks() {
    $("ticks").innerHTML = FLAGS.map(function (f) {
      return '<label class="tick"><input type="checkbox" value="' + f[0] + '"><span>' + esc(f[1]) + "</span></label>";
    }).join("");
    $("ticks").addEventListener("change", function (e) {
      var r = review(cases[cur].id), v = e.target.value;
      var i = r.flags.indexOf(v);
      if (e.target.checked) { if (i === -1) r.flags.push(v); }
      else if (i !== -1) r.flags.splice(i, 1);
      stamp(r); markDirty(); renderIndex(); renderProgress();
      e.target.closest(".tick").classList.toggle("on", e.target.checked);
    });
  }

  function stamp(r) { r.at = new Date().toISOString(); }

  function paintForm() {
    var c = cases[cur], r = state.reviews[c.id] || { verdict: "", flags: [], notes: "" };
    $("rvCase").textContent = c.block + " · " + c.floor.replace("-", " ") + " · flat " + c.flat;
    $("rvSub").textContent = "case " + (cur + 1) + "/" + cases.length + " · " + c.id + " · " + c.split +
      (c.ok ? "" : " · NO CAD");
    Array.prototype.forEach.call(document.querySelectorAll('input[name="verdict"]'), function (el) {
      el.checked = r.verdict === el.value;
    });
    Array.prototype.forEach.call($("ticks").querySelectorAll("input"), function (el) {
      el.checked = (r.flags || []).indexOf(el.value) !== -1;
    });
    $("notes").value = r.notes || "";
    paintFacts(c);
  }

  function paintFacts(c) {
    // Printed rooms (the architect's own words, transcribed) against the rooms
    // the drawing actually carries. This is the comparison the checker needs
    // and it is tedious to do by eye.
    var truth = (c.truth && c.truth.rooms) || [];
    var drawn = (c.cad && c.cad.rooms) || [];
    var rows = [], n = Math.max(truth.length, drawn.length);
    for (var i = 0; i < n; i++) {
      var t = truth[i], d = drawn[i];
      rows.push("<tr><td>" + (t ? esc(t.name) + '<br><span class="mono">' + esc(t.size || "—") + "</span>" : '<span class="miss">—</span>') +
        "</td><td>" + (d ? esc(d.name || "(unnamed)") + '<br><span class="mono">' + esc(d.label || "—") + "</span>" : '<span class="miss">—</span>') + "</td></tr>");
    }
    var head = "<p class=\"note\">Same row does not mean same room &mdash; the two lists are in different orders. Count them, then look.</p>" +
      "<table><tr><th>Printed on the plan (" + truth.length + ")</th><th>In the CAD (" + drawn.length + ")</th></tr>" + rows.join("") + "</table>";
    if (c.truth) {
      head += '<p class="note">Plan also prints ' + c.truth.doors + " door" + (c.truth.doors === 1 ? "" : "s") +
        ", " + c.truth.windows + " window" + (c.truth.windows === 1 ? "" : "s") +
        (c.truth.ventilators ? " and " + c.truth.ventilators + " ventilator" + (c.truth.ventilators === 1 ? "" : "s") : "") + ".";
      if (c.cad && c.cad.placed) head += " The CAD places " + c.cad.placed.length + ".";
      head += "</p>";
    }
    $("roomsFacts").innerHTML = head;

    var self = [];
    if (c.ok && c.quality) {
      self.push('<p class="note">The generator rates its own confidence <b>' + esc(c.quality.level) +
        "</b>. Its notes, verbatim:</p><ul class=\"checklist\">" +
        c.quality.checks.map(function (k) {
          return '<li><span class="lv lv-' + esc(k.level) + '">' + esc(k.level) + "</span><span>" + esc(k.text) + "</span></li>";
        }).join("") + "</ul>");
      if (c.cad.notes && c.cad.notes.length) self.push('<p class="note">Opening notes: ' + esc(c.cad.notes.join("; ")) + "</p>");
      if (c.cad.pxPerIn) self.push('<p class="note">Scale fitted: ' + c.cad.pxPerIn.toFixed(2) + " px per inch" +
        (c.cad.scaleSpreadPct ? ", labels disagreeing by " + c.cad.scaleSpreadPct.toFixed(1) + "%" : "") + ".</p>");
      if (c.measured) self.push('<p class="note">Earlier automated scoring of this flat: ' + c.measured.recalled + " of " +
        c.measured.truth_rooms + " rooms found, " + c.measured.clean + " of them in a region of their own, from " +
        c.measured.spaces + " spaces.</p>");
    } else {
      self.push('<p class="note">Nothing to report: the generator stopped with <code>' + esc(c.error) + "</code></p>");
    }
    self.push('<p class="note">Read ' + (c.ms || "?") + " ms. Drawing in millimetres, internal walls 125 mm, external 250 mm &mdash; " +
      "those thicknesses are the client's spec, applied, never measured off the image. Do not flag them.</p>");
    $("selfFacts").innerHTML = self.join("");
  }

  /* ---------------- navigation ---------------- */

  function go(i) {
    if (i < 0 || i >= cases.length || i === cur) return;
    cur = i;
    var c = cases[cur];
    releaseFar();
    paintForm();
    renderIndex();
    if (c.ok && svgCache[c.id] === undefined) {
      svgCache[c.id] = null;
      fetch("cad/" + encodeURIComponent(c.id) + ".svg")
        .then(function (r) { return r.ok ? r.text() : Promise.reject(new Error(r.status)); })
        .then(function (t) { svgCache[c.id] = t; if (cases[cur].id === c.id) { paintPanes(); fitAll(); } })
        .catch(function () { svgCache[c.id] = ""; if (cases[cur].id === c.id) paintPanes(); });
    }
    paintPanes();
    fitAll();
    prefetchNeighbour();
  }

  function nextUnreviewed() {
    for (var k = 1; k <= cases.length; k++) {
      var i = (cur + k) % cases.length;
      if (!isReviewed(cases[i].id)) { go(i); return; }
    }
  }

  function setMode(m) {
    state.ui.mode = m;
    $("mSide").setAttribute("aria-pressed", m === "side");
    $("mOver").setAttribute("aria-pressed", m === "overlay");
    $("mFlip").setAttribute("aria-pressed", m === "flip");
    $("opacityWrap").hidden = m !== "overlay";
    markDirty();
    paintPanes();
    fitAll();
  }

  /* Both panels through one function, so a hidden panel always leaves its edge
     strip behind and the Focus button always says what it will do next. */
  function setPanels(index, review) {
    state.ui.index = index;
    state.ui.review = review;
    var m = $("main");
    m.classList.toggle("hide-index", !index);
    m.classList.toggle("hide-review", !review);
    $("indexToggle").setAttribute("aria-pressed", String(index));
    $("reviewToggle").setAttribute("aria-pressed", String(review));
    var both = !index && !review;
    $("focusBtn").setAttribute("aria-pressed", String(both));
    $("focusBtn").innerHTML = (both ? "Show panels " : "Focus ") + "<kbd>Z</kbd>";
    markDirty();
    requestAnimationFrame(fitAll);
  }

  function toggleFocus() {
    var both = !state.ui.index && !state.ui.review;
    setPanels(both, both);
  }

  function setLock(v) {
    state.ui.lock = v;
    $("lockBtn").setAttribute("aria-pressed", String(v));
    $("lockBtn").textContent = v ? "Panes locked" : "Panes free";
    if (v) { views.B = { z: views.A.z, x: views.A.x, y: views.A.y }; applyView("B"); readZoom(); }
    markDirty();
  }

  /* ---------------- CSV ---------------- */

  function csvCell(v) {
    var s = v == null ? "" : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function buildCsv() {
    var head = ["case_id", "block", "floor_plan", "flat", "split", "cad_generated", "cad_error",
      "verdict"].concat(FLAGKEYS).concat(["notes", "reviewed_at", "checker"]);
    var lines = [head.join(",")];
    cases.forEach(function (c) {
      var r = state.reviews[c.id] || { verdict: "", flags: [], notes: "", at: "" };
      var row = [c.id, c.block, c.floor, c.flat, c.split, c.ok ? "yes" : "no", c.ok ? "" : c.error, r.verdict || ""];
      FLAGKEYS.forEach(function (k) { row.push((r.flags || []).indexOf(k) !== -1 ? "yes" : ""); });
      row.push(r.notes || "", r.at || "", state.checker || "");
      lines.push(row.map(csvCell).join(","));
    });
    return lines.join("\r\n") + "\r\n";
  }

  function exportCsv() {
    var blob = new Blob(["﻿" + buildCsv()], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    var d = new Date(), p = function (n) { return String(n).padStart(2, "0"); };
    a.href = URL.createObjectURL(blob);
    a.download = "cad-review-" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + ".csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }

  function parseCsv(text) {
    var rows = [], row = [], cell = "", q = false;
    text = text.replace(/^﻿/, "");
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ",") { row.push(cell); cell = ""; }
      else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
      else if (ch !== "\r") cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.length > 1 || (r[0] || "").trim(); });
  }

  function importCsv(text) {
    var rows = parseCsv(text);
    if (!rows.length) { alert("That file has no rows in it."); return; }
    var head = rows[0].map(function (h) { return h.trim(); });
    var ix = {};
    head.forEach(function (h, i) { ix[h] = i; });
    if (ix.case_id === undefined) { alert("That CSV has no case_id column, so rows cannot be matched to cases."); return; }
    var known = {}, n = 0, unknown = 0;
    cases.forEach(function (c) { known[c.id] = true; });
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i], id = (r[ix.case_id] || "").trim();
      if (!id) continue;
      if (!known[id]) { unknown++; continue; }
      var rec = review(id);
      if (ix.verdict !== undefined) rec.verdict = (r[ix.verdict] || "").trim();
      if (ix.notes !== undefined) rec.notes = r[ix.notes] || "";
      var flags = [];
      FLAGKEYS.forEach(function (k) {
        if (ix[k] !== undefined && /^(yes|y|1|true|x)$/i.test((r[ix[k]] || "").trim())) flags.push(k);
      });
      rec.flags = flags;
      rec.at = (ix.reviewed_at !== undefined && r[ix.reviewed_at]) || new Date().toISOString();
      if (ix.checker !== undefined && (r[ix.checker] || "").trim() && !state.checker) {
        state.checker = r[ix.checker].trim();
        $("checker").value = state.checker;
      }
      n++;
    }
    save();
    paintForm(); renderIndex(); renderProgress();
    alert("Merged " + n + " review" + (n === 1 ? "" : "s") + " in." +
      (unknown ? " " + unknown + (unknown === 1 ? " row named a case that is not in this set and was skipped."
        : " rows named cases that are not in this set and were skipped.") : ""));
  }

  /* ---------------- about ---------------- */

  function buildAbout() {
    var failed = cases.filter(function (c) { return !c.ok; });
    $("aboutBody").innerHTML =
      "<p><b>" + cases.length + " cases.</b> These are the flats that have been annotated against the " +
      "architect's own printed room names and sizes, so they are the ones where an opinion can be checked " +
      "against something. The brochure holds <b>" + data.total_in_brochure + "</b> flats in total; " +
      "extending this set to all of them is a configuration change, not new work.</p>" +
      "<p><b>" + (cases.length - failed.length) + " produced a drawing. " + failed.length +
      " did not</b> and are shown as such rather than hidden — a plan the reader cannot read at all is " +
      "exactly what is worth knowing. All " + failed.length + " are from the pale, outline-walled pages.</p>" +
      "<p><b>Who drew these.</b> " + esc(data.reader) + ". " + esc(data.units) +
      " — those wall thicknesses are the client's standard, applied on purpose, not measured off the image.</p>" +
      "<p><b>Images.</b> The brochure plans are the original 400 dpi PNGs, byte for byte. The drawings are " +
      "vector SVG, so they stay sharp however far you zoom.</p>" +
      '<p class="note">Generated ' + esc((data.generated || "").slice(0, 16).replace("T", " ")) + " UTC.</p>";
  }

  /* ---------------- theme ---------------- */

  function applyTheme() {
    if (state.ui.theme) document.documentElement.setAttribute("data-theme", state.ui.theme);
    else document.documentElement.removeAttribute("data-theme");
    var b = $("themeBtn");
    if (!b) return;
    b.textContent = state.ui.theme === "dark" ? "Dark" : state.ui.theme === "light" ? "Light" : "Auto";
    b.title = "Theme: " + (state.ui.theme || "following the system") + " \u2014 click to change";
  }

  /* ---------------- wiring ---------------- */

  function wire() {
    $("search").addEventListener("input", renderIndex);

    Array.prototype.forEach.call(document.querySelectorAll(".chipbtn"), function (b) {
      b.addEventListener("click", function () {
        filter = b.dataset.filter;
        Array.prototype.forEach.call(document.querySelectorAll(".chipbtn"), function (o) {
          o.setAttribute("aria-pressed", String(o === b));
        });
        renderIndex();
      });
    });

    $("indexList").addEventListener("click", function (e) {
      var row = e.target.closest(".row");
      if (row) go(+row.dataset.i);
    });

    $("mSide").onclick = function () { setMode("side"); };
    $("mOver").onclick = function () { setMode("overlay"); };
    $("mFlip").onclick = function () { setMode("flip"); };

    $("opacity").addEventListener("input", function () {
      state.ui.opacity = +this.value;
      var l = document.querySelector("#cvA .cadlayer");
      if (l) l.style.opacity = state.ui.opacity / 100;
      markDirty();
    });

    $("lockBtn").onclick = function () { setLock(!state.ui.lock); };
    $("zIn").onclick = function () { zoomCentre(1.3); };
    $("zOut").onclick = function () { zoomCentre(1 / 1.3); };
    $("zFit").onclick = fitAll;
    $("zOne").onclick = oneToOne;
    $("prevBtn").onclick = function () { go(cur - 1); };
    $("nextBtn").onclick = function () { go(cur + 1); };
    $("todoBtn").onclick = nextUnreviewed;

    $("indexToggle").onclick = function () { setPanels(!state.ui.index, state.ui.review); };
    $("reviewToggle").onclick = function () { setPanels(state.ui.index, !state.ui.review); };
    $("focusBtn").onclick = toggleFocus;
    $("edgeL").onclick = function () { setPanels(true, state.ui.review); };
    $("edgeR").onclick = function () { setPanels(state.ui.index, true); };

    $("wheelBtn").onclick = function () {
      setWheelMode({ auto: "zoom", zoom: "pan", pan: "auto" }[state.ui.wheel] || "auto");
    };

    $("checker").addEventListener("input", function () { state.checker = this.value; markDirty(); });

    document.querySelector(".verdicts").addEventListener("change", function (e) {
      var r = review(cases[cur].id);
      r.verdict = e.target.value;
      stamp(r); markDirty(); renderIndex(); renderProgress(); paintForm();
    });

    $("notes").addEventListener("input", function () {
      var r = review(cases[cur].id);
      r.notes = this.value;
      stamp(r); markDirty(); renderIndex(); renderProgress();
    });

    $("exportCsv").onclick = exportCsv;
    $("importCsv").onclick = function () { $("csvFile").click(); };
    $("csvFile").addEventListener("change", function () {
      var f = this.files && this.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () { importCsv(String(fr.result)); };
      fr.readAsText(f);
      this.value = "";
    });

    $("themeBtn").onclick = function () {
      state.ui.theme = state.ui.theme === "dark" ? "light" : state.ui.theme === "light" ? null : "dark";
      applyTheme(); markDirty();
    };

    $("aboutBtn").onclick = function () { $("aboutDlg").showModal(); };
    $("helpBtn").onclick = function () { $("helpDlg").showModal(); };
    $("helpClose").onclick = function () { $("helpDlg").close(); };
    $("aboutClose").onclick = function () { $("aboutDlg").close(); };

    wireViewport("A");
    wireViewport("B");

    var ro = new ResizeObserver(function () { fitAll(); });
    ro.observe($("vpA"));

    document.addEventListener("keydown", function (e) {
      var t = e.target, typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (typing) {
        if (e.key === "Escape") t.blur();
        return;
      }
      if (e.key === "Escape" && !state.ui.index && !state.ui.review) { setPanels(true, true); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var k = e.key;
      if (k === "ArrowRight" || k === "j") { go(cur + 1); e.preventDefault(); }
      else if (k === "ArrowLeft" || k === "k") { go(cur - 1); e.preventDefault(); }
      else if (k === "u" || k === "U") { nextUnreviewed(); e.preventDefault(); }
      else if (k === "1" || k === "2" || k === "3") {
        var r = review(cases[cur].id);
        r.verdict = ["good", "minor", "unusable"][+k - 1];
        stamp(r); markDirty(); paintForm(); renderIndex(); renderProgress();
      }
      else if (k === "s" || k === "S") setMode("side");
      else if (k === "o" || k === "O") setMode("overlay");
      else if (k === "f" || k === "F") setMode("flip");
      else if (k === " ") {
        if (state.ui.mode !== "flip") setMode("flip");
        else { state.ui.flip = state.ui.flip === "cad" ? "plan" : "cad"; paintPanes(); }
        e.preventDefault();
      }
      else if (k === "l" || k === "L") setLock(!state.ui.lock);
      else if (k === "+" || k === "=") zoomCentre(1.3);
      else if (k === "-" || k === "_") zoomCentre(1 / 1.3);
      else if (k === "0") fitAll();
      else if (k === "9") oneToOne();
      else if (k === "z" || k === "Z") { toggleFocus(); }
      else if (k === "[") { setPanels(!state.ui.index, state.ui.review); }
      else if (k === "]") { setPanels(state.ui.index, !state.ui.review); }
      else if (k === "/") { $("notes").focus(); e.preventDefault(); }
      else if (k === "?") $("helpDlg").showModal();
    });
  }

  /* ---------------- boot ---------------- */

  fetch("cases.json")
    .then(function (r) { return r.json(); })
    .then(function (d) {
      data = d;
      cases = d.cases;
      load();
      applyTheme();
      $("checker").value = state.checker;
      buildTicks();
      buildAbout();
      wire();
      setPanels(state.ui.index !== false, state.ui.review !== false);
      paintWheelHint();
      $("lockBtn").setAttribute("aria-pressed", String(state.ui.lock));
      $("lockBtn").textContent = state.ui.lock ? "Panes locked" : "Panes free";
      $("opacity").value = state.ui.opacity;
      setMode(state.ui.mode);
      renderProgress();
      // Start where the work is, not at the top.
      var first = 0;
      for (var i = 0; i < cases.length; i++) if (!isReviewed(cases[i].id)) { first = i; break; }
      cur = -1;
      go(first);
      save();
    })
    .catch(function (e) {
      document.body.innerHTML = '<p style="padding:40px;font-family:sans-serif">' +
        "Could not load <code>cases.json</code> (" + esc(e.message) + "). " +
        "This page must be served over http, not opened from the filesystem.</p>";
    });
})();
