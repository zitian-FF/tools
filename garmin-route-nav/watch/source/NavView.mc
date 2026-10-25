import Toybox.Activity;
import Toybox.ActivityRecording;
import Toybox.Application;
import Toybox.Attention;
import Toybox.Graphics;
import Toybox.Lang;
import Toybox.Math;
import Toybox.Position;
import Toybox.Timer;
import Toybox.WatchUi;

// Navigation screen: heading-up route line, next turn, alerts and the
// cycling recording. START starts/pauses recording; BACK opens the stop menu
// (or leaves, if nothing was recorded).
module Nav {

    var active as NavView or Null;

    function open(route as Route, note as String or Null) as Void {
        var view = new NavView(route, note);
        active = view;
        WatchUi.pushView(view, new NavDelegate(view), WatchUi.SLIDE_LEFT);
    }

    // Called when the app closes, so a ride in progress isn't lost.
    function shutdown() as Void {
        if (active != null) {
            (active as NavView).finish(true);
        }
    }

    function setting(key as String, fallback as Number) as Number {
        var v = Application.Properties.getValue(key);
        return v instanceof Number && v > 0 ? v : fallback;
    }
}

class NavView extends WatchUi.View {

    const MAP_RADIUS_M = 250.0;     // metres from the rider to the map edge
    const MAP_BACK_M = 150.0;       // route drawn behind the rider
    const MIN_HEADING_SPEED = 2.0;  // m/s; below this GPS heading is noise

    private var _nav as Navigator;
    private var _note as String or Null;
    private var _session as ActivityRecording.Session or Null;
    private var _timer as Timer.Timer;
    private var _turnWarn as Number;
    private var _heading as Float;      // degrees, map up direction
    private var _speed as Float;        // m/s
    private var _gpsOk as Boolean;
    // Highest cue index already announced. Kept monotonic so GPS jitter
    // around a turn just passed can't announce it twice.
    private var _warnedUpTo as Number;
    private var _nowUpTo as Number;
    private var _wasOffCourse as Boolean;
    private var _closed as Boolean;

    function initialize(route as Route, note as String or Null) {
        View.initialize();
        _nav = new Navigator(route, Nav.setting("offCourse", 40));
        _note = note;
        _session = null;
        _turnWarn = Nav.setting("turnWarn", 150);
        _heading = _nav.routeBearing;
        _speed = 0.0;
        _gpsOk = false;
        _warnedUpTo = -1;
        _nowUpTo = -1;
        _wasOffCourse = false;
        _closed = false;
        _timer = new Timer.Timer();
        Position.enableLocationEvents(Position.LOCATION_CONTINUOUS, method(:onPosition));
        _timer.start(method(:onTick), 1000, true);
    }

    function onTick() as Void {
        WatchUi.requestUpdate();
    }

    function onPosition(info as Position.Info) as Void {
        _gpsOk = info.accuracy != null && info.accuracy >= Position.QUALITY_USABLE
                 && info.position != null;
        if (!_gpsOk) {
            return;
        }
        var deg = (info.position as Position.Location).toDegrees();
        _nav.update(deg[0], deg[1]);
        _note = null;

        _speed = info.speed != null ? (info.speed as Float) : 0.0;
        if (_speed >= MIN_HEADING_SPEED && info.heading != null) {
            _heading = _nav.normalise(Math.toDegrees(info.heading as Float).toFloat());
        } else if (!_nav.joined || _speed < 0.5) {
            // Standing still: keep the map lined up with the route.
            _heading = _nav.joined ? _nav.routeBearing : _nav.targetBearing;
        }

        checkAlerts();
        WatchUi.requestUpdate();
    }

    // ------------------------------------------------------------ alerts

