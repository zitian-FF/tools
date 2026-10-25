import Toybox.Application;
import Toybox.Lang;

// Reads the Gist setting and turns whatever form was pasted into the raw
// base URL that files are fetched from.
module Config {

    const RAW_HOST = "https://gist.githubusercontent.com/";
    const PAGE_HOST = "https://gist.github.com/";

    // Accepts:
    //   https://gist.github.com/user/id          (Gist page link)
    //   user/id
    //   https://gist.githubusercontent.com/user/id/raw/
    // Returns e.g. "https://gist.githubusercontent.com/user/id/raw/", or null.
    function gistBase() as String or Null {
        var value = Application.Properties.getValue("gist");
        if (!(value instanceof String)) {
            return null;
        }
        var s = TextUtil.trim(value);
        while (s.length() > 0 && TextUtil.endsWith(s, "/")) {
            s = s.substring(0, s.length() - 1);
        }
        if (s.length() == 0) {
            return null;
        }
        if (s.find(RAW_HOST) == 0) {
            return TextUtil.endsWith(s, "/raw") ? s + "/" : s + "/raw/";
        }
        if (s.find(PAGE_HOST) == 0) {
            s = s.substring(PAGE_HOST.length(), s.length());
        } else if (s.find("http") == 0) {
            return null;
        }
        return RAW_HOST + s + "/raw/";
    }
}
