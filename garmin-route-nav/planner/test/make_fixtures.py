#!/usr/bin/env python3
"""Writes fixtures.json: synthetic routes plus the Python tool's output for
each, so test_routecore.js can check the JS port produces identical files."""
import json, os, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "tools"))
import gpx_to_route as g
import test_gpx_to_route as t

CASES = {
    "l_noisy": dict(legs=[(0, 500), (90, 500), (0, 300)], noise=2.0),
    "mixed": dict(legs=[(0, 300), (45, 300), (195, 300), (15, 300)], noise=0.0),
    "mixed_noisy": dict(legs=[(0, 500), (90, 500), (0, 300), (45, 300), (195, 300), (15, 300)], noise=2.0),
    "jog": dict(legs=[(0, 300), (90, 25), (0, 300)], noise=2.0),
    "arc": dict(legs=[(0, 200)] + t.arc(80, 180) + [(180, 300)] + t.arc(60, -120), noise=0.0),
    "out_back": dict(legs=[(0, 1000), (180, 1000)], noise=1.0),
}

out = {}
for name, c in CASES.items():
    pts = t.walk(c["legs"], noise=c["noise"], seed=7)
    with tempfile.NamedTemporaryFile("w", suffix=".gpx", delete=False) as f:
        f.write(t.gpx(pts))
    route, _ = g.build_route(f.name, "Case " + name)
    os.remove(f.name)
    out[name] = {"points": pts, "text": g.format_route(route)}
with open(os.path.join(HERE, "fixtures.json"), "w") as f:
    json.dump(out, f)
print("wrote", len(out), "fixtures")
