# How High

Shows where a hike is exposed, before you walk it. Built for someone with a
fear of heights living in Switzerland: the trigger is less altitude than steep
ground falling away beside the path, so that is what gets measured.

Upload a GPX file and you get the route coloured by exposure on a map, an
elevation and score profile, and a table of flagged sections. Mark how
stretches actually felt, and new hikes are compared against those marks.

Each entry is either planned or done. A planned one gets a forecast: whether
its worst stretch is within what you have found fine, reaches something that
bothered you, or goes beyond anything you have marked. Rating or marking an
entry sets it to done.

Routes by car, bus or train can be added by pasting a shared Google Maps
directions link (optional, needs a Google Maps API key).

## Running it

```sh
cp .env.example .env
docker compose up --build -d
```

Then open http://localhost:8421.

| Variable | Default | Purpose |
|---|---|---|
| `FRONTEND_PORT` | `8421` | Host port the app is served on |
| `DATA_PATH` | `./data` | Where the database, uploaded GPX files and terrain cache live |
| `PUID` / `PGID` | `1000` | User and group the backend runs as; match the owner of `DATA_PATH` |
| `TZ` | `Europe/Zurich` | Container timezone |
| `GOOGLE_MAPS_API_KEY` | unset | Enables routes from Google Maps links; see below |
| `MAX_IMPORT_MB` | `500` | Largest export file the backend accepts on import |

Only the frontend publishes a port; it serves the page and proxies `/api` to
the backend on an internal network. Locally, `docker-compose.override.yml`
also publishes the backend on port 3000 for debugging. The app has no login,
so put it behind your reverse proxy's access control if it is reachable from
outside.

## Moving data between installations

**Settings → Transfer** exports everything to one file
(`how-high-YYYY-MM-DD.json.gz`): hikes and routes with what they were made
from, their measurements, marks, ratings, and the settings. Terrain and map
caches are not included; they are fetched again when needed.

Importing that file elsewhere first shows what it holds and what would
change, then either adds to what is there (entries both sides have are
updated from the file; an entry is recognised by the GPX file or route it
was made from) or replaces everything. The settings in the file can be taken
or left. The state before an import is saved as a backup export under
`backups/` in the data folder; the newest three are kept.

Both installations should run the same version. A file from a version that
measured differently is still accepted, but its entries are measured again
on arrival.

## How the score works

The track is resampled to a point every 5 m (15 m outside Switzerland). At
each point the terrain around it is measured:

- **Fall height**: height lost following the steepest line down from beside
  the path, for as long as the ground stays steep.
- **Drops** within 10, 30 and 100 m, to either side.
- **Side slope**: steepness of the ground across the direction of travel.
- **Ridge**: ground falling away on both sides.
- **Bridge**: ground dipping well below a straight span of track.

A second, separate measure is the **open view**: from every 25 m of the
route the app works out which ground is visible out to 8 km and how far
below you it lies. A flat, safe path that looks out over a valley 400 m down
scores on this even though nothing beside it is steep. Ground hidden behind
nearer ground does not count, a view has to span a set width of the horizon,
and forest at the spot halves it. It starts switched off for car, bus and
train.

The worse of the two decides. Together they give a score from 0 to 100,
shown as Easy, Mild, Exposed or Severe; the profile chart draws them as two
lines and each flagged section says whether drops, the view or both caused
it. Map data then adjusts it: wooded slopes and wide tracks lower the
score, tunnels clear it, and bridges are confirmed or dismissed. Neighbouring
flagged points are grouped into sections.

Every number involved is adjustable under **Settings**, with an explanation
of each. Hikes are stored as measurements and scored on demand, so a change
applies to all hikes at once.

### Routes from Google Maps links

A shared link only says where the route starts and ends and how it is
travelled, not which line it follows. The app asks Google's Routes API for
the route and scores that, so it is Google's current suggestion and can
differ from what was on screen when the link was shared. Public-transport
routes are split into legs (train, bus, walk), each matched to the railway
or road on the map.

Anything made from a link can be exported as a GPX file (**Export GPX**):
the line that was measured, a point every few metres, with the terrain
elevation under each point and one track per leg. Hikes uploaded as GPX give
back the original file instead.

A **walking** link is treated as a hike: it is listed under Hikes, scored
with the hike settings and compared with other hikes. The Hikes tab has its
own link field for this. Google keeps to roads and easy paths on foot, so
for a mountain trail a GPX from a hiking app follows the real path more
closely.

