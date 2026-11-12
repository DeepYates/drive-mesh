// The marketing funnel, end to end: start screen -> lead to HubSpot -> admission -> drive,
// plus the capacity page, the ad-blocker fallback, the tile budget and the phone mode.
//
//   node test/gate.mjs
//
// Needs the local stack from the README: `npx wrangler dev` in worker/ (port 8787) with a
// .dev.vars holding TILESETS, ALLOWED_ORIGINS=http://127.0.0.1:8600, DAILY_USERS=3, PASS_KEY,
// STATS_KEY, HUBSPOT_FORM=test-form and HUBSPOT_ENDPOINT=http://127.0.0.1:8790; a build made
// with TILES_BASE=http://127.0.0.1:8787/tiles/; and server.py on 8600 serving static/.
// Run it once per `wrangler dev` start: it uses up the day's three admissions.
//
// The live site uses HubSpot's own embedded form; that needs real HubSpot, so here the embed
// is switched off (hubspot.embed: false) and the fallback path - this page's own fields,
// posted to the form API - is what runs.
// HubSpot is played by a stand-in server here (port 8790) that enforces the two rules that
// matter: fields not on the form are rejected, and a blocked address is refused.
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname( fileURLToPath( import.meta.url ) ), out = join( here, 'out' );
mkdirSync( out, { recursive: true } );
const SITE = 'http://127.0.0.1:8600/', WORKER = 'http://127.0.0.1:8787', HUBSPOT = 'http://127.0.0.1:8790';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const STATS_KEY = /^STATS_KEY=(.+)$/m.exec( readFileSync( join( here, '..', 'worker', '.dev.vars' ), 'utf8' ) )[ 1 ].trim();
const FORM_FIELDS = [ 'email', 'firstname', 'company', 'drive_demo_mesh', 'drive_demo_outcome' ];
const sleep = ms => new Promise( r => setTimeout( r, ms ) );
let failed = false;
const check = ( ok, label, detail = '' ) => { console.log( ok ? 'PASS' : 'FAIL', label, detail ); if ( ! ok ) failed = true; };

// ----- stand-in HubSpot
const leads = [];
const hubspot = createServer( ( req, res ) => {

	const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
	if ( req.method === 'OPTIONS' ) return res.writeHead( 204, cors ).end();
	// the form's public definition, as HubSpot's embed endpoint serves it; "no-definition" has none
	const def = /^\/embed\/v3\/form\/[^/]+\/([^/]+)\/json$/.exec( req.url );
	if ( def ) {

		if ( def[ 1 ] === 'no-definition' ) return res.writeHead( 404, cors ).end();
		const names = def[ 1 ] === 'email-only' ? [ 'email' ] : FORM_FIELDS;
		return res.writeHead( 200, { 'Content-Type': 'application/json', ...cors } ).end( JSON.stringify( { form: { formFieldGroups: names.map( name => ( { fields: [ { name } ] } ) ) } } ) );

	}

	let raw = '';
	req.on( 'data', c => raw += c ).on( 'end', () => {

		const body = JSON.parse( raw ), f = Object.fromEntries( body.fields.map( x => [ x.name, x.value ] ) );
		// the form "email-only" has just the email field, like a form made with HubSpot's defaults
		const onForm = /\/(email-only|no-definition)$/.test( req.url ) ? [ 'email' ] : FORM_FIELDS;
		const bad = body.fields.find( x => ! onForm.includes( x.name ) );
		const error = bad ? 'FIELD_NOT_IN_FORM_DEFINITION' : /@blocked\.test$/.test( f.email ) ? 'BLOCKED_EMAIL' : null;
		leads.push( { path: req.url, via: req.headers.origin ? 'browser' : 'worker', f, context: body.context, error } );
		res.writeHead( error ? 400 : 200, { 'Content-Type': 'application/json', ...cors } )
			.end( JSON.stringify( error ? { status: 'error', errors: [ { message: error, errorType: error } ] } : { inlineMessage: 'ok' } ) );

	} );

} ).listen( 8790, '127.0.0.1' );

