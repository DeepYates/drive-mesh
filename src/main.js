// Drive-mesh prototype: drive a car over DeepWalk's streamed 3D Tiles mesh.
import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { GLTFExtensionsPlugin } from '3d-tiles-renderer/plugins';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree, MeshBVH } from 'three-mesh-bvh';
import { makeFrame } from './geo.js';
import { CAR, Vehicle } from './vehicle.js';

// Wheel and obstacle rays hit ~25k-triangle tiles every frame. Brute force cost 17 ms/frame;
// a per-tile BVH makes each ray a few dozen tests. Trees are built in workers, and only for
// tiles near the car (see "raycast BVHs" below); a mesh without one is raycast brute-force by
// acceleratedRaycast, which returns the same hits.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;
const USE_BVH = new URLSearchParams( location.search ).get( 'bvh' ) !== '0';

// Every URL is resolved against this bundle's own URL, never the site root, so the page works
// under any base path (GitHub Pages serves it from /<repo>/). __TILESET_URL__ is set at build
// time (build.mjs, $TILESET_URL): './tiles/tileset.json' for the local server.py proxy, or
// the absolute URL of the tile proxy Worker for a hosted build.
const asset = path => new URL( path, import.meta.url ).href;
const TILESET = asset( __TILESET_URL__ );
const SUBSTEP = 1 / 120;
const MPH = 2.23694;
const $ = id => document.getElementById( id );
const params = new URLSearchParams( location.search );

// ---------- renderer / scene ----------
// Resolution is adaptive (adaptResolution): it starts at the display's pixel ratio, capped at
// 2, and steps down only while the median frame is slow. `?res=<ratio>` pins it.
const PR_MAX = Math.min( devicePixelRatio || 1, 2 ), PR_MIN = Math.min( PR_MAX, 0.75 );
const PR_FIXED = Number( params.get( 'res' ) ) || 0;
let pixelRatio = PR_FIXED || PR_MAX;
const renderer = new THREE.WebGLRenderer( { antialias: true, powerPreference: 'high-performance' } );
renderer.setPixelRatio( pixelRatio );
renderer.setSize( innerWidth, innerHeight );
document.body.appendChild( renderer.domElement );

// Atmosphere. The tile materials are unlit, so the scene lights only reach the car; what the
// mesh gets is fog. FOG_DENSITY is tuned so the mesh has dissolved into the horizon colour by
// ~1 km, and the far plane sits where it is opaque - tiles past that are never requested.
// `?fog=0` turns it off and restores the old 5 km far plane.
const FOG_DENSITY = params.has( 'fog' ) ? Number( params.get( 'fog' ) ) : 0.002;
const FAR = FOG_DENSITY > 0 ? Math.min( 5000, 2.4 / FOG_DENSITY ) : 5000;
const SKY = {
	zenith: new THREE.Color( 0x3f7fca ), horizon: new THREE.Color( 0xc4d6e6 ),
	// Below the horizon the dome is earth-coloured, so a hole in the mesh reads as missing
	// ground (flat, untextured) rather than as a patch of sky.
	ground: new THREE.Color( 0x59605a ), sun: new THREE.Color( 0xfff1d6 ),
	sunDir: new THREE.Vector3( 40, 80, 30 ).normalize(),
};
renderer.setClearColor( SKY.horizon );

const scene = new THREE.Scene();
if ( FOG_DENSITY > 0 ) scene.fog = new THREE.FogExp2( SKY.horizon, FOG_DENSITY );
const sun = new THREE.DirectionalLight( 0xfff4e0, 2.6 );
sun.position.copy( SKY.sunDir ).multiplyScalar( 100 );
scene.add( sun );
const BASE_FOV = 62;
const camera = new THREE.PerspectiveCamera( BASE_FOV, innerWidth / innerHeight, 0.4, FAR );

function buildSky() {

	// A unit box around the camera, written at the far plane (z = w) and drawn after the
	// opaque mesh, so the gradient is only shaded where no tile covered the pixel.
	const mat = new THREE.ShaderMaterial( {
		uniforms: { zenith: { value: SKY.zenith }, horizon: { value: SKY.horizon }, ground: { value: SKY.ground },
			sunCol: { value: SKY.sun }, sunDir: { value: SKY.sunDir } },
		vertexShader: /* glsl */`
			varying vec3 vDir;
			void main() {
				vDir = position;
				vec4 p = projectionMatrix * vec4( mat3( viewMatrix ) * position, 1.0 );
				gl_Position = p.xyww;
			}`,
		fragmentShader: /* glsl */`
			uniform vec3 zenith, horizon, ground, sunCol, sunDir;
			varying vec3 vDir;
			void main() {
				vec3 d = normalize( vDir );
				vec3 col = mix( horizon, zenith, 1.0 - exp( - max( d.y, 0.0 ) * 3.2 ) );
				col = mix( col, ground, smoothstep( 0.0, - 0.10, d.y ) );
				float s = max( dot( d, sunDir ), 0.0 );
				col += sunCol * ( pow( s, 900.0 ) * 1.5 + pow( s, 24.0 ) * 0.22 ) * smoothstep( - 0.02, 0.03, d.y );
				// a little noise hides 8-bit banding in the gradient
				col += ( fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) - 0.5 ) / 255.0;
				gl_FragColor = vec4( col, 1.0 );
				#include <colorspace_fragment>
			}`,
		side: THREE.BackSide, depthWrite: false, fog: false,
	} );
	const m = new THREE.Mesh( new THREE.BoxGeometry( 1, 1, 1 ), mat );
	m.frustumCulled = false;
	m.renderOrder = 1000;
	return m;

}

scene.add( buildSky() );
{

	// The same sky, prefiltered once, as the car's environment map: paint and glass pick up
	// the horizon and the ground tone. Unlit tile materials ignore it.
	const pmrem = new THREE.PMREMGenerator( renderer );
	scene.environment = pmrem.fromScene( new THREE.Scene().add( buildSky() ), 0.02 ).texture;
	pmrem.dispose();

}

// Shown only while the car is off the mesh: the fallback floor the wheels are rolling on.
const voidFloor = ( () => {

	const c = document.createElement( 'canvas' );
	c.width = c.height = 128;
	const x = c.getContext( '2d' );
	x.fillStyle = 'rgba(255,255,255,0.10)'; x.fillRect( 0, 0, 128, 128 );
	x.strokeStyle = 'rgba(255,255,255,0.9)'; x.lineWidth = 3; x.strokeRect( 0, 0, 128, 128 );
	const tex = new THREE.CanvasTexture( c );
	tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
	tex.repeat.set( 60, 60 );
	tex.anisotropy = 8;
	const m = new THREE.Mesh( new THREE.PlaneGeometry( 600, 600 ).rotateX( - Math.PI / 2 ),
		new THREE.MeshBasicMaterial( { map: tex, transparent: true, opacity: 0, depthWrite: false } ) );
	m.visible = false;
	m.renderOrder = 1;
	return m;

} )();
scene.add( voidFloor );

// ---------- state ----------
const car = new Vehicle();
const carMesh = buildCarMesh();
scene.add( carMesh.root, carMesh.shadow );
const keys = new Set();
let tiles = null, frame = null, routes = [], bounds = null;
let state = 'boot';            // boot -> loading -> driving
let routeIdx = 0, spawnPending = null, cameraMode = 'chase';
let acc = 0, last = performance.now(), fps = 60, upsideDownFor = 0;
const auto = { on: false, speed: 9, idx: 0, stuckFor: 0, done: false };
const stats = newStats();
const spawnLog = [];
const perf = { frames: 0, cast: 0, step: 0, tiles: 0, render: 0, tris: 0, calls: 0, frameMs: 0, slowFrames: 0,
	bvhTiles: 0, bvhBuildMs: 0, bvhMainMs: 0 };
