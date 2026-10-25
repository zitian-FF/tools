import Toybox.Application;
import Toybox.Graphics;
import Toybox.Lang;
import Toybox.Math;
import Toybox.System;
import Toybox.Timer;
import Toybox.WatchUi;

// AI Girls edge clock: a portrait in the centre, a thin battery ring around
// it, and two short curved blocks riding the rim, the white hour block and
// the accent-coloured minute block, each with its number upright inside.
//
// Asleep (always-on display) the portrait and colour go: outlined blocks and
// a thin battery arc on black, nudged a few pixels each minute against
// burn-in.
class FaceView extends WatchUi.WatchFace {

    // Geometry (px, centre 195,195).
    const C = 195;
    const PORTRAIT_R = 152;
    const BATTERY_R = 158;
    const BATTERY_ICON_GAP = 9.0;      // degrees either side of 12 left for the icon
    const TRACK_R = 178;               // block centreline
    const HOUR_T = 30;                 // block thickness (radial)
    const MINUTE_T = 24;
    const HOUR_SPAN = 14.0;            // block body arc in degrees (caps extend it)
    const MINUTE_SPAN = 10.0;
    const BLOCK_GAP = 2.0;             // degrees between blocks that would touch

    const DARK_TEXT = 0x111111;
    const TRACK_GREY = 0x333333;
    const AOD_OUTLINE = 0x707070;
    const AOD_TEXT = 0x9A9A9A;
    const AOD_BATTERY = 0x5A5A5A;

    // Burn-in shift pattern for the always-on display, one step per minute.
    const SHIFT_X = [0, 2, -1, -2, 1];
    const SHIFT_Y = [0, 1, 2, -1, -2];

    private var _rotation as Rotation;
    private var _remember as Boolean;
    private var _intervalMs as Number;
    private var _portrait as WatchUi.BitmapResource or Null;
    private var _portraitIndex as Number;
    private var _sleeping as Boolean;
    private var _timer as Timer.Timer or Null;
    private var _hourFont as WatchUi.FontResource;
    private var _minuteFont as WatchUi.FontResource;

    function initialize() {
        WatchFace.initialize();
        _hourFont = WatchUi.loadResource(Rez.Fonts.HourFont) as WatchUi.FontResource;
        _minuteFont = WatchUi.loadResource(Rez.Fonts.MinuteFont) as WatchUi.FontResource;
        _portrait = null;
        _portraitIndex = -1;
        _sleeping = TestHooks.ACTIVE ? TestHooks.SLEEPING : false;
        _timer = null;
        _remember = true;
        _intervalMs = 5000;
        _rotation = new Rotation(0, [true] as Array<Boolean>, MODE_ON_WAKE, 0);
        loadSettings();
    }

    // Reads settings and the remembered girl. Never advances the rotation.
    function loadSettings() as Void {
        var mode = intProp("rotationMode", MODE_ON_WAKE);
        var start = intProp("startGirl", 0);
        _remember = boolProp("remember", true);
        _intervalMs = intProp("intervalSec", 5) * 1000;
        var enabled = [] as Array<Boolean>;
        for (var i = 0; i < Roster.count(); i++) {
            enabled.add(boolProp("show_" + Roster.IDS[i], true));
        }
        var selected = start;
        if (_remember) {
            var saved = Application.Storage.getValue("selected");
            if (saved instanceof String && Roster.indexOf(saved) >= 0) {
                selected = Roster.indexOf(saved);
            }
        }
        if (TestHooks.ACTIVE) {
            selected = TestHooks.GIRL;
        }
        _rotation = new Rotation(selected, enabled, mode, start);
        restartTimer();
    }

    // ------------------------------------------------------------ lifecycle

    function onShow() as Void {
        restartTimer();
    }

    function onHide() as Void {
        stopTimer();
    }

    function onEnterSleep() as Void {
        _sleeping = true;
        stopTimer();
        _rotation.onEnterSleep();
        _portrait = null;               // not shown asleep; free the image memory
        _portraitIndex = -1;
        WatchUi.requestUpdate();
    }

    function onExitSleep() as Void {
        _sleeping = false;
        if (_rotation.onExitSleep()) {
            commit();
        }
        restartTimer();
        WatchUi.requestUpdate();
    }

    function onInterval() as Void {
        if (!_sleeping && _rotation.onInterval()) {
            commit();
            WatchUi.requestUpdate();
        }
    }

