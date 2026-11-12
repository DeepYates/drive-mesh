# Drive Mesh prototype: how it works

This document is for a reviewer who has not seen the code or the conversation that produced
it. It describes what the prototype does, how each part works, what has been measured, and
where the author thinks it is weakest. Setup and key bindings are in `README.md`.

## Purpose

DeepWalk captures streets by driving them with lidar and cameras and publishes the result as
a textured 3D mesh. The prototype puts a drivable car on that mesh in a browser. It exists to
answer one question: **is the mesh drivable as-is, or does the road surface need work first?**
It is a local, single-player test rig, not a game. There is no gameplay loop, sound,
multiplayer or public hosting.

## The data

**Mesh.** An OGC 3D Tiles 1.1 tileset served over HTTPS. The URL contains an API key as a
path segment (`dw_live_…`).

- The root tile has no content and 125 children. Each child points at a nested
  `tileset.json` for one grid cell of roughly 128 m × 128 m.
- Each cell is a five-level pyramid, with geometric error 8, 4, 2, 1 and 0 m. The one cell
  inspected has 172 tiles, 118 of them leaves. Refinement is `REPLACE`.
- Tile content is `.glb`. The tiles **require** `KHR_draco_mesh_compression` and
  `KHR_texture_basisu` (KTX2), and use `KHR_materials_unlit`. Materials are double-sided.
- Displayed tiles average about 10,000 triangles each.
- Bounding volumes at the root are regions in radians. The whole set spans about
  2.7 km × 2.0 km in central Iowa, at 217 to 274 m elevation. Cells carry a transform into
  Earth-centred (ECEF) coordinates.
- Cells only hold mesh where data was captured. Cell footprints total 2.06 km² inside a
  5.5 km² bounding box.
- The tile directory is timestamped and changed during development
  (`20261111T172812Z` became `20261111T211504Z`), so the tileset is regenerated in place.

**Routes.** A GeoJSON export of `vroom.pack_versions.display_route` for one project: 76
features in lon/lat, of which 68 are current LineStrings (61 m to 2,100 m, 32.5 km in total).
These are the paths the capture vehicle drove. They are 2D. All 68 lie entirely inside mesh
cell footprints, but a route can start a few metres before the mesh does.

## Files

| File | Lines | Role |
|---|---|---|
| `server.py` | 126 | Static file server plus a caching read-only proxy for the tiles |
| `build.mjs` | 31 | esbuild bundle; copies the Draco and Basis decoders into `static/libs` |
| `src/geo.js` | 56 | WGS84 to ECEF, and the local east-north-up frame |
| `src/vehicle.js` | 310 | The car: rigid body, suspension rays, tyre model |
| `src/main.js` | 791 | Everything else: tiles, routes, spawn, input, camera, HUD, autopilot, telemetry |
| `static/index.html` | 43 | Page shell and HUD markup |
| `test/smoke.mjs` | 154 | Headless Chrome driver: smoke run, single-route autopilot, multi-route survey |
| `test/profile.mjs`, `spawn.mjs`, `debug.mjs` | 72 | One-off probes used while debugging |

Dependencies are pinned: `three` 0.180.0, `3d-tiles-renderer` 0.4.28, `three-mesh-bvh` 0.9.1.
The bundle is 1.5 MB unminified.

## Server (`server.py`)

A standard-library `ThreadingHTTPServer` bound to 127.0.0.1.

- `/tiles/<path>` fetches `<upstream base>/<path>` and returns it. The upstream base is the
  tileset URL minus `tileset.json`, read from `$DRIVE_MESH_TILESET_URL` or
  `tileset_url.local.txt`. The browser never sees the key.