let lastInput = { throttle: 0, steer: 0, brake: 0, handbrake: false };

function newStats() {

	return { frames: 0, time: 0, distance: 0, wheelFrames: 0, offMeshWheelFrames: 0, allOffMeshFrames: 0,
		airFrames: 0, sumAy2: 0, substeps: 0, maxAy: 0, crashes: 0, stalls: 0, resets: 0, maxSpeed: 0,
		tilesFailed: 0, routeProgress: 0, route: null };

}

// ---------- boot ----------
boot().catch( fail );

function fail( err ) {

	console.error( err );
	renderer.setAnimationLoop( null );    // the HUD would otherwise overwrite the message
	$( 'overlay' ).classList.add( 'failed' );
	$( 'overlayText' ).textContent = 'Failed to start: ' + err.message;

}

async function boot() {

	const [ ts, gj ] = await Promise.all( [
		fetch( TILESET ).then( r => r.ok ? r.json() : Promise.reject( new Error( `tileset ${r.status}` ) ) ),
		fetch( asset( './routes.geojson' ) ).then( r => r.ok ? r.json() : { features: [] } ),
	] );

	// Local frame at the centre of the root bounding region (radians, metres).
	const [ w, s, e, n, zmin, zmax ] = ts.root.boundingVolume.region;
	frame = makeFrame( ( w + e ) / 2, ( s + n ) / 2, ( zmin + zmax ) / 2 );
	const c0 = frame.toLocal( w, s ), c1 = frame.toLocal( e, n );
	bounds = { minX: Math.min( c0[ 0 ], c1[ 0 ] ), maxX: Math.max( c0[ 0 ], c1[ 0 ] ),
		minZ: Math.min( c0[ 2 ], c1[ 2 ] ), maxZ: Math.max( c0[ 2 ], c1[ 2 ] ), halfY: ( zmax - zmin ) / 2 };

	// Routes: current pack versions only, lon/lat degrees -> local x/z (height comes from the mesh).
	const rad = Math.PI / 180;
	routes = gj.features
		.filter( f => f.geometry && f.geometry.type === 'LineString' && f.properties.is_current )
		.map( f => {

			const pts = f.geometry.coordinates.map( ( [ lon, lat ] ) => {

				const p = frame.toLocal( lon * rad, lat * rad );
				return new THREE.Vector2( p[ 0 ], p[ 2 ] );

			} );
			const cum = [ 0 ];
			for ( let i = 1; i < pts.length; i ++ ) cum.push( cum[ i - 1 ] + pts[ i ].distanceTo( pts[ i - 1 ] ) );
			return { id: f.properties.id, pts, cum, length: cum[ cum.length - 1 ] };

		} )
		.filter( r => r.pts.length > 1 && r.length > 20 )
		// A route that never enters the mesh cannot be spawned on (the camera would sit over
		// empty space and no tile would ever be requested).
		.filter( r => r.pts.some( p => p.x >= bounds.minX && p.x <= bounds.maxX && p.y >= bounds.minZ && p.y <= bounds.maxZ ) )
		.sort( ( a, b ) => b.length - a.length );


	tiles = new TilesRenderer( TILESET );
	const dracoLoader = new DRACOLoader().setDecoderPath( asset( './libs/draco/' ) );
	dracoLoader.preload();    // fetch + compile the decoder now, not when the first tile arrives
	tiles.registerPlugin( new GLTFExtensionsPlugin( {
		dracoLoader,
		ktxLoader: new KTX2Loader().setTranscoderPath( asset( './libs/basis/' ) ).detectSupport( renderer ),
	} ) );
	tiles.errorTarget = Number( params.get( 'error' ) ) || 10;
	tiles.setCamera( camera );
	tiles.setResolutionFromRenderer( camera, renderer );
	tiles.addEventListener( 'load-error', () => stats.tilesFailed ++ );
	const anisotropy = Math.min( 8, renderer.capabilities.getMaxAnisotropy() );
	tiles.addEventListener( 'load-model', ( { scene: model } ) => {

		model.traverse( o => {

			if ( ! o.isMesh ) return;
			// The chase camera sees the road at a grazing angle, where trilinear filtering
			// alone smears the texture along the view direction.
			const map = o.material.map;
			if ( map && map.anisotropy !== anisotropy ) {

				map.anisotropy = anisotropy;
				map.needsUpdate = true;

			}

			if ( USE_BVH ) bvhJobs.add( { mesh: o, model, state: 'waiting', centre: null, radius: 0, dist: 0 } );

		} );

	} );
	tiles.addEventListener( 'dispose-model', ( { scene: model } ) => {

		for ( const job of bvhJobs ) {

			if ( job.model !== model ) continue;
			job.state = 'disposed';      // a worker result that arrives later is dropped
			bvhJobs.delete( job );

		}

		model.traverse( o => o.isMesh && o.geometry.boundsTree && o.geometry.disposeBoundsTree() );

	} );
	frame.ecefToLocal().decompose( tiles.group.position, tiles.group.quaternion, tiles.group.scale );
	scene.add( tiles.group );
	if ( USE_BVH ) startBvhWorkers( 2 );

	routeIdx = Math.min( Number( params.get( 'route' ) ) || 0, Math.max( routes.length - 1, 0 ) );
	if ( routes.length ) {

		requestSpawn( routeIdx, 0 );
		state = 'loading';

	} else {

		// No route export for this mesh (or one for a different capture): find roads in the
		// mesh itself and use those as the routes.
		startScan();
		state = 'scanning';

	}

	renderer.setAnimationLoop( tick );

}

// ---------- routes from the mesh ----------
// With no usable route export, the mesh is surveyed from above: one down-ray per SCAN_CELL
// metres gives a height grid, and the longest straight, level runs of ground along either
// axis become the routes. In a street capture those runs are the roads (lawns, roofs and
// trees are short or bumpy), so the car spawns on a road and autopilot has a line to follow.
// Roads that run diagonally to the axes come out as shorter pieces.
const SCAN_CELL = 5, SCAN_STEP = 0.6, SCAN_MIN_RUN = 40, SCAN_ROUTES = 10;
let scan = null;

function startScan() {

	const w = bounds.maxX - bounds.minX, d = bounds.maxZ - bounds.minZ;
	const cx = ( bounds.minX + bounds.maxX ) / 2, cz = ( bounds.minZ + bounds.maxZ ) / 2;
	// High enough to hold the whole mesh in view (so all of it streams in, coarsely), but
	// inside the far plane.
	const h = Math.min( FAR * 0.8, 1.1 * Math.max( w / camera.aspect, d ) / ( 2 * Math.tan( camera.fov * Math.PI / 360 ) ) );
	camera.position.set( cx, bounds.halfY + h, cz + 1 );    // +1: lookAt is undefined straight down
	camera.lookAt( cx, - bounds.halfY, cz );
	scan = { nx: Math.ceil( w / SCAN_CELL ), nz: Math.ceil( d / SCAN_CELL ), y: null, next: 0, since: performance.now(), quietSince: 0 };

}

