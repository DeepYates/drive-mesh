// Backend for the hosted Drive Mesh demo: the Cloudflare Worker counterpart of server.py.
//
//   GET  /tiles/<mesh>/<path>  ->  that mesh's upstream tileset dir + <path>   (edge-cached)
//   GET  /room/<name>          ->  WebSocket to a multiplayer room (room.js)
//   POST /enter  { mesh, pass? }   admission for today (gate.js): { ok, pass } or { ok: false }
//   POST /lead   <HubSpot form body>   forwards a lead to HubSpot when the browser cannot
//                                      reach hsforms.com itself (ad blockers)
//   GET  /stats?key=<STATS_KEY>[&days=7]   daily counts, for the site owner
//
// Secrets (wrangler secret put):
//   TILESETS   JSON { "<mesh id>": "<.../tileset.json URL>" }. The URLs carry the DeepWalk
//              API key (the dw_live_... segment), so they never reach the browser. The old
//              single TILESET_URL is still honoured as mesh "default".
//   PASS_KEY   signs the day-pass, so a visitor who returns the same day takes no new slot.
//   STATS_KEY  the key for /stats.
//
// ALLOWED_ORIGINS (wrangler.toml) lists the sites allowed to call this: a request must carry
// one of them as its Origin header. That stops other websites from using it; it does not
// stop a script that fakes the header, so treat whatever the tile proxy serves as public.
//
// Cost: this runs on the Workers Free plan, which never bills - at a daily limit requests
// fail until 00:00 UTC. The demo is sized for DAILY_USERS visitors a day (gate.js); the
// limits here keep one visitor from using up the allowance: the admission gate, MULTIPLAYER
// ("off" disables rooms), name whitelists, and per-IP rate limiters (wrangler.toml).
import { Room } from './room.js';
import { Gate } from './gate.js';
export { Room, Gate };

const ROOT_TTL = 600;            // a root tileset.json is re-fetched after 10 minutes
const TILE_TTL = 30 * 86400;     // everything else lives under a timestamped directory: immutable
const TYPES = { json: 'application/json', glb: 'model/gltf-binary' };
const NAME = /^[a-z0-9-]{1,40}$/;
const FLUSH_EVERY = 100;         // tile counters go to the gate in batches, never one call per tile

// tile-cache counters for this isolate, per mesh; approximate (an evicted isolate loses < 100)
const tally = {};

