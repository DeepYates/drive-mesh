// Multiplayer room: a relay, not a game server. Each browser simulates its own car and sends
// its pose; this forwards it to everyone else in the room. No physics runs here.
//
// Protocol
//   client -> server   binary, exactly POSE_BYTES: Float32 x10 (pos xyz, quat xyzw, speed, steer, braking)
//   server -> client   binary, 1 + POSE_BYTES: sender id (Uint8) then the pose, unchanged
//   client -> server   text JSON {t:'name', name, car}: the label above this player's car and their car model
//   server -> client   text JSON: {t:'hello', id, peers:[id], names:{id:{name, car}}} on connect,
//                      {t:'join', id}, {t:'leave', id}, {t:'name', id, name, car}, {t:'ok'} (liveness)
//   close codes        4000 room full · 4001 idle · 4002 flooding · 4003 bad message
//
// Everything here exists to protect the free plan's daily allowance (20 incoming messages
// are billed as one request, and an awake object is billed for its time):
//   - WebSocket Hibernation API: an empty or quiet room is evicted from memory and costs nothing.
//   - MAX_PLAYERS per room; a fixed message size; a per-socket rate limit that closes floods.
//   - An idle sweep (alarm) closes sockets that have not sent a pose for IDLE_SECONDS - a hidden
//     tab stops sending, so a forgotten tab drops off instead of holding the room open.
import { DurableObject } from 'cloudflare:workers';

const POSE_BYTES = 40;
const RATE = 15, BURST = 30;       // messages per second allowed per socket, and the bucket size
const MAX_DROPS = 50;              // dropped messages before a flooding socket is closed
const IDLE_SECONDS = 300;          // default; the IDLE_SECONDS var overrides it (tests use a few seconds)

const NAME_MAX = 64;
// control, format (zero-width, bidi overrides) and line/paragraph separator characters are removed
const cleanName = s => s.replace( /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '' ).trim().slice( 0, NAME_MAX );

export class Room extends DurableObject {

	constructor( ctx, env ) {

		super( ctx, env );
		// Rate-limit buckets live in memory only: hibernation (which needs ~10 s of silence)
		// resets them, and a reset bucket is a full one, so nothing is lost by that.
		this.buckets = new Map();
		this.gone = new WeakSet();
		this.idleMs = 1000 * ( Number( env.IDLE_SECONDS ) || IDLE_SECONDS );
		this.sweepMs = Math.min( 60_000, this.idleMs / 2 );

	}

	async fetch() {

		const pair = new WebSocketPair();
		const [ client, server ] = Object.values( pair );
		const sockets = this.ctx.getWebSockets();
		const others = sockets.filter( ws => ! this.gone.has( ws ) ).map( ws => ws.deserializeAttachment() ).filter( Boolean );
		const used = new Set( others.map( a => a.id ) );
		const max = Math.min( 255, Number( this.env.MAX_PLAYERS ) || 8 );
		if ( sockets.length >= max ) {

			// Accept and close with a code, so the page can tell "full" from "unreachable".
			server.accept();
			server.close( 4000, 'room full' );
			return new Response( null, { status: 101, webSocket: client } );

		}

		let id = 1;
		while ( used.has( id ) ) id ++;
		this.ctx.acceptWebSocket( server );
		server.serializeAttachment( { id, seen: Date.now() } );
		server.send( JSON.stringify( { t: 'hello', id, peers: [ ...used ],
			names: Object.fromEntries( others.filter( a => a.name || a.car ).map( a => [ a.id, { name: a.name ?? '', car: a.car ?? '' } ] ) ) } ) );
		this.broadcast( JSON.stringify( { t: 'join', id } ), server );
		if ( await this.ctx.storage.getAlarm() === null ) await this.ctx.storage.setAlarm( Date.now() + this.sweepMs );
		return new Response( null, { status: 101, webSocket: client } );

	}

	webSocketMessage( ws, message ) {

		const isText = typeof message === 'string';
		if ( isText ? message.length > 200 : message.byteLength !== POSE_BYTES ) return this.drop( ws, 4003, 'bad message' );

		const now = Date.now();
		let b = this.buckets.get( ws );
		if ( ! b ) this.buckets.set( ws, b = { tokens: BURST, at: now, drops: 0 } );
		b.tokens = Math.min( BURST, b.tokens + ( now - b.at ) * RATE / 1000 );
		b.at = now;
		if ( b.tokens < 1 ) {

			if ( ++ b.drops > MAX_DROPS ) this.drop( ws, 4002, 'flooding' );
			return;

		}

		b.tokens --;

		const state = ws.deserializeAttachment();

		if ( isText ) {

			// The only text message: the label a player wants shown above their car. It is
			// whatever they typed - unverified - so it is length-capped, stripped of control
			// characters, kept only in this socket's attachment (never written to storage),
			// and the page draws it as canvas text, not HTML.
			let m;
			try { m = JSON.parse( message ); } catch { return this.drop( ws, 4003, 'bad message' ); }
			if ( m?.t !== 'name' || typeof m.name !== 'string' ) return this.drop( ws, 4003, 'bad message' );
			const name = cleanName( m.name );
			const car = typeof m.car === 'string' && /^[a-z0-9-]{1,24}$/.test( m.car ) ? m.car : '';    // a model id, nothing else
			ws.serializeAttachment( { ...state, name, car } );
			this.broadcast( JSON.stringify( { t: 'name', id: state.id, name, car } ), ws );
			return;

		}

		// Last-seen is written a few times per idle window, not on every pose. Each time, the
		// sender gets an "ok" (outgoing messages are free): a page that keeps sending but hears
		// nothing for 90 s knows its connection is dead and reconnects (see net.js). That
		// matters because a close sent from alarm() does not reliably reach the browser.
		if ( now - state.seen > this.idleMs / 10 ) {

			ws.serializeAttachment( { ...state, seen: now } );
			try { ws.send( '{"t":"ok"}' ); } catch { /* closing */ }

		}

		const out = new Uint8Array( 1 + POSE_BYTES );
		out[ 0 ] = state.id;
		out.set( new Uint8Array( message ), 1 );
		this.broadcast( out, ws );

	}

	webSocketClose( ws ) {

		this.left( ws );

	}

	webSocketError( ws ) {

		this.left( ws );

	}

	async alarm() {

		const now = Date.now();
		for ( const ws of this.ctx.getWebSockets() ) {

			if ( now - ( ws.deserializeAttachment()?.seen ?? 0 ) > this.idleMs ) this.drop( ws, 4001, 'idle' );

		}

		// keep sweeping only while someone is connected; an empty room schedules nothing
		if ( this.ctx.getWebSockets().length ) await this.ctx.storage.setAlarm( now + this.sweepMs );

	}

	drop( ws, code, reason ) {

		try { ws.close( code, reason ); } catch { /* already closed */ }
		this.left( ws );

	}

	left( ws ) {

		if ( this.gone.has( ws ) ) return;    // close + error + drop can all report the same socket
		this.gone.add( ws );
		this.buckets.delete( ws );
		const id = ws.deserializeAttachment()?.id;
		if ( id !== undefined ) this.broadcast( JSON.stringify( { t: 'leave', id } ), ws );

	}

	broadcast( data, except ) {

		for ( const ws of this.ctx.getWebSockets() ) {

			if ( ws === except || this.gone.has( ws ) ) continue;
			try { ws.send( data ); } catch { /* closing */ }

		}

	}

}
