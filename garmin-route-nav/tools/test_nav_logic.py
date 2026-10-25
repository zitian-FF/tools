#!/usr/bin/env python3
"""Simulated rides against a line-by-line Python mirror of the watch's route
matching (watch/source/Navigator.mc) and turn alerts (NavView.checkAlerts).

Monkey C can't run here, so this is how the matching logic is tested. Keep
it in step with the watch code when either changes.
Run: python3 test_nav_logic.py
"""
import math, random, unittest
import gpx_to_route as g
import test_gpx_to_route as t

M_E5 = 1.11195

class Route:
    def __init__(self, text):
        r = g.parse_route(text)
        pts = g.decode_polyline(r["pts"])
        self.lats = [round(p[0] * 1e5) for p in pts]
        self.lons = [round(p[1] * 1e5) for p in pts]
        self.cueIndex = [c[0] for c in r["cues"]]
        self.cueType = [c[1] for c in r["cues"]]
        self.cum = [0.0]
        for i in range(1, len(pts)):
            mid = math.radians((self.lats[i-1] + self.lats[i]) / 200000.0)
            dy = (self.lats[i] - self.lats[i-1]) * M_E5
            dx = (self.lons[i] - self.lons[i-1]) * M_E5 * math.cos(mid)
            self.cum.append(self.cum[-1] + math.hypot(dx, dy))

class Nav:
    WINDOW_BACK, WINDOW_AHEAD, START_WINDOW, LOOKAHEAD, PASS_MARGIN, OFF = 100.0, 400.0, 500.0, 40.0, 15.0, 2
    def __init__(s, r, thr=40):
        s.r, s.thr = r, float(thr)
        s.hasFix = s.joined = s.offCourse = False
        s.along = s.offset = 0.0; s.seg = 0; s.nextCue = -1; s.cueDist = 0.0
        s.bad = 0; s.ky = M_E5; s.kx = M_E5 * math.cos(math.radians(r.lats[0] / 1e5))
    def indexAt(s, d):
        c = s.r.cum; lo, hi = 0, len(c) - 2
        if d <= 0: return 0
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if c[mid] <= d: lo = mid
            else: hi = mid - 1
        return lo
    def search(s, fr, to, track):
        lats, lons, cum = s.r.lats, s.r.lons, s.r.cum
        best, bd, bs, bt = 1e9, 1e9, fr, 0.0
        to = min(to, len(lats) - 2)
        bx = (lons[fr] - s.lon) * s.kx; by = (lats[fr] - s.lat) * s.ky
        for i in range(fr, to + 1):
            ax, ay = bx, by
            bx = (lons[i+1] - s.lon) * s.kx; by = (lats[i+1] - s.lat) * s.ky
            if (ax > best and bx > best) or (ax < -best and bx < -best) or (ay > best and by > best) or (ay < -best and by < -best):
                continue
            dx, dy = bx - ax, by - ay; l2 = dx*dx + dy*dy; tt = 0.0
            if l2 > 0: tt = min(1.0, max(0.0, -(ax*dx + ay*dy) / l2))
            d = math.hypot(ax + tt*dx, ay + tt*dy)
            cost = d
            if track:
                move = cum[i] + tt * (cum[i+1] - cum[i]) - s.along
                if move < 0: cost -= move * 0.5
                elif move > 40.0: cost += (move - 40.0) * 0.5
            if cost < best: best, bd, bs, bt = cost, d, i, tt
        s.bSeg, s.bDist, s.bT = bs, bd, bt
    def update(s, lat, lon):
        s.lat, s.lon = lat * 1e5, lon * 1e5
        s.kx = s.ky * math.cos(math.radians(lat))
        last = len(s.r.lats) - 2
        if not s.hasFix:
            s.search(0, s.indexAt(s.START_WINDOW), False)
            if s.bDist > s.thr: s.search(0, last, False)
            s.hasFix = True
        else:
            s.search(s.indexAt(s.along - s.WINDOW_BACK), s.indexAt(s.along + s.WINDOW_AHEAD), True)
            if s.bDist > s.thr:
                w = (s.bSeg, s.bDist, s.bT)
                s.search(0, last, False)
                if s.bDist > s.thr: s.bSeg, s.bDist, s.bT = w
        s.seg, s.offset = s.bSeg, s.bDist
        c = s.r.cum
        s.along = c[s.seg] + s.bT * (c[s.seg+1] - c[s.seg])
        if s.offset <= s.thr: s.joined = True
        if not s.joined: s.bad = 0
        elif s.offset > s.thr: s.bad += 1
        elif s.offset < s.thr * 0.75: s.bad = 0
        if s.bad >= s.OFF: s.offCourse = True
        elif s.bad == 0: s.offCourse = False
        s.nextCue = -1
        for i, ci in enumerate(s.r.cueIndex):
            d = c[ci] - s.along
            if d > -s.PASS_MARGIN:
                s.nextCue, s.cueDist = i, d; break