    private function checkAlerts() as Void {
        var nav = _nav;
        if (!nav.joined) {
            return;
        }
        if (nav.offCourse != _wasOffCourse) {
            _wasOffCourse = nav.offCourse;
            if (nav.offCourse) {
                vibrate([400, 200, 400, 200, 400]);
            } else {
                vibrate([150]);
            }
        }
        if (nav.offCourse || nav.nextCue < 0) {
            return;
        }
        var cue = nav.nextCue;
        var type = nav.route().cueType[cue];
        if (type == CUE_STRAIGHT) {
            return;
        }
        // "Now" fires about 5 seconds out, but never later than 25 m.
        var nowDist = _speed * 5 > 25 ? _speed * 5 : 25.0;
        if (cue > _nowUpTo && nav.cueDist <= nowDist) {
            _nowUpTo = cue;
            _warnedUpTo = cue;
            vibrate(type == CUE_FINISH ? [300, 150, 300, 150, 800] : [800]);
        } else if (cue > _warnedUpTo && nav.cueDist <= _turnWarn) {
            _warnedUpTo = cue;
            vibrate([200, 150, 200]);
        }
    }

    // Pattern: on, off, on, ... in milliseconds.
    private function vibrate(pattern as Array<Number>) as Void {
        if (!(Attention has :vibrate)) {
            return;
        }
        var profile = [] as Array<Attention.VibeProfile>;
        for (var i = 0; i < pattern.size(); i++) {
            profile.add(new Attention.VibeProfile(i % 2 == 0 ? 100 : 0, pattern[i]));
        }
        Attention.vibrate(profile);
        if (Attention has :backlight) {
            Attention.backlight(true);
        }
    }

    // --------------------------------------------------------- recording

    function isRecording() as Boolean {
        return _session != null && (_session as ActivityRecording.Session).isRecording();
    }

    function hasSession() as Boolean {
        return _session != null;
    }

    function startStop() as Void {
        if (_session == null) {
            _session = ActivityRecording.createSession({
                :name => "Ride",
                :sport => Activity.SPORT_CYCLING,
                :subSport => Activity.SUB_SPORT_ROAD
            });
        }
        var s = _session as ActivityRecording.Session;
        if (s.isRecording()) {
            s.stop();
            vibrate([150]);
        } else {
            s.start();
            vibrate([300]);
        }
        WatchUi.requestUpdate();
    }

    function resume() as Void {
        if (_session != null && !isRecording()) {
            (_session as ActivityRecording.Session).start();
        }
    }

    // Stops GPS and ends the recording, saving or discarding it.
    function finish(save as Boolean) as Void {
        if (_closed) {
            return;
        }
        _closed = true;
        _timer.stop();
        Position.enableLocationEvents(Position.LOCATION_DISABLE, method(:onPosition));
        if (_session != null) {
            var s = _session as ActivityRecording.Session;
            if (s.isRecording()) {
                s.stop();
            }
            if (save) {
                s.save();
            } else {
                s.discard();
            }
            _session = null;
        }
        Nav.active = null;
    }

    // ------------------------------------------------------------ drawing

    function onUpdate(dc as Graphics.Dc) as Void {
        var w = dc.getWidth();
        var h = dc.getHeight();
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_BLACK);
        dc.clear();
        var nav = _nav;