function stepScan() {

	const s = scan, now = performance.now();
	if ( ! s.y ) {

		// wait for the overview tiles: streaming quiet for a second, and something on screen
		const quiet = tiles.stats.downloading === 0 && tiles.stats.parsing === 0 && tiles.stats.visible > 0;
		if ( ! quiet ) s.quietSince = 0; else if ( ! s.quietSince ) s.quietSince = now;
		if ( quiet && now - s.quietSince > 1000 ) s.y = new Float32Array( s.nx * s.nz ).fill( NaN );
		else if ( now - s.since > 45000 ) fail( new Error( 'the mesh did not load' ) );
		return;

	}

	// a slice of the grid per frame, so the page stays responsive while it is surveyed
	const top = bounds.halfY + 60;
	raycaster.near = 0; raycaster.far = 2 * bounds.halfY + 200; raycaster.firstHitOnly = true;
	while ( s.next < s.y.length && performance.now() - now < 12 ) {

		const i = s.next ++;
		raycaster.set( _go.set( bounds.minX + ( i % s.nx + 0.5 ) * SCAN_CELL, top, bounds.minZ + ( Math.floor( i / s.nx ) + 0.5 ) * SCAN_CELL ), _gd );
		const hit = raycaster.intersectObject( tiles.group, true )[ 0 ];
		if ( hit ) s.y[ i ] = hit.point.y;

	}

	if ( s.next < s.y.length ) return;

	// Maximal level runs along the rows (east-west), then the columns (north-south).
	const runs = [];
	for ( const ew of [ true, false ] ) {

		const len = ew ? s.nx : s.nz, lines = ew ? s.nz : s.nx;
		for ( let j = 0; j < lines; j ++ ) {

			const at = k => s.y[ ew ? j * s.nx + k : k * s.nx + j ];
			for ( let k = 0, start = - 1; k <= len; k ++ ) {

				const on = k < len && ! Number.isNaN( at( k ) );
				if ( on && start >= 0 && Math.abs( at( k ) - at( k - 1 ) ) <= SCAN_STEP ) continue;
				if ( start >= 0 && ( k - start ) * SCAN_CELL >= SCAN_MIN_RUN ) runs.push( { ew, j, a: start, b: k - 1 } );
				start = on ? k : - 1;

			}

		}

	}

	// Longest first; neighbouring rows of one road give near-identical runs, so skip a run
	// that lies within 15 m of, and overlaps, one already taken.
	runs.sort( ( p, q ) => ( q.b - q.a ) - ( p.b - p.a ) );
	const taken = [];
	for ( const r of runs ) {

		if ( taken.length === SCAN_ROUTES ) break;
		if ( ! taken.some( t => t.ew === r.ew && Math.abs( t.j - r.j ) * SCAN_CELL < 15 && t.a <= r.b && r.a <= t.b ) ) taken.push( r );

	}

	if ( ! taken.length ) return fail( new Error( 'no drivable road found in this mesh' ) );
	routes = taken.map( ( r, n ) => {

		// one cell in from each end: the last cell of a run is the lip of the mesh
		const cell = k => ( k + 0.5 ) * SCAN_CELL, a = r.a + 1, count = r.b - r.a - 1;
		const pts = Array.from( { length: count }, ( _, i ) => r.ew
			? new THREE.Vector2( bounds.minX + cell( a + i ), bounds.minZ + cell( r.j ) )
			: new THREE.Vector2( bounds.minX + cell( r.j ), bounds.minZ + cell( a + i ) ) );
		return { id: `mesh-${n + 1}`, pts, cum: pts.map( ( _, i ) => i * SCAN_CELL ), length: ( count - 1 ) * SCAN_CELL };

	} );
	console.info( `No route lies on this mesh; found ${routes.length} road line(s) in it, longest ${routes[ 0 ].length} m.` );
	scan = null;
	hudLast.routesFor = - 1;    // re-stroke the minimap with the new routes
	routeIdx = Math.min( routeIdx, routes.length - 1 );
	requestSpawn( routeIdx, 0 );
	state = 'loading';

}

// ---------- raycast BVHs ----------
// Building a tree costs ~25 ms per tile. Doing that on the main thread as each tile loaded
// (the first version) stalled a drive for seconds in total, almost all of it for scenery the
// car never touches. Now: only displayed tiles within BVH_RANGE of the car (or of the spawn
// point while loading) get a tree, nearest first, and the build runs in a worker. Until a
// tree arrives that mesh is raycast brute-force - slower for a few frames, same hits - so
// what the wheels feel does not depend on build timing.
const BVH_RANGE = 70;            // m, horizontal, from the focus to the mesh's bounding sphere
const bvhJobs = new Set();       // meshes without a tree yet: state 'waiting' | 'building'
const bvhWorkers = [];
const _sphere = new THREE.Sphere();

function startBvhWorkers( n ) {

	for ( let i = 0; i < n; i ++ ) {

		const slot = { worker: null, job: null, dead: false };
		try {

			slot.worker = new Worker( asset( './bvh.worker.js' ), { type: 'module' } );

		} catch {

			slot.dead = true;

		}

		if ( slot.worker ) {

			slot.worker.onmessage = ( { data } ) => {

				const job = slot.job;
				slot.job = null;
				if ( ! job || job.state !== 'building' ) return;    // tile was disposed meanwhile
				if ( data.error ) return buildBvhSync( job );
				const t0 = performance.now();
				const geometry = job.mesh.geometry;
				geometry.boundsTree = MeshBVH.deserialize(
					{ roots: data.roots, indirectBuffer: data.indirectBuffer, index: null }, geometry, { setIndex: false } );
				bvhJobs.delete( job );
				job.state = 'done';
				perf.bvhBuildMs += data.ms; perf.bvhMainMs += performance.now() - t0; perf.bvhTiles ++;

			};
			slot.worker.onerror = () => {

				// e.g. bvh.worker.js missing from an old build: fall back to main-thread builds
				slot.dead = true;
				if ( slot.job && slot.job.state === 'building' ) slot.job.state = 'waiting';
				slot.job = null;

			};

		}

		bvhWorkers.push( slot );

	}

}

function buildBvhSync( job ) {

	const t0 = performance.now();
	job.mesh.geometry.computeBoundsTree( { indirect: true } );
	bvhJobs.delete( job );
	job.state = 'done';
	const ms = performance.now() - t0;
	perf.bvhBuildMs += ms; perf.bvhMainMs += ms; perf.bvhTiles ++;

}

function pumpBvh() {

	if ( ! bvhJobs.size ) return;
	const fx = state === 'driving' ? car.pos.x : spawnPending?.x, fz = state === 'driving' ? car.pos.z : spawnPending?.z;
	if ( fx === undefined ) return;
	const alive = bvhWorkers.filter( s => ! s.dead ), idle = alive.filter( s => ! s.job );
	if ( alive.length && ! idle.length ) return;

	const near = [];
	for ( const job of bvhJobs ) {

		if ( job.state !== 'waiting' || ! job.model.parent ) continue;    // parent = displayed
		if ( ! job.centre ) {

			const geometry = job.mesh.geometry;
			if ( ! geometry.boundingSphere ) geometry.computeBoundingSphere();
			job.mesh.updateWorldMatrix( true, false );
			_sphere.copy( geometry.boundingSphere ).applyMatrix4( job.mesh.matrixWorld );
			job.centre = _sphere.center.clone();
			job.radius = _sphere.radius;

		}

		job.dist = Math.hypot( job.centre.x - fx, job.centre.z - fz ) - job.radius;
		if ( job.dist < BVH_RANGE ) near.push( job );

	}

	if ( ! near.length ) return;
	near.sort( ( a, b ) => a.dist - b.dist );
	if ( ! alive.length ) return buildBvhSync( near[ 0 ] );    // no workers: one per frame

	for ( let i = 0; i < idle.length && i < near.length; i ++ ) {

		const job = near[ i ], slot = idle[ i ];
		const geometry = job.mesh.geometry, pos = geometry.attributes.position, idx = geometry.index;
		if ( pos.isInterleavedBufferAttribute || idx?.isInterleavedBufferAttribute ) {

			buildBvhSync( job );
			continue;

		}

		// copies, so the originals stay usable for rendering and brute-force rays meanwhile
		const position = pos.array.slice(), index = idx ? idx.array.slice() : null;
		job.state = 'building';
		slot.job = job;
		slot.worker.postMessage( { id: 0, position, itemSize: pos.itemSize, normalized: pos.normalized, index,
			groups: geometry.groups.map( g => ( { start: g.start, count: g.count, materialIndex: g.materialIndex } ) ) },
		index ? [ position.buffer, index.buffer ] : [ position.buffer ] );

	}

}

