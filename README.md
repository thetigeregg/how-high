# How High

Shows where a hike is exposed, before you walk it. Built for someone with a
fear of heights living in Switzerland: the trigger is less altitude than steep
ground falling away beside the path, so that is what gets measured.

Upload a GPX file and you get the route coloured by exposure on a map, an
elevation and score profile, and a table of flagged sections. Mark how
stretches actually felt, and new hikes are compared against those marks.

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

Only the frontend publishes a port; it serves the page and proxies `/api` to
the backend on an internal network. Locally, `docker-compose.override.yml`
also publishes the backend on port 3000 for debugging. The app has no login,
so put it behind your reverse proxy's access control if it is reachable from
outside.

## How the score works

The track is resampled to a point every 5 m (15 m outside Switzerland). At
each point the terrain around it is measured:

- **Fall height**: height lost following the steepest line down from beside
  the path, for as long as the ground stays steep.
- **Drops** within 10, 30 and 100 m, to either side.
- **Side slope**: steepness of the ground across the direction of travel.
- **Ridge**: ground falling away on both sides.
- **Bridge**: ground dipping well below a straight span of track.

These combine into a score from 0 to 100, shown as Easy, Mild, Exposed or
Severe. Map data then adjusts it: wooded slopes and wide tracks lower the
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

Roads and railways have their own set of scoring knobs (**Settings**, "Car,
bus and train"), which start out more lenient than the hiking ones: you are
inside a vehicle, usually behind a guardrail. Tunnels score nothing, and on a
mapped bridge the height above the ground is measured along its whole
length. Cable cars, gondolas, chairlifts, funiculars and rack railways are
rated Severe outright; each can be switched off in Settings. Rack railways
are only recognised where OpenStreetMap marks the rack rail.

To enable links, create a Google Cloud project with billing, enable the
**Routes API**, create an API key restricted to that API, and set
`GOOGLE_MAPS_API_KEY`. Without it the link field is hidden and everything
else works. Each added route is one API request.

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
- **Terrain elsewhere**: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/),
  roughly 10 to 30 m. Good for steep mountainsides, blind to small cliffs;
  results are labelled as low confidence.
- **Paths, forest, bridges, tunnels**: © OpenStreetMap contributors, fetched
  through public Overpass servers. These are sometimes slow or down; a hike is
  then scored on terrain alone and completed in the background once the data
  can be fetched.
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
