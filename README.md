# Drive Mesh

Drive a car through DeepWalk 3D Tiles meshes in a browser. It began as a prototype to answer
"is the mesh drivable as-is?" and is now also a marketing demo: a start screen with a mesh
gallery, a car picker and a lead form, multiplayer, and a daily capacity limit.

Live: https://deepyates.github.io/drive-mesh/ (GitHub Pages) with a Cloudflare Worker
(`worker/`) for tiles, rooms, admission and the lead fallback.

## Run locally

```
npm install          # once
npm run build        # bundles src/ -> static/bundle.js, copies the Draco + Basis decoders
python server.py     # http://127.0.0.1:8600/
```

`server.py` serves `static/` and proxies `/tiles/<mesh>/...` to the tile service, caching on
disk in `.cache/tiles`. Tileset URLs carry the `dw_live_…` API key, so they live in
git-ignored files: `tilesets.local.json` (`{"<mesh id>": "<.../tileset.json>"}`) or, for a
single mesh, `tileset_url.local.txt`. With no Worker, there is no admission gate, lead
fallback or multiplayer.

Keys: `W A S D` / arrows drive · `Space` handbrake · `R` reset onto the route · `N` next route
· `C` camera · `P` autopilot. URL options: `?mesh=<id>`, `?room=<name>`, `?route=<n>`,
`?error=<px>` tile detail (default 10; lower = sharper), `?sat=0` no satellite, `?mp=0` no
multiplayer, `?touch=1` phone controls, `?pick=1` reopen the start screen, `?bvh=0`.

## The site: `static/meshes.json`

One file holds everything public about the site. No URLs with keys go in it.

```
site.title, site.pitch          start screen headline and text
site.ctaLabel, site.ctaUrl      the "Talk to DeepWalk" button (bar, prompts, capacity page)
site.privacyUrl                 linked from the lead form when set
site.hubspot.portalId/formGuid  lead capture; an empty formGuid turns the gate OFF
site.hubspot.consentText        sent as GDPR consent text if the portal requires it
site.errorTarget                tile detail; site.tileBudget / tileHardStop: see Capacity
meshes[]: id, title, provider, place, blurb, thumb?, routes?, routeCache?, sceneUrl?, unlisted?
```

**Add a mesh:** add an entry to `meshes[]`, add its tileset URL under the same id to the
Worker's `TILESETS` secret (and `tilesets.local.json`), run `node test/thumbs.mjs` for its
thumbnail, push. With two or more listed meshes the start screen shows the gallery.

**Unlisted meshes:** `"unlisted": true` keeps a mesh out of the gallery and out of the
default; it loads only from a link that names it (`?mesh=<id>`), and needs no thumbnail.
This keeps it off the site, not secret: the id is in this public file. The Iowa mesh
(`johnston`, 2.7 km x 2 km, 68 routes in `static/routes/johnston.geojson`) is unlisted.

**View in ArcGIS Online:** every mesh gets this button. It opens ArcGIS Online's Scene
Viewer with the mesh as a 3D Tiles layer:
`https://www.arcgis.com/home/webscene/viewer.html?url=<worker>/tiles/<id>/tileset.json`
(URL-encoded). The address is the Worker's keyless one, so the keyed service URL is never
published; `TILE_ORIGINS` in `worker/wrangler.toml` lets ArcGIS's site (and any
`<org>.maps.arcgis.com`) read tiles and nothing else. Those requests count against the
same daily allowance and have no per-visitor budget. A mesh can set its own `sceneUrl`
(a saved web scene, say), or `"sceneUrl": false` for no button.

**Routes:** a mesh with `"routes": true` loads `static/routes/<id>.geojson`. Without one,
the game surveys the mesh from above and uses the longest straight, level runs of ground as
routes (`stepScan` in `src/main.js`); roads at an angle to the axes come out shorter.
The survey takes several seconds and an overview's worth of tiles, so its result is kept:
`node test/thumbs.mjs` writes `static/routes/<id>.json` (used when the mesh has
`"routeCache": true`), and each browser also remembers it. Both are tied to the mesh's
timestamp folder and ignored when the mesh changes; `?rescan=1` forces a new survey.