// ---------- raycasting against the displayed tiles ----------
const raycaster = new THREE.Raycaster();
const _nrm = new THREE.Vector3();
function cast( origin, dir, far ) {

	raycaster.set( origin, dir );
	raycaster.near = 0;
	raycaster.far = far;
	raycaster.firstHitOnly = true;
	const hits = raycaster.intersectObject( tiles.group, true );
	if ( ! hits.length ) return null;
	const h = hits[ 0 ];
	_nrm.set( 0, 1, 0 );
	if ( h.face ) _nrm.copy( h.face.normal ).transformDirection( h.object.matrixWorld );
	if ( _nrm.dot( dir ) > 0 ) _nrm.negate();
	return { point: h.point, normal: _nrm, distance: h.distance };

}

/**
 * Ground height at (x, z), or null. The mesh has stray fragments above the road (branches)
 * and below it (reconstruction debris), so neither the first nor the last hit of one ray is
 * trustworthy. Five rays in a small cross each list every surface they pass through, and the
 * height level the most rays agree on wins (ties go to the higher level).
 */
const _go = new THREE.Vector3(), _gd = new THREE.Vector3( 0, - 1, 0 );
function groundAt( x, z ) {

	const top = bounds.halfY + 60, far = 2 * bounds.halfY + 200;
	const rays = [];
	for ( const [ ox, oz ] of [ [ 0, 0 ], [ 1.2, 0 ], [ - 1.2, 0 ], [ 0, 1.2 ], [ 0, - 1.2 ] ] ) {

		raycaster.set( _go.set( x + ox, top, z + oz ), _gd );
		raycaster.near = 0; raycaster.far = far; raycaster.firstHitOnly = false;
		rays.push( raycaster.intersectObject( tiles.group, true ).map( h => h.point.y ) );

	}

	let best = null, bestVotes = 0;
	for ( const y of rays.flat() ) {

		const near = rays.map( r => r.filter( v => Math.abs( v - y ) < 0.35 ) );
		const votes = near.filter( r => r.length ).length;
		if ( votes > bestVotes || ( votes === bestVotes && y > best ) ) {

			bestVotes = votes;
			best = near.flat().reduce( ( a, v ) => a + v, 0 ) / near.flat().length;

		}

	}

	return bestVotes >= 3 ? best : null;

}

// ---------- spawning ----------
function routePoint( r, dist ) {

	const d = Math.max( 0, Math.min( r.length, dist ) );
	let i = 1;
	while ( i < r.pts.length - 1 && r.cum[ i ] < d ) i ++;
	const a = r.pts[ i - 1 ], b = r.pts[ i ], seg = r.cum[ i ] - r.cum[ i - 1 ] || 1;
	const t = ( d - r.cum[ i - 1 ] ) / seg;
	return { x: a.x + ( b.x - a.x ) * t, z: a.y + ( b.y - a.y ) * t, dx: ( b.x - a.x ) / seg, dz: ( b.y - a.y ) / seg };

}

function nearestOnRoute( r, x, z ) {

	let best = 0, bestD = Infinity;
	for ( let i = 1; i < r.pts.length; i ++ ) {

		const a = r.pts[ i - 1 ], b = r.pts[ i ];
		const vx = b.x - a.x, vz = b.y - a.y, len2 = vx * vx + vz * vz || 1;
		const t = Math.max( 0, Math.min( 1, ( ( x - a.x ) * vx + ( z - a.y ) * vz ) / len2 ) );
		const d = Math.hypot( a.x + vx * t - x, a.y + vz * t - z );
		if ( d < bestD ) {

			bestD = d; best = r.cum[ i - 1 ] + Math.sqrt( len2 ) * t;

		}

	}

	return { along: best, offset: bestD };

}

/** Queue a spawn; it completes once the mesh under that point has streamed in. */
function requestSpawn( idx, along ) {

	routeIdx = idx;
	const r = routes[ idx ];
	const p = r ? routePoint( r, along ) : { x: 0, z: 0, dx: 0, dz: - 1 };
	spawnPending = { x: p.x, z: p.z, yaw: Math.atan2( - p.dx, - p.dz ), since: performance.now(),
		idx, along: Math.max( 0, along ), searched: spawnPending?.searching ? spawnPending.searched : 0 };
	stats.route = r ? r.id : null;
	// Ground height is unknown until tiles load, and tiles only load if the camera can see
	// them, so start well above the highest possible ground looking down; trySpawn drops the
	// camera close once the first ray lands, which pulls in the full-detail tiles.
	camera.position.set( p.x - p.dx * 9, bounds.halfY + 80, p.z - p.dz * 9 );
	camera.lookAt( p.x, - bounds.halfY, p.z );

}

function trySpawn() {

	const s = spawnPending;
	// Ground is needed under the whole car, not just its centre: the first point on a route
	// that has mesh is the lip of the mesh, and spawning there leaves the rear wheels in the air.
	const fx = - Math.sin( s.yaw ), fz = - Math.cos( s.yaw );
	const gy = groundAt( s.x, s.z );
	const span = gy !== null && groundAt( s.x + fx * 3, s.z + fz * 3 ) !== null && groundAt( s.x - fx * 3, s.z - fz * 3 ) !== null;
	const hit = span ? { point: { y: gy } } : null;
	const waited = performance.now() - s.since;
	const settled = tiles.stats.downloading === 0 && tiles.stats.parsing === 0;
	if ( ! hit ) {

		// Nothing under this point. Once streaming has gone quiet that is a real gap (routes
		// start a little before the mesh does, and the mesh has holes), so walk up the route.
		const r = routes[ s.idx ];
		if ( settled && waited > 1200 && r && s.along + 6 < r.length && s.searched < 400 ) {

			spawnPending.searching = true;
			const searched = s.searched + 6;
			requestSpawn( s.idx, s.along + 6 );
			spawnPending.searched = searched;
			stats.spawnSearch = Math.max( stats.spawnSearch ?? 0, searched );

		}

		return;

	}

	if ( s.closeSince === undefined ) s.closeSince = performance.now();
	const closeFor = performance.now() - s.closeSince;
	if ( closeFor < 400 || ( ! settled && closeFor < 6000 ) ) {

		camera.position.y = hit.point.y + 6;
		camera.lookAt( s.x, hit.point.y, s.z );
		return;

	}

	void waited;

	spawnLog.push( { t: Math.round( performance.now() ), x: s.x, z: s.z, y: hit.point.y, along: s.along,
		closeFor: Math.round( closeFor ), settled, shown: tiles.stats.visible } );
	car.reset( new THREE.Vector3( s.x, hit.point.y + CAR.wheelRadius + CAR.restLength + 0.3, s.z ), s.yaw );
	camera.position.copy( car.pos ).addScaledVector( car.fwd, - 8 ).add( new THREE.Vector3( 0, 3, 0 ) );
	spawnPending = null;
	state = 'driving';

}