export default {

	async fetch( request, env, ctx ) {

		const url = new URL( request.url ), { pathname } = url;
		const gate = env.GATE?.get( env.GATE.idFromName( 'gate' ) );

		// The owner's numbers: opened from a browser tab or curl, so no Origin - its own key instead.
		if ( pathname === '/stats' ) {

			if ( ! env.STATS_KEY || ! gate || ! same( url.searchParams.get( 'key' ) ?? '', env.STATS_KEY ) ) return text( 404, 'not found' );
			return gate.fetch( `https://gate/stats?days=${Number( url.searchParams.get( 'days' ) ) || 7}` );

		}

		const origin = request.headers.get( 'Origin' );
		const list = v => ( v || '' ).split( ',' ).map( s => s.trim() ).filter( Boolean );
		const allowed = list( env.ALLOWED_ORIGINS );
		// TILE_ORIGINS: other sites that may read tiles and nothing else - ArcGIS Online's Scene
		// Viewer, so a mesh can be opened there without its keyed URL. "https://*.host" matches
		// any subdomain (a signed-in ArcGIS user is on <org>.maps.arcgis.com).
		const viewer = ! allowed.includes( origin ) && pathname.startsWith( '/tiles/' ) && ( request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS' )
			&& list( env.TILE_ORIGINS ).some( o => o.includes( '*.' ) ? !! origin && origin.startsWith( o.split( '*.' )[ 0 ] ) && origin.endsWith( '.' + o.split( '*.' )[ 1 ] ) : o === origin );
		if ( allowed.length && ! allowed.includes( origin ) && ! viewer ) return text( 403, 'origin not allowed' );
		const cors = {
			'Access-Control-Allow-Origin': allowed.length ? origin : '*',
			// lets the page read transferSize for these cross-origin responses: its tile
			// budget counts tiles that came over the network, not ones from its own cache
			'Timing-Allow-Origin': allowed.length ? origin : '*',
			'Vary': 'Origin',
		};

		if ( request.method === 'OPTIONS' ) {

			return new Response( null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, HEAD, POST',
				'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } } );

		}

		const ip = request.headers.get( 'CF-Connecting-IP' ) || 'unknown';

		if ( request.method === 'POST' ) {

			if ( pathname !== '/enter' && pathname !== '/lead' ) return text( 404, 'not found', cors );
			if ( ! await allow( env.LIMIT_FORMS, ip ) ) return text( 429, 'too many requests', cors );
			const raw = await request.text();
			if ( raw.length > 4096 ) return text( 413, 'too large', cors );
			let body;
			try { body = JSON.parse( raw ); } catch { return text( 400, 'bad json', cors ); }
			if ( ! body || typeof body !== 'object' ) return text( 400, 'bad json', cors );
			return pathname === '/enter' ? enter( body, env, gate, cors ) : lead( body, env, ip, cors );

		}

		if ( request.method !== 'GET' && request.method !== 'HEAD' ) return text( 405, 'method not allowed', cors );

		if ( pathname.startsWith( '/room/' ) ) {

			if ( ( env.MULTIPLAYER || 'on' ) !== 'on' || ! env.ROOMS ) return text( 503, 'multiplayer is off', cors );
			const name = pathname.slice( '/room/'.length );
			if ( ! NAME.test( name ) ) return text( 400, 'bad room name', cors );
			if ( request.headers.get( 'Upgrade' ) !== 'websocket' ) return text( 426, 'expected a websocket', cors );
			if ( ! await allow( env.LIMIT_ROOMS, ip ) ) return text( 429, 'too many connections', cors );
			return env.ROOMS.get( env.ROOMS.idFromName( name ) ).fetch( request );

		}

		if ( ! pathname.startsWith( '/tiles/' ) ) return text( 404, 'not found', cors );
		if ( ! await allow( env.LIMIT_TILES, ip ) ) return text( 429, 'too many requests', { ...cors, 'Retry-After': '10' } );
		let rel = pathname.slice( '/tiles/'.length );
		// Tile paths are plain segments (20261111T211504Z/cell/0/1/2/L3/4_5.glb); refuse
		// anything else rather than forward it upstream.
		if ( ! /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/.test( rel ) || rel.split( '/' ).some( p => p === '.' || p === '..' ) ) {

			return text( 400, 'bad tile path', cors );

		}

		// /tiles/<mesh>/<path>. A first segment that is not a mesh id is the pre-gallery form
		// /tiles/<path>, still served from mesh "default" for pages loaded before the change.
		const sets = tilesets( env );
		let mesh = rel.split( '/' )[ 0 ];
		if ( sets[ mesh ] && rel.includes( '/' ) ) rel = rel.slice( mesh.length + 1 ); else mesh = 'default';
		const root = sets[ mesh ];
		if ( ! root ) return text( 404, 'unknown mesh', cors );

		// Edge cache, keyed by path only (no query string, no Origin). CORS headers are added
		// per request on the way out, so one cached copy serves every allowed origin.
		const cache = caches.default;
		const key = new Request( `${url.origin}/tiles/${mesh}/${rel}` );
		const t = tally[ mesh ] ??= { hit: 0, miss: 0, missBytes: 0 };
		let res = await cache.match( key );
		if ( res ) t.hit ++; else {

			let upstream;
			try {

				upstream = await fetch( root.slice( 0, - 'tileset.json'.length ) + rel, {
					headers: { 'User-Agent': 'drive-mesh-game/0.1' },
				} );

			} catch {

				return text( 502, 'upstream fetch failed', cors );    // never echo the upstream URL

			}

			if ( ! upstream.ok ) return text( upstream.status, 'upstream error', cors );
			t.miss ++;
			t.missBytes += Number( upstream.headers.get( 'Content-Length' ) ) || 0;
			res = new Response( upstream.body, { headers: {
				'Content-Type': TYPES[ rel.split( '.' ).pop() ] || 'application/octet-stream',
				'Cache-Control': rel === 'tileset.json' ? `public, max-age=${ROOT_TTL}` : `public, max-age=${TILE_TTL}, immutable`,
			} } );
			ctx.waitUntil( cache.put( key, res.clone() ) );

		}

		if ( gate && t.hit + t.miss >= FLUSH_EVERY ) {

			tally[ mesh ] = { hit: 0, miss: 0, missBytes: 0 };
			ctx.waitUntil( gate.fetch( 'https://gate/count', { method: 'POST', body: JSON.stringify( { mesh, ...t } ) } ).catch( () => {} ) );

		}

		const out = new Response( request.method === 'HEAD' ? null : res.body, res );
		for ( const [ k, v ] of Object.entries( cors ) ) out.headers.set( k, v );
		return out;

	},

};

// ---------- admission ----------
// A day-pass is "<day>.<nonce>.<hmac>". A visitor who already holds today's is let straight
// in; anyone else asks the gate, which counts them against DAILY_USERS.
async function enter( body, env, gate, cors ) {

	const day = new Date().toISOString().slice( 0, 10 );
	const mesh = NAME.test( body.mesh ?? '' ) ? body.mesh : 'unknown';
	if ( typeof body.pass === 'string' && env.PASS_KEY ) {

		const [ d, nonce, sig ] = body.pass.split( '.' );
		if ( d === day && nonce && sig && same( sig, await sign( `${d}.${nonce}`, env.PASS_KEY ) ) ) return reply( { ok: true, pass: body.pass }, cors );

	}

	if ( ! gate ) return reply( { ok: true }, cors );    // no gate bound: nothing to count against
	const r = await ( await gate.fetch( 'https://gate/enter', { method: 'POST', body: JSON.stringify( { mesh } ) } ) ).json();
	if ( ! r.ok ) return reply( { ok: false, limit: r.limit }, cors );      // the page tells the visitor the daily number
	const nonce = crypto.randomUUID().replace( /-/g, '' );
	return reply( { ok: true, pass: env.PASS_KEY ? `${day}.${nonce}.${await sign( `${day}.${nonce}`, env.PASS_KEY )}` : undefined }, cors );

}

async function sign( message, secret ) {

	const key = await crypto.subtle.importKey( 'raw', new TextEncoder().encode( secret ), { name: 'HMAC', hash: 'SHA-256' }, false, [ 'sign' ] );
	const mac = new Uint8Array( await crypto.subtle.sign( 'HMAC', key, new TextEncoder().encode( message ) ) );
	return btoa( String.fromCharCode( ...mac ) ).replace( /\+/g, '-' ).replace( /\//g, '_' ).replace( /=+$/, '' );

}

// ---------- leads ----------
// The page posts leads to HubSpot directly; this is the fallback for browsers that block
// hsforms.com. Nothing is stored here: the body is forwarded and HubSpot's answer returned.
async function lead( body, env, ip, cors ) {

	if ( ! env.HUBSPOT_PORTAL || ! env.HUBSPOT_FORM ) return text( 503, 'lead capture is not configured', cors );
	if ( ! Array.isArray( body.fields ) ) return text( 400, 'bad lead', cors );
	const base = env.HUBSPOT_ENDPOINT || 'https://api.hsforms.com';
	let res;
	try {

		res = await fetch( `${base}/submissions/v3/integration/submit/${env.HUBSPOT_PORTAL}/${env.HUBSPOT_FORM}`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			// HubSpot would otherwise record this Worker's address as the visitor's
			body: JSON.stringify( { ...body, context: { ...body.context, ipAddress: ip === 'unknown' ? undefined : ip } } ),
		} );

	} catch {

		return text( 502, 'lead forward failed', cors );

	}

	return new Response( await res.text(), { status: res.status, headers: { 'Content-Type': 'application/json', ...cors } } );

}

// ---------- helpers ----------
let parsedFrom, parsed;
function tilesets( env ) {

	const src = `${env.TILESETS ?? ''}|${env.TILESET_URL ?? ''}`;
	if ( src === parsedFrom ) return parsed;
	const out = {};
	try {

		for ( const [ id, u ] of Object.entries( JSON.parse( env.TILESETS || '{}' ) ) ) {

			if ( NAME.test( id ) && typeof u === 'string' && u.endsWith( '/tileset.json' ) ) out[ id ] = u;

		}

	} catch { /* a malformed secret serves nothing rather than something wrong */ }

	if ( ! out.default && ( env.TILESET_URL || '' ).endsWith( '/tileset.json' ) ) out.default = env.TILESET_URL;
	parsedFrom = src; parsed = out;
	return out;

}

// Per-IP rate limit. The binding is optional and best-effort: a missing or failing limiter
// lets the request through (the daily cap is still the hard stop).
async function allow( limiter, key ) {

	if ( ! limiter ) return true;
	try {

		return ( await limiter.limit( { key } ) ).success;

	} catch {

		return true;

	}

}

/** string equality that does not stop at the first difference */
function same( a, b ) {

	if ( a.length !== b.length ) return false;
	let diff = 0;
	for ( let i = 0; i < a.length; i ++ ) diff |= a.charCodeAt( i ) ^ b.charCodeAt( i );
	return diff === 0;

}

const reply = ( body, cors ) => new Response( JSON.stringify( body ), { headers: { 'Content-Type': 'application/json', ...cors } } );

function text( status, message, headers = {} ) {

	return new Response( message + '\n', { status, headers: { 'Content-Type': 'text/plain', ...headers } } );

}
