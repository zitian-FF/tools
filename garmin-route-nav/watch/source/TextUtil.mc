import Toybox.Lang;

module TextUtil {

    function split(s as String, sep as String) as Array<String> {
        var out = [] as Array<String>;
        var i = s.find(sep);
        while (i != null) {
            out.add(s.substring(0, i));
            s = s.substring(i + sep.length(), s.length());
            i = s.find(sep);
        }
        out.add(s);
        return out;
    }

    // Splits on newlines, dropping a trailing "\r" from each line.
    function lines(s as String) as Array<String> {
        var out = split(s, "\n");
        for (var i = 0; i < out.size(); i++) {
            if (endsWith(out[i], "\r")) {
                out[i] = out[i].substring(0, out[i].length() - 1);
            }
        }
        return out;
    }

    function endsWith(s as String, suffix as String) as Boolean {
        var n = s.length();
        var m = suffix.length();
        return n >= m && s.substring(n - m, n).equals(suffix);
    }

    function trim(s as String) as String {
        var start = 0;
        var end = s.length();
        while (start < end && isSpace(s.substring(start, start + 1))) {
            start++;
        }
        while (end > start && isSpace(s.substring(end - 1, end))) {
            end--;
        }
        return s.substring(start, end);
    }

    function isSpace(c as String) as Boolean {
        return c.equals(" ") || c.equals("\t") || c.equals("\r") || c.equals("\n");
    }

    function formatKm(metres as Number) as String {
        return (metres / 1000.0).format("%.1f") + " km";
    }
}