// ---------- input ----------
addEventListener( 'keydown', e => {

	if ( e.repeat ) return;
	keys.add( e.code );
	if ( e.code === 'KeyR' ) resetToRoute();
	if ( e.code === 'KeyN' && routes.length ) {

		auto.on = false;
		requestSpawn( ( routeIdx + ( e.shiftKey ? routes.length - 1 : 1 ) ) % routes.length, 0 );
		state = 'loading';

	}

	if ( e.code === 'KeyC' ) cameraMode = cameraMode === 'chase' ? 'high' : 'chase';
	if ( e.code === 'KeyP' ) auto.on ? stopAutopilot() : startAutopilot( routeIdx, auto.speed, false );
	if ( [ 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight' ].includes( e.code ) ) e.preventDefault();

} );
addEventListener( 'keyup', e => keys.delete( e.code ) );
addEventListener( 'blur', () => keys.clear() );
addEventListener( 'resize', () => {

	camera.aspect = innerWidth / innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize( innerWidth, innerHeight );
	if ( tiles ) tiles.setResolutionFromRenderer( camera, renderer );

} );

function resetToRoute() {

	const r = routes[ routeIdx ];
	if ( ! r ) return;
	stats.resets ++;
	requestSpawn( routeIdx, nearestOnRoute( r, car.pos.x, car.pos.z ).along );
	state = 'loading';

}

function readInput() {

	if ( auto.on ) return autopilotInput();
	const k = c => keys.has( c ) ? 1 : 0;
	return {
		throttle: ( k( 'KeyW' ) || k( 'ArrowUp' ) ) - ( k( 'KeyS' ) || k( 'ArrowDown' ) ),
		steer: ( k( 'KeyA' ) || k( 'ArrowLeft' ) ) - ( k( 'KeyD' ) || k( 'ArrowRight' ) ),
		brake: 0,
		handbrake: keys.has( 'Space' ),
	};

}

// ---------- autopilot (pure pursuit along the current route) ----------
function startAutopilot( idx, speed = 9, respawn = true ) {

	auto.on = true; auto.speed = speed; auto.idx = idx; auto.stuckFor = 0; auto.done = false;
	Object.assign( stats, newStats(), { route: routes[ idx ]?.id ?? null } );
	for ( const k in perf ) perf[ k ] = 0;
	if ( respawn || idx !== routeIdx ) {

		requestSpawn( idx, 0 );
		state = 'loading';

	}

}

function stopAutopilot() {

	auto.on = false;

}

function autopilotInput() {

	const r = routes[ auto.idx ];
	const { along, offset } = nearestOnRoute( r, car.pos.x, car.pos.z );
	stats.routeProgress = along / r.length;
	if ( along > r.length - 4 ) {

		auto.done = true; auto.on = false;
		return { throttle: 0, steer: 0, brake: 1, handbrake: false };

	}

	const speed = car.speed;
	const tgt = routePoint( r, along + 6 + Math.abs( speed ) * 0.6 );
	const tx = tgt.x - car.pos.x, tz = tgt.z - car.pos.z;
	// signed angle from the car's heading to the target, positive = target is to the left
	const fx = car.fwd.x, fz = car.fwd.z;
	const angle = Math.atan2( fz * tx - fx * tz, fx * tx + fz * tz );
	const want = auto.speed * ( Math.abs( angle ) > 0.5 ? 0.5 : 1 );
	const err = want - speed;
	void offset;
	return {
		throttle: Math.max( - 1, Math.min( 1, err * 0.6 ) ),
		steer: Math.max( - 1, Math.min( 1, angle * 2.2 ) ),
		brake: 0, handbrake: false,
	};

}

// ---------- frame ----------
function tick() {

	const now = performance.now();
	const dt = Math.min( ( now - last ) / 1000, 0.1 );
	last = now;
	fps += ( 1 / Math.max( dt, 1e-3 ) - fps ) * 0.05;

	if ( state === 'loading' ) {

		camera.updateMatrixWorld();
		tiles.update();
		pumpBvh();
		trySpawn();

	} else if ( state === 'scanning' ) {

		camera.updateMatrixWorld();
		tiles.update();
		stepScan();

	} else if ( state === 'driving' ) {

		drive( dt );
		updateCamera( dt );
		camera.updateMatrixWorld();
		const t1 = performance.now();
		tiles.update();
		perf.tiles += performance.now() - t1;
		perf.frames ++;
		pumpBvh();
		adaptResolution( dt * 1000, now );

	}

	syncCarMesh( dt );
	syncVoidFloor( dt );
	const t2 = performance.now();
	renderer.render( scene, camera );
	if ( state === 'driving' ) {

		perf.render += performance.now() - t2;
		perf.tris += renderer.info.render.triangles;
		perf.calls += renderer.info.render.calls;
		perf.frameMs += dt * 1000;
		if ( dt > 0.05 ) perf.slowFrames ++;

	}

	drawHud();

}

/**
 * Adaptive resolution. Only the pixel ratio changes - tile level of detail is chosen from the
 * CSS size (setResolutionFromRenderer), so this cannot change which surface the wheels hit.
 * It judges the MEDIAN frame of a 90-frame window, which ignores streaming hitches (those are
 * CPU stalls that fewer pixels would not fix). Vsync hides GPU headroom, so stepping back up
 * is a timed probe whose interval doubles every time a probe turns out too slow.
 */
const dyn = { buf: [], retryAt: 0, backoff: 20000 };
function adaptResolution( ms, now ) {

	if ( PR_FIXED || document.hidden ) return;
	dyn.buf.push( ms );
	if ( dyn.buf.length < 90 ) return;
	const med = dyn.buf.sort( ( a, b ) => a - b )[ 45 ];
	dyn.buf.length = 0;
	let next = pixelRatio;
	if ( med > 21 && pixelRatio > PR_MIN ) {

		next = Math.max( PR_MIN, pixelRatio * 0.85 );
		dyn.retryAt = now + dyn.backoff;
		dyn.backoff = Math.min( dyn.backoff * 2, 240000 );

	} else if ( med < 17.5 && pixelRatio < PR_MAX && now > dyn.retryAt ) {

		next = Math.min( PR_MAX, pixelRatio * 1.1 );

	}

	if ( next !== pixelRatio ) renderer.setPixelRatio( pixelRatio = next );

}

function drive( dt ) {

	const t0 = performance.now();
	car.castRays( cast, dt );
	perf.cast += performance.now() - t0;
	const input = lastInput = readInput();
	const before = car.pos.clone();
	acc += dt;
	let n = 0;
	while ( acc >= SUBSTEP && n < 12 ) {

		car.step( SUBSTEP, input );
		acc -= SUBSTEP; n ++;
		stats.sumAy2 += car.verticalAccel ** 2;
		stats.maxAy = Math.max( stats.maxAy, Math.abs( car.verticalAccel ) );
		stats.substeps ++;

	}

	if ( n === 12 ) acc = 0;
	perf.step += performance.now() - t0;

	// telemetry
	const off = car.wheels.filter( w => ! w.onMesh ).length;
	stats.frames ++; stats.time += dt;
	stats.distance += Math.hypot( car.pos.x - before.x, car.pos.z - before.z );
	stats.wheelFrames += 4; stats.offMeshWheelFrames += off;
	if ( off === 4 ) stats.allOffMeshFrames ++;
	if ( ! car.wheels.some( w => w.contact ) ) stats.airFrames ++;
	stats.crashes = car.crashes;
	stats.maxSpeed = Math.max( stats.maxSpeed, Math.abs( car.speed ) );

	// recovery: upside down for a while, or somehow far below the world
	upsideDownFor = car.up.y < 0.2 ? upsideDownFor + dt : 0;
	const floor = Math.min( ...car.wheels.map( w => w.lastY ?? Infinity ) );
	const lost = Number.isFinite( floor ) ? car.pos.y < floor - 25 : car.pos.y < - bounds.halfY - 60;
	if ( upsideDownFor > 2.5 || lost ) {

		upsideDownFor = 0;
		resetToRoute();
		return;

	}

	// autopilot stall detection: not moving for 5 s -> count it and hop 12 m up the route
	if ( auto.on ) {

		auto.stuckFor = Math.abs( car.speed ) < 0.6 ? auto.stuckFor + dt : 0;
		if ( auto.stuckFor > 5 ) {

			auto.stuckFor = 0; stats.stalls ++;
			const r = routes[ auto.idx ];
			requestSpawn( auto.idx, nearestOnRoute( r, car.pos.x, car.pos.z ).along + 12 );
			state = 'loading';

		}

	}

}

const _camTarget = new THREE.Vector3(), _look = new THREE.Vector3(), _flat = new THREE.Vector3();
function updateCamera( dt ) {

	_flat.set( car.fwd.x, 0, car.fwd.z );
	if ( _flat.lengthSq() < 1e-4 ) _flat.set( 0, 0, - 1 );
	_flat.normalize();
	if ( cameraMode === 'chase' ) _camTarget.copy( car.pos ).addScaledVector( _flat, - 7.5 ).add( _look.set( 0, 2.8, 0 ) );
	else _camTarget.copy( car.pos ).addScaledVector( _flat, - 25 ).add( _look.set( 0, 45, 0 ) );
	camera.position.lerp( _camTarget, 1 - Math.exp( - dt * 5 ) );
	_look.copy( car.pos ).addScaledVector( _flat, 3 );
	_look.y += 0.8;
	camera.lookAt( _look );
	// widen the view a little with speed
	const fov = BASE_FOV + 9 * Math.min( 1, Math.abs( car.speed ) / CAR.topSpeed );
	if ( Math.abs( fov - camera.fov ) > 0.02 ) {

		camera.fov += ( fov - camera.fov ) * ( 1 - Math.exp( - dt * 3 ) );
		camera.updateProjectionMatrix();

	}

}

// ---------- car visuals ----------
function buildCarMesh() {

	// Purely cosmetic: the physics body is the box in CAR.size and the wheel positions in
	// CAR.wheels; nothing here is raycast. Geometry is merged per material to keep the car at
	// a dozen draw calls.
	const root = new THREE.Group();
	const paint = new THREE.MeshStandardMaterial( { color: 0xe4572e, roughness: 0.32, metalness: 0.35 } );
	const dark = new THREE.MeshStandardMaterial( { color: 0x15171b, roughness: 0.85 } );
	const glass = new THREE.MeshStandardMaterial( { color: 0x0f1820, roughness: 0.08, metalness: 0.85 } );
	const alloy = new THREE.MeshStandardMaterial( { color: 0xc9ced6, roughness: 0.3, metalness: 0.9 } );
	const head = new THREE.MeshStandardMaterial( { color: 0xffffff, emissive: 0xfff2cc, emissiveIntensity: 1.6 } );
	const tail = new THREE.MeshStandardMaterial( { color: 0x5a0a0a, emissive: 0xff1a1a, emissiveIntensity: 0.5 } );

	// A side profile (u = metres forward, v = metres up) extruded across the car's width.
	const across = ( pts, width, bevel ) => {

		const shape = new THREE.Shape( pts.map( ( [ u, v ] ) => new THREE.Vector2( u, v ) ) );
		const depth = width - 2 * bevel;
		return new THREE.ExtrudeGeometry( shape, { depth, bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel,
			bevelSegments: 3, curveSegments: 1 } ).translate( 0, 0, - depth / 2 ).rotateY( Math.PI / 2 );

	};
	const box = ( w, h, l, x, y, z ) => new THREE.BoxGeometry( w, h, l ).translate( x, y, z );

	const HALF_W = 0.95;
	const body = across( [ [ - 2.0, - 0.3 ], [ 1.98, - 0.3 ], [ 2.08, - 0.2 ], [ 2.08, 0.0 ], [ 1.92, 0.1 ], [ 0.82, 0.19 ],
		[ - 1.5, 0.21 ], [ - 2.02, 0.15 ], [ - 2.08, - 0.18 ] ], HALF_W * 2, 0.06 );
	const cabin = across( [ [ 0.86, 0.2 ], [ 0.22, 0.62 ], [ - 0.9, 0.62 ], [ - 1.52, 0.22 ] ], 1.56, 0.05 );
	const roof = box( 1.42, 0.05, 1.06, 0, 0.67, 0.34 ).toNonIndexed();    // extrusions are non-indexed
	root.add( new THREE.Mesh( mergeGeometries( [ body, roof ] ), paint ), new THREE.Mesh( cabin, glass ) );

	// dark trim: grille, sills, and a wheel-well disc on the body side behind each wheel
	const trim = [ box( 0.78, 0.1, 0.04, 0, - 0.12, - 2.135 ), box( 1.5, 0.07, 0.04, 0, - 0.2, 2.13 ) ];
	for ( const w of CAR.wheels ) {

		const well = new THREE.CircleGeometry( 0.43, 24, 0, Math.PI ).rotateY( Math.sign( w.x ) * Math.PI / 2 );
		trim.push( well.translate( Math.sign( w.x ) * ( HALF_W + 0.004 ), - 0.33, w.z ) );

	}

	root.add( new THREE.Mesh( mergeGeometries( trim ), dark ) );
	root.add( new THREE.Mesh( mergeGeometries( [ box( 0.36, 0.09, 0.05, - 0.62, - 0.05, - 2.135 ), box( 0.36, 0.09, 0.05, 0.62, - 0.05, - 2.135 ) ] ), head ) );
	root.add( new THREE.Mesh( mergeGeometries( [ box( 0.4, 0.08, 0.05, - 0.6, 0.02, 2.12 ), box( 0.4, 0.08, 0.05, 0.6, 0.02, 2.12 ) ] ), tail ) );

	// wheels: a tyre plus a six-spoke star so the spin is visible
	const r = CAR.wheelRadius;
	const tyreGeo = new THREE.CylinderGeometry( r, r, 0.26, 28 ).rotateZ( Math.PI / 2 );
	const rimGeo = mergeGeometries( [
		new THREE.CylinderGeometry( 0.075, 0.075, 0.285, 12 ).rotateZ( Math.PI / 2 ),
		...[ 0, 1, 2 ].map( k => new THREE.BoxGeometry( 0.272, r * 1.3, 0.06 ).rotateX( k * Math.PI / 3 ) ),
	] );
	const wheels = CAR.wheels.map( () => {

		const g = new THREE.Group();
		g.rotation.order = 'YXZ';    // steer about Y, then spin about the axle
		g.add( new THREE.Mesh( tyreGeo, dark ), new THREE.Mesh( rimGeo, alloy ) );
		root.add( g );
		return g;

	} );
	root.visible = false;

	// Contact shadow: the mesh is unlit and cannot receive a real one, so a soft dark quad
	// rides on the plane under the wheels. It is what stops the car looking pasted on.
	const c = document.createElement( 'canvas' );
	c.width = 128; c.height = 256;
	const x = c.getContext( '2d' );
	x.shadowColor = '#000'; x.shadowBlur = 26; x.fillStyle = '#000';
	x.fillRect( 34, 40, 60, 176 );
	const shadow = new THREE.Mesh( new THREE.PlaneGeometry( 3.3, 6.4 ).rotateX( - Math.PI / 2 ),
		new THREE.MeshBasicMaterial( { map: new THREE.CanvasTexture( c ), color: 0x000000, transparent: true, opacity: 0,
			depthWrite: false, polygonOffset: true, polygonOffsetFactor: - 2, polygonOffsetUnits: - 4 } ) );
	shadow.visible = false;
	shadow.renderOrder = 2;

	return { root, wheels, shadow, tail, spin: 0 };

}

function syncCarMesh( dt ) {

	const driving = state === 'driving';
	carMesh.root.visible = carMesh.shadow.visible = driving;
	if ( ! driving ) return;
	carMesh.root.position.copy( car.pos );
	carMesh.root.quaternion.copy( car.quat );
	carMesh.spin -= car.speed * dt / CAR.wheelRadius;
	let drop = 0, contacts = 0;
	for ( let i = 0; i < car.wheels.length; i ++ ) {

		const w = car.wheels[ i ], g = carMesh.wheels[ i ];
		// drawn 4 cm outboard of the physics wheel so the tyre stands proud of the body side
		g.position.set( w.local.x + Math.sign( w.local.x ) * 0.04, w.local.y - w.length, w.local.z );
		g.rotation.set( carMesh.spin, w.front ? car.steer : 0, 0 );
		drop += w.length - w.local.y + CAR.wheelRadius;
		if ( w.contact ) contacts ++;

	}

	const braking = lastInput.handbrake || lastInput.brake > 0 ||
		( lastInput.throttle < 0 && car.speed > 0.5 ) || ( lastInput.throttle > 0 && car.speed < - 0.5 );
	carMesh.tail.emissiveIntensity = braking ? 3.2 : 0.5;

	const sh = carMesh.shadow;
	sh.position.copy( car.pos ).addScaledVector( car.up, 0.04 - drop / car.wheels.length );
	sh.quaternion.copy( car.quat );
	sh.material.opacity += ( 0.1 + 0.42 * contacts / 4 - sh.material.opacity ) * Math.min( 1, dt * 8 );

}

function syncVoidFloor( dt ) {

	const off = state === 'driving' ? car.wheels.filter( w => ! w.onMesh ).length : 0;
	const mat = voidFloor.material;
	mat.opacity += ( ( off >= 2 ? 0.55 : 0 ) - mat.opacity ) * Math.min( 1, dt * 4 );
	voidFloor.visible = mat.opacity > 0.01;
	if ( ! voidFloor.visible ) return;
	const ys = car.wheels.map( w => w.lastY ).filter( y => y !== null );
	if ( ! ys.length ) return;
	// snap to the 10 m grid so the lines stay put while the plane follows the car
	voidFloor.position.set( Math.round( car.pos.x / 10 ) * 10, ys.reduce( ( a, y ) => a + y, 0 ) / ys.length - 0.03, Math.round( car.pos.z / 10 ) * 10 );

}

// ---------- HUD + minimap ----------
// The HUD runs at a quarter of the frame rate and only touches the DOM when a value changed.
// The minimap's routes (68 polylines) are stroked once into a backing canvas and re-stroked
// only when the selected route changes; each update then is one blit plus the car wedge.
const mini = $( 'minimap' ), mctx = mini.getContext( '2d' );
const MINI_W = mini.width, MINI_H = mini.height, MINI_DPR = Math.min( devicePixelRatio || 1, 2 );
mini.style.width = MINI_W + 'px'; mini.style.height = MINI_H + 'px';
mini.width = MINI_W * MINI_DPR; mini.height = MINI_H * MINI_DPR;
const miniRoutes = document.createElement( 'canvas' );
miniRoutes.width = mini.width; miniRoutes.height = mini.height;
const hudEls = { overlay: $( 'overlay' ), overlayText: $( 'overlayText' ), speed: $( 'speed' ), status: $( 'status' ) };
const hudLast = { overlayText: '', speed: '', status: '', overlayOn: true, routesFor: - 1 };
function setText( key, value, html = false ) {

	if ( hudLast[ key ] === value ) return;
	hudLast[ key ] = value;
	if ( html ) hudEls[ key ].innerHTML = value; else hudEls[ key ].textContent = value;

}

let hudTimer = 0;
function drawHud() {

	if ( ++ hudTimer % 4 ) return;
	const t = tiles.stats;
	const loading = t.downloading + t.parsing;
	const overlayOn = state !== 'driving';
	if ( overlayOn !== hudLast.overlayOn ) hudEls.overlay.classList.toggle( 'hidden', ! ( hudLast.overlayOn = overlayOn ) );
	if ( overlayOn ) setText( 'overlayText', loading ? `Streaming mesh · ${loading} tiles in flight`
		: scan?.y ? `Surveying the mesh · ${Math.round( 100 * scan.next / scan.y.length )}%` : 'Finding the road…' );

	let off = 0;
	for ( const w of car.wheels ) if ( ! w.onMesh ) off ++;
	setText( 'speed', String( Math.round( Math.abs( car.speed ) * MPH ) ) );
	setText( 'status',
		`route ${routeIdx + 1}/${routes.length} · ${( routes[ routeIdx ]?.length ?? 0 ).toFixed( 0 )} m` +
		`<br>tiles ${t.visible ?? '–'} shown · ${loading} loading · ${Math.round( fps )} fps` +
		( auto.on ? `<br><b>autopilot</b> ${( stats.routeProgress * 100 ).toFixed( 0 )}%` : '' ) +
		( off && state === 'driving' ? `<br><span class="warn">${off}/4 wheels off mesh</span>` : '' ), true );

	// minimap: all routes, current one highlighted, car as a heading wedge
	const pad = 8;
	const sc = Math.min( ( MINI_W - 2 * pad ) / ( bounds.maxX - bounds.minX ), ( MINI_H - 2 * pad ) / ( bounds.maxZ - bounds.minZ ) );
	const mx = x => pad + ( x - bounds.minX ) * sc, mz = z => pad + ( z - bounds.minZ ) * sc;
	if ( hudLast.routesFor !== routeIdx ) {

		hudLast.routesFor = routeIdx;
		const rc = miniRoutes.getContext( '2d' );
		rc.setTransform( MINI_DPR, 0, 0, MINI_DPR, 0, 0 );
		rc.clearRect( 0, 0, MINI_W, MINI_H );
		rc.lineJoin = rc.lineCap = 'round';
		const stroke = ( r, style, width ) => {

			rc.beginPath();
			r.pts.forEach( ( p, j ) => j ? rc.lineTo( mx( p.x ), mz( p.y ) ) : rc.moveTo( mx( p.x ), mz( p.y ) ) );
			rc.strokeStyle = style; rc.lineWidth = width;
			rc.stroke();

		};
		routes.forEach( ( r, i ) => i !== routeIdx && stroke( r, 'rgba(255,255,255,.4)', 1 ) );
		if ( routes[ routeIdx ] ) stroke( routes[ routeIdx ], '#ffd166', 2.5 );    // on top of the others

	}

	mctx.setTransform( 1, 0, 0, 1, 0, 0 );
	mctx.clearRect( 0, 0, mini.width, mini.height );
	mctx.drawImage( miniRoutes, 0, 0 );
	if ( state !== 'driving' ) return;
	mctx.setTransform( MINI_DPR, 0, 0, MINI_DPR, 0, 0 );
	mctx.translate( mx( car.pos.x ), mz( car.pos.z ) );
	mctx.rotate( Math.atan2( car.fwd.x, - car.fwd.z ) );
	mctx.beginPath(); mctx.moveTo( 0, - 7 ); mctx.lineTo( 4.5, 5 ); mctx.lineTo( - 4.5, 5 ); mctx.closePath();
	mctx.fillStyle = '#e4572e'; mctx.strokeStyle = '#fff'; mctx.lineWidth = 1.25; mctx.fill(); mctx.stroke();

}

function perfReport() {

	const n = Math.max( 1, perf.frames ), r = v => + ( v / n ).toFixed( 2 );
	// 'step' includes the raycasts; all values are per-frame averages (ms) since the last reset
	return { frames: perf.frames, frameMs: r( perf.frameMs ), castMs: r( perf.cast ), castPlusPhysicsMs: r( perf.step ),
		tilesUpdateMs: r( perf.tiles ), renderCallMs: r( perf.render ), triangles: Math.round( perf.tris / n ),
		drawCalls: Math.round( perf.calls / n ), slowFramePct: + ( 100 * perf.slowFrames / n ).toFixed( 1 ),
		// bvhBuildMsPerTile is worker time; bvhMainMsPerTile is what the main thread paid to attach it
		bvhTiles: perf.bvhTiles, bvhBuildMsPerTile: + ( perf.bvhBuildMs / Math.max( 1, perf.bvhTiles ) ).toFixed( 2 ),
		bvhMainMsPerTile: + ( perf.bvhMainMs / Math.max( 1, perf.bvhTiles ) ).toFixed( 2 ), bvhWaiting: bvhJobs.size,
		pixelRatio: + pixelRatio.toFixed( 2 ) };

}

// ---------- debug / test hooks ----------
window.__game = {
	get state() {

		return state;

	},
	get routes() {

		return routes.map( ( r, i ) => ( { i, id: r.id, length: r.length } ) );

	},
	get auto() {

		return { ...auto };

	},
	get car() {

		return { x: car.pos.x, y: car.pos.y, z: car.pos.z, speed: car.speed, upY: car.up.y,
			onMesh: car.wheels.map( w => w.onMesh ), contact: car.wheels.map( w => w.contact ) };

	},
	get tiles() {

		return { ...tiles.stats };

	},
	report() {

		const s = stats;
		return { ...s,
			rmsVerticalAccel: Math.sqrt( s.sumAy2 / Math.max( 1, s.substeps ) ),
			offMeshWheelFraction: s.offMeshWheelFrames / Math.max( 1, s.wheelFrames ),
			allWheelsOffFraction: s.allOffMeshFrames / Math.max( 1, s.frames ),
			airborneFraction: s.airFrames / Math.max( 1, s.frames ),
			avgSpeed: s.distance / Math.max( 1e-6, s.time ), fps, perf: perfReport() };

	},
	startAutopilot, stopAutopilot,
	groundAt, spawnLog,
	/**
	 * Road height profile through the car: first surface under points along the car's forward
	 * axis (offset sideways by `lateral` m), every `step` m for +-halfLen m. null = no mesh.
	 * Only meaningful near the car, where the full-detail tiles are loaded.
	 */
	profile( halfLen = 15, step = 0.05, lateral = 0 ) {

		const f = new THREE.Vector3( car.fwd.x, 0, car.fwd.z ).normalize();
		const r = new THREE.Vector3( - f.z, 0, f.x );
		const base = car.pos.y, out = [], o = new THREE.Vector3(), d = new THREE.Vector3( 0, - 1, 0 );
		for ( let t = - halfLen; t <= halfLen; t += step ) {

			o.copy( car.pos ).addScaledVector( f, t ).addScaledVector( r, lateral );
			o.y = base + 1.0;
			const hit = cast( o, d, 6 );
			out.push( hit ? + hit.point.y.toFixed( 4 ) : null );

		}

		return out;

	},
	triangleStats() {

		// triangle size of the displayed tiles near the car (edge length, m)
		const edges = [];
		const a = new THREE.Vector3(), b = new THREE.Vector3();
		tiles.forEachLoadedModel( ( model, tile ) => {

			if ( ! tile.__visible && ! tile.__active ) return;
			model.traverse( o => {

				if ( ! o.isMesh ) return;
				const pos = o.geometry.attributes.position, idx = o.geometry.index;
				const n = Math.min( idx ? idx.count : pos.count, 3000 );
				for ( let i = 0; i + 1 < n; i += 3 ) {

					const i0 = idx ? idx.getX( i ) : i, i1 = idx ? idx.getX( i + 1 ) : i + 1;
					a.fromBufferAttribute( pos, i0 ).applyMatrix4( o.matrixWorld );
					if ( a.distanceTo( car.pos ) > 25 ) break;
					b.fromBufferAttribute( pos, i1 ).applyMatrix4( o.matrixWorld );
					edges.push( a.distanceTo( b ) );

				}

			} );

		} );
		edges.sort( ( x, y ) => x - y );
		const q = f => edges.length ? + edges[ Math.floor( f * ( edges.length - 1 ) ) ].toFixed( 3 ) : null;
		return { samples: edges.length, p10: q( 0.1 ), p50: q( 0.5 ), p90: q( 0.9 ) };

	},
	surfacesAt( x, z ) {

		raycaster.set( new THREE.Vector3( x, bounds.halfY + 60, z ), new THREE.Vector3( 0, - 1, 0 ) );
		raycaster.near = 0; raycaster.far = 2 * bounds.halfY + 200; raycaster.firstHitOnly = false;
		return raycaster.intersectObject( tiles.group, true ).map( h => + h.point.y.toFixed( 2 ) );

	},
	resetPerf() {

		for ( const k in perf ) perf[ k ] = 0;

	},
	setKey( code, down ) {

		down ? keys.add( code ) : keys.delete( code );

	},
	setCamera( mode ) {

		cameraMode = mode;

	},
	spawn( idx, along = 0 ) {

		requestSpawn( idx, along ); state = 'loading';

	},
};

window.__game.debug = () => {

	const sphere = new THREE.Sphere(), box = new THREE.Box3(), m = new THREE.Matrix4();
	const hasSphere = tiles.getBoundingSphere( sphere );
	const hasBox = tiles.getOrientedBoundingBox( box, m );
	const centre = sphere.center.clone().applyMatrix4( tiles.group.matrixWorld );
	const kids = tiles.root?.children ?? [];
	const k = kids[ 0 ];
	return {
		hasSphere, sphereLocal: sphere.center.toArray(), radius: sphere.radius, sphereWorld: centre.toArray(), hasBox,
		groupPos: tiles.group.position.toArray(), groupQuat: tiles.group.quaternion.toArray(),
		camera: camera.position.toArray(), camDir: camera.getWorldDirection( new THREE.Vector3() ).toArray(),
		bounds, spawnPending, route0: routes[ 0 ]?.pts.slice( 0, 2 ).map( p => p.toArray() ),
		rootKids: kids.length, kid0: k ? { bv: k.boundingVolume, content: k.content?.uri, loaded: k.__loadingState, hasTransform: !! k.transform } : null,
		errorTarget: tiles.errorTarget,
	};

};
