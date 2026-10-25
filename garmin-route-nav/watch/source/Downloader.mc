import Toybox.Communications;
import Toybox.Lang;
import Toybox.System;
import Toybox.Time;
import Toybox.WatchUi;

// Fetches the route list and route files from the Gist through the phone.
// One request at a time; a progress screen is shown while it runs and Back
// cancels it.
class Downloader {

    private var _busy as Boolean = false;
    private var _routeId as String or Null = null;

    function initialize() {
    }

    function fetchIndex() as Void {
        if (!start("Loading routes")) {
            return;
        }
        _routeId = null;
        request("routes.txt", method(:onIndex));
    }

    // Always tries a fresh copy so edits to a route are picked up; falls back
    // to the cached copy if the phone or Gist can't be reached.
    function fetchRoute(id as String) as Void {
        var entry = RouteStore.findEntry(id);
        if (entry == null) {
            Message.show("Route not in list.\nRefresh the list.");
            return;
        }
        if (!phoneReady() || Config.gistBase() == null) {
            openCached(id, "Phone not connected");
            return;
        }
        if (!start("Loading route")) {
            return;
        }
        _routeId = id;
        request(entry[3] as String, method(:onRoute));
    }

    function cancel() as Void {
        if (_busy) {
            _busy = false;
            Communications.cancelAllRequests();
        }
    }

    function onIndex(code, data) as Void {
        if (!finish()) {
            return;
        }
        if (code != 200 || !(data instanceof String)) {
            Message.show(errorText(code));
            return;
        }
        var index = RouteStore.parseIndex(data);
        if (index == null) {
            Message.show("routes.txt is not a\nRouteNav route list");
            return;
        }
        pruneRemoved(index);
        RouteStore.saveIndex(index);
        RouteMenu.refresh();
        if (index.size() == 0) {
            Message.show("The route list\nis empty");
        }
    }

    function onRoute(code, data) as Void {
        if (!finish()) {
            return;
        }
        var id = _routeId as String;
        if (code != 200 || !(data instanceof String)) {
            openCached(id, errorText(code));
            return;
        }
        var route = RouteParser.parse(data);
        if (route == null) {
            openCached(id, "Route file is damaged");
            return;
        }
        RouteStore.saveRouteText(id, data);
        RouteSummary.open(route, null);
    }

    private function openCached(id as String, reason as String) as Void {
        var text = RouteStore.loadRouteText(id);
        var route = text != null ? RouteParser.parse(text) : null;
        if (route == null) {
            Message.show(reason + "\nand no saved copy");
            return;
        }
        RouteSummary.open(route, "Saved copy (" + reason + ")");
    }

    private function pruneRemoved(index as Array<Array>) as Void {
        var old = RouteStore.loadIndex();
        for (var i = 0; i < old.size(); i++) {
            var keep = false;
            for (var j = 0; j < index.size(); j++) {
                if ((old[i][0] as String).equals(index[j][0])) {
                    keep = true;
                    break;
                }
            }
            if (!keep) {
                RouteStore.deleteRoute(old[i][0] as String);
            }
        }
    }

    private function start(label as String) as Boolean {
        if (_busy) {
            return false;
        }
        if (Config.gistBase() == null) {
            Message.show("Set the Gist link in\nGarmin Connect app:\nRouteNav > Settings");
            return false;
        }
        if (!phoneReady()) {
            Message.show("Phone not connected.\nOpen Garmin Connect\non your phone.");
            return false;
        }
        _busy = true;
        WatchUi.pushView(new WatchUi.ProgressBar(label, null), new ProgressDelegate(self),
                         WatchUi.SLIDE_IMMEDIATE);
        return true;
    }

    // Returns false if the request was cancelled (its progress screen is gone).
    private function finish() as Boolean {
        if (!_busy) {
            return false;
        }
        _busy = false;
        WatchUi.popView(WatchUi.SLIDE_IMMEDIATE);
        return true;
    }

    private function request(file as String, callback as Method) as Void {
        // The query string sidesteps the Gist CDN cache (a few minutes) so a
        // just-uploaded route shows up straight away.
        var url = (Config.gistBase() as String) + file + "?t=" + Time.now().value();
        Communications.makeWebRequest(url, null, {
            :method => Communications.HTTP_REQUEST_METHOD_GET,
            :responseType => Communications.HTTP_RESPONSE_CONTENT_TYPE_TEXT_PLAIN
        }, callback);
    }

    private function phoneReady() as Boolean {
        return System.getDeviceSettings().phoneConnected;
    }

    private function errorText(code) as String {
        if (code == 404) {
            return "File not found in Gist.\nCheck the Gist link.";
        }
        if (code == Communications.BLE_CONNECTION_UNAVAILABLE) {
            return "Phone not connected";
        }
        if (code == Communications.NETWORK_REQUEST_TIMED_OUT) {
            return "Request timed out";
        }
        if (code == Communications.NETWORK_RESPONSE_TOO_LARGE) {
            return "Route file too large";
        }
        if (code == Communications.NETWORK_RESPONSE_OUT_OF_MEMORY) {
            return "Out of memory";
        }
        return "Download failed (" + code + ")";
    }
}

class ProgressDelegate extends WatchUi.BehaviorDelegate {

    private var _downloader as Downloader;

    function initialize(downloader as Downloader) {
        BehaviorDelegate.initialize();
        _downloader = downloader;
    }

    function onBack() as Boolean {
        _downloader.cancel();
        WatchUi.popView(WatchUi.SLIDE_IMMEDIATE);
        return true;
    }
}
