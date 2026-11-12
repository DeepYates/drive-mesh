// The start screen: what the demo is, which mesh to drive, and the lead gate.
//
// start() resolves { mesh, site, name, car } once the visitor may drive. It never resolves when
// the day's admissions are used up (or the Worker is down): the "at capacity" page stays up.
// The sequence for a new visitor is  form -> POST /enter -> HubSpot -> drive | at capacity,
// so the lead reaches HubSpot either way, tagged with what happened.
//
// The gate is on when the site config names a HubSpot form (meshes.json: site.hubspot.formGuid).
// Without one, only an optional display name is asked for - there would be nowhere to send
// an email. It runs in the browser, so someone determined can step around it; it is a prompt
// for interested people, not access control.
import { alreadySent, flushQueue, forgetLead, markSent, savedLead, saveLead, sendLead } from './lead.js';
import { CARS, DEFAULT_CAR, isCar } from './cars.js';

const PASS_KEY = 'driveMeshPass', NAME_KEY = 'driveMeshName', CAR_KEY = 'driveMeshCar';
const $ = id => document.getElementById( id );
const get = key => { try { return localStorage.getItem( key ) ?? ''; } catch { return ''; } };
const set = ( key, value ) => { try { localStorage.setItem( key, value ); } catch { /* private window */ } };
const tidy = ( s, n ) => String( s ?? '' ).replace( /\s+/g, ' ' ).trim().slice( 0, n );

/** Ask the Worker for one of today's places. No Worker (local server.py) = always admitted. */
async function admit( api, mesh ) {

	if ( ! api ) return { ok: true };
	try {

		const res = await fetch( new URL( 'enter', api ), { method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify( { mesh, pass: get( PASS_KEY ) || undefined } ) } );
		if ( ! res.ok ) return { ok: false, reason: 'unreachable' };
		const r = await res.json();
		if ( r.pass ) set( PASS_KEY, r.pass );
		return r.ok ? r : { ...r, reason: 'full' };      // the day's places are taken

	} catch {

		return { ok: false, reason: 'unreachable' };      // the free plan's daily stop looks like this, and so does a dropped connection

	}

}

/** When the daily limits reset (00:00 UTC), in the visitor's own time: "today at 6:00 PM". */
export function resetWhen() {

	const now = new Date(), reset = new Date( Date.UTC( now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1 ) );
	const time = reset.toLocaleTimeString( [], { hour: 'numeric', minute: '2-digit' } );
	return `${reset.toDateString() === now.toDateString() ? 'today' : 'tomorrow'} at ${time}`;

}

/**
 * A full-page notice in place of the start screen, for when the visitor cannot drive:
 *   'full'         today's visitor places are taken
 *   'unreachable'  the demo's server did not answer
 *   'tiles'        this visitor has used their own daily allowance of mesh
 *   'mesh'         the game started but the mesh is not arriving
 * Each says what happened, when it resets and what to do next.
 */
export function showNotice( site, kind, { hasEmail = false, limit = 0 } = {} ) {

	const when = resetWhen();
	const text = {
		full: [ 'Today\u2019s demo drives are all taken',
			`To keep this demo free we run ${limit || 'a limited number of'} drives a day, and today\u2019s have all been used. New drives open ${when} (your time).${hasEmail ? ' We have your email and will follow up.' : ''}` ],
		unreachable: [ 'The demo can\u2019t be reached right now',
			`We couldn\u2019t connect to the demo\u2019s server. It may have used up its free allowance for the day, which resets ${when} (your time), or your connection may have dropped. Try again in a moment.` ],
		tiles: [ 'You\u2019ve used today\u2019s driving allowance',
			`Each visitor can load a set amount of 3D mesh per day, and you have reached it. Your allowance resets ${when} (your time). Want a longer look? We would be glad to walk you through it.` ],
		mesh: [ 'The mesh isn\u2019t loading',
			`The demo started, but the 3D mesh did not arrive. The demo may have used up its free allowance for the day, which resets ${when} (your time), or something on your network may be blocking it. Try again in a moment.` ],
	}[ kind ];
	$( 'startTitle' ).textContent = text[ 0 ];
	$( 'startPitch' ).textContent = text[ 1 ];
	for ( const id of [ 'meshes', 'cars', 'carsTitle', 'gate' ] ) $( id ).hidden = true;
	const cta = $( 'busyCta' ), retry = $( 'busyRetry' );
	cta.textContent = site.ctaLabel || 'Talk to DeepWalk'; cta.href = site.ctaUrl || '#'; cta.hidden = ! site.ctaUrl;
	retry.hidden = kind !== 'unreachable' && kind !== 'mesh';
	retry.onclick = () => location.reload();
	$( 'startBusy' ).hidden = false;
	const box = $( 'start' );
	box.dataset.notice = kind;
	box.hidden = false;
	$( 'overlay' ).classList.add( 'hidden' );

}

