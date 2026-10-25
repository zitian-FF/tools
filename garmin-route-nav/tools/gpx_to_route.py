#!/usr/bin/env python3
"""Convert a GPX file into a compact route file for the RouteNav watch app.

Usage:
    python3 gpx_to_route.py ride.gpx --name "Coast loop" [--out ../routes]
    python3 gpx_to_route.py --remove coast-loop [--out ../routes]

Each run writes <id>.json and updates routes.json (the index the watch reads
to offer a choice of routes). Upload everything in the output folder to the
Gist. Standard library only.

Route file format (v1):
    {"v": 1, "name": str, "dist": metres,
     "pts": Google-encoded polyline (precision 5),
     "cues": [[point_index, cue_type, "optional label"], ...]}

Cue types: see CUE_* below. Turn cues come from the GPX itself when it has
them (waypoints / route points named like "Turn left"), otherwise they are
detected from the route's geometry.
"""

import argparse
import bisect
import json
import math
import os
import re
import sys
import xml.etree.ElementTree as ET

CUE_STRAIGHT = 0
CUE_SLIGHT_LEFT = 1
CUE_LEFT = 2
CUE_SHARP_LEFT = 3
CUE_UTURN = 4
CUE_SLIGHT_RIGHT = 5
CUE_RIGHT = 6
CUE_SHARP_RIGHT = 7
CUE_FINISH = 8

EARTH_R = 6371000.0

# Tuning. Distances in metres, angles in degrees.
SIMPLIFY_TOLERANCE = 4.0      # max deviation of simplified line from the GPX
MAX_POINTS = 1500             # keeps download size and watch memory in check
TURN_WINDOW = 40.0            # look this far before/after a point for bearing
TURN_SMOOTH = 15.0            # GPS-noise smoothing radius for turn detection
TURN_MIN_ANGLE = 35.0         # smaller bends are not announced
TURN_MIN_GAP = 10.0           # never two cues closer than this
WPT_SNAP_DIST = 30.0          # GPX cue waypoints further than this are ignored
LABEL_MAX = 24


# ---------------------------------------------------------------- geometry