    // Persist the selection: only when it changes, never per frame.
    private function commit() as Void {
        if (_remember && !TestHooks.ACTIVE) {
            Application.Storage.setValue("selected", Roster.IDS[_rotation.selected()]);
        }
    }

    private function restartTimer() as Void {
        stopTimer();
        if (_rotation.mode == MODE_INTERVAL && !_sleeping) {
            var t = new Timer.Timer();
            t.start(method(:onInterval), _intervalMs, true);
            _timer = t;
        }
    }

    private function stopTimer() as Void {
        if (_timer != null) {
            (_timer as Timer.Timer).stop();
            _timer = null;
        }
    }

    // -------------------------------------------------------------- drawing

    function onUpdate(dc as Graphics.Dc) as Void {
        var clock = System.getClockTime();
        var hour = TestHooks.ACTIVE ? TestHooks.HOUR : clock.hour;
        var minute = TestHooks.ACTIVE ? TestHooks.MINUTE : clock.min;
        var is24 = TestHooks.ACTIVE ? TestHooks.IS24 : System.getDeviceSettings().is24Hour;
        var battery = TestHooks.ACTIVE ? TestHooks.BATTERY : System.getSystemStats().battery;

        dc.setColor(Graphics.COLOR_BLACK, Graphics.COLOR_BLACK);
        dc.clear();
        dc.setAntiAlias(true);

        if (_sleeping) {
            var s = minute % SHIFT_X.size();
            drawFace(dc, C + SHIFT_X[s], C + SHIFT_Y[s], hour, minute, is24, battery, -1);
        } else {
            var girl = _rotation.current();
            if (_portraitIndex != girl) {
                _portrait = null;           // release before loading: one image at a time
                _portrait = Roster.portrait(girl);
                _portraitIndex = girl;
            }
            dc.drawBitmap(C - PORTRAIT_R, C - PORTRAIT_R, _portrait as WatchUi.BitmapResource);
            drawFace(dc, C, C, hour, minute, is24, battery, Roster.ACCENTS[girl]);
        }
        if (TestHooks.ACTIVE) {
            var stats = System.getSystemStats();
            System.println("memory " + stats.usedMemory + " / " + stats.totalMemory);
        }
    }

    // accent < 0 draws the always-on version.
    private function drawFace(dc as Graphics.Dc, cx as Number, cy as Number, hour as Number,
                              minute as Number, is24 as Boolean, battery as Float or Number,
                              accent as Number) as Void {
        var aod = accent < 0;
        drawBattery(dc, cx, cy, battery, aod ? AOD_BATTERY : accent, aod);

        var hourAngle = 30.0 * ((hour % 12) + minute / 60.0);
        var minuteAngle = 6.0 * minute;
        var hourExtent = HOUR_SPAN + capDegrees(HOUR_T);
        var minuteExtent = MINUTE_SPAN + capDegrees(MINUTE_T);
        // Blocks that would overlap (12:00, 1:05, ...) are pushed apart along
        // the rim around their midpoint, keeping their clockwise order.
        var d = wrap180(minuteAngle - hourAngle);
        var sep = (hourExtent + minuteExtent) / 2 + BLOCK_GAP;
        if (d.abs() < sep) {
            var sign = d >= 0 ? 1 : -1;
            var mid = hourAngle + d / 2;
            hourAngle = mid - sign * sep / 2;
            minuteAngle = mid + sign * sep / 2;
        }

        var hourText = is24 ? hour.format("%02d") : ((hour % 12 == 0) ? 12 : hour % 12).toString();
        var minuteText = minute.format("%02d");
        if (aod) {
            drawBlockOutline(dc, cx, cy, hourAngle, HOUR_SPAN, HOUR_T, AOD_OUTLINE);
            drawBlockOutline(dc, cx, cy, minuteAngle, MINUTE_SPAN, MINUTE_T, AOD_OUTLINE);
            drawLabel(dc, cx, cy, hourAngle, _hourFont, hourText, AOD_TEXT);
            drawLabel(dc, cx, cy, minuteAngle, _minuteFont, minuteText, AOD_TEXT);
        } else {
            drawBlock(dc, cx, cy, hourAngle, HOUR_SPAN, HOUR_T, Graphics.COLOR_WHITE);
            drawBlock(dc, cx, cy, minuteAngle, MINUTE_SPAN, MINUTE_T, accent);
            drawLabel(dc, cx, cy, hourAngle, _hourFont, hourText, DARK_TEXT);
            drawLabel(dc, cx, cy, minuteAngle, _minuteFont, minuteText, DARK_TEXT);
        }
    }

