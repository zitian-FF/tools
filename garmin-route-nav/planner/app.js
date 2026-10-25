// RouteNav planner: pick a destination, compare cycling routes from BRouter,
// and save the chosen ones to the Gist the watch app downloads from.
(function () {
  "use strict";

  const BROUTER = "https://brouter.de/brouter";
  const NOMINATIM = "https://nominatim.openstreetmap.org/search";
  const GITHUB = "https://api.github.com";
  const OPTIONS = [
    { key: "fast", label: "Fastest", profile: "fastbike", alt: 0 },
    { key: "quiet", label: "Quieter", profile: "safety", alt: 0 },
    { key: "alt", label: "Alternative", profile: "fastbike", alt: 1 },
  ];

  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem("routenav." + k) || ""; } catch (e) { return ""; } },
    set(k, v) { try { localStorage.setItem("routenav." + k, v); } catch (e) { /* private mode */ } },
  };

  // ------------------------------------------------------------------ map

  const map = L.map("map", { zoomControl: false }).setView([1.3521, 103.8198], 12);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, routing <a href="https://brouter.de">BRouter</a>',
  }).addTo(map);

  const pinIcon = (color, text) => L.divIcon({
    className: "", iconSize: [26, 26], iconAnchor: [13, 13],
    html: `<div class="pin" style="background:${color}">${text}</div>`,
  });

  let start = null, dest = null, destName = "";
  const stops = [];   // via point markers
  let results = [];   // [{opt, points, hints, dist, climb, time, layer}]
  let selected = -1;
  let planSeq = 0;    // drops responses from superseded requests
  let previewLayer = null;
  const PIN_LABEL = "Pin on map";

  // label: what the From box shows; empty means "my location".
  function setStart(latlng, label) {
    $("from").value = label || "";
    if (start) start.setLatLng(latlng);
    else {
      start = L.marker(latlng, { icon: pinIcon("#2e7d32", "S"), draggable: true }).addTo(map);
      start.on("dragend", () => { $("from").value = PIN_LABEL; plan(); });
    }
    plan();
  }

  function setDest(latlng, name) {
    destName = name || "";
    $("q").value = name || PIN_LABEL;
    if (dest) dest.setLatLng(latlng);
    else {
      dest = L.marker(latlng, { icon: pinIcon("#c62828", "&#9873;"), draggable: true }).addTo(map);
      dest.on("dragend", () => { destName = ""; $("q").value = PIN_LABEL; plan(); });
    }
    plan();
  }

  function addStop(latlng) {
    const m = L.marker(latlng, { icon: pinIcon("#1565c0", stops.length + 1), draggable: true }).addTo(map);
    m.on("dragend", plan);
    m.on("click", () => {
      const btn = document.createElement("button");
      btn.textContent = "Remove stop";
      btn.className = "danger";
      btn.onclick = () => { map.closePopup(); removeStop(m); };
      L.popup().setLatLng(m.getLatLng()).setContent(btn).openOn(map);
    });
    stops.push(m);
    plan();
  }

  function removeStop(m) {
    map.removeLayer(m);
    stops.splice(stops.indexOf(m), 1);
    stops.forEach((s, i) => s.setIcon(pinIcon("#1565c0", i + 1)));
    plan();
  }

  map.on("click", (e) => {
    const box = document.createElement("div");
    box.style.display = "grid";
    box.style.gap = "6px";
    const add = (text, fn) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.onclick = () => { map.closePopup(); fn(e.latlng); };
      box.appendChild(b);
    };
    add("Go here", (ll) => setDest(ll, ""));
    if (start && dest) add("Add stop", addStop);
    add("Start here", (ll) => setStart(ll, PIN_LABEL));
    L.popup().setLatLng(e.latlng).setContent(box).openOn(map);
  });

  // onLoad: the automatic lookup at page load, which mustn't replace a start
  // the user already picked while it was running.
  function locate(onLoad) {
    if (!navigator.geolocation) return status("This browser can't share its location.", "err");
    status("Finding your location...");
    navigator.geolocation.getCurrentPosition((p) => {
      status("");
      if (onLoad && start) return;
      const ll = L.latLng(p.coords.latitude, p.coords.longitude);
      if (!dest) map.setView(ll, 15, { animate: false });
      setStart(ll, "");
    }, () => status("Location not available. Search a start or tap the map.", "err"),
    { enableHighAccuracy: true, timeout: 15000 });
  }
  $("locate").onclick = () => locate(false);

  // --------------------------------------------------------------- search

  // Both boxes search the same way; picking a result sets start or destination.
  $("fromForm").onsubmit = (e) => {
    e.preventDefault();
    const q = $("from").value.trim();
    if (!q || q === PIN_LABEL) return locate(false);   // empty From = my location
    search(q, $("fromForm"), (ll, name) => setStart(ll, name));
  };
  $("searchForm").onsubmit = (e) => {
    e.preventDefault();
    const q = $("q").value.trim();
    if (q && q !== PIN_LABEL) search(q, $("searchForm"), setDest);
  };
  // Typing over a "Pin on map" label starts fresh.
  for (const id of ["from", "q"]) {
    $(id).addEventListener("focus", () => { if ($(id).value === PIN_LABEL) $(id).value = ""; });
  }

  async function search(q, form, onPick) {
    form.querySelector("input").blur();
    const b = map.getBounds();
    const params = new URLSearchParams({
      q, format: "jsonv2", limit: "6", "accept-language": "en",
      viewbox: [b.getWest(), b.getNorth(), b.getEast(), b.getSouth()].join(","),
    });
    status("Searching...");
    try {
      const res = await fetch(NOMINATIM + "?" + params);
      if (!res.ok) throw new Error("search service returned " + res.status);
      showResults(await res.json(), form, onPick);
      status("");
    } catch (err) {
      status("Search failed: " + err.message, "err");
    }
  }

  function showResults(list, form, onPick) {
    const box = $("results");
    box.style.top = (form.getBoundingClientRect().bottom + 6) + "px";
    box.innerHTML = "";
    if (!list.length) {
      box.innerHTML = "<div>No places found. Try a street or area name, or tap the map.</div>";
    }
    for (const r of list) {
      const div = document.createElement("div");
      const parts = r.display_name.split(", ");
      div.innerHTML = `<b></b><small></small>`;
      div.querySelector("b").textContent = r.name || parts[0];
      div.querySelector("small").textContent = parts.slice(1, 4).join(", ");
      div.onclick = () => {
        box.classList.add("hidden");
        const ll = L.latLng(+r.lat, +r.lon);
        onPick(ll, r.name || parts[0]);
        if (!start || !dest) map.setView(ll, 15, { animate: false });
      };
      box.appendChild(div);
    }
    box.classList.remove("hidden");
  }
  map.on("movestart", () => $("results").classList.add("hidden"));

  // -------------------------------------------------------------- routing

  async function fetchRoute(opt, lonlats) {
    const params = new URLSearchParams({
      lonlats, profile: opt.profile, alternativeidx: String(opt.alt), format: "geojson", timode: "3",
    });
    const res = await fetch(BROUTER + "?" + params);
    const text = await res.text();
    if (!res.ok) throw new Error(text.trim().slice(0, 120) || "routing failed");
    const f = JSON.parse(text).features[0];
    const p = f.properties || {};
    return {
      opt,
      points: f.geometry.coordinates.map((c) => [c[1], c[0]]),
      hints: Array.isArray(p.voicehints) ? p.voicehints.map((h) => [h[0], h[1]]) : [],
      dist: +p["track-length"] || 0,
      climb: +p["filtered ascend"] || 0,
      time: +p["total-time"] || 0,
    };
  }

  async function plan() {
    if (!start || !dest) return;
    const seq = ++planSeq;
    clearRoutes();
    const pts = [start, ...stops, dest].map((m) => m.getLatLng());
    const lonlats = pts.map((p) => p.lng.toFixed(6) + "," + p.lat.toFixed(6)).join("|");
    status("Finding routes...");
    const settled = await Promise.allSettled(OPTIONS.map((o) => fetchRoute(o, lonlats)));
    if (seq !== planSeq) return;
    results = [];
    for (const s of settled) {
      if (s.status !== "fulfilled") continue;
      // An alternative identical to one we already have isn't a choice.
      const dup = results.some((r) => Math.abs(r.dist - s.value.dist) < 20 &&
                                      Math.abs(r.climb - s.value.climb) < 5);
      if (!dup) results.push(s.value);
    }
    if (!results.length) {
      const why = settled[0].reason ? settled[0].reason.message : "";
      return status("No route found. " + why, "err");
    }
    status("");
    results.forEach((r, i) => {
      r.layer = L.polyline(r.points, { weight: 5, opacity: 0.7 }).addTo(map);
      r.layer.on("click", (e) => { L.DomEvent.stopPropagation(e); select(i); });
    });
    renderOptions();
    select(0);
    fitRoute(L.featureGroup(results.map((r) => r.layer)).getBounds());
  }

  // Fit a route between the search boxes and the bottom sheet. (Jumps to a
  // searched place are not animated: Leaflet drops a fit requested while a
  // zoom animation is still running.)
  function fitRoute(bounds) {
    map.fitBounds(bounds, {
      paddingTopLeft: [24, $("top").getBoundingClientRect().bottom + 16],
      paddingBottomRight: [24, $("sheet").getBoundingClientRect().height + 16],
    });
  }

  function clearRoutes() {
    results.forEach((r) => r.layer && map.removeLayer(r.layer));
    results = [];
    selected = -1;
    $("planned").classList.add("hidden");
    $("intro").classList.remove("hidden");
  }

  function renderOptions() {
    const box = $("options");
    box.innerHTML = "";
    results.forEach((r, i) => {
      const div = document.createElement("div");
      div.className = "opt";
      div.innerHTML = "<b></b><span></span><span></span>";
      div.querySelector("b").textContent = r.opt.label;
      const spans = div.querySelectorAll("span");
      spans[0].textContent = (r.dist / 1000).toFixed(1) + " km · " + Math.round(r.time / 60) + " min";
      spans[1].textContent = "↑ " + Math.round(r.climb) + " m climb";
      div.onclick = () => select(i);
      box.appendChild(div);
    });
    $("intro").classList.add("hidden");
    $("planned").classList.remove("hidden");
  }

  function select(i) {
    selected = i;
    results.forEach((r, j) => {
      r.layer.setStyle(j === i ? { color: "#1565c0", weight: 7, opacity: 0.95 }
                               : { color: "#888", weight: 5, opacity: 0.6 });
      if (j === i) r.layer.bringToFront();
    });
    [...$("options").children].forEach((el, j) => el.classList.toggle("sel", j === i));
    const base = destName ? "To " + destName : "Ride " + new Date().toLocaleDateString();
    $("routeName").value = results.length > 1 && i > 0 ? `${base} (${results[i].opt.label.toLowerCase()})` : base;
  }

  // ----------------------------------------------------------------- gist

  async function gh(method, path, body) {
    const token = store.get("token");
    if (!token) throw new Error("Add your GitHub token in Settings first.");
    const res = await fetch(GITHUB + path, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) throw new Error("GitHub rejected the token. Check it in Settings.");
      if (res.status === 404) throw new Error("Gist not found. Check the Gist ID in Settings, or the token's Gist permission.");
      throw new Error("GitHub error " + res.status + ": " + (data.message || ""));
    }
    return data;
  }

  // Returns the gist, creating a secret one on first use.
  async function getGist() {
    let id = store.get("gistId");
    if (!id) {
      const g = await gh("POST", "/gists", {
        description: "RouteNav routes", public: false,
        files: { "routes.txt": { content: RouteCore.formatIndex([]) } },
      });
      rememberGist(g);
      return g;
    }
    const g = await gh("GET", "/gists/" + id);
    rememberGist(g);
    return g;
  }

  function rememberGist(g) {
    store.set("gistId", g.id);
    if (g.owner && g.owner.login) store.set("gistOwner", g.owner.login);
  }

  function gistLink() {
    const id = store.get("gistId"), owner = store.get("gistOwner");
    return id && owner ? `https://gist.github.com/${owner}/${id}` : "";
  }

  async function fileText(gist, name) {
    const f = gist.files[name];
    if (!f) return "";
    if (!f.truncated) return f.content;
    return (await fetch(f.raw_url)).text();
  }

  $("saveBtn").onclick = async () => {
    const r = results[selected];
    if (!r) return;
    const name = RouteCore.clean($("routeName").value) || "Route";
    $("saveBtn").disabled = true;
    try {
      const { route, stats } = RouteCore.buildRoute(r.points, name, r.hints);
      const id = RouteCore.slugify(name);
      status("Saving...");
      const gist = await getGist();
      const index = RouteCore.parseIndex(await fileText(gist, "routes.txt"));
      if (index.some((e) => e.id === id) && !confirm(`Replace the saved route "${name}"?`)) {
        return status("");
      }
      const file = id + ".txt";
      const newIndex = index.filter((e) => e.id !== id).concat([{ id, name, dist: route.dist, file }]);
      await gh("PATCH", "/gists/" + gist.id, {
        files: {
          [file]: { content: RouteCore.formatRoute(route) },
          "routes.txt": { content: RouteCore.formatIndex(newIndex) },
        },
      });
      const first = index.length === 0;
      status(`Saved "${name}" (${stats.turns} ${stats.turns === 1 ? "turn" : "turns"}). On the watch: Routes > Refresh list.` +
             (first ? " First save: copy the Gist link from Settings into the Garmin Connect app." : ""), "ok");
    } catch (err) {
      status(err.message, "err");
    } finally {
      $("saveBtn").disabled = false;
    }
  };

  // ------------------------------------------------------------ my routes

  $("routesBtn").onclick = async () => {
    const list = $("routeList");
    list.innerHTML = "<p>Loading...</p>";
    $("routesDlg").showModal();
    try {
      if (!store.get("gistId")) throw new Error("No routes saved yet.");
      const gist = await getGist();
      const index = RouteCore.parseIndex(await fileText(gist, "routes.txt"));
      list.innerHTML = index.length ? "" : "<p>No routes saved yet.</p>";
      for (const e of index) {
        const row = document.createElement("div");
        row.className = "item";
        row.innerHTML = "<div><b></b><small></small></div><button class='danger'>Delete</button>";
        row.querySelector("b").textContent = e.name;
        row.querySelector("small").textContent = (e.dist / 1000).toFixed(1) + " km";
        row.querySelector("div").onclick = async () => {
          $("routesDlg").close();
          showSaved(await fileText(gist, e.file));
        };
        row.querySelector("button").onclick = async () => {
          if (!confirm(`Delete "${e.name}"?`)) return;
          try {
            await gh("PATCH", "/gists/" + gist.id, {
              files: {
                [e.file]: null,
                "routes.txt": { content: RouteCore.formatIndex(index.filter((x) => x.id !== e.id)) },
              },
            });
            row.remove();
            index.splice(index.indexOf(e), 1);
          } catch (err) {
            alert(err.message);
          }
        };
        list.appendChild(row);
      }
    } catch (err) {
      list.innerHTML = "";
      const p = document.createElement("p");
      p.textContent = err.message;
      list.appendChild(p);
    }
  };
  $("routesClose").onclick = () => $("routesDlg").close();

  function showSaved(text) {
    const lines = (text || "").split("\n");
    if (lines[0] !== "RNR1") return status("That route file looks damaged.", "err");
    if (previewLayer) map.removeLayer(previewLayer);
    previewLayer = L.polyline(RouteCore.decodePolyline(lines[4]), { color: "#6a1b9a", weight: 6, dashArray: "8 6" })
      .addTo(map);
    fitRoute(previewLayer.getBounds());
    status(`Showing saved route "${lines[1]}" (dashed).`);
  }

  // ------------------------------------------------------------- settings

  function openSettings() {
    $("token").value = store.get("token");
    $("gistId").value = store.get("gistId");
    const link = gistLink();
    $("gistLink").textContent = link;
    $("gistInfo").classList.toggle("hidden", !link);
    $("settings").showModal();
  }
  $("settingsBtn").onclick = openSettings;
  $("settingsClose").onclick = () => $("settings").close();
  $("settingsSave").onclick = async () => {
    const newId = $("gistId").value.trim().replace(/^.*\//, "");   // accept a pasted Gist URL
    if (newId !== store.get("gistId")) store.set("gistOwner", "");
    store.set("token", $("token").value.trim());
    store.set("gistId", newId);
    $("settings").close();
    if (store.get("token")) {
      try {
        status("Checking GitHub access...");
        await getGist();
        status("GitHub connected.", "ok");
        openSettings();
      } catch (err) {
        status(err.message, "err");
      }
    }
  };
  $("copyLink").onclick = async () => {
    try { await navigator.clipboard.writeText(gistLink()); $("copyLink").textContent = "Copied"; }
    catch (e) { /* select manually */ }
  };

  function status(text, kind) {
    const el = $("status");
    el.textContent = text;
    el.className = kind || "";
  }

  if (!store.get("token")) status("First time? Open Settings (⚙) to connect GitHub.");
  locate(true);
})();
