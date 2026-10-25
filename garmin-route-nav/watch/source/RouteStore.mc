import Toybox.Application;
import Toybox.Lang;

// On-watch cache of the route list and downloaded route files, so a route
// already fetched still works if the phone drops out mid-ride.
module RouteStore {

    const KEY_INDEX = "index";
    const CHUNK = 4000;   // characters per Storage value, well under its size limit

    // Index entry layout: [id, name, distance_m, file].
    function parseIndex(text as String) as Array<Array> or Null {
        var lines = TextUtil.lines(text);
        if (lines.size() < 1 || !lines[0].equals("RNI1")) {
            return null;
        }
        var out = [] as Array<Array>;
        for (var i = 1; i < lines.size(); i++) {
            var f = TextUtil.split(lines[i], "|");
            if (f.size() < 4) {
                continue;
            }
            var dist = f[2].toNumber();
            out.add([f[0], f[1], dist != null ? dist : 0, f[3]]);
        }
        return out;
    }

    function saveIndex(index as Array<Array>) as Void {
        Application.Storage.setValue(KEY_INDEX, index);
    }

    function loadIndex() as Array<Array> {
        var index = Application.Storage.getValue(KEY_INDEX);
        return index instanceof Array ? index as Array<Array> : [] as Array<Array>;
    }

    function findEntry(id as String) as Array or Null {
        var index = loadIndex();
        for (var i = 0; i < index.size(); i++) {
            if (id.equals(index[i][0])) {
                return index[i];
            }
        }
        return null;
    }

    function saveRouteText(id as String, text as String) as Void {
        deleteRoute(id);
        var count = 0;
        for (var start = 0; start < text.length(); start += CHUNK) {
            var end = start + CHUNK < text.length() ? start + CHUNK : text.length();
            Application.Storage.setValue(chunkKey(id, count), text.substring(start, end));
            count++;
        }
        Application.Storage.setValue(countKey(id), count);
    }

    function loadRouteText(id as String) as String or Null {
        var count = Application.Storage.getValue(countKey(id));
        if (!(count instanceof Number) || count == 0) {
            return null;
        }
        var text = "";
        for (var i = 0; i < count; i++) {
            var part = Application.Storage.getValue(chunkKey(id, i));
            if (!(part instanceof String)) {
                return null;
            }
            text += part;
        }
        return text;
    }

    function deleteRoute(id as String) as Void {
        var count = Application.Storage.getValue(countKey(id));
        if (count instanceof Number) {
            for (var i = 0; i < count; i++) {
                Application.Storage.deleteValue(chunkKey(id, i));
            }
        }
        Application.Storage.deleteValue(countKey(id));
    }

    function countKey(id as String) as String {
        return "r:" + id;
    }

    function chunkKey(id as String, i as Number) as String {
        return "r:" + id + ":" + i;
    }
}
