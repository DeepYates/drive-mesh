// Is the first view sharp when the loading screen lifts?
//   node test/firstview.mjs [mesh id]        (local stack running, as for the other tests)
// Loads the mesh twice, with the first-open hold on (default) and off (?sharp=0), and for each reports
// how long the loading screen stayed up and how many tiles were still arriving in the first seconds of
// driving with the car standing still. A sharp first view means next to none arrive after the screen lifts.
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join( dirname( fileURLToPath( import.meta.url ) ), 'out' );
mkdirSync( out, { recursive: true } );
const BASE = process.env.GAME_URL || 'http://127.0.0.1:8600/';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const meshId = process.argv[ 2 ] || 'pinellas';
const sleep = ms => new Promise( r => setTimeout( r, ms ) );

async function run( label, extra ) {

	// a fresh browser each time: an empty HTTP cache, so both runs stream every tile over the network
	const browser = await puppeteer.launch( { executablePath: CHROME, headless: 'new',
		args: [ '--window-size=1280,720', '--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11',
			'--disable-background-timer-throttling', '--disable-renderer-backgrounding' ], defaultViewport: { width: 1280, height: 720 } } );
	const page = await browser.newPage();
	const t0 = Date.now();
	await page.goto( `${BASE}?mesh=${meshId}&mp=0${extra}`, { waitUntil: 'load' } );
	const g = expr => page.evaluate( `(() => { const g = window.__game; return ${expr}; })()` );
	let solidSeen = false;
	for ( let i = 0; i < 1200 && await g( 'g && g.state' ) !== 'driving'; i ++ ) {

		if ( ! solidSeen ) solidSeen = await page.evaluate( () => document.getElementById( 'overlay' ).classList.contains( 'solid' ) );
		await sleep( 100 );

	}

	const loadMs = Date.now() - t0;
	const at = await g( 'g.tiles' ), first = await g( 'g.firstView' );
	await page.screenshot( { path: join( out, `firstview_${label}_0s.jpg` ), type: 'jpeg', quality: 85 } );
	let peak = at.downloading + at.parsing;
	for ( let i = 0; i < 30; i ++ ) { await sleep( 100 ); const s = await g( 'g.tiles' ); peak = Math.max( peak, s.downloading + s.parsing ); }
	const after = await g( 'g.tiles' );
	await page.screenshot( { path: join( out, `firstview_${label}_3s.jpg` ), type: 'jpeg', quality: 85 } );
	const overlay = await page.evaluate( () => document.getElementById( 'overlay' ).className );
	console.log( `${label}: loading screen ${( loadMs / 1000 ).toFixed( 1 )} s | solid during load: ${solidSeen} | at lift: ${at.downloading + at.parsing} in flight, ${at.visible} shown` +
		` | next 3 s standing still: peak ${peak} in flight, ${after.visible} shown (${after.visible - at.visible >= 0 ? '+' : ''}${after.visible - at.visible})` +
		` | hold: ${first ? JSON.stringify( first ) : 'off'} | overlay now: "${overlay}"` );
	await browser.close();
	return { loadMs, at, after, peak, first };

}

const on = await run( 'hold', '' );
const off = await run( 'nohold', '&sharp=0' );
// a handful of tiles swap as the chase camera eases the last half metre into place; a blurry start is dozens (see the no-hold run)
const ok = on.first && on.first.sharp && on.at.downloading + on.at.parsing === 0 && on.peak <= 8 && Math.abs( on.after.visible - on.at.visible ) <= 6;
console.log( `${ok ? 'PASS' : 'FAIL'}: with the hold, the view ${ok ? 'does not change' : 'still changes'} after the loading screen lifts` +
	` (without it: peak ${off.peak} in flight, ${off.after.visible - off.at.visible >= 0 ? '+' : ''}${off.after.visible - off.at.visible} tiles shown). Extra wait: ${( ( on.loadMs - off.loadMs ) / 1000 ).toFixed( 1 )} s.` );
process.exit( ok ? 0 : 1 );
