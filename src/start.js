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
import { alreadySent, flushQueue, forgetLead, savedLead, saveLead, sendLead } from './lead.js';
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
		if ( ! res.ok ) return { ok: false };
		const r = await res.json();
		if ( r.pass ) set( PASS_KEY, r.pass );
		return r;

	} catch {

		return { ok: false };      // unreachable: the free plan's daily stop looks like this

	}

}

export async function start( { params, asset, api } ) {

	const cfg = await fetch( asset( './meshes.json' ) ).then( r => r.ok ? r.json() : Promise.reject( new Error( `meshes.json ${r.status}` ) ) );
	const site = cfg.site ?? {}, meshes = cfg.meshes ?? [];
	if ( ! meshes.length ) throw new Error( 'no meshes are configured' );
	const byId = id => meshes.find( m => m.id === id );
	let mesh = byId( params.get( 'mesh' ) ) ?? null;

	// The test scripts drive an automated browser: nobody to ask, nothing to send, no place taken.
	if ( navigator.webdriver ) return { mesh: mesh ?? meshes[ 0 ], site, meshCount: meshes.length, name: tidy( params.get( 'name' ), 40 ),
		car: isCar( params.get( 'car' ) ) ? params.get( 'car' ) : DEFAULT_CAR };

	const gateOn = !! site.hubspot?.formGuid;
	flushQueue( site, api );
	let lead = gateOn ? savedLead() : null;
	let car = isCar( get( CAR_KEY ) ) ? get( CAR_KEY ) : DEFAULT_CAR;
	const chosen = mesh ?? ( meshes.length === 1 ? meshes[ 0 ] : null );

	return new Promise( resolve => {

		const box = $( 'start' ), form = $( 'gate' ), error = $( 'gateError' ), button = $( 'gateGo' );
		const fields = { email: $( 'gateEmail' ), name: $( 'gateName' ), company: $( 'gateCompany' ) };

		const busy = () => {

			$( 'startTitle' ).textContent = 'Today’s demo is at capacity';
			$( 'startPitch' ).textContent = lead || ! gateOn
				? 'We only run a limited number of drives a day. Come back tomorrow, or talk to us now and we will show you the meshes ourselves.'
				: 'We only run a limited number of drives a day. Come back tomorrow, or talk to us now.';
			$( 'meshes' ).hidden = form.hidden = true;
			const cta = $( 'busyCta' );
			cta.textContent = site.ctaLabel || 'Talk to DeepWalk'; cta.href = site.ctaUrl || '#';
			$( 'startBusy' ).hidden = ! site.ctaUrl;
			box.hidden = false;
			$( 'overlay' ).classList.add( 'hidden' );

		};

		/** admission, then the lead, then in (or the capacity page) */
		const enter = async candidate => {

			const adm = await admit( api, mesh.id );
			if ( gateOn && ! alreadySent( candidate, mesh.id ) ) {

				const sent = await sendLead( site, api, candidate, mesh.id, adm.ok ? 'played' : 'at_capacity' );
				if ( sent.refused ) return 'refused';

			}

			if ( gateOn ) saveLead( lead = candidate );
			if ( ! adm.ok ) { busy(); return 'busy'; }
			const name = gateOn ? candidate.name : candidate.name || '';
			set( NAME_KEY, name ); set( CAR_KEY, car );
			const u = new URL( location.href );
			u.searchParams.set( 'mesh', mesh.id ); u.searchParams.delete( 'pick' );
			history.replaceState( null, '', u );       // the address now names the mesh, so it can be shared
			box.hidden = true;
			resolve( { mesh, site, meshCount: meshes.length, name, car } );
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
		list.hidden = meshes.length < 2;
		const pick = m => {

			mesh = m;
			for ( const el of list.children ) el.setAttribute( 'aria-checked', String( el.dataset.id === m.id ) );

		};

		for ( const m of meshes ) {

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

		pick( chosen ?? meshes[ 0 ] );

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

		fields.email.required = fields.name.required = gateOn;
		fields.name.value = get( NAME_KEY );
		if ( lead ) { $( 'gateWho' ).textContent = lead.name; showFields( false ); } else showFields( true );
		$( 'gateNotMe' ).addEventListener( 'click', () => { forgetLead(); lead = null; showFields( true ); fields.email.focus(); } );
		if ( site.privacyUrl ) { $( 'gatePrivacy' ).href = site.privacyUrl; $( 'gatePrivacy' ).hidden = false; }

		box.hidden = false;
		$( 'overlay' ).classList.add( 'hidden' );
		if ( ! lead ) ( gateOn ? fields.email : fields.name ).focus( { preventScroll: true } );

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