Google's line for a train ride is often a rough sketch that cuts across the
terrain, so only its two ends are trusted: the ride is traced along the
mapped track between them. Where no connected track is found, Google's line
is kept and any stretch of it with no track beside it is shown as not
scored rather than rated on terrain the train never crosses. Google does not accept stops in between for public
transport, so such a route is fetched stop to stop and joined.

A long route downloads terrain for its whole length the first time, about
1 MB per km in Switzerland, which can take several minutes. Adding and
re-analysing therefore run in the background: the entry appears in the
sidebar as pending, with a progress bar counting the roughly 5 km pieces it
is measured in, and can be cancelled. One is measured at a time and the
rest wait their turn. Pending entries are held in memory only, so one that
is interrupted by a restart has to be added again.

Roads and railways have their own set of scoring knobs (**Settings**, "Car,
bus and train"), which start out more lenient than the hiking ones: you are
inside a vehicle, usually behind a guardrail. Tunnels score nothing, and on a
mapped bridge the height above the ground is measured along its whole
length. Cable cars, gondolas, chairlifts, funiculars and rack railways are
rated Severe outright; each can be switched off in Settings. Rack railways
are only recognised where OpenStreetMap marks the rack rail.

For each ride the app also says which side the drops are on, relative to
the direction of travel, and which side to sit on when one is clearly
better. Bridges count as both sides, tunnels are left out, and a train leg is
split where the train reverses. It cannot know which way the seats face or
whether you get to choose one.

To enable links, create a Google Cloud project with billing, enable the
**Routes API**, create an API key restricted to that API, and set
`GOOGLE_MAPS_API_KEY`. Without it the link field is hidden and everything
else works. Each added route is one API request.

### Fitting the settings to your marks

Marks update forecasts and comparisons at once, but they do not move the
scoring settings by themselves. **Settings → Suggest settings from my marks**
works out changes under which marked stretches score as you marked them
(fine below Exposed, bad and turned-back at Exposed or above), moving each
setting as little as it can and never the level boundaries. It shows the
proposed values, the effect on your marks and on every rating and forecast,
and saves nothing until you apply. An applied suggestion can be reverted.
With few marks, many settings fit equally well, and the dialog says so.

### What it cannot see

Path width, railings, guardrails, chains and cables are not in any of the
data, nor which side of a train or bus you sit on. Forest
outlines are coarse, and trees near the treeline hide little. GPS lines can
be several metres off, which is why each section also shows an "at least"
score for the most favourable sideways shift. Treat the result as a warning
of where to look, and use the swisstopo and Google links on each section to
check for yourself.

## Data sources

- **Terrain in Switzerland**: [swissALTI3D](https://www.swisstopo.admin.ch/en/height-model-swissalti3d)
  2 m elevation model, © swisstopo.
- **Distant terrain for views**: the same global tiles as below, at about
  30 m, everywhere.
- **Terrain elsewhere**: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/),
  roughly 10 to 30 m. Good for steep mountainsides, blind to small cliffs;
  results are labelled as low confidence.
- **Paths, roads, railways, forest, bridges, tunnels**: © OpenStreetMap
  contributors, fetched through public Overpass servers: the Swiss one
  (overpass.osm.ch) inside Switzerland, the worldwide ones otherwise. The
  worldwide servers are often slow or down; a route is then scored on terrain
  alone and completed in the background once the data can be fetched.
- **Base map**: swisstopo national map inside Switzerland, OpenStreetMap
  elsewhere.

Terrain tiles and map data are cached under `DATA_PATH`, about 1 MB per km²
of Swiss terrain a route touches.

## Development

```sh
cd backend && npm install && npm run dev     # API on :3000, data in ../local-data
cd frontend && npm install && npm run dev    # page on :5173, proxies /api to :3000
```

- `npm test` in `backend/` runs the unit tests, which score synthetic terrain
  with known answers.
- `npm run analyze -- hike.gpx` in `backend/` analyses one file from the
  command line with the default settings.
- `npm run check` in `frontend/` type-checks the Svelte code.

## Layout

```
backend/src/
  exposure/   measuring terrain, scoring, sectioning, comparing stretches;
              pipeline.ts runs it over a whole route in pieces
  terrain/    swissALTI3D and global terrain loading
  context/    OpenStreetMap fetch and lookups
  gpx/        GPX parsing and resampling
  google/     Google Maps link parsing and route fetching
  api/        HTTP routes
  hikes.ts    stored hikes: measure, score on demand, marks, retries
  settings.ts every adjustable knob, with bounds
frontend/src/
  App.svelte  page shell
  lib/        map, profile chart, section table, settings, upload
```
