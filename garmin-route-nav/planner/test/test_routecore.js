// Run: python3 make_fixtures.py && node test_routecore.js
const assert = require("assert");
const path = require("path");
const RC = require("../routecore.js");
const fixtures = require(path.join(__dirname, "fixtures.json"));

let failed = 0;
function test(name, fn) {
  try { fn(); console.log("ok   " + name); }
  catch (e) { failed++; console.log("FAIL " + name + "\n     " + e.message.split("\n").join("\n     ")); }
}

for (const [name, fx] of Object.entries(fixtures)) {
  test("matches Python output: " + name, () => {
    const { route } = RC.buildRoute(fx.points, "Case " + name);
    assert.strictEqual(RC.formatRoute(route), fx.text);
  });
}

test("polyline example from Google docs", () => {
  assert.strictEqual(RC.encodePolyline([[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]),
                     "_p~iF~ps|U_ulLnnqC_mqNvxq`@");
});

test("index round trip and separator cleaning", () => {
  const routes = [{ id: "a", name: "Coast | loop; x", dist: 1200, file: "a.txt" }];
  const text = RC.formatIndex(routes);
  assert.strictEqual(text, "RNI1\na|Coast loop x|1200|a.txt\n");
  assert.deepStrictEqual(RC.parseIndex(text), [{ id: "a", name: "Coast loop x", dist: 1200, file: "a.txt" }]);
  assert.deepStrictEqual(RC.parseIndex("garbage"), []);
});

// Helpers for routing-hint tests: an L route (north then east) at 5 m steps.
function lRoute() {
  const pts = [];
  const mLat = 1 / 111195, mLon = 1 / (111195 * Math.cos(1.3521 * Math.PI / 180));
  for (let i = 0; i <= 100; i++) pts.push([1.3521 + i * 5 * mLat, 103.8198]);
  for (let i = 1; i <= 100; i++) pts.push([1.3521 + 500 * mLat, 103.8198 + i * 5 * mLon]);
  return pts;
}

test("router hint used when it agrees with the road", () => {
  const { route, stats } = RC.buildRoute(lRoute(), "x", [[100, 5]]);   // TR at the corner
  assert.strictEqual(stats.cueSource, "router+geometry");
  assert.deepStrictEqual(route.cues.map((c) => c[1]), [RC.CUE.RIGHT, RC.CUE.FINISH]);
});

test("router hint pointing the wrong way is overruled by geometry", () => {
  const { route } = RC.buildRoute(lRoute(), "x", [[100, 2]]);          // says TL, road goes right
  assert.deepStrictEqual(route.cues.map((c) => c[1]), [RC.CUE.RIGHT, RC.CUE.FINISH]);
});

test("bend the router missed is added from geometry", () => {
  const { route } = RC.buildRoute(lRoute(), "x", [[30, 1]]);           // only a 'continue'
  assert.deepStrictEqual(route.cues.map((c) => c[1]), [RC.CUE.RIGHT, RC.CUE.FINISH]);
});

test("fork hint kept even where the road barely bends", () => {
  const pts = lRoute().slice(0, 101);                                   // straight line north
  const { route } = RC.buildRoute(pts, "x", [[50, 8]]);                 // KL
  assert.deepStrictEqual(route.cues.map((c) => c[1]), [RC.CUE.SLIGHT_LEFT, RC.CUE.FINISH]);
});

test("hint and geometry at the same turn give one cue", () => {
  const { route } = RC.buildRoute(lRoute(), "x", [[98, 5]]);
  assert.strictEqual(route.cues.length, 2);
});

test("slugify", () => {
  assert.strictEqual(RC.slugify("To Marina Bay!"), "to-marina-bay");
  assert.strictEqual(RC.slugify("###"), "route");
});

if (failed) { console.log(failed + " failed"); process.exit(1); }
console.log("all passed");
