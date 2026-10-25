# RouteNav for Garmin Vivoactive 5

Turn-by-turn route navigation (no map tiles) for watches without built-in
courses. Routes are prepared from GPX files, hosted in a GitHub Gist, and
downloaded to the watch through the paired phone's Garmin Connect app.

Status: steps 1-2 of 5 done (route pipeline; watch app route picker and
download). Navigation screen, turn alerts and cycling recording are next.
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
- The Gist link is set in the Garmin Connect app (RouteNav > Settings), or
  baked in as the default in `resources/properties/properties.xml`. It
  accepts the Gist page link, `user/id`, or the raw URL.

## Tests

```
cd tools && python3 test_gpx_to_route.py
```
