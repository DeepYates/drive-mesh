// Tile proxy for the hosted build: the Cloudflare Worker counterpart of server.py's /tiles/.
//
//   GET /tiles/<path>  ->  <upstream tileset dir>/<path>
//
// The upstream URL carries the DeepWalk API key (the dw_live_... path segment), so it is a
// Worker *secret* (TILESET_URL, the full .../tileset.json URL) and never reaches the browser.
// ALLOWED_ORIGINS (wrangler.toml, comma-separated) is the list of sites allowed to use the
// proxy: a request must carry one of them as its Origin header. That stops other websites
// from embedding the tiles; it does not stop a script that fakes the header, so treat
// whatever this proxy serves as public.

const ROOT_TTL = 600;        // root tileset.json: re-fetched after 10 minutes, as in server.py
const TILE_TTL = 86400;      // everything else lives under a timestamped directory: immutable
const TYPES = { json: 'application/json', glb: 'model/gltf-binary' };

export default {

	async fetch( request, env, ctx ) {

		const origin = request.headers.get( 'Origin' );
		const allowed = ( env.ALLOWED_ORIGINS || '' ).split( ',' ).map( s => s.trim() ).filter( Boolean );
		if ( allowed.length && ! allowed.includes( origin ) ) return text( 403, 'origin not allowed' );
		const cors = {
			'Access-Control-Allow-Origin': allowed.length ? origin : '*',
			'Vary': 'Origin',
		};

		if ( request.method === 'OPTIONS' ) {

			return new Response( null, { status: 204, headers: {
				...cors, 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Max-Age': '86400',
			} } );

		}

		if ( request.method !== 'GET' && request.method !== 'HEAD' ) return text( 405, 'method not allowed', cors );

		const { pathname, origin: self } = new URL( request.url );
		if ( ! pathname.startsWith( '/tiles/' ) ) return text( 404, 'not found', cors );
		const rel = pathname.slice( '/tiles/'.length );
		// Tile paths are plain segments (20261111T211504Z/cell/0/1/2/L3/4_5.glb); refuse
		// anything else rather than forward it upstream.
		if ( ! /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/.test( rel ) || rel.split( '/' ).some( p => p === '.' || p === '..' ) ) {

			return text( 400, 'bad tile path', cors );

		}

		const root = env.TILESET_URL || '';
		if ( ! root.endsWith( '/tileset.json' ) ) return text( 500, 'TILESET_URL secret is not set', cors );

		// Edge cache, keyed by path only (no query string, no Origin). CORS headers are added
		// per request on the way out, so one cached copy serves every allowed origin.
		const cache = caches.default;
		const key = new Request( self + pathname );
		let res = await cache.match( key );
		if ( ! res ) {

			let upstream;
			try {

				upstream = await fetch( root.slice( 0, - 'tileset.json'.length ) + rel, {
					headers: { 'User-Agent': 'drive-mesh-game/0.1' },
				} );

			} catch {

				return text( 502, 'upstream fetch failed', cors );    // never echo the upstream URL

			}

			if ( ! upstream.ok ) return text( upstream.status, 'upstream error', cors );
			res = new Response( upstream.body, { headers: {
				'Content-Type': TYPES[ rel.split( '.' ).pop() ] || 'application/octet-stream',
				'Cache-Control': rel === 'tileset.json' ? `public, max-age=${ROOT_TTL}` : `public, max-age=${TILE_TTL}, immutable`,
			} } );
			ctx.waitUntil( cache.put( key, res.clone() ) );

		}

		const out = new Response( request.method === 'HEAD' ? null : res.body, res );
		for ( const [ k, v ] of Object.entries( cors ) ) out.headers.set( k, v );
		return out;

	},

};

function text( status, message, headers = {} ) {

	return new Response( message + '\n', { status, headers: { 'Content-Type': 'text/plain', ...headers } } );

}
