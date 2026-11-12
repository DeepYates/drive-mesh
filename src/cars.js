// The cars a visitor can choose, in DeepWalk livery.
//
// Models: Kenney's Car Kit 3.1 (CC0, static/cars/, files unmodified). Each is one `body`
// mesh plus four named wheel nodes, all textured from one shared palette image
// (Textures/colormap.png): a 16 x 4 grid of colour cells, alternately flat and shaded top to
// bottom, with every face mapped into one cell.
//
// Branding happens here, at load time, so the files stay stock:
//   - The palette texture is replaced by vertex colours read from it. The paint is the
//     strongly coloured cell covering the most body area (grey chassis, pale glass and the
//     small lights are not it); its faces are repainted in the livery colour, keeping each
//     vertex's lighter/darker shading. Everything else keeps its own colour.
//   - The DeepWalk mark (static/brand/mark.png, white on transparent) goes on the roof and
//     both doors, tinted for the livery. Rays cast at the body find where those surfaces are.
//
// The car is cosmetic: the physics body (vehicle.js) is the same for every model.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const CARS = [
	{ id: 'sedan', label: 'Sedan' },
	{ id: 'sedan-sports', label: 'Sports sedan' },
	{ id: 'hatchback-sports', label: 'Hot hatch' },
	{ id: 'suv', label: 'SUV' },
	{ id: 'truck', label: 'Pickup' },
	{ id: 'van', label: 'Van' },
];
export const DEFAULT_CAR = 'sedan';
export const isCar = id => CARS.some( c => c.id === id );

// DeepWalk navy (#13213C, from the logo) and white, plus two tints of the same family.
// Livery 0 is the visitor's own car; other players get 1..3 by player id.
export const LIVERIES = [
	{ paint: '#13213c', mark: '#ffffff' },
	{ paint: '#f4f6f8', mark: '#13213c' },
	{ paint: '#2f5d9b', mark: '#ffffff' },
	{ paint: '#c3ccd6', mark: '#13213c' },
];

export const SCALE = 1.45;                 // kit units -> metres: a 1.5-unit-wide body becomes ~2.2 m
export const WHEEL_RADIUS = 0.3 * SCALE;   // the kit's wheels are 0.3 units in radius
const WHEEL_NAMES = [ 'wheel-front-left', 'wheel-front-right', 'wheel-back-left', 'wheel-back-right' ];    // = CAR.wheels order
const CELLS_U = 16, CELLS_V = 4;           // the palette grid

const loader = new GLTFLoader();
const templates = new Map();               // id -> Promise<THREE.Group>
let atlas = null, markImage = null;        // Promise<ImageData>, Promise<HTMLImageElement>
const markTextures = new Map();            // tint -> THREE.Texture

const image = url => new Promise( ( resolve, reject ) => {

	const img = new Image();
	img.onload = () => resolve( img ); img.onerror = () => reject( new Error( `could not load ${url}` ) );
	img.src = url;

} );

async function palette( asset ) {

	const img = await image( asset( './cars/Textures/colormap.png' ) );
	const c = document.createElement( 'canvas' );
	c.width = img.width; c.height = img.height;
	const ctx = c.getContext( '2d', { willReadFrequently: true } );
	ctx.drawImage( img, 0, 0 );
	return ctx.getImageData( 0, 0, c.width, c.height );

}

/**
 * The mark, tinted. The PNG is white on transparent, so `source-in` recolours it exactly.
 * It is line art, which thins to nothing on a small decal, so the lines are drawn a few
 * pixels heavier (the same image stamped around a small circle).
 */
function markTexture( img, tint ) {

	let tex = markTextures.get( tint );
	if ( tex ) return tex;
	const c = document.createElement( 'canvas' );
	c.width = c.height = 256;
	const ctx = c.getContext( '2d' );
	for ( let k = 0; k < 8; k ++ ) ctx.drawImage( img, 8 + 2.5 * Math.cos( k * Math.PI / 4 ), 8 + 2.5 * Math.sin( k * Math.PI / 4 ), 240, 240 );
	ctx.globalCompositeOperation = 'source-in';
	ctx.fillStyle = tint; ctx.fillRect( 0, 0, 256, 256 );
	tex = new THREE.CanvasTexture( c );
	tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
	markTextures.set( tint, tex );
	return tex;

}

/**
 * Build one car. Resolves { group, wheels } where `group` goes under the car's root (origin
 * on the ground under the car's centre, front along -Z like the game) and `wheels` are the
 * four wheel nodes in CAR.wheels order - set .position.y, .rotation.x (spin) and .rotation.y (steer).
 */