    // Battery: one clockwise circuit from 12 for 100%, starting and ending at
    // the icon gap, with the icon at 12.
    private function drawBattery(dc as Graphics.Dc, cx as Number, cy as Number,
                                 battery as Float or Number, color as Number, aod as Boolean) as Void {
        var pct = battery.toFloat();
        pct = pct < 0 ? 0.0 : (pct > 100 ? 100.0 : pct);
        var from = BATTERY_ICON_GAP;
        var to = 360.0 - BATTERY_ICON_GAP;
        dc.setPenWidth(2);
        if (!aod) {
            dc.setColor(TRACK_GREY, Graphics.COLOR_TRANSPARENT);
            arc(dc, cx, cy, BATTERY_R, from, to);
        }
        var end = from + (to - from) * pct / 100.0;
        if (end - from >= 0.5) {
            dc.setColor(color, Graphics.COLOR_TRANSPARENT);
            arc(dc, cx, cy, BATTERY_R, from, end);
        }
        // Icon: outlined body and terminal, centred on the ring at 12.
        var iy = cy - BATTERY_R;
        dc.setColor(aod ? AOD_BATTERY : color, Graphics.COLOR_TRANSPARENT);
        dc.setPenWidth(1);
        dc.drawRoundedRectangle(cx - 8, iy - 4, 14, 9, 2);
        dc.fillRectangle(cx + 6, iy - 2, 2, 5);
    }

    // Filled capsule centred at clock angle `at`.
    private function drawBlock(dc as Graphics.Dc, cx as Number, cy as Number, at as Float,
                               span as Float, thickness as Number, color as Number) as Void {
        dc.setColor(color, Graphics.COLOR_TRANSPARENT);
        dc.setPenWidth(thickness);
        arc(dc, cx, cy, TRACK_R, at - span / 2, at + span / 2);
        var r = thickness / 2.0;
        var a = polar(cx, cy, TRACK_R, at - span / 2);
        var b = polar(cx, cy, TRACK_R, at + span / 2);
        dc.fillCircle(a[0], a[1], r);
        dc.fillCircle(b[0], b[1], r);
    }

    // Outlined capsule: a filled capsule with a black one 2px smaller inside.
    private function drawBlockOutline(dc as Graphics.Dc, cx as Number, cy as Number, at as Float,
                                      span as Float, thickness as Number, color as Number) as Void {
        drawBlock(dc, cx, cy, at, span, thickness, color);
        drawBlock(dc, cx, cy, at, span, thickness - 4, Graphics.COLOR_BLACK);
    }

    private function drawLabel(dc as Graphics.Dc, cx as Number, cy as Number, at as Float,
                               font as WatchUi.FontResource, text as String, color as Number) as Void {
        var p = polar(cx, cy, TRACK_R, at);
        dc.setColor(color, Graphics.COLOR_TRANSPARENT);
        dc.drawText(p[0], p[1], font, text, Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
    }

    // Clockwise arc between clock angles (degrees clockwise from 12).
    private function arc(dc as Graphics.Dc, cx as Number, cy as Number, r as Number,
                         fromClock as Float, toClock as Float) as Void {
        dc.drawArc(cx, cy, r, Graphics.ARC_CLOCKWISE, 90 - fromClock, 90 - toClock);
    }

    private function polar(cx as Number, cy as Number, r as Number, clock as Float) as Array<Float> {
        var a = Math.toRadians(clock);
        return [(cx + r * Math.sin(a)).toFloat(), (cy - r * Math.cos(a)).toFloat()];
    }

    // Degrees added at each end by a block's round cap (both ends together).
    private function capDegrees(thickness as Number) as Float {
        return Math.toDegrees(thickness.toFloat() / TRACK_R).toFloat();
    }

    private function wrap180(deg as Float) as Float {
        while (deg > 180) {
            deg -= 360;
        }
        while (deg <= -180) {
            deg += 360;
        }
        return deg;
    }

    private function intProp(key as String, fallback as Number) as Number {
        var v = Application.Properties.getValue(key);
        return v instanceof Number ? v : fallback;
    }

    private function boolProp(key as String, fallback as Boolean) as Boolean {
        var v = Application.Properties.getValue(key);
        return v instanceof Boolean ? v : fallback;
    }
}
