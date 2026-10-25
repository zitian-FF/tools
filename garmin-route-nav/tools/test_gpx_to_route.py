#!/usr/bin/env python3
"""Tests for gpx_to_route.py. Run: python3 test_gpx_to_route.py"""

import json
import math
import os
import random
import tempfile
import unittest

import gpx_to_route as g

LAT0, LON0 = 1.3521, 103.8198  # Singapore
M_LAT = 1 / 111195.0
M_LON = 1 / (111195.0 * math.cos(math.radians(LAT0)))


def walk(legs, step=5.0, noise=0.0, seed=1):
    """legs: list of (bearing_deg, metres). Returns (lat, lon) points."""
    rnd = random.Random(seed)
    x = y = 0.0
    pts = [(x, y)]
    for brg, dist in legs:
        dx, dy = math.sin(math.radians(brg)), math.cos(math.radians(brg))
        for _ in range(int(dist / step)):
            x += dx * step
            y += dy * step
            pts.append((x, y))
    return [(LAT0 + (py + rnd.gauss(0, noise)) * M_LAT,
             LON0 + (px + rnd.gauss(0, noise)) * M_LON) for px, py in pts]


def arc(radius, degrees, step=5.0):
    legs, n = [], int(math.radians(degrees) * radius / step)
    for i in range(n):
        legs.append((i * degrees / n, step))
    return legs


def gpx(track, wpts=()):
    w = "".join(f'<wpt lat="{la}" lon="{lo}"><name>{n}</name><type>{t}</type></wpt>'
                for la, lo, n, t in wpts)
    t = "".join(f'<trkpt lat="{la}" lon="{lo}"/>' for la, lo in track)
    return ('<?xml version="1.0"?><gpx version="1.1" '
            'xmlns="http://www.topografix.com/GPX/1/1">'
            f'{w}<trk><trkseg>{t}</trkseg></trk></gpx>')