export async function buildCar( id, livery, asset ) {

	if ( ! isCar( id ) ) id = DEFAULT_CAR;
	if ( ! templates.has( id ) ) templates.set( id, loader.loadAsync( asset( `./cars/${id}.glb` ) ).then( g => g.scene ) );
	const [ template, pal, mark ] = await Promise.all( [ templates.get( id ), atlas ??= palette( asset ), markImage ??= image( asset( './brand/mark.png' ) ) ] );

	const model = template.clone( true );
	const material = new THREE.MeshStandardMaterial( { vertexColors: true, roughness: 0.4, metalness: 0.3, side: THREE.DoubleSide } );
	const paint = new THREE.Color( livery.paint );
	const swatch = new THREE.Color(), hsl = {};
	let body = null, painted = null, paintCell = - 1, paintLight = 1;
	const extras = [];      // parts attached to the body (a spoiler): painted with it

	model.traverse( o => {

		if ( ! o.isMesh ) return;
		const geo = o.geometry.clone(), uv = geo.attributes.uv, pos = geo.attributes.position;
		const colors = new Float32Array( pos.count * 3 ), cell = new Uint8Array( pos.count ), light = new Float32Array( pos.count );
		for ( let i = 0; i < pos.count; i ++ ) {

			// glTF UVs start at the top-left, like the canvas the palette was drawn on
			const u = Math.min( 0.9999, Math.max( 0, uv.getX( i ) ) ), v = Math.min( 0.9999, Math.max( 0, uv.getY( i ) ) );
			const k = ( Math.floor( v * pal.height ) * pal.width + Math.floor( u * pal.width ) ) * 4;
			swatch.setRGB( pal.data[ k ] / 255, pal.data[ k + 1 ] / 255, pal.data[ k + 2 ] / 255, THREE.SRGBColorSpace );
			colors[ i * 3 ] = swatch.r; colors[ i * 3 + 1 ] = swatch.g; colors[ i * 3 + 2 ] = swatch.b;
			cell[ i ] = Math.floor( v * CELLS_V ) * CELLS_U + Math.floor( u * CELLS_U );
			light[ i ] = 0.2126 * swatch.r + 0.7152 * swatch.g + 0.0722 * swatch.b;

		}

		if ( o.name === 'body' ) {

			body = o;
			// surface area and average colour per palette cell
			const cells = new Map(), index = geo.index, a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
			const tris = ( index ? index.count : pos.count ) / 3;
			for ( let t = 0; t < tris; t ++ ) {

				const i0 = index ? index.getX( t * 3 ) : t * 3, i1 = index ? index.getX( t * 3 + 1 ) : t * 3 + 1, i2 = index ? index.getX( t * 3 + 2 ) : t * 3 + 2;
				a.fromBufferAttribute( pos, i0 ); b.fromBufferAttribute( pos, i1 ); c.fromBufferAttribute( pos, i2 );
				const area = b.sub( a ).cross( c.sub( a ) ).length();
				const s = cells.get( cell[ i0 ] ) ?? { area: 0, r: 0, g: 0, b: 0, light: 0 };
				s.area += area; s.r += colors[ i0 * 3 ] * area; s.g += colors[ i0 * 3 + 1 ] * area; s.b += colors[ i0 * 3 + 2 ] * area; s.light += light[ i0 ] * area;
				cells.set( cell[ i0 ], s );

			}

			// the paint: the most-used cell with real colour in it (saturation > 0.35 rules out
			// the grey chassis and the pale glass; the lights are colourful but small)
			let most = 0;
			for ( const [ id, s ] of cells ) {

				swatch.setRGB( s.r / s.area, s.g / s.area, s.b / s.area ).getHSL( hsl, THREE.SRGBColorSpace );
				if ( hsl.s > 0.35 && s.area > most ) { most = s.area; paintCell = id; paintLight = s.light / s.area; }

			}

			painted = new Uint8Array( pos.count );
			for ( let i = 0; i < pos.count; i ++ ) {

				if ( cell[ i ] !== paintCell ) continue;
				painted[ i ] = 1;
				// keep the panel's shading: lighter where the kit's gradient was lighter
				const shade = Math.min( 1.35, Math.max( 0.7, light[ i ] / paintLight ) );
				colors[ i * 3 ] = paint.r * shade; colors[ i * 3 + 1 ] = paint.g * shade; colors[ i * 3 + 2 ] = paint.b * shade;

			}

		}

		else if ( ! o.name.startsWith( 'wheel' ) ) extras.push( { colors, cell, light } );

		geo.setAttribute( 'color', new THREE.BufferAttribute( colors, 3 ) );
		o.geometry = geo;
		o.material = material;

	} );

	for ( const { colors, cell, light } of extras ) {

		for ( let i = 0; i < cell.length; i ++ ) {

			if ( cell[ i ] !== paintCell ) continue;
			const shade = Math.min( 1.35, Math.max( 0.7, light[ i ] / paintLight ) );
			colors[ i * 3 ] = paint.r * shade; colors[ i * 3 + 1 ] = paint.g * shade; colors[ i * 3 + 2 ] = paint.b * shade;

		}

	}

	const wheels = WHEEL_NAMES.map( name => {

		const w = model.getObjectByName( name );
		w.rotation.order = 'YXZ';      // steer about Y, then spin about the axle
		return w;

	} );

	// between the axles, in the body's own coordinates: where the doors are
	if ( body ) addMarks( body, painted, markTexture( mark, livery.mark ), ( wheels[ 0 ].position.z + wheels[ 2 ].position.z ) / 2 - body.position.z );

	const group = new THREE.Group();
	group.add( model );
	model.rotation.y = Math.PI;        // the kit's cars face +Z; the game drives toward -Z
	model.scale.setScalar( SCALE );
	return { group, wheels, material };

}

