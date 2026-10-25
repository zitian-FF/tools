# RouteNav for Garmin Vivoactive 5

Turn-by-turn route navigation (no map tiles) for watches without built-in
courses. Routes are prepared from GPX files, hosted in a GitHub Gist, and
downloaded to the watch through the paired phone's Garmin Connect app.

Status: steps 1-3 of 5 done (route pipeline; route picker and download;
navigation, turn alerts and cycling recording). Next: getting real routes
into a Gist, then building and sideloading.
The watch app has not been compiled yet: the cloud session that wrote it
cannot reach Garmin's SDK download, so the first build happens locally.

## Route pipeline

```
cd tools
python3 gpx_to_route.py ~/Downloads/coast.gpx --name "Coast loop"
python3 gpx_to_route.py ~/Downloads/coast-hills.gpx --name "Coast hills"
python3 gpx_to_route.py --remove coast-hills
```

Output goes to `routes/` (git-ignored): one `<id>.txt` per route plus
`routes.txt`, the index the watch uses to offer a choice of routes. Upload
all of them to the Gist. The watch reads files from
`https://gist.githubusercontent.com/<user>/<gist-id>/raw/<file>`, which
always serves the latest revision.

Turn cues come from the GPX when it has them (e.g. RideWithGPS cue
waypoints); otherwise they are detected from the route's shape. The line is
simplified to within 4 m of the original and capped at 1500 points.

Gist files are public to anyone with the link, so avoid routes that start
at your exact home address.

Files are plain text rather than JSON: Gists serve `text/plain`, which
Connect IQ's JSON download can reject.

## Watch app (`watch/`)

- Home screen: phone status and route count; tap to open the route list.
- Route list: every route in `routes.txt`, plus "Refresh list".
- Picking a route downloads a fresh copy through the phone, or uses the
  copy saved on the watch if the phone or Gist can't be reached.
- Navigation screen (opens when a route is picked):
  - top: next turn arrow, distance to it, street name when the GPX has one
  - middle: the route line around you, turning with your direction of
    travel (heading up); ridden part grey, ahead blue, turns as dots
  - bottom: speed, distance to finish, ride timer
  - before reaching the route: distance and arrow to the start
  - off course: red banner, distance from the route, arrow back to it
- Buzzes: double buzz at the turn-warning distance (default 150 m), long
  buzz about 5 s before the turn, triple buzz when off course (default
  40 m away), short buzz when back on course, finish pattern at the end.
- Recording: START starts/pauses a cycling activity. BACK opens
  Resume / Save / Discard (or leaves, if nothing was recorded). Screen taps
  and swipes are ignored on this screen so a bump can't pause the ride.
  Saved rides sync to Garmin Connect like any other.
- The Gist link is set in the Garmin Connect app (RouteNav > Settings), or
  baked in as the default in `resources/properties/properties.xml`. It
  accepts the Gist page link, `user/id`, or the raw URL.

Settings (Garmin Connect app > RouteNav > Settings): Gist link, turn
warning distance, off-course distance.

### How matching works

Each GPS fix is matched to the nearest point on the route within a window
around the current progress (100 m back, 400 m ahead). Jumping backwards,
or further forward than a bike travels between fixes, adds to a match's
cost, so routes that use the same road twice (out-and-back, lollipop) stay
on the pass being ridden. If nothing in the window is within the off-course
distance, the whole route is searched, so shortcuts and detours rejoin
correctly. Off course needs two bad fixes in a row; fixes with poor GPS
accuracy are ignored.

## Tests

```
cd tools
python3 test_gpx_to_route.py   # route pipeline
python3 test_nav_logic.py      # simulated rides against a mirror of the matching logic
```