/**
 * HubSpot's own embedded form, rendered into #hsForm. Resolves with the submitted values
 * once HubSpot reports the submission went through; rejects if its script is blocked or the
 * form never appears (the caller then falls back to this page's own fields). HubSpot's
 * script reports progress as window messages of type 'hsFormCallback'.
 */
function hubspotForm( hs, onReady ) {

	return new Promise( ( resolve, reject ) => {

		let ready = false;
		const values = {};
		const timer = setTimeout( () => { if ( ! ready ) reject( new Error( 'the HubSpot form did not load' ) ); }, 8000 );
		addEventListener( 'message', e => {

			const d = e.data;
			if ( ! d || d.type !== 'hsFormCallback' || d.id !== hs.formGuid ) return;
			if ( d.eventName === 'onFormReady' && ! ready ) { ready = true; clearTimeout( timer ); onReady(); }
			if ( d.eventName === 'onFormSubmit' && Array.isArray( d.data ) ) for ( const f of d.data ) values[ f.name ] = f.value;
			if ( d.eventName === 'onFormSubmitted' ) resolve( { ...values, ...( d.data?.submissionValues ?? {} ) } );

		} );
		const script = document.createElement( 'script' );
		script.src = 'https://js.hsforms.net/forms/embed/v2.js'; script.charset = 'utf-8';
		script.onerror = () => { clearTimeout( timer ); reject( new Error( 'the HubSpot form script was blocked' ) ); };
		script.onload = () => {

			try {

				window.hbspt.forms.create( { portalId: hs.portalId, formId: hs.formGuid, region: hs.region || 'na1', target: '#hsForm' } );

			} catch ( err ) {

				clearTimeout( timer ); reject( err );

			}

		};
		document.head.append( script );

	} );

}

