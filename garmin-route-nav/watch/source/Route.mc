import Toybox.Lang;
import Toybox.Math;
import Toybox.StringUtil;

// Cue types, matching gpx_to_route.py.
enum {
    CUE_STRAIGHT = 0,
    CUE_SLIGHT_LEFT = 1,
    CUE_LEFT = 2,
    CUE_SHARP_LEFT = 3,
    CUE_UTURN = 4,
    CUE_SLIGHT_RIGHT = 5,
    CUE_RIGHT = 6,
    CUE_SHARP_RIGHT = 7,
    CUE_FINISH = 8
}

// A route decoded from the RNR1 text format (see tools/gpx_to_route.py).
// Coordinates are kept as integer degrees * 1e5 so no precision is lost to
// 32-bit floats.
class Route {
    var name as String;
    var distance as Number;         // metres, as measured on the full GPX
    var lats as Array<Number>;
    var lons as Array<Number>;
    var cum as Array<Float>;        // metres along route at each point
    var cueIndex as Array<Number>;
    var cueType as Array<Number>;
    var cueLabel as Array<String>;

    function initialize() {
        name = "";
        distance = 0;
        lats = [] as Array<Number>;
        lons = [] as Array<Number>;
        cum = [] as Array<Float>;
        cueIndex = [] as Array<Number>;
        cueType = [] as Array<Number>;
        cueLabel = [] as Array<String>;
    }

    function pointCount() as Number {
        return lats.size();
    }

    function turnCount() as Number {
        var n = 0;
        for (var i = 0; i < cueType.size(); i++) {
            if (cueType[i] != CUE_FINISH) {
                n++;
            }
        }
        return n;
    }
}

module RouteParser {

    const METRES_PER_E5 = 1.11195;   // metres per 1e-5 degree of latitude

    // Returns a Route, or null if the text is not a valid route file.
    function parse(text as String) as Route or Null {
        var lines = TextUtil.lines(text);
        if (lines.size() < 5 || !lines[0].equals("RNR1")) {
            return null;
        }
        var route = new Route();
        route.name = lines[1];
        var dist = lines[2].toNumber();
        route.distance = dist != null ? dist : 0;

        if (!decodePolyline(lines[4], route)) {
            return null;
        }
        var n = route.pointCount();

        var cues = lines[3].length() > 0 ? TextUtil.split(lines[3], ";") : [] as Array<String>;
        for (var i = 0; i < cues.size(); i++) {
            var f = TextUtil.split(cues[i], ",");
            if (f.size() < 2) {
                continue;
            }
            var idx = f[0].toNumber();
            var type = f[1].toNumber();
            if (idx == null || type == null || idx < 0 || idx >= n) {
                continue;
            }
            route.cueIndex.add(idx);
            route.cueType.add(type);
            route.cueLabel.add(f.size() > 2 ? f[2] : "");
        }

        computeDistances(route);
        return route;
    }

    // Google encoded polyline, precision 5.
    function decodePolyline(s as String, route as Route) as Boolean {
        var bytes = StringUtil.convertEncodedString(s, {
            :fromRepresentation => StringUtil.REPRESENTATION_STRING_PLAIN_TEXT,
            :toRepresentation => StringUtil.REPRESENTATION_BYTE_ARRAY
        }) as ByteArray;
        var n = bytes.size();
        var i = 0;
        var lat = 0;
        var lon = 0;
        while (i < n) {
            var vals = [0, 0];
            for (var k = 0; k < 2; k++) {
                var result = 0;
                var shift = 0;
                var b = 0x20;
                while (b >= 0x20) {
                    if (i >= n) {
                        return false;   // truncated file
                    }
                    b = bytes[i] - 63;
                    i++;
                    result |= (b & 0x1f) << shift;
                    shift += 5;
                }
                vals[k] = (result & 1) != 0 ? ~(result >> 1) : (result >> 1);
            }
            lat += vals[0];
            lon += vals[1];
            route.lats.add(lat);
            route.lons.add(lon);
        }
        return route.lats.size() >= 2;
    }

    function computeDistances(route as Route) as Void {
        var n = route.pointCount();
        var cum = new [n] as Array<Float>;
        cum[0] = 0.0;
        for (var i = 1; i < n; i++) {
            cum[i] = cum[i - 1] + segmentMetres(route.lats[i - 1], route.lons[i - 1],
                                                route.lats[i], route.lons[i]);
        }
        route.cum = cum;
    }

    // Equirectangular distance between two points in 1e-5 degrees; accurate
    // to well under 0.1% at the few-metre to few-km segment lengths we use.
    function segmentMetres(lat1 as Number, lon1 as Number, lat2 as Number, lon2 as Number) as Float {
        var midLat = Math.toRadians((lat1 + lat2) / 200000.0);
        var dy = (lat2 - lat1) * METRES_PER_E5;
        var dx = (lon2 - lon1) * METRES_PER_E5 * Math.cos(midLat);
        return Math.sqrt(dx * dx + dy * dy).toFloat();
    }
}