def haversine(a, b):
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    h = (math.sin((lat2 - lat1) / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2)
    return 2 * EARTH_R * math.asin(min(1.0, math.sqrt(h)))


def bearing(a, b):
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    y = math.sin(lon2 - lon1) * math.cos(lat2)
    x = (math.cos(lat1) * math.sin(lat2)
         - math.sin(lat1) * math.cos(lat2) * math.cos(lon2 - lon1))
    return math.degrees(math.atan2(y, x)) % 360


def angle_diff(b1, b2):
    """Signed change from bearing b1 to b2, in (-180, 180]. Positive = right."""
    d = (b2 - b1) % 360
    return d - 360 if d > 180 else d


def to_xy(points, ref=None):
    """Local equirectangular projection in metres, fine at route scale.
    Pass the same ref points to keep separate calls in one frame."""
    ref = ref or points
    lat0 = math.radians(sum(p[0] for p in ref) / len(ref))
    k = math.cos(lat0)
    return [(math.radians(lon) * EARTH_R * k, math.radians(lat) * EARTH_R)
            for lat, lon in points]


def cumulative(points):
    out = [0.0]
    for i in range(1, len(points)):
        out.append(out[-1] + haversine(points[i - 1], points[i]))
    return out


# ------------------------------------------------------------------ parsing

def local(tag):
    return tag.rsplit("}", 1)[-1]


def child_text(el, name):
    for c in el:
        if local(c.tag) == name and c.text:
            return c.text.strip()
    return ""


def parse_gpx(path):
    root = ET.parse(path).getroot()
    trk, rte, wpts = [], [], []
    for el in root.iter():
        tag = local(el.tag)
        if tag not in ("trkpt", "rtept", "wpt"):
            continue
        try:
            pt = (float(el.get("lat")), float(el.get("lon")))
        except (TypeError, ValueError):
            continue
        text = " ".join(child_text(el, n) for n in ("type", "name", "desc", "cmt", "sym"))
        item = {"pt": pt, "text": text, "name": child_text(el, "name")}
        {"trkpt": trk, "rtept": rte, "wpt": wpts}[tag].append(item)
    # Prefer the detailed track; route points then act like cue waypoints.
    if trk:
        return trk, wpts + rte
    return rte, wpts


def cue_from_text(text):
    t = text.lower()
    if re.search(r"u[- ]?turn", t):
        return CUE_UTURN
    side = None
    if re.search(r"\bleft\b", t):
        side = "L"
    elif re.search(r"\bright\b", t):
        side = "R"
    if side is None:
        if re.search(r"\b(straight|continue)\b", t):
            return CUE_STRAIGHT
        return None
    if re.search(r"\bsharp\b", t):
        return CUE_SHARP_LEFT if side == "L" else CUE_SHARP_RIGHT
    if re.search(r"\b(slight|keep|bear|fork)\b", t):
        return CUE_SLIGHT_LEFT if side == "L" else CUE_SLIGHT_RIGHT
    return CUE_LEFT if side == "L" else CUE_RIGHT


def cue_from_angle(delta):
    a = abs(delta)
    if a < TURN_MIN_ANGLE:
        return None
    if a >= 165:
        return CUE_UTURN
    if a < 60:
        kind = (CUE_SLIGHT_LEFT, CUE_SLIGHT_RIGHT)
    elif a < 130:
        kind = (CUE_LEFT, CUE_RIGHT)
    else:
        kind = (CUE_SHARP_LEFT, CUE_SHARP_RIGHT)
    return kind[1] if delta > 0 else kind[0]


def short_label(name):
    """Keep a street-ish label from a GPX cue, dropping the direction words."""
    s = re.sub(r"(?i)\b(turn|slight|sharp|keep|bear|left|right|onto|on|to|"
               r"continue|straight|u-?turn)\b", " ", name)
    s = re.sub(r"\s+", " ", s).strip(" ,.-")
    return s[:LABEL_MAX]


# ---------------------------------------------------------------- pipeline

def dedupe(points):
    out = [points[0]]
    for p in points[1:]:
        if haversine(out[-1], p) >= 0.5:
            out.append(p)
    return out


def gpx_cues(points, cum, cue_items):
    """Snap GPX cue waypoints onto the route, walking forward so out-and-back
    routes match each cue to the right pass."""
    xy = to_xy(points)
    cues = {}
    search_from = 0
    for item in cue_items:
        kind = cue_from_text(item["text"])
        if kind is None:
            continue
        wx, wy = to_xy([item["pt"]], points)[0]
        best, best_d = None, WPT_SNAP_DIST
        # Search forward first; fall back to the whole route if unordered.
        for rng in (range(search_from, len(points)), range(0, len(points))):
            for i in rng:
                d = math.hypot(xy[i][0] - wx, xy[i][1] - wy)
                if d < best_d:
                    best, best_d = i, d
            if best is not None:
                break
        if best is None:
            continue
        search_from = best
        cues[best] = [best, kind, short_label(item["name"])]
    return cues


def smooth_xy(xy, cum, radius):
    """Average each point with its neighbours within radius metres."""
    out = []
    lo = hi = 0
    sx = sy = 0.0
    n = len(xy)
    for i in range(n):
        while hi < n and cum[hi] - cum[i] <= radius:
            sx += xy[hi][0]
            sy += xy[hi][1]
            hi += 1
        while cum[i] - cum[lo] > radius:
            sx -= xy[lo][0]
            sy -= xy[lo][1]
            lo += 1
        out.append((sx / (hi - lo), sy / (hi - lo)))
    return out


def xy_bearing(a, b):
    return math.degrees(math.atan2(b[0] - a[0], b[1] - a[1])) % 360


def geometric_cues(points, cum):
    n = len(points)
    xy = smooth_xy(to_xy(points), cum, TURN_SMOOTH)
    # Distances along the smoothed line; raw GPS jitter inflates them.
    cum = [0.0]
    for i in range(1, n):
        cum.append(cum[-1] + math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]))
    total = cum[-1]

    def at(d):
        k = max(1, min(n - 1, bisect.bisect_left(cum, d)))
        seg = cum[k] - cum[k - 1]
        t = 0.0 if seg == 0 else (d - cum[k - 1]) / seg
        return (xy[k - 1][0] + t * (xy[k][0] - xy[k - 1][0]),
                xy[k - 1][1] + t * (xy[k][1] - xy[k - 1][1]))

    # Compare the leg before and after each point, skipping the part near the
    # point itself that smoothing rounds off.
    candidates = []
    for i in range(1, n - 1):
        c = cum[i]
        if c < TURN_WINDOW or total - c < TURN_WINDOW:
            continue
        delta = angle_diff(xy_bearing(at(c - TURN_WINDOW), at(c - TURN_SMOOTH)),
                           xy_bearing(at(c + TURN_SMOOTH), at(c + TURN_WINDOW)))
        if abs(delta) >= TURN_MIN_ANGLE:
            candidates.append((i, delta))
    # Peak picking: strongest bends first. A bend's shoulders also exceed the
    # threshold in the same direction, so suppress same-direction candidates
    # within a window plus the smoothing blur; opposite turns (a quick
    # right-left jog) stay separate.
    # Sharp and U-turn bends flip sign with noise, so they count as both ways.
    cues = {}
    accepted = []
    for i, delta in sorted(candidates, key=lambda c: -abs(c[1])):
        clash = False
        for j, d2 in accepted:
            gap = abs(cum[i] - cum[j])
            same_way = (delta > 0) == (d2 > 0) or abs(d2) >= 130
            if gap < TURN_MIN_GAP or (gap < TURN_WINDOW + TURN_SMOOTH and same_way):
                clash = True
                break
        if clash:
            continue
        accepted.append((i, delta))
        cues[i] = [i, cue_from_angle(delta), ""]
    return cues