## Lead gate (`src/start.js`, `src/lead.js`)

With `site.hubspot.formGuid` set, a visitor must give a work email and a name before
driving; company is optional. Order: form → `POST /enter` (admission) → HubSpot → drive, or
the capacity page. The lead reaches HubSpot either way.

**The email step is HubSpot's own embedded form** (`hbspt.forms.create`, rendered into the
start screen). HubSpot's script submits it, so it records like any form on the website.
Posting to the form's API from the page was tried first: HubSpot answered "200 OK" and then
discarded or spam-filed every submission. The game starts when HubSpot reports the
submission went through (`onFormSubmitted`). The page's own email and company fields, and
the API path described below, are only the fallback for a browser that blocks HubSpot's
script (`site.hubspot.embed: false` forces the fallback; the tests use it). With the embed,
the mesh and outcome are not sent: HubSpot records the page address and title itself. The
form's button label and fields are whatever the form has in HubSpot; if it has a First
name field, that is the name shown on the car.

**The HubSpot form** (legacy editor, reCAPTCHA off) is "DeepWalk Drive Game" form
`242060b0-0bed-4978-8941-515a68cc9616` in portal 46598388. Its id is in
`site.hubspot.formGuid` and in `HUBSPOT_FORM` in `worker/wrangler.toml`. Fields the game can fill:

| Field | Type | Notes |
|---|---|---|
| `email` | built-in | required; the only field the form has today |
| `firstname` | built-in | the name shown above the car |
| `company` | built-in | optional for the visitor |
| `drive_demo_mesh` | new contact property, single-line text | mesh id |
| `drive_demo_outcome` | new contact property, single-line text | `played` or `at_capacity` |

Only the fields the form has are sent: the page reads the form's public definition first
(the JSON HubSpot's embed script uses). Add a field to the form in HubSpot and it starts
being filled; nothing changes here. If the definition cannot be read, the lead is offered in
three shapes until one is accepted: all five fields, then email + name + company, then email
alone. Every submission's page name reads "Drive the mesh - <mesh> - drove it" (or
"turned away, demo at capacity"), followed by the name and company when those could not be
sent as fields.

- The browser posts to `api.hsforms.com` directly. If that is blocked (ad blockers), it
  retries through the Worker (`POST /lead`). If both fail, the visitor is let in and the
  submission is queued in localStorage and retried on their next visit.
- An address HubSpot refuses (`INVALID_EMAIL`, `BLOCKED_EMAIL`) keeps the gate shut.
- The page address is sent as `pageUri`, so UTM tags on campaign links reach HubSpot.
- Returning visitors skip the form. A first view of another mesh sends one more submission.
- Other players see only the name. The email never enters the multiplayer path.
- The gate runs in the browser: it is a prompt for interested people, not access control.
  Automated browsers (the tests) skip it and send nothing.

## Capacity and cost

**Keep the Cloudflare account on the Workers Free plan.** Free never bills: at a daily limit
(100,000 Worker requests; Durable Objects 100,000 requests + 13,000 GB-s) requests fail
until 00:00 UTC. Workers Paid has no spending cap. Pages, HubSpot forms and the satellite
imagery cost nothing here. The one real exposure is data served by the DeepWalk tile
service on edge-cache misses (`/stats` reports misses and bytes).

The site is sized for **25 new visitors a day** (`DAILY_USERS` in `worker/wrangler.toml`):

