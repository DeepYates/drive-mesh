// Makes the pictures the site needs from the game itself: a card thumbnail per mesh
// (static/thumbs/<id>.jpg) and the link-preview image (static/og.jpg).
//   node test/thumbs.mjs          (local stack running, as for the other tests)
import puppeteer from 'puppeteer-core';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join( dirname( fileURLToPath( import.meta.url ) ), '..', 'static' );
const BASE = process.env.GAME_URL || 'http://127.0.0.1:8600/';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const { meshes, site } = JSON.parse( readFileSync( join( root, 'meshes.json' ), 'utf8' ) );
const sleep = ms => new Promise( r => setTimeout( r, ms ) );
mkdirSync( join( root, 'thumbs' ), { recursive: true } );

const browser = await puppeteer.launch( { executablePath: CHROME, headless: 'new',
	args: [ '--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11' ] } );

/** Drive a mesh on autopilot for a few seconds at full detail, hide the interface, take the picture. */
async function shoot( mesh, width, height, file, caption ) {

	const page = await browser.newPage();
	await page.setViewport( { width, height } );
	await page.goto( `${BASE}?mesh=${mesh.id}&mp=0&error=6`, { waitUntil: 'load' } );
	const g = expr => page.evaluate( `(() => { const g = window.__game; return ${expr}; })()` );
	for ( let i = 0; i < 480 && await g( 'g && g.state' ) !== 'driving'; i ++ ) await sleep( 250 );
	await g( 'g.startAutopilot(0, 9, false)' );
	await sleep( 7000 );
	for ( let i = 0; i < 80 && ( await g( 'g.tiles' ) ).downloading + ( await g( 'g.tiles' ) ).parsing > 0; i ++ ) await sleep( 250 );
	await page.addStyleTag( { content: 'body > :not(canvas):not(#shot) { display: none !important; }' } );
	if ( caption ) await page.evaluate( ( { brand, title } ) => {

		const el = document.createElement( 'div' );
		el.id = 'shot';
		el.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;justify-content:flex-end;padding:56px 64px;' +
			'background:linear-gradient(180deg,rgba(13,17,23,0) 35%,rgba(13,17,23,.88));font-family:ui-sans-serif,system-ui,"Segoe UI",sans-serif;color:#fff';
		el.innerHTML = '<div style="font-weight:700;letter-spacing:.14em;font-size:20px;color:#ffd166"></div><div style="font-weight:700;font-size:76px;line-height:1.05;letter-spacing:-.02em;margin-top:10px"></div>';
		el.children[ 0 ].textContent = brand; el.children[ 1 ].textContent = title;
		document.body.append( el );

	}, caption );
	await sleep( 300 );
	await page.screenshot( { path: join( root, file ), type: 'jpeg', quality: 82 } );
	console.log( 'wrote', file );
	await page.close();

}

// the car picker's pictures: studio shots rendered by the game itself (window.__game.carShot)
{

	const page = await browser.newPage();
	await page.goto( `${BASE}?mesh=${meshes[ 0 ].id}&mp=0&sat=0`, { waitUntil: 'load' } );
	for ( let i = 0; i < 480 && await page.evaluate( () => window.__game?.state ) !== 'driving'; i ++ ) await sleep( 250 );
	for ( const id of [ 'sedan', 'sedan-sports', 'hatchback-sports', 'suv', 'truck', 'van' ] ) {

		const url = await page.evaluate( id => window.__game.carShot( id, 480, 300 ), id );
		writeFileSync( join( root, 'cars', `${id}.png` ), Buffer.from( url.split( ',' )[ 1 ], 'base64' ) );
		console.log( 'wrote', `cars/${id}.png` );

	}

	await page.close();

}

for ( const mesh of meshes ) await shoot( mesh, 960, 540, `thumbs/${mesh.id}.jpg` );
await shoot( meshes[ 0 ], 1200, 630, 'og.jpg', { brand: 'DEEPWALK', title: site.title || 'Drive the mesh' } );
await browser.close();
