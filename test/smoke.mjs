// Headless check of the prototype: node test/smoke.mjs [mode] [args]
//   smoke                     load, spawn, hold the throttle, screenshot
//   auto <route> <speed>      autopilot one route and print the telemetry report
//   survey <speed> <n>        autopilot the first n routes (longest first)
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname( fileURLToPath( import.meta.url ) );
const out = join( here, 'out' );
mkdirSync( out, { recursive: true } );
const BASE = process.env.GAME_URL || 'http://127.0.0.1:8600/';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const [ mode = 'smoke', a1, a2 ] = process.argv.slice( 2 );
const sleep = ms => new Promise( r => setTimeout( r, ms ) );

const browser = await puppeteer.launch( {
	executablePath: CHROME, headless: 'new',
	args: [ '--window-size=1280,720', '--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11',
		'--disable-background-timer-throttling', '--disable-renderer-backgrounding' ],
	defaultViewport: { width: 1280, height: 720 },
} );
const page = await browser.newPage();
const problems = [];
page.on( 'console', m => {

	if ( [ 'error', 'warning' ].includes( m.type() ) ) problems.push( `[${m.type()}] ${m.text()}`.slice( 0, 300 ) );

} );
page.on( 'pageerror', e => problems.push( `[pageerror] ${e.message}`.slice( 0, 300 ) ) );
const failures = {};
page.on( 'requestfailed', r => {

	// in-flight tile downloads are cancelled when a tile leaves view; those are not errors
	const why = r.failure()?.errorText ?? 'unknown';
	failures[ why ] = ( failures[ why ] ?? 0 ) + 1;

} );

const g = expr => page.evaluate( `(() => { const g = window.__game; return ${expr}; })()` );
const shot = name => page.screenshot( { path: join( out, name + '.png' ) } );
async function waitState( want, timeout = 90000 ) {

	const t0 = Date.now();
	while ( Date.now() - t0 < timeout ) {

		if ( await g( 'g && g.state' ) === want ) return true;
		await sleep( 250 );

	}

	return false;

}

async function runRoute( idx, speed, label ) {

	await g( `g.startAutopilot(${idx}, ${speed})` );
	const len = await g( `g.routes[${idx}].length` );
	const deadline = Date.now() + Math.max( 60000, len / speed * 1000 * 2.5 + 30000 );
	let shots = 0, nextShot = 0.25;
	while ( Date.now() < deadline ) {

		await sleep( 500 );
		const a = await g( 'g.auto' );
		const r = await g( 'g.report()' );
		if ( label && r.routeProgress >= nextShot && shots < 3 ) {

			await shot( `${label}_${++ shots}` ); nextShot += 0.25;

		}

		if ( a.done || ! a.on ) break;

	}

	const r = await g( 'g.report()' );
	const done = ( await g( 'g.auto' ) ).done;
	await g( 'g.stopAutopilot()' );
	return { route: idx, length: +len.toFixed( 0 ), completed: done, progress: +r.routeProgress.toFixed( 3 ),
		time: +r.time.toFixed( 1 ), avgSpeed: +r.avgSpeed.toFixed( 2 ), maxSpeed: +r.maxSpeed.toFixed( 1 ),
		rmsAy: +r.rmsVerticalAccel.toFixed( 2 ), maxAy: +r.maxAy.toFixed( 1 ),
		offMeshWheel: +r.offMeshWheelFraction.toFixed( 4 ), allWheelsOff: +r.allWheelsOffFraction.toFixed( 4 ),
		airborne: +r.airborneFraction.toFixed( 4 ), crashes: r.crashes, stalls: r.stalls, resets: r.resets,
		tilesFailed: r.tilesFailed, fps: +r.fps.toFixed( 0 ) };

}

try {

	await page.goto( BASE + ( mode === 'smoke' && a1 ? `?route=${a1}` : '' ), { waitUntil: 'load' } );
	const gl = await page.evaluate( () => {

		const c = document.createElement( 'canvas' ).getContext( 'webgl2' );
		const e = c && c.getExtension( 'WEBGL_debug_renderer_info' );
		return c ? ( e ? c.getParameter( e.UNMASKED_RENDERER_WEBGL ) : 'webgl2' ) : 'NO WEBGL2';

	} );
	console.log( 'renderer:', gl );
	const ok = await waitState( 'driving' );
	console.log( 'spawned:', ok, '| routes:', await g( 'g.routes.length' ), '| tiles:', JSON.stringify( await g( 'g.tiles' ) ) );
	if ( ! ok ) {

		await shot( 'failed_to_spawn' );
		throw new Error( 'never reached driving state' );

	}

	if ( mode === 'smoke' ) {

		await sleep( 2500 );
		await shot( 'smoke_1_spawn' );
		console.log( 'at rest:', JSON.stringify( await g( 'g.car' ) ) );
		await g( `g.setKey('KeyW', true)` );
		await sleep( 6000 );
		await shot( 'smoke_2_driving' );
		console.log( 'after 6 s throttle:', JSON.stringify( await g( 'g.car' ) ) );
		await g( `g.setKey('KeyW', false)` );
		await g( `g.setCamera('high')` );
		await sleep( 3500 );
		await shot( 'smoke_3_high' );
		console.log( 'report:', JSON.stringify( await g( 'g.report()' ) ) );

	} else if ( mode === 'auto' ) {

		console.log( JSON.stringify( await runRoute( Number( a1 ?? 0 ), Number( a2 ?? 9 ), `auto_r${a1 ?? 0}` ) ) );

	} else if ( mode === 'survey' ) {

		// a2 is either a count (first n routes, longest first) or a comma list of route indices
		const speed = Number( a1 ?? 9 ), total = await g( 'g.routes.length' );
		const list = String( a2 ?? 5 ).includes( ',' ) ? String( a2 ).split( ',' ).map( Number )
			: [ ...Array( Math.min( Number( a2 ?? 5 ), total ) ).keys() ];
		const rows = [];
		for ( const i of list ) {

			const row = await runRoute( i, speed, null );
			rows.push( row );
			console.log( JSON.stringify( row ) );

		}

		writeFileSync( join( out, `survey_${speed}.json` ), JSON.stringify( rows, null, 1 ) );

	}

} finally {

	if ( Object.keys( failures ).length ) console.log( 'request failures by reason:', JSON.stringify( failures ) );
	if ( problems.length ) console.log( `console problems (${problems.length}):\n  ` + [ ...new Set( problems ) ].slice( 0, 15 ).join( '\n  ' ) );
	await browser.close();

}