def rdp(xy, first, last, tol, keep):
    stack = [(first, last)]
    while stack:
        s, e = stack.pop()
        (x1, y1), (x2, y2) = xy[s], xy[e]
        dx, dy = x2 - x1, y2 - y1
        seg2 = dx * dx + dy * dy
        best, best_d = None, tol
        for i in range(s + 1, e):
            px, py = xy[i]
            if seg2 == 0:
                d = math.hypot(px - x1, py - y1)
            else:
                t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / seg2))
                d = math.hypot(px - x1 - t * dx, py - y1 - t * dy)
            if d > best_d:
                best, best_d = i, d
        if best is not None:
            keep.add(best)
            stack.append((s, best))
            stack.append((best, e))


def simplify(points, forced, tol):
    xy = to_xy(points)
    keep = {0, len(points) - 1} | set(forced)
    anchors = sorted(keep)
    for s, e in zip(anchors, anchors[1:]):
        rdp(xy, s, e, tol, keep)
    return sorted(keep)


def encode_polyline(points):
    out = []
    plat = plon = 0
    for lat, lon in points:
        ilat, ilon = round(lat * 1e5), round(lon * 1e5)
        for v in (ilat - plat, ilon - plon):
            v = ~(v << 1) if v < 0 else v << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        plat, plon = ilat, ilon
    return "".join(out)


def decode_polyline(s):
    pts, i, lat, lon = [], 0, 0, 0
    while i < len(s):
        vals = []
        for _ in range(2):
            shift = result = 0
            while True:
                b = ord(s[i]) - 63
                i += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            vals.append(~(result >> 1) if result & 1 else result >> 1)
        lat += vals[0]
        lon += vals[1]
        pts.append((lat / 1e5, lon / 1e5))
    return pts


def build_route(path, name):
    track, cue_items = parse_gpx(path)
    if len(track) < 2:
        raise ValueError("GPX has fewer than 2 track/route points")
    points = dedupe([t["pt"] for t in track])
    cum = cumulative(points)

    cues = gpx_cues(points, cum, cue_items)
    source = "gpx"
    if not any(c[1] != CUE_STRAIGHT for c in cues.values()):
        cues = geometric_cues(points, cum)
        source = "geometry"
    cues.pop(0, None)
    last = len(points) - 1
    cues[last] = [last, CUE_FINISH, ""]

    tol = SIMPLIFY_TOLERANCE
    kept = simplify(points, cues.keys(), tol)
    while len(kept) > MAX_POINTS:
        tol *= 1.5
        kept = simplify(points, cues.keys(), tol)
    remap = {old: new for new, old in enumerate(kept)}
    simple = [points[i] for i in kept]

    out_cues = []
    for i in sorted(cues):
        idx, kind, label = cues[i]
        out_cues.append([remap[idx], kind, label] if label else [remap[idx], kind])

    route = {
        "v": 1,
        "name": name,
        "dist": round(cum[-1]),
        "pts": encode_polyline(simple),
        "cues": out_cues,
    }
    stats = {"points_in": len(points), "points_out": len(simple),
             "tolerance_m": round(tol, 1), "cue_source": source,
             "turns": len(out_cues) - 1}
    return route, stats


def slugify(name):
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s[:40] or "route"


def load_index(out_dir):
    path = os.path.join(out_dir, "routes.json")
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return {"v": 1, "routes": []}


def save_json(path, data):
    with open(path, "w") as f:
        json.dump(data, f, separators=(",", ":"), ensure_ascii=False)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("gpx", nargs="?", help="input GPX file")
    ap.add_argument("--name", help="route name shown on the watch")
    ap.add_argument("--id", help="file id (default: from name)")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "routes"))
    ap.add_argument("--remove", metavar="ID", help="remove a route from the index")
    args = ap.parse_args(argv)

    os.makedirs(args.out, exist_ok=True)
    index = load_index(args.out)

    if args.remove:
        index["routes"] = [r for r in index["routes"] if r["id"] != args.remove]
        f = os.path.join(args.out, args.remove + ".json")
        if os.path.exists(f):
            os.remove(f)
        save_json(os.path.join(args.out, "routes.json"), index)
        print("removed", args.remove)
        return 0

    if not args.gpx:
        ap.error("a GPX file is required")
    name = args.name or os.path.splitext(os.path.basename(args.gpx))[0]
    rid = args.id or slugify(name)
    route, stats = build_route(args.gpx, name)

    filename = rid + ".json"
    save_json(os.path.join(args.out, filename), route)
    entry = {"id": rid, "name": name, "dist": route["dist"], "file": filename}
    index["routes"] = [r for r in index["routes"] if r["id"] != rid] + [entry]
    save_json(os.path.join(args.out, "routes.json"), index)

    size = os.path.getsize(os.path.join(args.out, filename))
    print(f"{name}: {route['dist'] / 1000:.1f} km, {stats['points_in']} -> "
          f"{stats['points_out']} points (tol {stats['tolerance_m']} m), "
          f"{stats['turns']} turn cues from {stats['cue_source']}, {size} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