        if (nav.hasFix) {
            drawMap(dc, w / 2, h * 0.58, h * 0.40);
        }
        drawTop(dc, w, h);
        drawBottom(dc, w, h);
    }

    private function drawMap(dc as Graphics.Dc, cx as Number, cy as Float, radius as Float) as Void {
        var nav = _nav;
        var r = nav.route();
        var scale = radius / MAP_RADIUS_M;
        var rad = Math.toRadians(_heading);
        var cosH = Math.cos(rad);
        var sinH = Math.sin(rad);

        // Only the part of the route near the rider; when not yet on it, the
        // part near the closest match (which is what the pointer leads to).
        var from = nav.indexAt(nav.along - MAP_BACK_M);
        var to = nav.indexAt(nav.along + MAP_RADIUS_M * 2.5) + 1;
        var px = 0.0;
        var py = 0.0;
        dc.setPenWidth(7);
        for (var i = from; i <= to; i++) {
            var p = nav.toLocal(i);
            // Rotate so the heading points up the screen.
            var x = cx + (p[0] * cosH - p[1] * sinH) * scale;
            var y = cy - (p[0] * sinH + p[1] * cosH) * scale;
            if (i > from) {
                var done = r.cum[i] <= nav.along;
                dc.setColor(done ? Graphics.COLOR_DK_GRAY
                                 : (nav.offCourse ? Graphics.COLOR_ORANGE : Graphics.COLOR_BLUE),
                            Graphics.COLOR_TRANSPARENT);
                dc.drawLine(px, py, x, y);
            }
            px = x;
            py = y;
        }

        // Upcoming turn points.
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        for (var c = 0; c < r.cueIndex.size(); c++) {
            var i = r.cueIndex[c];
            if (i < from || i > to || r.cum[i] < nav.along) {
                continue;
            }
            var p = nav.toLocal(i);
            dc.fillCircle(cx + (p[0] * cosH - p[1] * sinH) * scale,
                          cy - (p[0] * sinH + p[1] * cosH) * scale, 6);
        }

        // Rider marker, always pointing up (the map turns instead).
        dc.setPenWidth(1);
        var s = radius * 0.09;
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        dc.fillPolygon([[cx, cy - s * 1.4], [cx + s, cy + s], [cx, cy + s * 0.4], [cx - s, cy + s]]);

        // Off course or before the start: arrow at the edge toward the target.
        if (!nav.joined || nav.offCourse) {
            var rel = Math.toRadians(nav.targetBearing - _heading);
            var ex = cx + Math.sin(rel) * radius * 0.8;
            var ey = cy - Math.cos(rel) * radius * 0.8;
            dc.setColor(Graphics.COLOR_YELLOW, Graphics.COLOR_TRANSPARENT);
            drawArrowHead(dc, ex, ey, rel, radius * 0.12);
        }
    }

    private function drawTop(dc as Graphics.Dc, w as Number, h as Number) as Void {
        var nav = _nav;
        dc.setColor(Graphics.COLOR_BLACK, Graphics.COLOR_BLACK);
        dc.fillRectangle(0, 0, w, h * 0.30);
        var cx = w / 2;
        var C = Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER;
        var L = Graphics.TEXT_JUSTIFY_LEFT | Graphics.TEXT_JUSTIFY_VCENTER;

        if (!_gpsOk && !nav.hasFix) {
            dc.setColor(Graphics.COLOR_YELLOW, Graphics.COLOR_TRANSPARENT);
            dc.drawText(cx, h * 0.17, Graphics.FONT_SMALL, "Waiting for GPS", C);
            if (_note != null) {
                dc.drawText(cx, h * 0.45, Graphics.FONT_XTINY, _note, C);
            }
            return;
        }
        if (!nav.joined) {
            dc.setColor(Graphics.COLOR_YELLOW, Graphics.COLOR_TRANSPARENT);
            dc.drawText(cx, h * 0.12, Graphics.FONT_XTINY, "To start", C);
            dc.drawText(cx, h * 0.21, Graphics.FONT_MEDIUM, distText(nav.startDist), C);
            return;
        }
        if (nav.offCourse) {
            dc.setColor(Graphics.COLOR_RED, Graphics.COLOR_BLACK);
            dc.fillRectangle(0, 0, w, h * 0.30);
            dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
            dc.drawText(cx, h * 0.12, Graphics.FONT_SMALL, "OFF COURSE", C);
            dc.drawText(cx, h * 0.22, Graphics.FONT_TINY, distText(nav.offset) + " away", C);
            return;
        }
        if (nav.nextCue < 0) {
            return;
        }
        var r = nav.route();
        var type = r.cueType[nav.nextCue];
        var iconSize = h * 0.075;
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        drawCueIcon(dc, cx - w * 0.14, h * 0.17, iconSize, type);
        var text = nav.cueDist <= 0 ? "Now" : distText(nav.cueDist);
        dc.drawText(cx - w * 0.04, h * 0.15, Graphics.FONT_LARGE, text, L);
        var label = r.cueLabel[nav.nextCue];
        if (label.length() == 0) {
            label = cueName(type);
        }
        dc.setColor(Graphics.COLOR_LT_GRAY, Graphics.COLOR_TRANSPARENT);
        dc.drawText(cx, h * 0.265, Graphics.FONT_XTINY, label, C);
    }

    private function drawBottom(dc as Graphics.Dc, w as Number, h as Number) as Void {
        var C = Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER;
        var info = Activity.getActivityInfo();
        var timer = info != null && info.timerTime != null ? info.timerTime as Number : 0;
        var secs = timer / 1000;
        var time = secs >= 3600
            ? (secs / 3600) + ":" + ((secs / 60) % 60).format("%02d") + ":" + (secs % 60).format("%02d")
            : (secs / 60) + ":" + (secs % 60).format("%02d");

        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        dc.drawText(w * 0.33, h * 0.86, Graphics.FONT_TINY, (_speed * 3.6).format("%.0f") + " km/h", C);
        dc.drawText(w * 0.67, h * 0.86, Graphics.FONT_TINY, distText(_nav.remaining), C);

        if (!hasSession() || !isRecording()) {
            dc.setColor(Graphics.COLOR_YELLOW, Graphics.COLOR_TRANSPARENT);
            dc.drawText(w / 2, h * 0.94, Graphics.FONT_XTINY,
                        hasSession() ? "Paused " + time : "START to record", C);
        } else {
            dc.setColor(Graphics.COLOR_GREEN, Graphics.COLOR_TRANSPARENT);
            dc.drawText(w / 2, h * 0.94, Graphics.FONT_XTINY, time, C);
        }
    }

    // Arrow showing the turn: stem up from the bottom, then bending by the
    // turn angle, with a head at the end.
    private function drawCueIcon(dc as Graphics.Dc, x as Float or Number, y as Float, s as Float, type as Number) as Void {
        dc.setPenWidth((s * 0.28).toNumber());
        if (type == CUE_FINISH) {
            dc.drawCircle(x, y, s * 0.8);
            dc.fillCircle(x, y, s * 0.35);
            dc.setPenWidth(1);
            return;
        }
        if (type == CUE_UTURN) {
            dc.drawLine(x + s * 0.4, y + s, x + s * 0.4, y - s * 0.6);
            dc.drawLine(x + s * 0.4, y - s * 0.6, x - s * 0.4, y - s * 0.6);
            dc.drawLine(x - s * 0.4, y - s * 0.6, x - s * 0.4, y + s * 0.3);
            dc.setPenWidth(1);
            drawArrowHead(dc, x - s * 0.4, y + s * 0.6, Math.PI, s * 0.5);
            return;
        }
        var angle = cueAngle(type);
        var a = Math.toRadians(angle);
        var ex = x + Math.sin(a) * s;
        var ey = y - Math.cos(a) * s;
        dc.drawLine(x, y + s, x, y);
        dc.drawLine(x, y, ex, ey);
        dc.setPenWidth(1);
        drawArrowHead(dc, ex, ey, a, s * 0.5);
    }

    // Filled triangle with its tip at (x, y), pointing along angle (radians,
    // 0 = up the screen, clockwise).
    private function drawArrowHead(dc as Graphics.Dc, x as Float or Number, y as Float or Number, a as Float or Double, s as Float) as Void {
        var sinA = Math.sin(a);
        var cosA = Math.cos(a);
        // Back corners: s behind the tip, s * 0.6 either side.
        var bx = x - sinA * s;
        var by = y + cosA * s;
        dc.fillPolygon([
            [x, y],
            [bx + cosA * s * 0.6, by + sinA * s * 0.6],
            [bx - cosA * s * 0.6, by - sinA * s * 0.6]
        ]);
    }

    private function cueAngle(type as Number) as Number {
        switch (type) {
            case CUE_SLIGHT_LEFT: return -45;
            case CUE_LEFT: return -90;
            case CUE_SHARP_LEFT: return -135;
            case CUE_SLIGHT_RIGHT: return 45;
            case CUE_RIGHT: return 90;
            case CUE_SHARP_RIGHT: return 135;
        }
        return 0;
    }

    private function cueName(type as Number) as String {
        switch (type) {
            case CUE_SLIGHT_LEFT: return "Slight left";
            case CUE_LEFT: return "Turn left";
            case CUE_SHARP_LEFT: return "Sharp left";
            case CUE_UTURN: return "U-turn";
            case CUE_SLIGHT_RIGHT: return "Slight right";
            case CUE_RIGHT: return "Turn right";
            case CUE_SHARP_RIGHT: return "Sharp right";
            case CUE_FINISH: return "Finish";
        }
        return "Continue";
    }

    private function distText(m as Float) as String {
        if (m >= 1000) {
            return (m / 1000.0).format(m >= 10000 ? "%.0f" : "%.1f") + " km";
        }
        // Round to 10 m so the number doesn't flicker.
        return ((m / 10).toNumber() * 10) + " m";
    }
}

