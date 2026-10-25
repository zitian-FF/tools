import Toybox.Graphics;
import Toybox.Lang;
import Toybox.System;
import Toybox.WatchUi;

const CENTER = Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER;

// ------------------------------------------------------------------ home

class HomeView extends WatchUi.View {

    function initialize() {
        View.initialize();
    }

    function onUpdate(dc as Graphics.Dc) as Void {
        var w = dc.getWidth();
        var h = dc.getHeight();
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_BLACK);
        dc.clear();
        dc.drawText(w / 2, h * 0.28, Graphics.FONT_MEDIUM, "RouteNav", CENTER);

        var phone = System.getDeviceSettings().phoneConnected;
        dc.setColor(phone ? Graphics.COLOR_GREEN : Graphics.COLOR_RED, Graphics.COLOR_TRANSPARENT);
        dc.drawText(w / 2, h * 0.45, Graphics.FONT_TINY,
                    phone ? "Phone connected" : "No phone", CENTER);

        dc.setColor(Graphics.COLOR_LT_GRAY, Graphics.COLOR_TRANSPARENT);
        var routes = RouteStore.loadIndex().size();
        dc.drawText(w / 2, h * 0.57, Graphics.FONT_TINY,
                    routes == 1 ? "1 route" : routes + " routes", CENTER);

        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        dc.drawText(w / 2, h * 0.75, Graphics.FONT_SMALL, "Tap to choose", CENTER);
    }
}

class HomeDelegate extends WatchUi.BehaviorDelegate {

    function initialize() {
        BehaviorDelegate.initialize();
    }

    function onSelect() as Boolean {
        RouteMenu.open();
        return true;
    }

    function onTap(evt as WatchUi.ClickEvent) as Boolean {
        RouteMenu.open();
        return true;
    }
}

// ------------------------------------------------------------ route menu

module RouteMenu {

    const REFRESH_ID = "__refresh";

    var downloader as Downloader or Null;

    function getDownloader() as Downloader {
        if (downloader == null) {
            downloader = new Downloader();
        }
        return downloader as Downloader;
    }

    function open() as Void {
        WatchUi.pushView(build(), new RouteMenuDelegate(), WatchUi.SLIDE_LEFT);
    }

    // Replaces the menu on screen (the top view) after the list changes.
    function refresh() as Void {
        WatchUi.switchToView(build(), new RouteMenuDelegate(), WatchUi.SLIDE_IMMEDIATE);
    }

    function build() as WatchUi.Menu2 {
        var menu = new WatchUi.Menu2({:title => "Routes"});
        var index = RouteStore.loadIndex();
        for (var i = 0; i < index.size(); i++) {
            var e = index[i];
            menu.addItem(new WatchUi.MenuItem(e[1] as String, TextUtil.formatKm(e[2] as Number),
                                              e[0] as String, {}));
        }
        menu.addItem(new WatchUi.MenuItem("Refresh list", "Fetch from Gist", REFRESH_ID, {}));
        return menu;
    }
}

class RouteMenuDelegate extends WatchUi.Menu2InputDelegate {

    function initialize() {
        Menu2InputDelegate.initialize();
    }

    function onSelect(item as WatchUi.MenuItem) as Void {
        var id = item.getId() as String;
        if (id.equals(RouteMenu.REFRESH_ID)) {
            RouteMenu.getDownloader().fetchIndex();
        } else {
            RouteMenu.getDownloader().fetchRoute(id);
        }
    }
}

// ---------------------------------------------------------- route summary

// Placeholder for the navigation screen (step 3): confirms the route was
// downloaded and decoded.
module RouteSummary {

    function open(route as Route, note as String or Null) as Void {
        WatchUi.pushView(new RouteSummaryView(route, note), new WatchUi.BehaviorDelegate(),
                         WatchUi.SLIDE_LEFT);
    }
}

class RouteSummaryView extends WatchUi.View {

    private var _route as Route;
    private var _note as String or Null;

    function initialize(route as Route, note as String or Null) {
        View.initialize();
        _route = route;
        _note = note;
    }

    function onUpdate(dc as Graphics.Dc) as Void {
        var w = dc.getWidth();
        var h = dc.getHeight();
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_BLACK);
        dc.clear();
        dc.drawText(w / 2, h * 0.25, Graphics.FONT_SMALL, _route.name, CENTER);
        dc.drawText(w / 2, h * 0.40, Graphics.FONT_MEDIUM, TextUtil.formatKm(_route.distance), CENTER);
        dc.setColor(Graphics.COLOR_LT_GRAY, Graphics.COLOR_TRANSPARENT);
        dc.drawText(w / 2, h * 0.54, Graphics.FONT_TINY,
                    _route.turnCount() + " turns, " + _route.pointCount() + " points", CENTER);
        if (_note != null) {
            dc.setColor(Graphics.COLOR_YELLOW, Graphics.COLOR_TRANSPARENT);
            dc.drawText(w / 2, h * 0.66, Graphics.FONT_XTINY, _note, CENTER);
        }
        dc.setColor(Graphics.COLOR_DK_GRAY, Graphics.COLOR_TRANSPARENT);
        dc.drawText(w / 2, h * 0.80, Graphics.FONT_XTINY, "Navigation: next build", CENTER);
    }
}

// --------------------------------------------------------------- message

module Message {

    function show(text as String) as Void {
        WatchUi.pushView(new MessageView(text), new MessageDelegate(), WatchUi.SLIDE_IMMEDIATE);
    }
}

class MessageView extends WatchUi.View {

    private var _text as String;

    function initialize(text as String) {
        View.initialize();
        _text = text;
    }

    function onUpdate(dc as Graphics.Dc) as Void {
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_BLACK);
        dc.clear();
        dc.drawText(dc.getWidth() / 2, dc.getHeight() / 2, Graphics.FONT_SMALL, _text, CENTER);
    }
}

class MessageDelegate extends WatchUi.BehaviorDelegate {

    function initialize() {
        BehaviorDelegate.initialize();
    }

    function onSelect() as Boolean {
        WatchUi.popView(WatchUi.SLIDE_IMMEDIATE);
        return true;
    }

    function onTap(evt as WatchUi.ClickEvent) as Boolean {
        WatchUi.popView(WatchUi.SLIDE_IMMEDIATE);
        return true;
    }
}