// ----- browser: not flagged as automated, so the start screen appears as it does for a person
const browser = await puppeteer.launch( { executablePath: CHROME, headless: 'new',
	args: [ '--window-size=1280,800', '--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11', '--disable-blink-features=AutomationControlled' ],
	defaultViewport: { width: 1280, height: 800 } } );

/** A fresh visitor (own storage). `site` overrides meshes.json's site block; `block` aborts matching requests. */
async function visitor( { site = {}, block = null, query = '', extraMesh = false } = {} ) {

	const ctx = await browser.createBrowserContext(), page = await ctx.newPage();
	const errors = [];
	page.on( 'pageerror', e => errors.push( e.message ) );
	await page.setRequestInterception( true );
	page.on( 'request', async req => {

		if ( block && block.test( req.url() ) && req.method() !== 'OPTIONS' ) return req.abort();
		if ( ! req.url().endsWith( '/meshes.json' ) ) return req.continue();
		const cfg = JSON.parse( readFileSync( join( here, '..', 'static', 'meshes.json' ), 'utf8' ) );
		cfg.site = { ...cfg.site, ...site, hubspot: { portalId: '1', formGuid: 'test-form', endpoint: HUBSPOT, formsHost: HUBSPOT, consentText: '', embed: false, ...site.hubspot } };
		if ( extraMesh ) cfg.meshes.push( { ...cfg.meshes[ 0 ], id: 'second', title: 'A second mesh', provider: 'Another provider', thumb: '' } );
		req.respond( { status: 200, contentType: 'application/json', body: JSON.stringify( cfg ) } );

	} );
	await page.goto( SITE + query, { waitUntil: 'load' } );
	const v = {
		ctx, page, errors,
		g: expr => page.evaluate( `(() => { const g = window.__game; return ${expr}; })()` ),
		shown: id => page.evaluate( id => { const el = document.getElementById( id ); return !! el && ! el.hidden && el.getClientRects().length > 0; }, id ),
		text: id => page.evaluate( id => document.getElementById( id ).textContent.trim(), id ),
		notice: () => page.evaluate( () => document.getElementById( 'start' ).hidden ? '' : document.getElementById( 'start' ).dataset.notice || '' ),
		async fill( email, name, company = '' ) {

			for ( const [ id, value ] of [ [ 'gateEmail', email ], [ 'gateName', name ], [ 'gateCompany', company ] ] ) {

				await page.click( '#' + id, { clickCount: 3 } ); await page.keyboard.press( 'Backspace' );
				if ( value ) await page.type( '#' + id, value );

			}

			await page.click( '#gateGo' );

		},
		async until( what, fn, ms = 90000 ) { const t = Date.now(); while ( Date.now() - t < ms ) { if ( await fn() ) return true; await sleep( 250 ); } throw new Error( 'timed out: ' + what ); },
		driving() { return v.until( 'driving', async () => await v.g( 'g && g.state' ) === 'driving' ); },
	};
	await v.until( 'page ready', () => page.evaluate( () => ! document.getElementById( 'start' ).hidden || window.__game?.state !== 'boot' ), 20000 );
	return v;

}

const stats = async () => ( await ( await fetch( `${WORKER}/stats?key=${STATS_KEY}` ) ).json() ).days[ 0 ] ?? { admitted: 0, busy: 0 };