class NavDelegate extends WatchUi.BehaviorDelegate {

    private var _view as NavView;

    function initialize(view as NavView) {
        BehaviorDelegate.initialize();
        _view = view;
    }

    // The START button only; screen taps are ignored so a sweaty wrist or a
    // bump can't pause the ride.
    function onKey(evt as WatchUi.KeyEvent) as Boolean {
        if (evt.getKey() == WatchUi.KEY_ENTER) {
            _view.startStop();
            return true;
        }
        return false;
    }

    function onTap(evt as WatchUi.ClickEvent) as Boolean {
        return true;
    }

    function onSelect() as Boolean {
        return true;
    }

    function onBack() as Boolean {
        if (!_view.hasSession()) {
            _view.finish(false);
            WatchUi.popView(WatchUi.SLIDE_RIGHT);
            return true;
        }
        var wasRecording = _view.isRecording();
        if (wasRecording) {
            _view.startStop();   // pause while deciding
        }
        var menu = new WatchUi.Menu2({:title => "Ride"});
        menu.addItem(new WatchUi.MenuItem("Resume", null, :resume, {}));
        menu.addItem(new WatchUi.MenuItem("Save", null, :save, {}));
        menu.addItem(new WatchUi.MenuItem("Discard", null, :discard, {}));
        WatchUi.pushView(menu, new StopMenuDelegate(_view, wasRecording), WatchUi.SLIDE_UP);
        return true;
    }