/**
 * Put the mark on the roof and both doors. The body's widest point is the wheel arches, not
 * the doors, and roofs differ per model, so each surface is found by casting rays at it.
 */
function addMarks( body, painted, texture, doorZ ) {

	const geo = body.geometry;
	geo.computeBoundingBox();
	const box = geo.boundingBox, height = box.max.y - box.min.y;
	const probe = new THREE.Mesh( geo, new THREE.MeshBasicMaterial( { side: THREE.DoubleSide } ) );    // identity transform: body-local rays
	const ray = new THREE.Raycaster();
	const cast = ( ox, oy, oz, dx, dy, dz ) => {

		ray.set( new THREE.Vector3( ox, oy, oz ), new THREE.Vector3( dx, dy, dz ) );
		ray.firstHitOnly = false;
		return ray.intersectObject( probe, false )[ 0 ] ?? null;

	};

	const material = new THREE.MeshBasicMaterial( { map: texture, transparent: true, depthWrite: false, toneMapped: false,
		polygonOffset: true, polygonOffsetFactor: - 2, polygonOffsetUnits: - 2 } );
	const add = m => { m.renderOrder = 1; body.add( m ); };

	// ----- roof: straight down onto the highest patch, then grow until it stops being flat
	const pos = geo.attributes.position;
	let zSum = 0, n = 0;
	for ( let i = 0; i < pos.count; i ++ ) if ( pos.getY( i ) > box.max.y - 0.03 ) { zSum += pos.getZ( i ); n ++; }
	const roofZ = n ? zSum / n : 0, top = cast( 0, box.max.y + 1, roofZ, 0, - 1, 0 );
	if ( top ) {

		const flat = ( dx, dz ) => { const h = cast( dx, box.max.y + 1, roofZ + dz, 0, - 1, 0 ); return h && Math.abs( h.point.y - top.point.y ) < 0.035; };
		let half = 0.1;
		while ( half < 0.55 && flat( half + 0.05, 0 ) && flat( - half - 0.05, 0 ) && flat( 0, half + 0.05 ) && flat( 0, - half - 0.05 ) ) half += 0.05;
		const size = 1.8 * half;
		// flat, with the top of the mark toward the car's front (+Z here), so it reads from behind
		const m = new THREE.Mesh( new THREE.PlaneGeometry( size, size ).rotateX( - Math.PI / 2 ).rotateY( Math.PI ), material );
		m.position.set( 0, top.point.y + 0.008, roofZ );
		add( m );

	}

	// ----- doors: from the side, at several heights; the door is the run of painted, upright hits
	let best = null, run = null;
	for ( let y = box.min.y + 0.18 * height; y <= box.min.y + 0.72 * height; y += 0.02 ) {

		const h = cast( box.max.x + 1, y, doorZ, - 1, 0, 0 );
		const ok = h && painted?.[ h.face.a ] && Math.abs( h.face.normal.x ) > 0.8;
		if ( ! ok ) { run = null; continue; }
		run = run ? { y0: run.y0, y1: y, x: Math.max( run.x, h.point.x ) } : { y0: y, y1: y, x: h.point.x };
		if ( ! best || run.y1 - run.y0 > best.y1 - best.y0 ) best = run;

	}

	if ( best && best.y1 - best.y0 > 0.12 ) {

		const size = Math.min( 0.5, 0.92 * ( best.y1 - best.y0 ) ), y = ( best.y0 + best.y1 ) / 2;
		const left = new THREE.Mesh( new THREE.PlaneGeometry( size, size ).rotateY( Math.PI / 2 ), material );
		left.position.set( best.x + 0.008, y, doorZ );
		const right = new THREE.Mesh( new THREE.PlaneGeometry( size, size ).rotateY( - Math.PI / 2 ), material );
		right.position.set( - best.x - 0.008, y, doorZ );    // the kit's bodies are symmetric
		add( left ); add( right );

	}

	probe.material.dispose();

}

/** Free a car built by buildCar (its geometries are per-instance clones; textures are shared). */
export function disposeCar( car ) {

	car.group.traverse( o => { if ( o.isMesh ) { o.geometry.dispose(); if ( o.material !== car.material ) o.material.dispose(); } } );
	car.material.dispose();

}
