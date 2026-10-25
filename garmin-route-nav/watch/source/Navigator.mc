import Toybox.Lang;
import Toybox.Math;

// Matches GPS fixes onto the route and works out progress, the next turn and
// whether the rider is off course. Pure logic: no drawing or alerts.
//
// Positions are handled as Float degrees * 1e5 (the route's integer units),
// converted to local metres around the rider for the geometry.
class Navigator {

    const WINDOW_BACK = 100.0;       // normal search: this far back along the route
    const WINDOW_AHEAD = 400.0;      // ... and this far ahead
    const START_WINDOW = 500.0;      // first fix prefers the start of the route
    const LOOKAHEAD = 40.0;          // pointer aims at the route this far ahead
    const PASS_MARGIN = 15.0;        // a turn counts as passed this far after it
    const OFF_COURSE_FIXES = 2;      // consecutive bad fixes before alerting
    const JUMP_COST = 0.5;           // metres of cost per metre of implausible jump
    const FORWARD_SLACK = 40.0;      // progress allowed between fixes without cost

    var hasFix as Boolean;
    var joined as Boolean;           // has been on the route at least once
    var startDist as Float;          // metres to the route start (before joining)
    var offCourse as Boolean;
    var along as Float;              // metres along the route
    var offset as Float;             // metres from the route
    var seg as Number;               // matched segment (start point index)
    var nextCue as Number;           // index into route cue arrays, -1 if none
    var cueDist as Float;            // metres to next cue, negative just after it
    var remaining as Float;          // metres to the finish along the route
    var targetBearing as Float;      // degrees: rider to the route ahead
    var routeBearing as Float;       // degrees: direction of the matched segment
    var latE5 as Float;
    var lonE5 as Float;

    private var _route as Route;
    private var _threshold as Float;
    private var _badFixes as Number;
    private var _kx as Float;        // metres per 1e-5 degree of longitude here
    private var _ky as Float;        // metres per 1e-5 degree of latitude

    // Result of the last segment search.
    private var _bSeg as Number;
    private var _bDist as Float;
    private var _bT as Float;

    function initialize(route as Route, offCourseMetres as Number) {
        _route = route;
        _threshold = offCourseMetres.toFloat();
        hasFix = false;
        joined = false;
        startDist = 0.0;
        offCourse = false;
        along = 0.0;
        offset = 0.0;
        seg = 0;
        nextCue = -1;
        cueDist = 0.0;
        remaining = route.cum[route.cum.size() - 1];
        targetBearing = 0.0;
        routeBearing = 0.0;
        latE5 = 0.0;
        lonE5 = 0.0;
        _badFixes = 0;
        _ky = RouteParser.METRES_PER_E5.toFloat();
        _kx = _ky * Math.cos(Math.toRadians(route.lats[0] / 100000.0)).toFloat();
        _bSeg = 0;
        _bDist = 0.0;
        _bT = 0.0;
        routeBearing = segmentBearing(0);
    }

    function route() as Route {
        return _route;
    }

    // lat/lon in degrees. Call only with fixes of usable quality.
    function update(lat as Double or Float, lon as Double or Float) as Void {
        latE5 = (lat * 100000.0).toFloat();
        lonE5 = (lon * 100000.0).toFloat();
        _kx = _ky * Math.cos(Math.toRadians(lat)).toFloat();
        var last = _route.pointCount() - 2;

        if (!hasFix) {
            // Prefer the start, so loops and out-and-backs (whose finish is
            // also close by) begin at the beginning.
            search(0, indexAt(START_WINDOW), false);
            if (_bDist > _threshold) {
                search(0, last, false);
            }
            hasFix = true;
        } else {
            search(indexAt(along - WINDOW_BACK), indexAt(along + WINDOW_AHEAD), true);
            if (_bDist > _threshold) {
                // Lost the route near where we were: maybe a shortcut or a
                // detour that rejoins further on. Take a global match only
                // if it is actually on the route.
                var wSeg = _bSeg;
                var wDist = _bDist;
                var wT = _bT;
                search(0, last, false);
                if (_bDist > _threshold) {
                    _bSeg = wSeg;
                    _bDist = wDist;
                    _bT = wT;
                }
            }
        }

        seg = _bSeg;
        offset = _bDist;
        var c = _route.cum;
        along = c[seg] + _bT * (c[seg + 1] - c[seg]);
        remaining = c[c.size() - 1] - along;
        routeBearing = segmentBearing(seg);

        if (offset <= _threshold) {
            joined = true;
        }
        if (!joined) {
            _badFixes = 0;
        } else if (offset > _threshold) {
            _badFixes++;
        } else if (offset < _threshold * 0.75) {
            _badFixes = 0;
        }
        if (_badFixes >= OFF_COURSE_FIXES) {
            offCourse = true;
        } else if (_badFixes == 0) {
            offCourse = false;
        }

        updateCue();

        // Not yet on the route: point to its start. Off course: point back to
        // the closest bit of route. Otherwise point a little ahead along it,
        // which reads as "the way to go".
        if (!joined) {
            var s0 = toLocal(0);
            startDist = Math.sqrt(s0[0] * s0[0] + s0[1] * s0[1]).toFloat();
            targetBearing = normalise(Math.toDegrees(Math.atan2(s0[0], s0[1])).toFloat());
            return;
        }
        var t = pointAt(offCourse ? along : along + LOOKAHEAD);
        targetBearing = bearingTo(t[0], t[1]);
    }