    // Swipes would otherwise act as Back on some devices.
    function onSwipe(evt as WatchUi.SwipeEvent) as Boolean {
        return true;
    }
}

class StopMenuDelegate extends WatchUi.Menu2InputDelegate {

    private var _view as NavView;
    private var _wasRecording as Boolean;

    function initialize(view as NavView, wasRecording as Boolean) {
        Menu2InputDelegate.initialize();
        _view = view;
        _wasRecording = wasRecording;
    }

    function onSelect(item as WatchUi.MenuItem) as Void {
        var id = item.getId();
        if (id == :resume) {
            _view.resume();
            WatchUi.popView(WatchUi.SLIDE_DOWN);
            return;
        }
        var save = id == :save;
        _view.finish(save);
        // Close the menu, then replace the navigation screen with a message;
        // dismissing it returns to the route list.
        WatchUi.popView(WatchUi.SLIDE_IMMEDIATE);
        WatchUi.switchToView(new MessageView(save ? "Ride saved" : "Ride discarded"),
                             new MessageDelegate(), WatchUi.SLIDE_IMMEDIATE);
    }

    // Back out of the menu: carry on as before it opened.
    function onBack() as Void {
        if (_wasRecording) {
            _view.resume();
        }
        WatchUi.popView(WatchUi.SLIDE_DOWN);
    }
}