class Alerts:
    def __init__(a, nav, warn=150):
        a.nav, a.warn = nav, warn; a.wup = a.nup = -1; a.was = False; a.log = []
    def check(a, speed, tick):
        n = a.nav
        if not n.joined: return
        if n.offCourse != a.was:
            a.was = n.offCourse; a.log.append((tick, "OFF" if n.offCourse else "BACK", round(n.along)))
        if n.offCourse or n.nextCue < 0: return
        cue = n.nextCue; typ = n.r.cueType[cue]
        if typ == 0: return
        nowDist = max(25.0, speed * 5)
        if cue > a.nup and n.cueDist <= nowDist:
            a.nup = a.wup = cue; a.log.append((tick, f"NOW type{typ}", round(n.cueDist)))
        elif cue > a.wup and n.cueDist <= a.warn:
            a.wup = cue; a.log.append((tick, f"WARN type{typ}", round(n.cueDist)))

def make_route(legs):
    import tempfile, os
    with tempfile.NamedTemporaryFile("w", suffix=".gpx", delete=False) as f:
        f.write(t.gpx(t.walk(legs))); name = f.name
    r, _ = g.build_route(name, "x"); os.remove(name)
    return Route(g.format_route(r))

def ride(route, path_xy_legs, speed=7.0, noise=3.0, seed=0, start=(0.0, 0.0)):
    """Rider follows legs (bearing, metres) from start offset (x, y metres)."""
    rnd = random.Random(seed)
    nav = Nav(route); al = Alerts(nav)
    x, y = start; tick = 0; trace = []
    for brg, dist in path_xy_legs:
        steps = int(dist / speed)
        for _ in range(steps):
            x += math.sin(math.radians(brg)) * speed; y += math.cos(math.radians(brg)) * speed
            lat = t.LAT0 + (y + rnd.gauss(0, noise)) * t.M_LAT
            lon = t.LON0 + (x + rnd.gauss(0, noise)) * t.M_LON
            nav.update(lat, lon); al.check(speed, tick)
            trace.append((tick, round(nav.along), round(nav.offset), nav.offCourse, nav.joined)); tick += 1
    return nav, al, trace


L_ROUTE = [(0, 500), (90, 500), (0, 300)]
L_ALERTS = ["WARN type6", "NOW type6", "WARN type2", "NOW type2", "WARN type8", "NOW type8"]
OUT_BACK = [(0, 1000), (180, 1000)]


class NavLogicTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.L = make_route(L_ROUTE)
        cls.OB = make_route(OUT_BACK)

    def test_follow_route_under_noise(self):
        for seed in range(20):
            nav, al, tr = ride(self.L, L_ROUTE, noise=5.0, seed=seed)
            self.assertEqual([x[1] for x in al.log], L_ALERTS, f"seed {seed}")
            self.assertFalse(any(x[3] for x in tr))

    def test_turn_warning_distances(self):
        nav, al, tr = ride(self.L, L_ROUTE, noise=3.0)
        for tick, kind, dist in al.log:
            if kind.startswith("WARN"):
                self.assertTrue(130 <= dist <= 150, (kind, dist))
            else:
                self.assertTrue(15 <= dist <= 40, (kind, dist))

    def test_out_and_back_stays_on_ridden_pass(self):
        for speed in (3.0, 7.0, 12.0):
            for seed in range(10):
                nav, al, tr = ride(self.OB, OUT_BACK, noise=4.0, seed=seed, speed=speed)
                uturns = [x for x in al.log if x[1] == "NOW type4"]
                self.assertEqual(len(uturns), 1, f"speed {speed} seed {seed}")
                self.assertGreater(tr[-1][1], 1900)
                self.assertFalse(any(b[1] < a[1] - 20 for a, b in zip(tr, tr[1:])))

    def test_lollipop(self):
        legs = [(0, 600), (90, 300), (0, 300), (270, 300), (180, 300), (180, 600)]
        r = make_route(legs)
        for seed in range(10):
            nav, al, tr = ride(r, legs, noise=3.0, seed=seed)
            self.assertFalse(any(abs(b[1] - a[1]) > 40 for a, b in zip(tr, tr[1:])))
            self.assertGreater(tr[-1][1], r.cum[-1] - 40)

    def test_detour_alerts_off_then_back(self):
        path = [(0, 250), (270, 120), (0, 100), (90, 120), (0, 150), (90, 500), (0, 300)]
        nav, al, tr = ride(self.L, path)
        kinds = [x[1] for x in al.log]
        self.assertEqual(kinds[:2], ["OFF", "BACK"])
        self.assertEqual(kinds[2:], L_ALERTS)

    def test_shortcut_rejoins_further_on(self):
        path = [(0, 300), (45, 283), (90, 300), (0, 300)]
        nav, al, tr = ride(self.L, path)
        kinds = [x[1] for x in al.log]
        self.assertEqual(kinds[:2], ["OFF", "BACK"])
        self.assertGreater(al.log[1][2], 600)   # rejoined after the corner

    def test_start_away_from_route(self):
        nav, al, tr = ride(self.L, [(0, 2000)] + L_ROUTE, start=(0, -2000))
        self.assertFalse(tr[0][4])
        self.assertNotIn("OFF", [x[1] for x in al.log])
        self.assertEqual([x[1] for x in al.log][:4], L_ALERTS[:4])

    def test_loop_starts_at_beginning(self):
        legs = [(0, 400), (90, 400), (180, 400), (270, 400)]
        r = make_route(legs)
        nav, al, tr = ride(r, legs)
        self.assertLess(tr[0][1], 30)
        self.assertGreater(tr[-1][1], r.cum[-1] - 20)


if __name__ == "__main__":
    unittest.main()
