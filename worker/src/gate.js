// Admission gate + daily numbers. One instance for the whole site (idFromName('gate')).
//
// The demo runs on the Workers Free plan, sized for DAILY_USERS visitors a day (50): each
// visitor may use up to 2,000 tile requests and the plan allows 100,000 a day. This object
// counts admissions per UTC day and says "busy" past the limit, so the allowance runs out
// gracefully (a branded page) instead of abruptly (broken tiles). It is called once per new
// visitor and once per ~100 tile requests, never per tile - its own allowance is 100,000 too.
//
//   POST /enter  { mesh }                 -> { ok, admitted, limit }
//   POST /count  { mesh, hit, miss, missBytes }   tile-cache counters, batched by index.js
//   GET  /stats?days=7                    -> per-day totals, newest first
//
// Stored per day under `day:<YYYY-MM-DD>`: no visitor data, only counts.
import { DurableObject } from 'cloudflare:workers';

const today = () => new Date().toISOString().slice( 0, 10 );
const blank = () => ( { admitted: 0, busy: 0, tiles: { hit: 0, miss: 0, missBytes: 0 }, meshes: {} } );
const json = ( body, status = 200 ) => new Response( JSON.stringify( body ), { status, headers: { 'Content-Type': 'application/json' } } );

export class Gate extends DurableObject {

	async fetch( request ) {

		const { pathname, searchParams } = new URL( request.url );

		if ( pathname === '/stats' ) {

			const days = Math.min( 60, Math.max( 1, Number( searchParams.get( 'days' ) ) || 7 ) );
			const all = await this.ctx.storage.list( { prefix: 'day:', reverse: true, limit: days } );
			return json( { limit: this.limit(), days: [ ...all ].map( ( [ k, v ] ) => ( { day: k.slice( 4 ), ...v } ) ) } );

		}

		if ( request.method !== 'POST' ) return json( { error: 'not found' }, 404 );
		const body = await request.json().catch( () => ( {} ) );
		const mesh = /^[a-z0-9-]{1,40}$/.test( body.mesh ?? '' ) ? body.mesh : 'unknown';
		const key = 'day:' + today();
		const d = ( await this.ctx.storage.get( key ) ) ?? blank();
		const m = d.meshes[ mesh ] ??= { admitted: 0, busy: 0 };

		if ( pathname === '/enter' ) {

			const ok = d.admitted < this.limit();
			if ( ok ) { d.admitted ++; m.admitted ++; } else { d.busy ++; m.busy ++; }
			await this.ctx.storage.put( key, d );
			return json( { ok, admitted: d.admitted, limit: this.limit() } );

		}

		if ( pathname === '/count' ) {

			const n = v => Math.max( 0, Math.min( 1e9, Math.round( Number( v ) || 0 ) ) );
			d.tiles.hit += n( body.hit ); d.tiles.miss += n( body.miss ); d.tiles.missBytes += n( body.missBytes );
			await this.ctx.storage.put( key, d );
			return json( { ok: true } );

		}

		return json( { error: 'not found' }, 404 );

	}

	limit() {

		return Math.max( 0, Number( this.env.DAILY_USERS ) || 50 );

	}

}