- Path segments that are empty, `.`, `..`, or contain `:` or `\` are rejected with 400.
- Responses are cached on disk under `.cache/tiles`, written to a temp file and renamed.
  A per-path lock stops two threads fetching the same tile. Tiles are cached forever; the
  root `tileset.json` is re-fetched after 600 s.
- Upstream failures return the upstream status or 502 with the exception type only, so the
  upstream URL is not echoed to the client.
- `/routes.geojson` serves the export file.

## Coordinate frame (`src/geo.js`)

Tiles sit about 6.4 × 10⁶ m from the ECEF origin, where a 32-bit float resolves roughly half
a metre. `makeFrame(lon0, lat0, h0)` builds an east-north-up frame at the centre of the root
bounding region and returns:

- `ecefToLocal()`, a `Matrix4` whose rows are east, up and −north. It is decomposed onto the
  tiles group, so every tile lands in local metres.
- `toLocal(lon, lat, h)`, used to convert route vertices.

The local axes are `+X` east, `+Y` up, `−Z` north. The arithmetic is in JS doubles; only
camera-relative matrices reach the GPU. One check was made: the tileset's bounding sphere
centre maps to (0.0, −0.1, −0.06) in local coordinates.

## Tiles and raycasting (`src/main.js`)

`TilesRenderer` is created with `GLTFExtensionsPlugin` holding a `DRACOLoader` and a
`KTX2Loader`. `errorTarget` is 10 px (URL option `?error=`).

All collision is done by raycasting the tiles that are currently displayed. There is no
separate collision mesh. `cast(origin, dir, far)` calls
`raycaster.intersectObject(tiles.group, true)` with `firstHitOnly`, transforms the face
normal to world space and flips it to oppose the ray.

Each tile gets a `three-mesh-bvh` bounds tree on the `load-model` event, disposed on
`dispose-model`. `Mesh.prototype.raycast` is replaced by the accelerated version globally.

## The car (`src/vehicle.js`)

One rigid body (position, quaternion, linear and angular velocity), 1,300 kg, with a diagonal
box inertia tensor. Car axes are `+X` right, `+Y` up, `−Z` forward. Constants are in the
`CAR` object at the top of the file.

**Once per rendered frame, `castRays`:**

- One ray per wheel, starting 0.8 m above the suspension mount and pointing along the car's
  down axis, 1.94 m long.
- A hit becomes a contact **plane** (hit point and normal). If the normal's Y component is
  below 0.7 the normal is replaced with straight up, so curb faces act as a flat step.
- A miss uses a horizontal plane at that wheel's last real ground height. A wheel that has
  never hit ground borrows the mean height of the wheels that have.
- Three horizontal rays along the velocity direction at bumper height. A hit on a face with
  normal Y ≤ 0.5 removes the velocity component into that face, with 15% bounce.

**At 120 Hz, `step`:** for each wheel with a plane,

- intersect the suspension axis with the plane to get suspension length and compression;
- suspension force = spring (30,000 N/m) × compression − damper (3,200 N·s/m) × contact
  velocity along the normal, plus a bump stop (160,000 N/m) past 0.22 m of travel, clamped
  between 0 and three car weights;
- lateral tyre force cancels 35% of side-slip velocity per substep;
- longitudinal force is engine (7,500 N shared by four wheels, tapering to zero at 38 m/s),
  rolling resistance and brakes;
- both are scaled to fit a friction circle of μ × suspension force (μ = 1.15, or 0.55 on the
  rear wheels under handbrake);
- the combined wheel force is applied at the suspension **mount**, not the contact patch.

Gravity and quadratic drag are added, then semi-implicit Euler integrates velocity and
position. Angular acceleration is computed in the body frame. Angular velocity is damped by
0.8 per second.

## Spawning

Ground height is unknown until tiles load, and tiles load only where the camera looks.

1. `requestSpawn` puts the camera 80 m above the highest possible ground, looking down at the
   route point.
2. `groundAt(x, z)` casts five vertical rays in a 1.2 m cross, lists every surface each ray
   passes through, and returns the height level that the most rays agree on within 0.35 m
   (minimum three rays; ties go to the higher level).
3. Ground must also exist 3 m ahead of and 3 m behind the point.
4. If streaming has gone quiet and there is still no ground, the spawn point moves 6 m up
   the route and tries again, up to 400 m.
5. Once ground is found the camera drops to 6 m above it, waits for streaming to settle
   (at least 0.4 s, at most 6 s), and the car is placed 0.99 m above the ground.

## Autopilot and telemetry

The autopilot is pure pursuit: it finds the nearest point on the route, aims at a point
`6 + 0.6 × speed` metres further along, steers proportionally to the heading error, and holds
a target speed with a proportional throttle. It halves the target speed when the heading
error exceeds 0.5 rad. If the car is slower than 0.6 m/s for 5 s it counts a stall and
respawns 12 m further along.

`window.__game.report()` returns, since the last autopilot start:

- `rmsVerticalAccel`, `maxAy`: body vertical acceleration per substep, gravity removed.
- `offMeshWheelFraction`: share of wheel-frames whose ray missed.
- `allWheelsOffFraction`, `airborneFraction`, `crashes`, `stalls`, `resets`, `tilesFailed`.
- `perf`: per-frame averages of raycast time, tile update time, render call time, triangles
  and draw calls.

## What has been measured

All runs were headless Chrome at 1280 × 720 on an Intel Iris Xe integrated GPU.

| Measurement | Result |
|---|---|
| Raycasts per frame, brute force | 17.1 ms |
| Raycasts per frame, with BVH | 0.2 to 0.4 ms |
| BVH build | 2.9 to 6.2 ms per tile |
| Frame time while driving, with BVH | about 17 to 18 ms (about 55 to 60 fps) |
| Render call | 1.2 to 1.8 ms for 0.8 to 1.9 M triangles in 81 to 112 draw calls |
| Autopilot, route index 30 (313 m) at 9 m/s target | completed; 0 crashes, 0 stalls, 0 resets |
| Same run, wheels off mesh | 0.2% of wheel-frames |
| Same run, vertical acceleration | 1.48 m/s² RMS, 9.8 m/s² peak |
| Manual throttle from rest, 6 s | reached 16.6 m/s over 115 m |

From screenshots: the road surface renders as a continuous textured slab with lane markings
and curb edges. Fragmented geometry is concentrated on verges and in tree canopies.

**Not yet measured.** A 14-route autopilot survey (about 10.6 km) was started but had produced
no rows when this was written. A direct probe of road-height noise (`test/profile.mjs`) has
been written and not run. Nobody has driven it by hand for long. Nothing has been tested on a
phone, on another browser, or over a real network (tiles came from a local disk cache after
the first fetch).

## Bugs found and fixed during development

These are listed because each one shows a place the design is fragile.

1. **No tiles loaded at start.** The loading camera sat at y = +5 looking down, which was
   below street level at that spot, so nothing was in view. Fixed by starting 80 m up.
2. **Spawn never completed.** The first route vertex was about 24 m before the mesh began.
   Fixed by walking up the route.
3. **Car fell through the world at spawn.** It spawned on the lip of the mesh with the rear
   wheels over empty space. Those wheels had no last height to hold. Fixed by the ground
   span check and the borrowed height.
4. **Immediate reset loop.** The "fell out of the world" test compared against `Infinity`
   when no wheel had seen ground.
5. **Low frame rate.** Brute-force raycasts. Fixed with the BVH.

## Where the author thinks it is weakest

1. **One ray per wheel.** A single ray samples surface noise that a real tyre's contact patch
   would average out. The measured roughness may be an artefact of this, not of the mesh.
   This is a hypothesis; the profile probe is meant to test it.
2. **Rays per frame, physics per substep.** Contact planes are up to one frame stale. At
   38 m/s and 60 fps the car moves 0.63 m between ray casts.
3. **The lateral tyre force depends on the timestep.** It cancels a fixed fraction of slip
   per substep, so changing `SUBSTEP` changes handling.
4. **The fallback floor hides holes.** A wheel over a hole rolls on at its last height. That
   keeps the car driving but means the car's behaviour understates how many holes there are.
   `offMeshWheelFraction` is the only place holes show up.
5. **Obstacle detection is thin.** Three rays, only along the direction of travel, at one
   height. The car can clip objects with its sides, slide into things sideways, and pass
   under or over anything not at bumper height.
6. **Integration is simple.** Semi-implicit Euler, no gyroscopic term, torque applied at the
   suspension mount to limit roll. It has not been checked against a reference.
7. **Level-of-detail swaps under the car are unexamined.** Collision uses displayed tiles, so
   the surface can change when a tile refines. One check at a single parked location showed
   no height change. Moving cases have not been looked at.
8. **The tile cache is unbounded and its failure mode is bad.** Tiles average about 375 KB and
   nothing is ever evicted; the cache reached about 2 GB in one afternoon. When the disk
   filled, cache writes failed and the proxy returned 502 for tiles it had already downloaded
   successfully (235 in one minute), leaving zero-byte `.tmp` files behind. A failed cache
   write should still serve the bytes. The first survey row (route index 0: completed, 0
   crashes, 0 stalls, but 21% of frames with no mesh under any wheel and 386 failed tiles)
   was taken during that failure and says nothing about the mesh. Separately, the cached
   root can point at a tile directory that no longer exists upstream for up to 600 s.
9. **Spawn search state is awkward.** The search mutates `spawnPending` across calls using a
   `searching` flag and a carried-over `searched` counter.
10. **Debug hooks reach into library internals.** `triangleStats` and `debug` read
    `tile.__visible`, `tile.__active` and `tile.__loadingState`, which are not public API.
11. **Leftovers.** `void waited` and `void offset` mark values that are computed and unused.
    The frame rate shown is an exponential average and lags.
12. **The geometry maths has one check.** There are no unit tests for `geo.js` or the
    vehicle.

## Questions for the reviewer

- Is the vehicle model sound enough to draw conclusions about the mesh from its telemetry,
  or do items 1 to 3 above make `rmsVerticalAccel` unreliable?
- Is collision against displayed tiles a reasonable basis for a real game, or should
  collision use a fixed level of detail, or a separate surface built from the routes?
- Is the hold-last-height floor the right behaviour at holes and edges, given that it masks
  the defect being measured?
- Is there anything in `server.py` that would be unsafe if the proxy were exposed beyond
  localhost, beyond the missing authentication and rate limiting?
- Are there correctness errors in the frame construction in `geo.js` or in the sign
  conventions in `vehicle.js` (steering, side vector, yaw from route direction)?