class RouteTest(unittest.TestCase):
    def build(self, xml, name="Test"):
        with tempfile.NamedTemporaryFile("w", suffix=".gpx", delete=False) as f:
            f.write(xml)
        try:
            return g.build_route(f.name, name)
        finally:
            os.remove(f.name)

    def test_polyline_roundtrip(self):
        pts = walk([(30, 400), (200, 300)])
        back = g.decode_polyline(g.encode_polyline(pts))
        self.assertEqual(len(back), len(pts))
        for a, b in zip(pts, back):
            self.assertLess(g.haversine(a, b), 1.0)

    def test_known_polyline(self):
        # Example from Google's polyline documentation.
        pts = [(38.5, -120.2), (40.7, -120.95), (43.252, -126.453)]
        self.assertEqual(g.encode_polyline(pts), "_p~iF~ps|U_ulLnnqC_mqNvxq`@")

    def test_geometric_turns_with_gps_noise(self):
        track = walk([(0, 500), (90, 500), (0, 300)], noise=2.0)
        route, stats = self.build(gpx(track))
        self.assertEqual(stats["cue_source"], "geometry")
        kinds = [c[1] for c in route["cues"]]
        self.assertEqual(kinds, [g.CUE_RIGHT, g.CUE_LEFT, g.CUE_FINISH])
        pts = g.decode_polyline(route["pts"])
        corner1 = (LAT0 + 500 * M_LAT, LON0)
        self.assertLess(g.haversine(pts[route["cues"][0][0]], corner1), 15)

    def test_gentle_bend_not_announced(self):
        track = walk([(0, 200)] + arc(300, 90) + [(90, 200)])
        route, _ = self.build(gpx(track))
        self.assertEqual([c[1] for c in route["cues"]], [g.CUE_FINISH])

    def test_slight_sharp_and_uturn(self):
        track = walk([(0, 300), (45, 300), (195, 300), (15, 300)])
        route, _ = self.build(gpx(track))
        kinds = [c[1] for c in route["cues"]]
        self.assertEqual(kinds, [g.CUE_SLIGHT_RIGHT, g.CUE_SHARP_RIGHT,
                                 g.CUE_UTURN, g.CUE_FINISH])

    def test_mixed_turns_under_gps_noise(self):
        legs = [(0, 500), (90, 500), (0, 300), (45, 300), (195, 300), (15, 300)]
        want = [g.CUE_RIGHT, g.CUE_LEFT, g.CUE_SLIGHT_RIGHT, g.CUE_SHARP_RIGHT,
                g.CUE_UTURN, g.CUE_FINISH]
        for seed in range(20):
            route, _ = self.build(gpx(walk(legs, noise=2.0, seed=seed)))
            self.assertEqual([c[1] for c in route["cues"]], want, f"seed {seed}")

    def test_quick_jog_gives_two_cues(self):
        for jog in (25, 50, 80):
            route, _ = self.build(gpx(walk([(0, 300), (90, jog), (0, 300)], noise=2.0)))
            self.assertEqual([c[1] for c in route["cues"]],
                             [g.CUE_RIGHT, g.CUE_LEFT, g.CUE_FINISH], f"jog {jog} m")

    def test_gpx_cue_waypoints_win(self):
        track = walk([(0, 500), (90, 500)])
        corner = track[100]
        wpts = [(corner[0] + 5 * M_LAT, corner[1], "Right onto Orchard Rd", "Right")]
        route, stats = self.build(gpx(track, wpts))
        self.assertEqual(stats["cue_source"], "gpx")
        self.assertEqual(route["cues"][0][1], g.CUE_RIGHT)
        self.assertEqual(route["cues"][0][2], "Orchard Rd")

    def test_far_waypoint_ignored(self):
        track = walk([(0, 500), (90, 500)])
        wpts = [(track[50][0], track[50][1] + 200 * M_LON, "Cafe left", "Left")]
        _, stats = self.build(gpx(track, wpts))
        self.assertEqual(stats["cue_source"], "geometry")

    def test_simplified_line_stays_accurate(self):
        track = walk([(0, 200)] + arc(80, 180) + [(180, 300)] + arc(60, -120))
        route, stats = self.build(gpx(track))
        self.assertLess(stats["points_out"], stats["points_in"] / 2)
        simple = g.decode_polyline(route["pts"])
        xy = g.to_xy(simple, track)
        for p in g.to_xy(track):
            d = min(seg_dist(p, a, b) for a, b in zip(xy, xy[1:]))
            self.assertLess(d, g.SIMPLIFY_TOLERANCE + 1.5)

    def test_point_cap(self):
        rnd = random.Random(3)
        legs = [(rnd.uniform(0, 360), 20) for _ in range(3000)]
        route, stats = self.build(gpx(walk(legs, step=10)))
        self.assertLessEqual(stats["points_out"], g.MAX_POINTS)

    def test_cli_index(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "a.gpx")
            with open(src, "w") as f:
                f.write(gpx(walk([(0, 500), (90, 500)])))
            out = os.path.join(d, "out")
            g.main([src, "--name", "Coast Loop", "--out", out])
            g.main([src, "--name", "Hill Option", "--out", out])
            g.main([src, "--name", "Coast Loop", "--out", out])  # replace, not duplicate
            idx = load(os.path.join(out, "routes.json"))
            self.assertEqual([r["id"] for r in idx["routes"]], ["hill-option", "coast-loop"])
            self.assertTrue(os.path.exists(os.path.join(out, "coast-loop.json")))
            g.main(["--remove", "hill-option", "--out", out])
            idx = load(os.path.join(out, "routes.json"))
            self.assertEqual([r["id"] for r in idx["routes"]], ["coast-loop"])
            self.assertFalse(os.path.exists(os.path.join(out, "hill-option.json")))


def load(path):
    with open(path) as f:
        return json.load(f)


def seg_dist(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    seg2 = dx * dx + dy * dy
    t = 0 if seg2 == 0 else max(0, min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / seg2))
    return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)


if __name__ == "__main__":
    unittest.main()
