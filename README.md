# Drive Mesh — driving prototype

Drive a car around the DeepWalk Drive 3D Tiles mesh in a browser. Built to answer one
question: is the mesh drivable as-is? Single-player, local, no build server.

## Run

```
cd game
npm install          # once
npm run build        # bundles src/ -> static/bundle.js, copies the Draco + Basis decoders
python server.py     # http://127.0.0.1:8600/
```

The tileset URL comes from `$DRIVE_MESH_TILESET_URL` or the first line of
`tileset_url.local.txt`. That URL contains the `dw_live_…` API key, so the file is in
`.gitignore`; the browser only ever requests `/tiles/...` from the local server, which proxies
(and disk-caches, in `.cache/tiles`) the real service. Routes come from
`../exports/pack_versions_display_route_<project>.geojson` (override with
`$DRIVE_ROUTES_GEOJSON`).

Keys: `W A S D` / arrows drive · `Space` handbrake · `R` reset onto the route · `N` next route
(`Shift+N` previous) · `C` camera · `P` autopilot. URL options: `?route=<n>` start route,
`?error=<px>` tile detail (default 10; lower = sharper and heavier), `?bvh=0` disable the
raycast BVH.

## How it works

- **Tiles** — `3d-tiles-renderer` streams the tileset. The tiles *require* Draco geometry and
  KTX2/Basis textures, so both decoders are wired in (`GLTFExtensionsPlugin`).
- **Coordinates** (`src/geo.js`) — tiles are in Earth-centred coordinates, ~6.4e6 m from the
  origin, which jitters at float precision. The tiles group is transformed into an
  east-north-up frame at the mesh centre: `+X` east, `+Y` up, `-Z` north. Routes (lon/lat) go
  through the same frame; their height comes from the mesh.
- **Car** (`src/vehicle.js`) — a hand-rolled raycast vehicle: one rigid body, four
  spring-damper suspension rays, friction-circle tyres, 120 Hz substeps. Collision is "what
  you see": rays hit the tiles currently displayed, so there is no separate collision mesh.
  Rays are cast once per frame and reduced to a contact plane per wheel.
- **Raycast speed** — every tile gets a `three-mesh-bvh` tree when it loads. Without it the
  7 rays per frame cost ~17 ms; with it ~0.3 ms.
- **Holes and edges** — a wheel whose ray finds nothing keeps rolling on an invisible flat
  patch at its last real ground height (a faint grid fades in to show it). One mechanism
  covers holes, tiles that have not streamed in yet, and the edge of the capture.
- **Spawning** — ground height is a vote across five rays (the mesh has fragments above and
  below the road), ground is required under the whole car, and if a route starts before the
  mesh does the spawn walks up the route until it finds some.
- **Obstacles** — three horizontal rays at bumper height; faces steeper than ~60° stop the car.

## Measuring drivability

`P` (or `window.__game.startAutopilot(route, speed)`) runs a pure-pursuit driver along a route
and collects telemetry, readable from `window.__game.report()`. `test/smoke.mjs` drives that
headlessly through the installed Chrome:

```
node test/smoke.mjs smoke                 # spawn, hold the throttle, screenshots in test/out
node test/smoke.mjs auto 30 9             # one route at 9 m/s, with screenshots
node test/smoke.mjs survey 9 0,2,6,13     # several routes -> test/out/survey_9.json
```

Fields: `rmsAy` / `maxAy` vertical acceleration of the body (m/s², gravity removed),
`offMeshWheel` share of wheel-frames with no mesh under the wheel, `allWheelsOff` share of
frames with no mesh under any wheel, `crashes` obstacle hits above 1.5 m/s, `stalls` times the
autopilot sat still for 5 s and was hopped 12 m up the route.

## Routes

Routes that never enter the mesh are dropped. If none are left (no export, or an export for a
different capture), the game surveys the mesh from above and uses the longest straight, level
runs of ground as routes (`stepScan` in `src/main.js`) — in a street capture those are the
roads. To use real routes on the hosted build, commit a matching `static/routes.geojson`.

## Hosting (GitHub Pages + Cloudflare Worker)

Pages serves `static/`; the tiles come from a Worker (`worker/`) that does what `server.py`'s
`/tiles/` proxy does, with the tileset URL (and its API key) held as a Worker secret.

```
cd worker
npx wrangler login
npx wrangler secret put TILESET_URL     # paste the full .../tileset.json URL
npx wrangler deploy                     # prints https://drive-mesh-tiles.<you>.workers.dev
```

Then in the GitHub repo: Settings → Pages → Source = **GitHub Actions**, and Settings →
Secrets and variables → Actions → Variables → `TILESET_URL` =
`https://drive-mesh-tiles.<you>.workers.dev/tiles/tileset.json`. Every push to `main` runs
`.github/workflows/pages.yml`, which builds with that URL baked in and publishes `static/`.

- Every URL in the page is resolved against the bundle's own URL, so it works under
  `/<repo>/`. The tileset URL is the one build-time setting (`$TILESET_URL`, default
  `./tiles/tileset.json` for `server.py`).
- `ALLOWED_ORIGINS` in `worker/wrangler.toml` lists the sites allowed to use the proxy. A
  custom domain or a different GitHub account means editing it and redeploying.
- The Worker hides the key, not the data: anything it serves is effectively public.

## Not done

No multiplayer, no sound, no gameplay loop.
