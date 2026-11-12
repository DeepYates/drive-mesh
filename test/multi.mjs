// Two-player check: two browsers join the same room, one drives, the other must see it move.
//   node test/multi.mjs            (GAME_URL defaults to the local server on :8600)
// Two separate browsers, not two tabs: a background tab is throttled and reports
// document.hidden, and the game deliberately stops sending poses from a hidden tab.
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join( dirname( fileURLToPath( import.meta.url ) ), 'out' );
mkdirSync( out, { recursive: true } );
const BASE = process.env.GAME_URL || 'http://127.0.0.1:8600/';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOM = 'test' + Math.random().toString( 36 ).slice( 2, 8 );
const sleep = ms => new Promise( r => setTimeout( r, ms ) );

async function player( name ) {

	const browser = await puppeteer.launch( { executablePath: CHROME, headless: 'new',
		args: [ '--window-size=1280,720', '--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11',
			'--disable-background-timer-throttling', '--disable-renderer-backgrounding' ],
		defaultViewport: { width: 1280, height: 720 } } );
	const page = await browser.newPage();
	const problems = [];
	page.on( 'console', m => [ 'error', 'warning' ].includes( m.type() ) && problems.push( m.text().slice( 0, 200 ) ) );
	page.on( 'pageerror', e => problems.push( 'pageerror ' + e.message.slice( 0, 200 ) ) );
	await page.goto( `${BASE}?room=${ROOM}&name=Driver%20${name}&car=${name === 'A' ? 'truck' : 'suv'}`, { waitUntil: 'load' } );
	const g = expr => page.evaluate( `(() => { const g = window.__game; return ${expr}; })()` );
	return { name, browser, page, g, problems };

}

async function until( what, fn, timeout = 90000 ) {

	const t0 = Date.now();
	while ( Date.now() - t0 < timeout ) {

		if ( await fn() ) return true;
		await sleep( 250 );

	}

	throw new Error( 'timed out waiting for ' + what );

}

const a = await player( 'A' ), b = await player( 'B' );
let failed = false;
const check = ( ok, label, detail = '' ) => { console.log( ok ? 'PASS' : 'FAIL', label, detail ); if ( ! ok ) failed = true; };
try {

	await until( 'both driving', async () => await a.g( 'g && g.state' ) === 'driving' && await b.g( 'g && g.state' ) === 'driving' );
	await until( 'both see one peer', async () => ( await a.g( 'g.net.peers.length' ) ) === 1 && ( await b.g( 'g.net.peers.length' ) ) === 1, 20000 );
	const na = await a.g( 'g.net' ), nb = await b.g( 'g.net' );
	check( na.status === 'online' && nb.status === 'online' && na.id !== nb.id, 'both online with different ids', `A=${na.id} B=${nb.id} room=${na.url}` );

	await until( 'names to arrive', async () => ( await a.g( 'g.net.peers[0].name' ) ) === 'Driver B' && ( await b.g( 'g.net.peers[0].name' ) ) === 'Driver A', 10000 );
	check( true, 'each sees the other player name label' );
	await until( 'car models to load', async () => { const p = ( await b.g( 'g.net.peers' ) )[ 0 ]; return p.car === 'truck' && p.carLoaded && ( await a.g( 'g.net.peers' ) )[ 0 ].car === 'suv' && ( await a.g( 'g.net.carLoaded' ) ); }, 20000 );
	check( true, 'each sees the other player chosen car model (A: pickup, B: SUV)' );
	await sleep( 1500 );
	await a.page.screenshot( { path: join( out, 'multi_A_view.png' ) } );
	await b.page.screenshot( { path: join( out, 'multi_B_view.png' ) } );

	const own0 = await a.g( 'g.car' ), seen0 = ( await b.g( 'g.net.peers' ) )[ 0 ];
	check( Math.hypot( own0.x - seen0.x, own0.z - seen0.z ) < 1, 'B sees A where A is (parked)', `${Math.hypot( own0.x - seen0.x, own0.z - seen0.z ).toFixed( 2 )} m apart` );

	await a.page.keyboard.down( 'KeyW' );
	await sleep( 3000 );
	await b.page.screenshot( { path: join( out, 'multi_B_sees_A.png' ) } );
	await sleep( 3000 );
	await a.page.keyboard.up( 'KeyW' );
	await a.page.keyboard.down( 'Space' );
	await until( 'A to stop', async () => Math.abs( ( await a.g( 'g.car' ) ).speed ) < 0.05, 20000 );
	await a.page.keyboard.up( 'Space' );
	await sleep( 3000 );    // a parked car reports every 2 s; let the final pose arrive and be drawn
	const own1 = await a.g( 'g.car' ), seen1 = ( await b.g( 'g.net.peers' ) )[ 0 ];
	const drove = Math.hypot( own1.x - own0.x, own1.z - own0.z ), seenMove = Math.hypot( seen1.x - seen0.x, seen1.z - seen0.z );
	check( drove > 20, 'A drove', `${drove.toFixed( 1 )} m` );
	check( Math.abs( drove - seenMove ) < 2, 'B saw A move the same distance', `${seenMove.toFixed( 1 )} m` );
	check( Math.hypot( own1.x - seen1.x, own1.z - seen1.z ) < 1 && Math.abs( own1.y - seen1.y ) < 0.5, 'B sees A where A stopped',
		`${Math.hypot( own1.x - seen1.x, own1.z - seen1.z ).toFixed( 2 )} m apart` );

	await a.browser.close();
	await until( 'B sees A leave', async () => ( await b.g( 'g.net.peers.length' ) ) === 0, 10000 );
	check( true, 'B saw A leave' );
	check( b.problems.length === 0 && a.problems.length === 0, 'no console errors', [ ...a.problems, ...b.problems ].join( ' | ' ) );

} catch ( e ) {

	check( false, e.message, JSON.stringify( { a: await a.g( 'g && g.net' ).catch( () => null ), b: await b.g( 'g && g.net' ).catch( () => null ) } ) );
	await b.page.screenshot( { path: join( out, 'multi_failed.png' ) } ).catch( () => {} );

}

await a.browser.close().catch( () => {} );
await b.browser.close();
process.exit( failed ? 1 : 0 );
