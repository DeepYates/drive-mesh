// Multiplayer client: sends this car's pose to the room (worker/src/room.js) and keeps a
// smoothed view of everyone else's. The server only relays, so there is nothing to agree on:
// each browser simulates its own car and draws the others where they say they are.
//
// Every failure ends in single-player, silently: no room URL, the room is full, the daily
// free allowance is used up, or the connection keeps dropping - the game just shows no peers.
import { Quaternion, Vector3 } from 'three';

const SEND_MS = 100;         // 10 poses a second while the car is moving
const IDLE_SEND_MS = 2000;   // a parked car still says where it is, for players who join later
const DELAY_MS = 150;        // peers are drawn this far in the past, between two real poses
const STALE_MS = 10000;      // a peer that has gone quiet (hidden tab, lost link) is not drawn. A parked car
                             // reports every 2 s, so this rides out several missed or late updates.
const MAX_FAILS = 3;         // consecutive failed connections before giving up for this page load
const DEAF_MS = 90000;       // sending but hearing nothing for this long = a dead connection: reconnect
const FLOATS = 10;           // pos xyz, quat xyzw, speed, steer, braking

export class Net {

	/** @param {string|null} url  wss://<worker>/room/<name>, or null for single-player */
	constructor( url ) {

		this.url = url;
		this.status = url ? 'idle' : 'off';      // off | idle | connecting | online | full
		this.id = 0;
		this.peers = new Map();                  // id -> [ { t, pos, quat, speed, steer, braking } ] oldest first
		this.names = new Map();                  // id -> { name, car } sent by that player (unverified)
		this.name = ''; this.car = '';
		this.ws = null;
		this.fails = 0;
		this.retryAt = 0;
		this.heardAt = 0;                        // when the server last said anything
		this.sentAt = 0;
		this.sent = new Float32Array( FLOATS );
		this.out = new Float32Array( FLOATS );

	}

	connect( now ) {

		if ( this.status === 'off' || this.status === 'full' || this.ws || now < this.retryAt ) return;
		this.status = 'connecting';
		let ws;
		try {

			ws = new WebSocket( this.url );

		} catch {

			return this.failed( now );

		}

		ws.binaryType = 'arraybuffer';
		this.ws = ws;
		ws.onmessage = e => this.receive( e.data );
		ws.onclose = e => {

			if ( this.ws !== ws ) return;
			const wasOnline = this.status === 'online';
			this.ws = null;
			this.peers.clear();
			this.retryAt = performance.now() + 1000;    // never reconnect in a tight loop
			if ( e.code === 4000 ) this.status = 'full';                       // play alone
			else if ( e.code === 4001 || wasOnline ) this.status = 'idle';     // idle-closed or dropped: reconnect on demand
			else this.failed( performance.now() );

		};

	}

	failed( now ) {

		this.ws = null;
		this.fails ++;
		this.status = this.fails >= MAX_FAILS ? 'off' : 'idle';
		this.retryAt = now + 1000 * 2 ** this.fails;

	}

	receive( data ) {

		this.heardAt = performance.now();
		if ( typeof data === 'string' ) {

			let m;
			try { m = JSON.parse( data ); } catch { return; }
			if ( m.t === 'hello' ) {

				this.id = m.id; this.status = 'online'; this.fails = 0; this.sentAt = 0;
				this.names = new Map( Object.entries( m.names ?? {} ).map( ( [ id, v ] ) => [ Number( id ), { name: String( v?.name ?? '' ), car: String( v?.car ?? '' ) } ] ) );
				this.sendName();

			}

			if ( m.t === 'name' ) this.names.set( m.id, { name: String( m.name ?? '' ), car: String( m.car ?? '' ) } );
			if ( m.t === 'leave' ) { this.peers.delete( m.id ); this.names.delete( m.id ); }
			return;

		}

		if ( data.byteLength !== 1 + FLOATS * 4 ) return;
		const id = new Uint8Array( data, 0, 1 )[ 0 ];
		const f = new Float32Array( data.slice( 1 ) );
		if ( id === this.id || ! f.every( Number.isFinite ) ) return;
		let snaps = this.peers.get( id );
		if ( ! snaps ) this.peers.set( id, snaps = [] );
		snaps.push( { t: performance.now(), pos: new Vector3( f[ 0 ], f[ 1 ], f[ 2 ] ),
			quat: new Quaternion( f[ 3 ], f[ 4 ], f[ 5 ], f[ 6 ] ).normalize(), speed: f[ 7 ], steer: f[ 8 ], braking: f[ 9 ] > 0.5 } );
		if ( snaps.length > 6 ) snaps.shift();

	}

