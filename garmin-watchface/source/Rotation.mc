import Toybox.Lang;

enum {
    MODE_ON_WAKE = 0,
    MODE_INTERVAL = 1,
    MODE_FIXED = 2
}

// Which girl is showing, and when to move to the next one. Pure logic, no
// drawing or storage, so it can be unit-tested (RotationTests.mc).
//
// On-wake mode advances exactly once per sleep -> awake episode: entering
// sleep arms the next wake, and the first wake consumes it. Construction,
// redraws and repeated wake callbacks never advance.
class Rotation {

    var mode as Number;
    private var _selected as Number;
    private var _fixed as Number;
    private var _enabled as Array<Boolean>;
    private var _armed as Boolean;

    function initialize(selected as Number, enabled as Array<Boolean>, mode as Number, fixed as Number) {
        self.mode = mode;
        _enabled = enabled;
        _fixed = clampIndex(fixed);
        _selected = clampIndex(selected);
        _armed = false;
    }

    // Girl to show now.
    function current() as Number {
        var i = mode == MODE_FIXED ? _fixed : _selected;
        return _enabled[i] ? i : nextEnabled(i);
    }

    // The committed selection, to persist (not the fixed-mode girl).
    function selected() as Number {
        return _selected;
    }

    function onEnterSleep() as Void {
        _armed = true;
    }

    // Returns true if the girl changed.
    function onExitSleep() as Boolean {
        var armed = _armed;
        _armed = false;
        if (mode != MODE_ON_WAKE || !armed) {
            return false;
        }
        return advance();
    }

    // Interval mode timer tick. Returns true if the girl changed.
    function onInterval() as Boolean {
        return mode == MODE_INTERVAL ? advance() : false;
    }

    private function advance() as Boolean {
        var from = current();
        var next = nextEnabled(from);
        _selected = next;
        return next != from;
    }

    // Next enabled girl after i, wrapping. With nothing enabled, stays on i.
    private function nextEnabled(i as Number) as Number {
        var n = _enabled.size();
        for (var k = 1; k <= n; k++) {
            var j = (i + k) % n;
            if (_enabled[j]) {
                return j;
            }
        }
        return i;
    }

    private function clampIndex(i as Number) as Number {
        return i >= 0 && i < _enabled.size() ? i : 0;
    }
}
