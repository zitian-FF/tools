import Toybox.Lang;
import Toybox.Test;

// Unit tests for Rotation (only compiled into test builds):
//   monkeyc ... -t   then   monkeydo <prg> vivoactive5 -t

(:test)
function testStartDoesNotAdvance(logger as Logger) as Boolean {
    var r = new Rotation(3, [true, true, true, true, true, true, true, true], MODE_ON_WAKE, 0);
    Test.assertEqual(r.current(), 3);
    // A wake with no preceding sleep (app start, return from an app before
    // any sleep) must not advance.
    Test.assertEqual(r.onExitSleep(), false);
    Test.assertEqual(r.current(), 3);
    return true;
}

(:test)
function testOneAdvancePerSleepWake(logger as Logger) as Boolean {
    var r = new Rotation(0, [true, true, true, true, true, true, true, true], MODE_ON_WAKE, 0);
    r.onEnterSleep();
    Test.assertEqual(r.onExitSleep(), true);
    Test.assertEqual(r.current(), 1);
    // Duplicate wake callback in the same awake episode.
    Test.assertEqual(r.onExitSleep(), false);
    Test.assertEqual(r.current(), 1);
    // Duplicate sleep callbacks still arm only one advance.
    r.onEnterSleep();
    r.onEnterSleep();
    r.onExitSleep();
    r.onExitSleep();
    Test.assertEqual(r.current(), 2);
    return true;
}

(:test)
function testEightEpisodesWrap(logger as Logger) as Boolean {
    var r = new Rotation(0, [true, true, true, true, true, true, true, true], MODE_ON_WAKE, 0);
    var seen = [] as Array<Number>;
    for (var i = 0; i < 8; i++) {
        r.onEnterSleep();
        r.onExitSleep();
        seen.add(r.current());
    }
    Test.assertEqual(seen.toString(), [1, 2, 3, 4, 5, 6, 7, 0].toString());
    return true;
}

(:test)
function testSkipsDisabled(logger as Logger) as Boolean {
    var en = [true, true, true, true, true, true, true, true];
    en[1] = false;
    en[2] = false;
    en[7] = false;
    var r = new Rotation(0, en, MODE_ON_WAKE, 0);
    r.onEnterSleep();
    r.onExitSleep();
    Test.assertEqual(r.current(), 3);
    // Selection pointing at a disabled girl shows the next enabled one.
    var r2 = new Rotation(7, en, MODE_ON_WAKE, 0);
    Test.assertEqual(r2.current(), 0);
    return true;
}

(:test)
function testNothingEnabledIsSafe(logger as Logger) as Boolean {
    var none = [false, false, false, false, false, false, false, false];
    var r = new Rotation(4, none, MODE_ON_WAKE, 0);
    r.onEnterSleep();
    Test.assertEqual(r.onExitSleep(), false);
    Test.assertEqual(r.current(), 4);
    return true;
}

(:test)
function testFixedAndIntervalModes(logger as Logger) as Boolean {
    var fixed = new Rotation(2, [true, true, true, true, true, true, true, true], MODE_FIXED, 5);
    fixed.onEnterSleep();
    Test.assertEqual(fixed.onExitSleep(), false);
    Test.assertEqual(fixed.onInterval(), false);
    Test.assertEqual(fixed.current(), 5);

    var cyc = new Rotation(6, [true, true, true, true, true, true, true, true], MODE_INTERVAL, 0);
    cyc.onEnterSleep();
    Test.assertEqual(cyc.onExitSleep(), false);   // interval mode: no wake advance
    Test.assertEqual(cyc.onInterval(), true);
    Test.assertEqual(cyc.onInterval(), true);
    Test.assertEqual(cyc.current(), 0);

    var onWake = new Rotation(0, [true, true, true, true, true, true, true, true], MODE_ON_WAKE, 0);
    Test.assertEqual(onWake.onInterval(), false);  // default mode never cycles
    return true;
}

(:test)
function testBadIndicesClamp(logger as Logger) as Boolean {
    var r = new Rotation(42, [true, true, true, true, true, true, true, true], MODE_FIXED, -3);
    Test.assertEqual(r.current(), 0);
    Test.assertEqual(r.selected(), 0);
    return true;
}