	/** The label shown above this player's car ('' for none) and the car model they chose. */
	setName( name, car = this.car ) {

		this.name = name; this.car = car;
		this.sendName();

	}

	sendName() {

		if ( ( this.name || this.car ) && this.status === 'online' && this.ws?.readyState === 1 ) this.ws.send( JSON.stringify( { t: 'name', name: this.name, car: this.car } ) );

	}

	/** Call every driving frame; sends at most 10 poses a second, and only one every 2 s while parked. */
	send( car, braking, now ) {

		if ( this.status === 'off' || this.status === 'full' || document.hidden ) return;
		if ( ! this.ws ) return this.connect( now );
		if ( this.status !== 'online' || this.ws.readyState !== 1 ) return;
		// The room answers a sender with an "ok" every 30 s. Silence for much longer means the
		// connection is dead on the server's side (idle-swept while this tab was hidden, or a
		// lost link the browser has not noticed): drop it and reconnect on the next call.
		if ( now - this.heardAt > DEAF_MS ) {

			const dead = this.ws;
			this.ws = null; this.status = 'idle'; this.peers.clear();
			try { dead.close(); } catch { /* already gone */ }
			return;

		}

		const o = this.out, s = this.sent;
		o[ 0 ] = car.pos.x; o[ 1 ] = car.pos.y; o[ 2 ] = car.pos.z;
		o[ 3 ] = car.quat.x; o[ 4 ] = car.quat.y; o[ 5 ] = car.quat.z; o[ 6 ] = car.quat.w;
		o[ 7 ] = car.speed; o[ 8 ] = car.steer; o[ 9 ] = braking ? 1 : 0;
		const moved = Math.abs( o[ 0 ] - s[ 0 ] ) + Math.abs( o[ 1 ] - s[ 1 ] ) + Math.abs( o[ 2 ] - s[ 2 ] ) > 0.02 ||
			Math.abs( o[ 3 ] - s[ 3 ] ) + Math.abs( o[ 4 ] - s[ 4 ] ) + Math.abs( o[ 5 ] - s[ 5 ] ) + Math.abs( o[ 6 ] - s[ 6 ] ) > 0.002 ||
			o[ 9 ] !== s[ 9 ];
		if ( now - this.sentAt < ( moved ? SEND_MS : IDLE_SEND_MS ) ) return;
		this.sentAt = now;
		s.set( o );
		this.ws.send( o.slice().buffer );

	}

	/**
	 * Where to draw each peer now: interpolated between the two poses either side of
	 * (now - DELAY_MS), so motion is smooth even though poses arrive in uneven bursts.
	 * @returns {{ id, pos, quat, speed, steer, braking }[]}
	 */
	sample( now ) {

		const out = [], at = now - DELAY_MS;
		for ( const [ id, snaps ] of this.peers ) {

			const newest = snaps[ snaps.length - 1 ];
			if ( now - newest.t > STALE_MS ) { this.peers.delete( id ); continue; }
			let i = snaps.length - 1;
			while ( i > 0 && snaps[ i - 1 ].t > at ) i --;
			const b = snaps[ i ], a = snaps[ i - 1 ];
			const { name = '', car = '' } = this.names.get( id ) ?? {};
			if ( ! a || at >= b.t ) { out.push( { id, name, car, ...( at >= b.t ? newest : b ) } ); continue; }
			const k = Math.min( 1, Math.max( 0, ( at - a.t ) / ( b.t - a.t || 1 ) ) );
			out.push( { id, name, car, pos: a.pos.clone().lerp( b.pos, k ), quat: a.quat.clone().slerp( b.quat, k ),
				speed: a.speed + ( b.speed - a.speed ) * k, steer: a.steer + ( b.steer - a.steer ) * k, braking: b.braking } );

		}

		return out;

	}

}