    private function updateCue() as Void {
        var r = _route;
        nextCue = -1;
        for (var i = 0; i < r.cueIndex.size(); i++) {
            var d = r.cum[r.cueIndex[i]] - along;
            if (d > -PASS_MARGIN) {
                nextCue = i;
                cueDist = d;
                return;
            }
        }
    }

    // Finds the closest segment in [from, to] (start indices, inclusive).
    // With `track` set, a candidate that would move us backwards, or further
    // forward than a bike gets between fixes, costs extra. Where the route
    // uses the same road twice (out-and-back, lollipop) the match then stays
    // on the pass being ridden instead of hopping to the other one.
    private function search(from as Number, to as Number, track as Boolean) as Void {
        var lats = _route.lats;
        var lons = _route.lons;
        var cum = _route.cum;
        var best = 1.0e9;      // lowest cost so far; cost >= distance
        var bestDist = 1.0e9;
        var bestSeg = from;
        var bestT = 0.0;
        if (to > lats.size() - 2) {
            to = lats.size() - 2;
        }
        var bx = (lons[from] - lonE5) * _kx;
        var by = (lats[from] - latE5) * _ky;
        for (var i = from; i <= to; i++) {
            var ax = bx;
            var ay = by;
            bx = (lons[i + 1] - lonE5) * _kx;
            by = (lats[i + 1] - latE5) * _ky;
            // Cheap reject: segment's box doesn't come within `best` of us.
            if ((ax > best && bx > best) || (ax < -best && bx < -best) ||
                (ay > best && by > best) || (ay < -best && by < -best)) {
                continue;
            }
            var dx = bx - ax;
            var dy = by - ay;
            var len2 = dx * dx + dy * dy;
            var t = 0.0;
            if (len2 > 0) {
                t = -(ax * dx + ay * dy) / len2;
                t = t < 0 ? 0.0 : (t > 1 ? 1.0 : t);
            }
            var cx = ax + t * dx;
            var cy = ay + t * dy;
            var d = Math.sqrt(cx * cx + cy * cy).toFloat();
            var cost = d;
            if (track) {
                var move = cum[i] + t * (cum[i + 1] - cum[i]) - along;
                if (move < 0) {
                    cost -= move * JUMP_COST;
                } else if (move > FORWARD_SLACK) {
                    cost += (move - FORWARD_SLACK) * JUMP_COST;
                }
            }
            if (cost < best) {
                best = cost;
                bestDist = d;
                bestSeg = i;
                bestT = t;
            }
        }
        _bSeg = bestSeg;
        _bDist = bestDist;
        _bT = bestT.toFloat();
    }

    // Last point index with cum <= d, clamped to a valid segment start.
    function indexAt(d as Float) as Number {
        var c = _route.cum;
        var lo = 0;
        var hi = c.size() - 2;
        if (d <= 0) {
            return 0;
        }
        while (lo < hi) {
            var mid = (lo + hi + 1) / 2;
            if (c[mid] <= d) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        return lo;
    }

    // [latE5, lonE5] of the point d metres along the route.
    function pointAt(d as Float) as Array<Float> {
        var r = _route;
        var i = indexAt(d);
        var len = r.cum[i + 1] - r.cum[i];
        var t = len > 0 ? (d - r.cum[i]) / len : 0.0;
        t = t < 0 ? 0.0 : (t > 1 ? 1.0 : t);
        return [(r.lats[i] + t * (r.lats[i + 1] - r.lats[i])).toFloat(),
                (r.lons[i] + t * (r.lons[i + 1] - r.lons[i])).toFloat()];
    }

    function bearingTo(lat as Float, lon as Float) as Float {
        var dx = (lon - lonE5) * _kx;
        var dy = (lat - latE5) * _ky;
        return normalise(Math.toDegrees(Math.atan2(dx, dy)).toFloat());
    }

    function segmentBearing(i as Number) as Float {
        var r = _route;
        var dx = (r.lons[i + 1] - r.lons[i]) * _kx;
        var dy = (r.lats[i + 1] - r.lats[i]) * _ky;
        return normalise(Math.toDegrees(Math.atan2(dx, dy)).toFloat());
    }

    // Local metres east/north of the rider for route point i.
    function toLocal(i as Number) as Array<Float> {
        return [((_route.lons[i] - lonE5) * _kx).toFloat(),
                ((_route.lats[i] - latE5) * _ky).toFloat()];
    }

    function normalise(deg as Float) as Float {
        while (deg < 0) {
            deg += 360.0;
        }
        while (deg >= 360) {
            deg -= 360.0;
        }
        return deg;
    }
}