try {

	const before = await stats();

	// ----- A. a new visitor
	const a = await visitor( { extraMesh: true } );
	check( await a.shown( 'start' ) && await a.shown( 'gateEmail' ), 'A: start screen with the lead form is shown' );
	check( await a.page.$$eval( '.mesh', els => els.length ) === 2 && await a.shown( 'meshes' ), 'A: gallery lists both meshes' );
	await a.page.screenshot( { path: join( out, 'gate_start.png' ) } );
	await a.fill( 'not-an-email', 'Ada' );
	check( /email/i.test( await a.text( 'gateError' ) ) && leads.length === 0, 'A: a malformed email is refused before anything is sent' );
	await a.fill( 'someone@blocked.test', 'Ada' );
	await a.until( 'refusal', async () => /not accepted/.test( await a.text( 'gateError' ) ), 15000 );
	check( await a.shown( 'start' ) && leads.at( - 1 ).error === 'BLOCKED_EMAIL', 'A: an address HubSpot refuses keeps the gate shut' );
	await a.fill( 'ada@example.com', 'Ada L', 'Analytical Engines' );
	await a.driving();
	const lead = leads.at( - 1 );
	check( lead.f.email === 'ada@example.com' && lead.f.firstname === 'Ada L' && lead.f.company === 'Analytical Engines'
		&& lead.f.drive_demo_mesh === 'pinellas' && lead.f.drive_demo_outcome === 'played' && ! lead.error && lead.via === 'browser',
	'A: HubSpot got email, name, company, mesh and outcome=played, straight from the browser', JSON.stringify( lead.f ) );
	check( lead.context.pageUri.startsWith( SITE ) && lead.path.endsWith( '/1/test-form' ), 'A: page address and form id are on the submission' );
	check( ! await a.shown( 'start' ) && new URL( a.page.url() ).searchParams.get( 'mesh' ) === 'pinellas', 'A: screen gone, address names the mesh' );
	const net = await a.g( 'g.net' );
	check( net.name === 'Ada L' && ! JSON.stringify( net ).includes( 'ada@example.com' ), 'A: the car label is the name; the email is nowhere in the multiplayer state' );
	check( await a.shown( 'cta' ) && await a.shown( 'invite' ) && await a.shown( 'change' ), 'A: call to action, invite and mesh switcher are in the bar' );
	await sleep( 1500 );
	await a.page.screenshot( { path: join( out, 'gate_driving.png' ) } );
	const s1 = await stats();
	check( s1.admitted === before.admitted + 1, 'A: one admission counted', `${before.admitted} -> ${s1.admitted}` );

	// ----- B. the same visitor comes back
	const n = leads.length;
	await a.page.reload( { waitUntil: 'load' } );
	await a.driving();
	check( ! await a.shown( 'start' ), 'B: returning visitor goes straight in, no form' );
	check( ( await stats() ).admitted === s1.admitted && leads.length === n, 'B: no second admission, no second HubSpot submission' );
	await a.ctx.close();

	// ----- D. hsforms.com blocked (ad blocker): the Worker forwards the lead
	const d = await visitor( { block: /127\.0\.0\.1:8790/ } );
	await d.fill( 'blocked.path@example.com', 'Dee' );
	await d.driving();
	const viaWorker = leads.at( - 1 );
	check( viaWorker.f.email === 'blocked.path@example.com' && viaWorker.via === 'worker' && viaWorker.f.drive_demo_outcome === 'played',
		'D: with HubSpot blocked in the browser, the lead arrives through the Worker', viaWorker.via );
	await d.ctx.close();

	// ----- G. tile budget (tiny limits so it trips within one drive)
	const g = await visitor( { site: { tileBudget: 40, tileHardStop: 90 } } );
	await g.fill( 'budget@example.com', 'Gus' );
	await g.driving();
	await g.page.keyboard.down( 'KeyW' );
	await g.until( 'budget to trip', async () => ( await g.g( 'g.net.tileBudget.n' ) ) >= 90, 60000 );
	await g.page.keyboard.up( 'KeyW' );
	const dbg = await g.g( '({ n: g.net.tileBudget.n, error: g.debug().errorTarget, nudge: document.getElementById("nudgeText").textContent })' );
	check( dbg.error >= 40, 'G: past the soft budget the mesh drops to low detail', `errorTarget ${dbg.error} after ${dbg.n} network tiles` );
	// Downloads already in flight when the stop lands (up to 25) still finish, and through a
	// cold proxy that can take a while: wait until the count stops moving, then it must stay put.
	let n1 = dbg.n, still = 0;
	for ( let i = 0; i < 30 && still < 3; i ++ ) { await sleep( 2000 ); const n = await g.g( 'g.net.tileBudget.n' ); still = n === n1 ? still + 1 : 0; n1 = n; }
	await g.page.keyboard.down( 'KeyW' ); await sleep( 4000 ); await g.page.keyboard.up( 'KeyW' );      // drive on: nothing new may load
	const n2 = await g.g( 'g.net.tileBudget.n' );
	check( still >= 3 && n2 === n1 && n1 <= 90 + 30 && /limit/.test( dbg.nudge ), 'G: past the hard stop streaming stops and the visitor is told',
		`settled at ${n1} (limit 90 + up to 25 in flight), still ${n2} after driving on; "${dbg.nudge}"` );
	check( /resets (today|tomorrow) at \d/.test( dbg.nudge ) && /daily limit reached/.test( await g.text( 'status' ) ), 'G: the message gives the reset time, and the HUD keeps a line about the limit', await g.text( 'status' ) );
	// coming back after using the allowance: a clear page, not an endless "Finding the road"
	await g.page.reload( { waitUntil: 'load' } );
	await g.until( 'allowance page', async () => ( await g.notice() ) === 'tiles', 20000 );
	await sleep( 1500 );
	check( /driving allowance/.test( await g.text( 'startTitle' ) ) && /(today|tomorrow) at \d/.test( await g.text( 'startPitch' ) ) && await g.shown( 'busyCta' ) && await g.page.evaluate( () => document.getElementById( 'overlay' ).classList.contains( 'hidden' ) ),
		'G: a return visit after the limit shows the allowance page with the reset time (no spinner)', await g.text( 'startPitch' ) );
	await g.ctx.close();

	// ----- C. the day is full (DAILY_USERS = 3: A, D and G took the places)
	const c = await visitor();
	await c.fill( 'late@example.com', 'Cy' );
	await c.until( 'capacity page', async () => ( await c.notice() ) === 'full', 20000 );
	check( await c.shown( 'start' ) && await c.shown( 'busyCta' ) && ! await c.shown( 'gateGo' ) && ! await c.shown( 'cars' ) && ! await c.shown( 'busyRetry' ), 'C: the 4th visitor sees the capacity page with the call to action and nothing to fill in' );
	const said = await c.text( 'startPitch' );
	check( /all taken/.test( await c.text( 'startTitle' ) ) && /\b3 drives a day\b/.test( said ) && /(today|tomorrow) at \d/.test( said ) && /have your email/.test( said ), 'C: it says how many drives a day, when more open, and that the email was kept', said );
	check( leads.at( - 1 ).f.email === 'late@example.com' && leads.at( - 1 ).f.drive_demo_outcome === 'at_capacity', 'C: their lead still reached HubSpot, tagged at_capacity' );
	check( await c.g( 'window.__game?.state' ) === 'boot', 'C: the game did not start (no tiles fetched)' );
	await c.page.screenshot( { path: join( out, 'gate_busy.png' ) } );
	const s2 = await stats();
	check( s2.admitted === before.admitted + 3 && s2.busy === before.busy + 1, 'C: stats show 3 admitted, 1 turned away', JSON.stringify( { admitted: s2.admitted, busy: s2.busy } ) );
	await c.ctx.close();

	// ----- I. a form with only an email field (what the real form has): exactly that field is sent, once
	const basic = await visitor( { site: { hubspot: { formGuid: 'email-only' } } } );
	const before2 = leads.length;
	await basic.fill( 'basic@example.com', 'Bea', 'Basic Co' );
	await basic.until( 'capacity page', async () => ( await basic.notice() ) === 'full', 20000 );
	const tries = leads.slice( before2 ), kept = tries.at( - 1 );
	check( tries.length === 1 && ! kept.error && Object.keys( kept.f ).join() === 'email' && kept.f.email === 'basic@example.com',
		'I: for a form with only an email field, the form definition is read and only the email is sent', JSON.stringify( tries.map( t => Object.keys( t.f ) ) ) );
	check( /pinellas/.test( kept.context.pageName ) && /capacity/.test( kept.context.pageName ) && /Bea \(Basic Co\)/.test( kept.context.pageName ),
		'I: mesh, outcome, name and company are in the submission page name', kept.context.pageName );
	await basic.ctx.close();

	// ----- J. the form definition cannot be read: smaller shapes are offered until one is accepted
	const blind = await visitor( { site: { hubspot: { formGuid: 'no-definition' } } } );
	const before3 = leads.length;
	await blind.fill( 'blind@example.com', 'Jo', '' );
	await blind.until( 'capacity page', async () => ( await blind.notice() ) === 'full', 20000 );
	const tries3 = leads.slice( before3 );
	check( tries3.length === 3 && tries3[ 0 ].error === 'FIELD_NOT_IN_FORM_DEFINITION' && tries3[ 1 ].error === 'FIELD_NOT_IN_FORM_DEFINITION' && ! tries3[ 2 ].error && Object.keys( tries3[ 2 ].f ).join() === 'email',
		'J: without a readable definition, the lead is re-sent in smaller shapes until accepted', JSON.stringify( tries3.map( t => Object.keys( t.f ).length ) ) );
	await blind.ctx.close();

	// ----- E. the Worker is unreachable (what the free plan's daily stop looks like)
	const e = await visitor( { block: /127\.0\.0\.1:8787/ } );
	await e.fill( 'down@example.com', 'Eve' );
	await e.until( 'capacity page', async () => ( await e.notice() ) === 'unreachable', 20000 );
	check( await e.shown( 'busyRetry' ) && /can.t be reached/.test( await e.text( 'startTitle' ) ) && /(today|tomorrow) at \d/.test( await e.text( 'startPitch' ) ), 'E: an unreachable server gets its own message, with the reset time and a Try again button', await e.text( 'startTitle' ) );
	check( leads.at( - 1 ).f.email === 'down@example.com' && leads.at( - 1 ).via === 'browser', 'E: with the Worker down the visitor gets the capacity page and the lead is still captured' );
	await e.ctx.close();

	// ----- F. stats are for the owner only
	check( ( await fetch( `${WORKER}/stats?key=wrong` ) ).status === 404 && ( await fetch( `${WORKER}/stats` ) ).status === 404, 'F: /stats without the key is a 404' );
	check( typeof s2.tiles?.miss === 'number', 'F: tile cache counters are reported', JSON.stringify( s2.tiles ) );

	check( [ a, d, g, c, e, basic, blind ].every( v => v.errors.length === 0 ), 'no page errors in any visit', [ a, d, g, c, e, basic, blind ].flatMap( v => v.errors ).join( ' | ' ).slice( 0, 200 ) );

	// ----- H. phone mode. An ordinary automated browser: it skips the gate and takes no
	// admission, which is what is wanted now that the day is full.
	const phone = await puppeteer.launch( { executablePath: CHROME, headless: 'new',
		args: [ '--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11' ], defaultViewport: { width: 844, height: 390, hasTouch: true, isMobile: true } } );
	const hp = await phone.newPage();
	const herr = []; hp.on( 'pageerror', x => herr.push( x.message ) );
	await hp.goto( SITE + '?touch=1&name=Hal', { waitUntil: 'load' } );
	const hg = expr => hp.evaluate( `(() => { const g = window.__game; return ${expr}; })()` );
	for ( let i = 0; i < 360 && await hg( 'g && g.state' ) !== 'driving'; i ++ ) await sleep( 250 );
	await sleep( 1500 );
	const vis = id => hp.evaluate( id => { const el = document.getElementById( id ); return ! el.hidden && el.getClientRects().length > 0; }, id );
	check( await vis( 'touchGas' ) && await vis( 'touchLeft' ) && await vis( 'takeWheel' ), 'H: on-screen controls and "Take the wheel" are shown' );
	check( ( await hg( 'g.auto' ) ).on === true, 'H: the phone starts as a passenger (autopilot on)' );
	await hp.screenshot( { path: join( out, 'gate_phone.png' ) } );
	await hp.tap( '#takeWheel' );
	check( ( await hg( 'g.auto' ) ).on === false && ! await vis( 'takeWheel' ), 'H: "Take the wheel" hands over control' );
	await hg( 'g.car' ); const x0 = ( await hg( 'g.car' ) ).speed;
	const gas = await hp.$( '#touchGas' ), box = await gas.boundingBox();
	await hp.touchscreen.touchStart( box.x + box.width / 2, box.y + box.height / 2 );
	await sleep( 2500 );
	const fast = ( await hg( 'g.car' ) ).speed;
	await hp.touchscreen.touchEnd();
	check( fast > Math.max( 3, x0 ), 'H: holding the gas button accelerates the car', `${x0.toFixed( 1 )} -> ${fast.toFixed( 1 )} m/s` );
	check( herr.length === 0, 'H: no page errors', herr.join( ' | ' ).slice( 0, 200 ) );

	// ----- K. the owner's bypass link: with the right code the page stops limiting itself
	const sha = async s => [ ...new Uint8Array( await crypto.subtle.digest( 'SHA-256', new TextEncoder().encode( s ) ) ) ].map( b => b.toString( 16 ).padStart( 2, '0' ) ).join( '' );
	const hash = await sha( 'right-code' );
	for ( const [ code, expectUnlimited ] of [ [ 'wrong-code', false ], [ 'right-code', true ] ] ) {

		const kp = await ( await phone.createBrowserContext() ).newPage();
		await kp.setViewport( { width: 1280, height: 720 } );
		await kp.setRequestInterception( true );
		kp.on( 'request', req => { if ( ! req.url().endsWith( '/meshes.json' ) ) return req.continue(); const cfg = JSON.parse( readFileSync( join( here, '..', 'static', 'meshes.json' ), 'utf8' ) ); Object.assign( cfg.site, { tileBudget: 40, tileHardStop: 90, unlimitedHash: hash } ); req.respond( { status: 200, contentType: 'application/json', body: JSON.stringify( cfg ) } ); } );
		await kp.goto( `${SITE}?mp=0&unlimited=${code}`, { waitUntil: 'load' } );
		const kg = expr => kp.evaluate( `(() => { const g = window.__game; return ${expr}; })()` );
		for ( let i = 0; i < 360 && await kg( 'g && g.state' ) !== 'driving'; i ++ ) await sleep( 250 );
		await kp.keyboard.down( 'KeyW' ); await sleep( 14000 ); await kp.keyboard.up( 'KeyW' ); await sleep( 4000 );
		const k = await kg( '({ unlimited: g.net.unlimited, n: g.net.tileBudget.n, error: g.debug().errorTarget, nudge: ! document.getElementById( "nudge" ).hidden, inUrl: location.search.includes( "unlimited" ) })' );
		if ( expectUnlimited ) check( k.unlimited && k.n > 150 && k.error < 40 && ! k.nudge, 'K: the right code lifts the limit (kept loading at full detail well past the hard stop of 90)', JSON.stringify( k ) );
		else check( ! k.unlimited && k.n <= 125 && k.nudge, 'K: a wrong code changes nothing (stopped at the limit as usual)', JSON.stringify( k ) );
		check( ! k.inUrl, `K: the code is removed from the address (${code})` );
		await kp.close();

	}

	await phone.close();

} catch ( err ) {

	check( false, err.message );

}

await browser.close();
hubspot.close();
process.exit( failed ? 1 : 0 );