export async function start( { params, asset, api } ) {

	const cfg = await fetch( asset( './meshes.json' ) ).then( r => r.ok ? r.json() : Promise.reject( new Error( `meshes.json ${r.status}` ) ) );
	const site = cfg.site ?? {}, meshes = cfg.meshes ?? [];
	if ( ! meshes.length ) throw new Error( 'no meshes are configured' );
	// An unlisted mesh ("unlisted": true) is never offered: not in the gallery, not as the
	// default. It loads only for a link that names it (?mesh=<id>). That keeps it off the
	// site, not secret - its id is in this public file.
	const listed = meshes.filter( m => ! m.unlisted );
	const byId = id => meshes.find( m => m.id === id );
	let mesh = byId( params.get( 'mesh' ) ) ?? null;
	if ( ! mesh && ! listed.length ) throw new Error( 'no mesh is available without a link' );

	// The test scripts drive an automated browser: nobody to ask, nothing to send, no place taken.
	if ( navigator.webdriver ) return { mesh: mesh ?? listed[ 0 ], site, meshCount: listed.length, name: tidy( params.get( 'name' ), 40 ),
		car: isCar( params.get( 'car' ) ) ? params.get( 'car' ) : DEFAULT_CAR };

	const gateOn = !! site.hubspot?.formGuid;
	flushQueue( site, api );
	let lead = gateOn ? savedLead() : null;
	let car = isCar( get( CAR_KEY ) ) ? get( CAR_KEY ) : DEFAULT_CAR;
	const chosen = mesh ?? ( listed.length === 1 ? listed[ 0 ] : null );

	return new Promise( resolve => {

		const box = $( 'start' ), form = $( 'gate' ), error = $( 'gateError' ), button = $( 'gateGo' );
		const fields = { email: $( 'gateEmail' ), name: $( 'gateName' ), company: $( 'gateCompany' ) };

		const busy = adm => showNotice( site, adm.reason || 'full', { hasEmail: gateOn && !! lead, limit: adm.limit } );

		/** admission, then the lead, then in (or the capacity page) */
		const enter = async candidate => {

			const adm = await admit( api, mesh.id );
			if ( gateOn && ! alreadySent( candidate, mesh.id ) ) {

				const sent = await sendLead( site, api, candidate, mesh.id, adm.ok ? 'played' : 'at_capacity' );
				if ( sent.refused ) return 'refused';

			}

			if ( gateOn ) saveLead( lead = candidate );
			if ( ! adm.ok ) { busy( adm ); return 'busy'; }
			const name = gateOn ? candidate.name : candidate.name || '';
			set( NAME_KEY, name ); set( CAR_KEY, car );
			const u = new URL( location.href );
			u.searchParams.set( 'mesh', mesh.id ); u.searchParams.delete( 'pick' );
			history.replaceState( null, '', u );       // the address now names the mesh, so it can be shared
			box.hidden = true;
			resolve( { mesh, site, meshCount: listed.length, name, car } );
			return 'in';

		};

		// Known visitor on a link that names the mesh (or a one-mesh site): no screen at all -
		// unless they asked for it (`?pick=1`, the bar's "Change car" link).
		if ( chosen && ! params.has( 'pick' ) && ( lead || ! gateOn && get( NAME_KEY ) ) ) {

			mesh = chosen;
			enter( lead ?? { name: get( NAME_KEY ) } );
			return;

		}

		// ----- the screen
		$( 'startTitle' ).textContent = site.title || 'Drive the mesh';
		$( 'startPitch' ).textContent = site.pitch || '';
		const list = $( 'meshes' );
		list.hidden = listed.length < 2 || !! mesh?.unlisted;      // a link to an unlisted mesh goes to that mesh, no choosing
		const pick = m => {

			mesh = m;
			for ( const el of list.children ) el.setAttribute( 'aria-checked', String( el.dataset.id === m.id ) );

		};

		for ( const m of listed ) {

			const card = document.createElement( 'button' );
			card.type = 'button'; card.className = 'mesh'; card.dataset.id = m.id; card.setAttribute( 'role', 'radio' );
			if ( m.thumb ) { const img = new Image(); img.src = asset( './' + m.thumb ); img.alt = ''; img.loading = 'lazy'; card.append( img ); }
			for ( const [ cls, text ] of [ [ 'provider', m.provider ], [ 'title', m.title ], [ 'place', m.place ], [ 'blurb', m.blurb ] ] ) {

				if ( ! text ) continue;
				const el = document.createElement( 'span' );
				el.className = cls; el.textContent = text;
				card.append( el );

			}

			card.addEventListener( 'click', () => pick( m ) );
			list.append( card );

		}

		pick( chosen ?? listed[ 0 ] );

		// the car picker
		const garage = $( 'cars' );
		const choose = id => {

			car = id;
			for ( const el of garage.children ) el.setAttribute( 'aria-checked', String( el.dataset.id === id ) );

		};

		for ( const c of CARS ) {

			const el = document.createElement( 'button' );
			el.type = 'button'; el.className = 'car'; el.dataset.id = c.id; el.setAttribute( 'role', 'radio' );
			const img = new Image(); img.src = asset( `./cars/${c.id}.png` ); img.alt = ''; img.width = 240; img.height = 150;
			const label = document.createElement( 'span' ); label.textContent = c.label;
			el.append( img, label );
			el.addEventListener( 'click', () => choose( c.id ) );
			garage.append( el );

		}

		choose( car );

		// Returning lead choosing another mesh: no fields, just who they are and a way to change it.
		const known = $( 'gateKnown' );
		const showFields = on => {

			fields.email.parentElement.hidden = ! ( on && gateOn );
			fields.company.parentElement.hidden = ! ( on && gateOn );
			fields.name.parentElement.hidden = ! on;
			known.hidden = on;
			$( 'gateNote' ).hidden = ! ( on && gateOn );

		};

		// The email step is HubSpot's own embedded form. This page's email and company fields
		// and its Drive button stay hidden while it loads, and come back only if it cannot
		// load (script blocked): then the lead goes through sendLead instead.
		let embedStarted = false;
		const useEmbed = () => {

			if ( ! gateOn || lead || site.hubspot.embed === false || embedStarted ) return false;
			embedStarted = true;
			const slot = $( 'hsForm' ), waiting = $( 'hsWait' );
			const own = on => { fields.email.parentElement.hidden = fields.company.parentElement.hidden = button.hidden = ! on; fields.email.required = fields.name.required = on; };
			own( false ); slot.hidden = false; waiting.hidden = false;
			hubspotForm( site.hubspot, () => { waiting.hidden = true; } ).then( async values => {

				// a first name on the HubSpot form, if it has that field, is the name on the car
				const candidate = { email: tidy( values.email, 120 ).toLowerCase(), name: tidy( values.firstname || fields.name.value, 40 ) || 'Guest', company: tidy( values.company, 80 ) };
				if ( candidate.email ) markSent( candidate, mesh.id );      // HubSpot has it: do not send it again
				slot.hidden = true;
				if ( await enter( candidate ) === 'in' ) $( 'overlay' ).classList.remove( 'hidden' );

			} ).catch( () => { slot.hidden = waiting.hidden = true; own( true ); } );
			return true;

		};

		fields.email.required = fields.name.required = gateOn;
		fields.name.value = get( NAME_KEY );
		if ( lead ) { $( 'gateWho' ).textContent = lead.name; showFields( false ); } else { showFields( true ); useEmbed(); }
		$( 'gateNotMe' ).addEventListener( 'click', () => { forgetLead(); lead = null; showFields( true ); if ( ! useEmbed() ) fields.email.focus(); } );
		if ( site.privacyUrl ) { $( 'gatePrivacy' ).href = site.privacyUrl; $( 'gatePrivacy' ).hidden = false; }

		box.hidden = false;
		$( 'overlay' ).classList.add( 'hidden' );
		if ( ! lead ) ( gateOn && ! embedStarted ? fields.email : fields.name ).focus( { preventScroll: true } );

		form.addEventListener( 'submit', async e => {

			e.preventDefault();
			error.textContent = '';
			const candidate = lead ?? { email: tidy( fields.email.value, 120 ).toLowerCase(), name: tidy( fields.name.value, 40 ), company: tidy( fields.company.value, 80 ) };
			if ( gateOn && ! /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test( candidate.email ) ) { error.textContent = 'Enter a work email address so we can follow up.'; fields.email.focus(); return; }
			if ( gateOn && ! candidate.name ) { error.textContent = 'Enter the name to show above your car.'; fields.name.focus(); return; }
			button.disabled = true; button.textContent = 'Starting…';
			const outcome = await enter( candidate );
			button.disabled = false; button.textContent = 'Drive';
			if ( outcome === 'refused' ) { error.textContent = 'That email address was not accepted. Check it and try again.'; fields.email.focus(); }
			if ( outcome === 'in' ) $( 'overlay' ).classList.remove( 'hidden' );

		} );

	} );

}
