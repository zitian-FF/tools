# RouteNav for Garmin Vivoactive 5

Turn-by-turn route navigation (no map tiles) for watches without built-in
courses. Routes are prepared from GPX files, hosted in a GitHub Gist, and
downloaded to the watch through the paired phone's Garmin Connect app.

Status: step 1 of 5 (route pipeline) done. The watch app is not built yet.

## Route pipeline

```
cd tools
python3 gpx_to_route.py ~/Downloads/coast.gpx --name "Coast loop"
python3 gpx_to_route.py ~/Downloads/coast-hills.gpx --name "Coast hills"
python3 gpx_to_route.py --remove coast-hills
```

Output goes to `routes/` (git-ignored): one `<id>.json` per route plus
`routes.json`, the index the watch uses to offer a choice of routes. Upload
all of them to the Gist. The watch reads files from
`https://gist.githubusercontent.com/<user>/<gist-id>/raw/<file>`, which
always serves the latest revision.

Turn cues come from the GPX when it has them (e.g. RideWithGPS cue
waypoints); otherwise they are detected from the route's shape. The line is
simplified to within 4 m of the original and capped at 1500 points.

Gist files are public to anyone with the link, so avoid routes that start
at your exact home address.

## Tests

```
cd tools && python3 test_gpx_to_route.py
```
