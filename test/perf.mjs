// Frame-pacing bench: node test/perf.mjs [route=30] [speed=14] [dpr=1] [label]
// Autopilots one route from a cold page and records every frame interval with its own rAF
// loop (independent of the game's counters), so two builds can be compared like for like.
// Average fps is useless here - vsync pins it - so the output is the tail: p95/p99/max and
// how many frames missed one or more vsyncs.
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname( fileURLToPath( import.meta.url ) );
const out = join( here, 'out' );
mkdirSync( out, { recursive: true } );
const BASE = process.env.GAME_URL || 'http://127.0.0.1:8600/';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const [ route = '30', speed = '14', dpr = '1', label = 'perf' ] = process.argv.slice( 2 );
const sleep = ms => new Promise( r => setTimeout( r, ms ) );

const browser = await puppeteer.launch( {
	executablePath: CHROME, headless: 'new',
	args: [ '--window-size=1280,720', '--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11',
		'--disable-background-timer-throttling', '--disable-renderer-backgrounding' ],
	defaultViewport: { width: 1280, height: 720, deviceScaleFactor: Number( dpr ) },
} );
const page = await browser.newPage();
const problems = [];
page.on( 'console', m => m.type() === 'error' && problems.push( m.text().slice( 0, 200 ) ) );
page.on( 'pageerror', e => problems.push( e.message.slice( 0, 200 ) ) );
const g = expr => page.evaluate( `(() => { const g = window.__game; return ${expr}; })()` );

try {

	const t0 = Date.now();
	await page.goto( BASE + `?route=${route}`, { waitUntil: 'load' } );
	while ( await g( 'g && g.state' ) !== 'driving' ) {

		if ( Date.now() - t0 > 120000 ) throw new Error( 'never reached driving state' );
		await sleep( 100 );

	}

	const spawnMs = Date.now() - t0;
	await g( `g.startAutopilot(${route}, ${speed}, false)` );
	await page.evaluate( () => {

		window.__ft = [];
		let l = performance.now();
		( function f() {

			const n = performance.now();
			window.__ft.push( n - l ); l = n;
			requestAnimationFrame( f );

		} )();

	} );

	const len = await g( `g.routes[${route}].length` );
	const deadline = Date.now() + Math.max( 45000, len / speed * 2500 + 20000 );
	let shots = 0;
	while ( Date.now() < deadline ) {

		await sleep( 500 );
		const a = await g( 'g.auto' );
		if ( shots === 0 && ( await g( 'g.report().routeProgress' ) ) > 0.4 ) {

			await page.screenshot( { path: join( out, `${label}_dpr${dpr}.png` ) } ); shots ++;

		}

		if ( a.done || ! a.on ) break;

	}

	const ft = ( await page.evaluate( () => window.__ft ) ).slice( 2 ).sort( ( a, b ) => a - b );
	const q = f => + ft[ Math.floor( f * ( ft.length - 1 ) ) ].toFixed( 1 );
	const r = await g( 'g.report()' );
	console.log( JSON.stringify( {
		label, dpr: Number( dpr ), route: Number( route ), speed: Number( speed ), spawnMs,
		frames: ft.length, p50: q( 0.5 ), p95: q( 0.95 ), p99: q( 0.99 ), max: q( 1 ),
		over25ms: ft.filter( v => v > 25 ).length, over50ms: ft.filter( v => v > 50 ).length,
		over100ms: ft.filter( v => v > 100 ).length,
		completed: ( await g( 'g.auto' ) ).done, progress: + r.routeProgress.toFixed( 3 ),
		rmsAy: + r.rmsVerticalAccel.toFixed( 2 ), maxAy: + r.maxAy.toFixed( 1 ),
		offMeshWheel: + r.offMeshWheelFraction.toFixed( 4 ), crashes: r.crashes, stalls: r.stalls, resets: r.resets,
		perf: r.perf,
	} ) );
	if ( problems.length ) console.log( 'console errors:', [ ...new Set( problems ) ].slice( 0, 8 ) );

} finally {

	await browser.close();

}