- **Admission** (`worker/src/gate.js`): the 26th new visitor of the UTC day gets the
  capacity page. A signed day-pass means a returning visitor takes no new place. If the
  Worker is unreachable (the free plan's hard stop) the page shows the same capacity page.
- **Tile budget** (`watchTileBudget`): tiles are the binding cost, one request each.
  Measured on the Pinellas mesh: ~250 tiles to spawn, then ~1.5 per metre, so a 320 m route
  is ~750 and all three routes ~1,200. Detail level, view distance and ancestor/sibling
  loading each changed that by under 15% — it is set by how finely the mesh is tiled. Each
  visitor gets `tileBudget` (3,200) network tiles a day at full detail and `tileHardStop`
  (4,000) in total; then streaming stops and what is loaded stays drivable. Tiles from the
  browser's cache (kept 30 days) are not counted. **25 visitors x 4,000 tiles is the whole
  daily allowance**: 4,000 is enough for every route of about three meshes like this one.
  Visitors x tiles must stay at or under 100,000 on the free plan.
- **Bypass for the owner:** opening the site once with `?unlimited=<code>` switches the tile
  limit off in that browser (the HUD shows "no tile limit") until the code changes;
  `?unlimited=off` puts it back. The code is in the git-ignored `bypass_code.local.txt`;
  only its SHA-256 is published (`site.unlimitedHash`). To revoke every link, delete that
  file, generate a new code and hash, and push. The parameter is stripped from the address
  immediately. It lifts only the page's own limit: the tiles still count against the daily
  allowance, and the daily visitor cap still applies.
- **Limits against abuse:** only the Pages origin may call the Worker; per-IP rate limits
  (tiles 5,000/min, about five cars at speed behind one address; rooms 40/min; forms 20/min; approximate); rooms hold 8 players, accept
  15 messages/s per socket, drop sockets silent for 5 min, and hibernate when quiet;
  `MULTIPLAYER = "off"` turns rooms off.
- **Numbers:** `GET <worker>/stats?key=<STATS_KEY>&days=7` returns per-day admissions,
  turn-aways (overall and per mesh) and tile cache hits/misses. No visitor data is stored.

## Multiplayer (`src/net.js`, `worker/src/room.js`)

Players on the same mesh and room see each other drive (cars pass through each other). Each
browser simulates its own car and sends its pose; a Durable Object per room relays it.
Peers are drawn ~150 ms in the past, interpolated between real poses. The room name is
`<room>-<mesh id>-<mesh timestamp>`, so two meshes or two versions never share one.
"Invite a colleague" makes a link to a fresh private room. Any failure (room full,
allowance used up, connection lost) falls back to single-player.

## Cars (`src/cars.js`)

Six models from [Kenney's Car Kit](https://kenney.nl/assets/car-kit) (CC0; files unmodified
in `static/cars/`, licence in `static/cars/LICENSE.txt`). At load time the body is repainted
in a DeepWalk livery and the DeepWalk mark (`static/brand/mark.png`) is placed on the roof
and doors. The visitor's car is navy `#13213C` with a white mark; other players get white,
steel blue or pale grey. The choice is made on the start screen ("Change car" in the bar
reopens it) and sent to other players with the name. Cars are cosmetic: the physics body
(`src/vehicle.js`) is the same for all. Until a model loads, the built-in box car is shown.

## Phones (`src/touch.js`)

On a touch device the game shows on-screen steering, gas and brake, starts on autopilot with
a "Take the wheel" button, uses coarser tile detail and a compact HUD.

## Satellite basemap

Aerial imagery under and around the mesh (`buildBasemap`), loaded by the browser straight
from the imagery server, with its attribution on screen. It is drawn as a backdrop (its
depth is pinned just in front of the sky), so the mesh always shows over it. `?sat=0` turns
it off.

**It is draped over the ground** (`terrain` in `src/main.js`), so it meets the mesh at the
mesh's own height. The ground is learnt as the car drives, because the mesh is only at full
detail near the car: exact heights under the car, a few rays a frame at tiles within 55 m
that already have their BVH (the highest surface near the ground already known there, which
skips canopy, poles and stray fragments), and known heights spread outward to fill holes
and the area beyond the capture. Each imagery piece is a grid that eases onto that surface.
Measured against the mesh's ground along a route: median 1 cm, 90% within 7 cm on Pinellas
(a flat sheet at the car's level: 7 cm and 33 cm); 6 cm and 14 cm on the larger Iowa mesh,
whose height grid is coarser (8 m cells against 3 m). No measurable frame cost. `?drape=0`
keeps the flat sheet for comparison. Things that stand up from the ground (buildings, trees,
parked cars) are still painted flat: the source is a top-down photo.

The default source is Esri World Imagery. A mesh can name its own in the catalogue:

```
"basemap": { "url": "https://.../tile/{z}/{y}/{x}", "maxZoom": 19, "detailZoom": 21,
             "attribution": "..." }
```

`maxZoom` caps the wide layer (the whole mesh plus a margin, at most 9 x 9 tiles). With
`detailZoom`, a second, sharper layer streams in within 70 m of the car as it drives and is
dropped when far behind. The server must use the standard Web Mercator tile scheme and
allow cross-origin requests.

**Local-only settings:** on `localhost`/`127.0.0.1` the page also loads the git-ignored
`static/meshes.local.json` and lays it over the catalogue
(`{ "site": {...}, "meshes": { "<id>": {...} } }`). The live site never requests it.
Use it for settings that should not be published (the email gate off, no tile limit).

Pinellas uses the county's 2026 3-inch orthophotos
(`egis.pinellas.gov/gis/rest/services/Aerials2026/ImageServer`, native at level 21),
set in its `basemap` entry in `static/meshes.json`.

## How the driving works

- **Tiles** — `3d-tiles-renderer` streams the tileset; Draco and KTX2/Basis decoders are wired in.
- **Coordinates** (`src/geo.js`) — the tiles group is moved into an east-north-up frame at
  the mesh centre (`+X` east, `+Y` up, `-Z` north) to avoid float jitter at Earth scale.
- **Car** (`src/vehicle.js`) — a raycast vehicle: one rigid body, four spring-damper
  suspension rays, friction-circle tyres, 120 Hz substeps. Rays hit the tiles on screen, so
  there is no separate collision mesh. Each tile gets a `three-mesh-bvh` tree (in a worker).
- **Holes** — a wheel whose ray finds nothing keeps rolling at its last ground height.
- **Spawning** — ground height is a vote across five rays; ground is required under the
  whole car; the spawn walks up the route until it finds some.

## Deploying

```
cd worker
npx wrangler secret put TILESETS    # JSON {"<mesh id>": "<.../tileset.json URL with key>"}
npx wrangler secret put PASS_KEY    # any long random string
npx wrangler secret put STATS_KEY   # any long random string
npx wrangler deploy
```

GitHub: Settings → Pages → Source = **GitHub Actions**; Actions variable `TILES_BASE` =
`https://<worker>.workers.dev/tiles/`. Every push to `main` builds and publishes `static/`.
`ALLOWED_ORIGINS` in `worker/wrangler.toml` must list the site's origin.

## Tests

All drive the installed Chrome headless. Local stack: `npx wrangler dev` in `worker/` with a
`.dev.vars` (see the top of `test/gate.mjs`), a build made with
`TILES_BASE=http://127.0.0.1:8787/tiles/`, and `python server.py`.

```
node test/smoke.mjs smoke        # spawn and drive (works against plain server.py too)
node test/smoke.mjs auto 30 9    # one route on autopilot; survey 9 0,1,2 for several
node test/multi.mjs              # two browsers: names, car models, positions, leaving
node test/limits.mjs [worker] [origin] [--idle=<s>]   # abuse checks on rooms and tiles
node test/gate.mjs               # the funnel: form, HubSpot (stand-in), admission, capacity,
                                 # ad-blocker fallback, tile budget, phone mode
node test/thumbs.mjs             # regenerate mesh thumbnails, car pictures and og.jpg
```

`smoke`, `multi` and `limits` also run against the live site (`GAME_URL=...`).
