import Toybox.Lang;

// Release build: no overrides. tools/screenshots.sh swaps in a generated
// version that pins the clock, battery, girl and sleep state.
module TestHooks {
    const ACTIVE = false;
    const HOUR = 0;
    const MINUTE = 0;
    const BATTERY = 0.0;
    const GIRL = 0;
    const SLEEPING = false;
    const IS24 = false;
}
