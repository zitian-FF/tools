// Route conversion for the RouteNav planner: a port of tools/gpx_to_route.py
// (same constants, same RNR1/RNI1 text formats), plus turn hints from
// BRouter checked against the route's geometry. Runs in the browser and in
// Node (for tests).
(function (root) {
  "use strict";

  const CUE = {
    STRAIGHT: 0, SLIGHT_LEFT: 1, LEFT: 2, SHARP_LEFT: 3, UTURN: 4,
    SLIGHT_RIGHT: 5, RIGHT: 6, SHARP_RIGHT: 7, FINISH: 8,
  };

  const EARTH_R = 6371000.0;
  const SIMPLIFY_TOLERANCE = 4.0;
  const MAX_POINTS = 1500;
  const TURN_WINDOW = 40.0;
  const TURN_SMOOTH = 15.0;
  const TURN_MIN_ANGLE = 35.0;
  const TURN_MIN_GAP = 10.0;
  const HINT_GAP = 40.0;   // geometry cues this close to a routing hint are dropped
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;

  // ------------------------------------------------------------- geometry

  function haversine(a, b) {
    const lat1 = rad(a[0]), lat2 = rad(b[0]);
    const h = Math.sin((lat2 - lat1) / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(rad(b[1] - a[1]) / 2) ** 2;
    return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function angleDiff(b1, b2) {
    const d = (((b2 - b1) % 360) + 360) % 360;
    return d > 180 ? d - 360 : d;
  }

  function toXY(points, ref) {
    ref = ref || points;
    let s = 0;
    for (const p of ref) s += p[0];
    const k = Math.cos(rad(s / ref.length));
    return points.map((p) => [rad(p[1]) * EARTH_R * k, rad(p[0]) * EARTH_R]);
  }

  function cumulative(points) {
    const out = [0];
    for (let i = 1; i < points.length; i++) out.push(out[i - 1] + haversine(points[i - 1], points[i]));
    return out;
  }

  function dedupe(points) {
    const out = [points[0]];
    for (const p of points.slice(1)) if (haversine(out[out.length - 1], p) >= 0.5) out.push(p);
    return out;
  }

  function smoothXY(xy, cum, radius) {
    const out = [];
    const n = xy.length;
    let lo = 0, hi = 0, sx = 0, sy = 0;
    for (let i = 0; i < n; i++) {
      while (hi < n && cum[hi] - cum[i] <= radius) { sx += xy[hi][0]; sy += xy[hi][1]; hi++; }
      while (cum[i] - cum[lo] > radius) { sx -= xy[lo][0]; sy -= xy[lo][1]; lo++; }
      out.push([sx / (hi - lo), sy / (hi - lo)]);
    }
    return out;
  }

  function xyBearing(a, b) {
    return ((deg(Math.atan2(b[0] - a[0], b[1] - a[1])) % 360) + 360) % 360;
  }

  function bisectLeft(arr, x) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
  }

  function cueFromAngle(delta) {
    const a = Math.abs(delta);
    if (a < TURN_MIN_ANGLE) return null;
    if (a >= 165) return CUE.UTURN;
    let kind;
    if (a < 60) kind = [CUE.SLIGHT_LEFT, CUE.SLIGHT_RIGHT];
    else if (a < 130) kind = [CUE.LEFT, CUE.RIGHT];
    else kind = [CUE.SHARP_LEFT, CUE.SHARP_RIGHT];
    return delta > 0 ? kind[1] : kind[0];
  }

  // Turn angle measurer over the smoothed line (see geometric_cues in the
  // Python tool). Returns {cum, angleAt(i, window)}.
  function turnMeter(points, cum0) {
    const n = points.length;
    const xy = smoothXY(toXY(points), cum0, TURN_SMOOTH);
    const cum = [0];
    for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
    const total = cum[n - 1];
    function at(d) {
      const k = Math.max(1, Math.min(n - 1, bisectLeft(cum, d)));
      const seg = cum[k] - cum[k - 1];
      const t = seg === 0 ? 0 : (d - cum[k - 1]) / seg;
      return [xy[k - 1][0] + t * (xy[k][0] - xy[k - 1][0]), xy[k - 1][1] + t * (xy[k][1] - xy[k - 1][1])];
    }
    function angleAt(i, window) {
      const c = cum[i];
      if (c < window || total - c < window) return null;
      return angleDiff(xyBearing(at(c - window), at(c - TURN_SMOOTH)),
                       xyBearing(at(c + TURN_SMOOTH), at(c + window)));
    }
    return { cum, angleAt };
  }

  function geometricCues(points, cum0) {
    const n = points.length;
    const m = turnMeter(points, cum0);
    const cum = m.cum;
    const candidates = [];
    for (let i = 1; i < n - 1; i++) {
      const delta = m.angleAt(i, TURN_WINDOW);
      if (delta !== null && Math.abs(delta) >= TURN_MIN_ANGLE) candidates.push([i, delta]);
    }
    candidates.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    const cues = new Map();
    const accepted = [];
    for (const [i, delta] of candidates) {
      let clash = false;
      for (const [j, d2] of accepted) {
        const gap = Math.abs(cum[i] - cum[j]);
        const sameWay = (delta > 0) === (d2 > 0) || Math.abs(d2) >= 130;
        if (gap < TURN_MIN_GAP || (gap < TURN_WINDOW + TURN_SMOOTH && sameWay)) { clash = true; break; }
      }
      if (clash) continue;
      accepted.push([i, delta]);
      cues.set(i, [i, cueFromAngle(delta), ""]);
    }
    return cues;
  }

  // BRouter voice hint commands -> cue types. Roundabouts (14, 15) and any
  // unknown command take their direction from the geometry instead.
  const BROUTER_CMD = {
    1: CUE.STRAIGHT, 2: CUE.LEFT, 3: CUE.SLIGHT_LEFT, 4: CUE.SHARP_LEFT,
    5: CUE.RIGHT, 6: CUE.SLIGHT_RIGHT, 7: CUE.SHARP_RIGHT,
    8: CUE.SLIGHT_LEFT, 9: CUE.SLIGHT_RIGHT, 10: CUE.UTURN, 11: CUE.UTURN, 12: CUE.UTURN,
  };
  const IGNORED_CMD = { 13: true, 16: true };   // off-route, beeline
  const LEFT_CUES = [CUE.SLIGHT_LEFT, CUE.LEFT, CUE.SHARP_LEFT];
  const RIGHT_CUES = [CUE.SLIGHT_RIGHT, CUE.RIGHT, CUE.SHARP_RIGHT];

  // hints: [[pointIndex, command], ...] indexing the raw (pre-dedupe) points.
  // Each hint is checked against the road's actual shape: if the geometry
  // clearly turns the other way, the geometry wins. Clear bends the router
  // didn't mention are added from geometry.
  function hintCues(points, cum, hints, rawToDeduped) {
    const m = turnMeter(points, cum);
    const cues = new Map();
    for (const h of hints) {
      const idx = rawToDeduped[h[0]];
      if (idx === undefined || idx <= 0 || idx >= points.length - 1 || IGNORED_CMD[h[1]]) continue;
      const delta = m.angleAt(idx, TURN_WINDOW);
      const wide = m.angleAt(idx, TURN_WINDOW * 1.5);
      let kind = BROUTER_CMD[h[1]];
      if (kind === undefined) {
        kind = wide !== null ? cueFromAngle(wide) : null;
      } else if (delta !== null && Math.abs(delta) >= TURN_MIN_ANGLE) {
        const geo = cueFromAngle(delta);
        const wrongSide = (LEFT_CUES.includes(kind) && delta > 0) ||
                          (RIGHT_CUES.includes(kind) && delta < 0) ||
                          (kind === CUE.STRAIGHT && Math.abs(delta) >= 60);
        if (wrongSide) kind = geo;
      }
      if (kind === null || kind === CUE.STRAIGHT) continue;
      cues.set(idx, [idx, kind, ""]);
    }
    const hintAt = [...cues.keys()].map((i) => m.cum[i]);
    for (const [i, cue] of geometricCues(points, cum)) {
      if (hintAt.every((c) => Math.abs(c - m.cum[i]) >= HINT_GAP)) cues.set(i, cue);
    }
    return cues;
  }

  function rdp(xy, first, last, tol, keep) {
    const stack = [[first, last]];
    while (stack.length) {
      const [s, e] = stack.pop();
      const [x1, y1] = xy[s], [x2, y2] = xy[e];
      const dx = x2 - x1, dy = y2 - y1, seg2 = dx * dx + dy * dy;
      let best = null, bestD = tol;
      for (let i = s + 1; i < e; i++) {
        const [px, py] = xy[i];
        let d;
        if (seg2 === 0) d = Math.hypot(px - x1, py - y1);
        else {
          const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / seg2));
          d = Math.hypot(px - x1 - t * dx, py - y1 - t * dy);
        }
        if (d > bestD) { best = i; bestD = d; }
      }
      if (best !== null) { keep.add(best); stack.push([s, best]); stack.push([best, e]); }
    }
  }

  function simplify(points, forced, tol) {
    const xy = toXY(points);
    const keep = new Set([0, points.length - 1, ...forced]);
    const anchors = [...keep].sort((a, b) => a - b);
    for (let k = 0; k + 1 < anchors.length; k++) rdp(xy, anchors[k], anchors[k + 1], tol, keep);
    return [...keep].sort((a, b) => a - b);
  }

  // Python's round() rounds halves to even; match it so both tools agree.
  function pyRound(x) {
    const f = Math.floor(x), d = x - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
  }

  function encodePolyline(points) {
    let out = "", plat = 0, plon = 0;
    for (const [lat, lon] of points) {
      const ilat = pyRound(lat * 1e5), ilon = pyRound(lon * 1e5);
      for (let v of [ilat - plat, ilon - plon]) {
        v = v < 0 ? ~(v << 1) : v << 1;
        while (v >= 0x20) { out += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
        out += String.fromCharCode(v + 63);
      }
      plat = ilat; plon = ilon;
    }
    return out;
  }

  function decodePolyline(s) {
    const pts = [];
    let i = 0, lat = 0, lon = 0;
    while (i < s.length) {
      const vals = [];
      for (let k = 0; k < 2; k++) {
        let shift = 0, result = 0, b;
        do { b = s.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        vals.push(result & 1 ? ~(result >> 1) : result >> 1);
      }
      lat += vals[0]; lon += vals[1];
      pts.push([lat / 1e5, lon / 1e5]);
    }
    return pts;
  }

  // points: [[lat, lon], ...]; hints: optional BRouter voice hints.
  // Returns {route, stats} like build_route in the Python tool.
  function buildRoute(rawPoints, name, hints) {
    if (rawPoints.length < 2) throw new Error("Route has fewer than 2 points");
    // Map raw indices onto the deduped list so hints still line up.
    const points = [rawPoints[0]];
    const rawToDeduped = { 0: 0 };
    for (let i = 1; i < rawPoints.length; i++) {
      if (haversine(points[points.length - 1], rawPoints[i]) >= 0.5) points.push(rawPoints[i]);
      rawToDeduped[i] = points.length - 1;
    }
    if (points.length < 2) throw new Error("Route is too short");
    const cum = cumulative(points);

    let cues, source;
    if (hints && hints.length) { cues = hintCues(points, cum, hints, rawToDeduped); source = "router+geometry"; }
    else { cues = geometricCues(points, cum); source = "geometry"; }
    cues.delete(0);
    const last = points.length - 1;
    cues.set(last, [last, CUE.FINISH, ""]);

    let tol = SIMPLIFY_TOLERANCE;
    let kept = simplify(points, cues.keys(), tol);
    while (kept.length > MAX_POINTS) { tol *= 1.5; kept = simplify(points, cues.keys(), tol); }
    const remap = new Map(kept.map((old, i) => [old, i]));
    const simple = kept.map((i) => points[i]);

    const outCues = [...cues.keys()].sort((a, b) => a - b).map((i) => {
      const [idx, kind, label] = cues.get(i);
      return label ? [remap.get(idx), kind, label] : [remap.get(idx), kind];
    });
    const route = { name, dist: pyRound(cum[last]), pts: encodePolyline(simple), cues: outCues };
    const stats = { pointsIn: points.length, pointsOut: simple.length, toleranceM: tol,
                    cueSource: source, turns: outCues.length - 1 };
    return { route, stats };
  }

  // ---------------------------------------------------------- text formats

  function clean(text) {
    return String(text).replace(/[|;,\r\n]/g, " ").replace(/\s+/g, " ").trim();
  }

  function formatRoute(route) {
    const cues = route.cues.map((c) => c.map((x, i) => (i < 2 ? String(x) : clean(x))).join(",")).join(";");
    return ["RNR1", clean(route.name), String(route.dist), cues, route.pts].join("\n") + "\n";
  }

  function parseIndex(text) {
    const lines = (text || "").split("\n").map((l) => l.replace(/\r$/, ""));
    const routes = [];
    if (lines[0] !== "RNI1") return routes;
    for (const line of lines.slice(1)) {
      if (!line) continue;
      const f = line.split("|");
      if (f.length >= 4) routes.push({ id: f[0], name: f[1], dist: parseInt(f[2], 10) || 0, file: f[3] });
    }
    return routes;
  }

  function formatIndex(routes) {
    return ["RNI1", ...routes.map((r) => [r.id, clean(r.name), String(r.dist), r.file].join("|"))].join("\n") + "\n";
  }

  function slugify(name) {
    const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return s.slice(0, 40) || "route";
  }

  const api = { CUE, buildRoute, formatRoute, parseIndex, formatIndex, slugify, clean,
                encodePolyline, decodePolyline, haversine };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RouteCore = api;
})(typeof self !== "undefined" ? self : this);
