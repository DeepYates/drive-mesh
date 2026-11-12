// Abuse checks for the multiplayer room and the tile proxy (worker/). Run against
// `npx wrangler dev` (default) or the deployed Worker:
//   node test/limits.mjs [worker url] [allowed origin]
const WORKER = ( process.argv[ 2 ] || 'http://127.0.0.1:8787' ).replace( /\/$/, '' );
const ORIGIN = process.argv[ 3 ] || 'http://127.0.0.1:8600';
const WS = WORKER.replace( /^http/, 'ws' );
const room = 'limits' + Math.random().toString( 36 ).slice( 2, 8 );
const sleep = ms => new Promise( r => setTimeout( r, ms ) );
let failed = false;
const check = ( ok, label, detail = '' ) => { console.log( ok ? 'PASS' : 'FAIL', label, detail ); if ( ! ok ) failed = true; };

/** Open a socket and record everything it receives. */
function open( name = room, origin = ORIGIN ) {

	const ws = new WebSocket( `${WS}/room/${name}`, { headers: { Origin: origin } } );
	ws.binaryType = 'arraybuffer';
	const s = { ws, text: [], binary: [], closed: null, hello: null };
	ws.onmessage = e => {

		if ( typeof e.data === 'string' ) { const m = JSON.parse( e.data ); s.text.push( m ); if ( m.t === 'hello' ) s.hello = m; } else s.binary.push( e.data );

	};
	ws.onclose = e => { s.closed = e.code; };
	ws.onerror = () => { s.closed ??= - 1; };
	return s;

}

const until = async ( fn, ms = 5000 ) => { const t = Date.now(); while ( Date.now() - t < ms ) { if ( fn() ) return true; await sleep( 25 ); } return false; };
const status = async ( path, headers ) => ( await fetch( WORKER + path, { headers } ) ).status;
const pose = () => new Float32Array( 10 ).fill( 1 ).buffer;

// --- HTTP-level refusals
check( await status( `/room/${room}`, { Origin: 'https://evil.example' } ) === 403, 'wrong origin refused (403)' );
check( await status( `/room/${room}`, {} ) === 403, 'missing origin refused (403)' );
check( await status( '/room/Bad_Name!', { Origin: ORIGIN } ) === 400, 'bad room name refused (400)' );
check( await status( `/room/${'x'.repeat( 41 )}`, { Origin: ORIGIN } ) === 400, 'over-long room name refused (400)' );
check( await status( `/room/${room}`, { Origin: ORIGIN } ) === 426, 'plain GET (no websocket) refused (426)' );
check( await status( '/tiles/..%2f..%2finfo', { Origin: ORIGIN } ) === 400, 'tile path traversal refused (400)' );

// --- relay + names
const a = open(), b = ( await until( () => a.hello ), open() );
await until( () => b.hello );
check( a.hello?.id === 1 && b.hello?.id === 2 && b.hello.peers.includes( 1 ), 'two sockets get ids 1 and 2', JSON.stringify( b.hello ) );
a.ws.send( pose() );
await until( () => b.binary.length );
check( b.binary[ 0 ]?.byteLength === 41 && new Uint8Array( b.binary[ 0 ] )[ 0 ] === 1, 'pose relayed with the sender id in front', `${b.binary[ 0 ]?.byteLength} bytes` );
check( a.binary.length === 0, 'sender does not get its own pose back' );
a.ws.send( JSON.stringify( { t: 'name', name: '  ev\u0007il‮@x.dev' + 'y'.repeat( 100 ), car: '../../etc' } ) );
await until( () => b.text.some( m => m.t === 'name' ) );
const nm = b.text.find( m => m.t === 'name' )?.name ?? '';
check( nm.length === 64 && nm.startsWith( 'evil@x.dev' ), 'name is trimmed, stripped of control/bidi characters and capped at 64', JSON.stringify( nm.slice( 0, 14 ) ) );
check( b.text.find( m => m.t === 'name' )?.car === '', 'a car id that is not a plain model name is dropped' );
const c = open(); await until( () => c.hello );
check( c.hello?.names?.[ 1 ]?.name === nm, 'a later joiner is told existing names' );

// --- bad messages close the socket
c.ws.send( new ArrayBuffer( 4096 ) ); await until( () => c.closed );
check( c.closed === 4003, 'oversized message -> closed 4003', String( c.closed ) );
const d = open(); await until( () => d.hello );
d.ws.send( 'hello there' ); await until( () => d.closed );
check( d.closed === 4003, 'malformed text -> closed 4003', String( d.closed ) );
await until( () => b.text.filter( m => m.t === 'leave' ).length >= 2 );
check( b.text.filter( m => m.t === 'leave' ).length >= 2, 'others are told when a socket is dropped' );

// --- flood: far more than 15 msg/s
const before = b.binary.length;
for ( let i = 0; i < 400; i ++ ) if ( a.ws.readyState === 1 ) a.ws.send( pose() );
await until( () => a.closed, 8000 );
check( a.closed === 4002, 'flood -> closed 4002', String( a.closed ) );
// allowance = the 30-message burst plus 15/s for as long as the flood lasted before the close
check( b.binary.length - before <= 100, 'flood was cut off (only the rate allowance was relayed)', `${b.binary.length - before} of 400 forwarded` );

// --- room cap (MAX_PLAYERS = 8): b is in; add 7 more to fill it, the next must be refused
await sleep( 300 );
const fill = Array.from( { length: 7 }, () => open() );
await until( () => fill.every( s => s.hello ) );
check( fill.every( s => s.hello ), 'room fills to 8 players', `ids ${fill.map( s => s.hello?.id ).join( ',' )}` );
const ninth = open(); await until( () => ninth.closed );
check( ninth.closed === 4000 && ! ninth.hello, '9th player -> closed 4000 (room full)', String( ninth.closed ) );
const other = open( room + 'b' ); await until( () => other.hello );
check( other.hello?.id === 1, 'a different room is unaffected' );

// --- idle sweep: only when the Worker runs with a short IDLE_SECONDS (pass --idle=<seconds>)
const idle = Number( ( process.argv.find( v => v.startsWith( '--idle=' ) ) || '' ).slice( 7 ) );
if ( idle ) {

	const busy = setInterval( () => other.ws.readyState === 1 && other.ws.send( pose() ), 500 );    // `other` keeps driving
	// `b` sends nothing. The room drops it; `fill[0]` (same room) is told it left. The close
	// itself is not asserted on `b`: a close sent from alarm() does not reliably reach the client.
	const leaves = () => fill[ 0 ].text.filter( m => m.t === 'leave' && m.id === b.hello.id ).length;
	await until( () => leaves() > 0, idle * 3000 );
	clearInterval( busy );
	check( leaves() > 0, `silent socket is dropped by the room after ~${idle} s` );
	check( other.closed === null && other.text.some( m => m.t === 'ok' ), 'a socket that keeps sending stays connected and gets liveness oks' );

}

for ( const s of [ b, other, ...fill ] ) s.ws.close();
await sleep( 300 );
process.exit( failed ? 1 : 0 );
