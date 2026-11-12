// Lead capture: the visitor's details go to a HubSpot form, and nowhere else.
//
// Path 1: the browser posts straight to HubSpot's public form endpoint (CORS-enabled, no
//         secret; the portal and form ids are public by design).
// Path 2: ad blockers often block hsforms.com, so a network failure retries through the
//         Worker (POST /lead), which forwards the same body.
// Path 3: if both fail, the submission is queued in localStorage and retried on later visits.
//
// HubSpot rejects any field that is not on the form (FIELD_NOT_IN_FORM_DEFINITION), so the
// form must have exactly FIELDS. Its answer for a bad address (INVALID_EMAIL, BLOCKED_EMAIL)
// is passed back so the gate can refuse it.
const LEAD_KEY = 'driveMeshLead', QUEUE_KEY = 'driveMeshLeadQueue', SENT_KEY = 'driveMeshLeadSent';
export const FIELDS = [ 'email', 'firstname', 'company', 'drive_demo_mesh', 'drive_demo_outcome' ];
const REFUSED = new Set( [ 'INVALID_EMAIL', 'BLOCKED_EMAIL', 'INVALID_DOMAIN' ] );

const read = ( key, fallback ) => { try { return JSON.parse( localStorage.getItem( key ) ) ?? fallback; } catch { return fallback; } };
const write = ( key, value ) => { try { localStorage.setItem( key, JSON.stringify( value ) ); } catch { /* private window */ } };

/** { email, name, company } saved by an earlier visit, or null. */
export const savedLead = () => { const l = read( LEAD_KEY, null ); return l && l.email && l.name ? l : null; };
export const saveLead = lead => write( LEAD_KEY, lead );
export const forgetLead = () => { try { localStorage.removeItem( LEAD_KEY ); } catch { /* private window */ } };

/** Has this browser already told HubSpot about this mesh for this email? */
export const alreadySent = ( lead, mesh ) => read( SENT_KEY, [] ).includes( `${lead.email}|${mesh}` );

function body( site, lead, mesh, outcome ) {

	const value = { email: lead.email, firstname: lead.name, company: lead.company || '', drive_demo_mesh: mesh, drive_demo_outcome: outcome };
	const out = {
		fields: FIELDS.filter( name => value[ name ] ).map( name => ( { objectTypeId: '0-1', name, value: value[ name ] } ) ),
		// the full address, so campaign tags (utm_source...) on the link reach HubSpot
		context: { pageUri: location.href, pageName: document.title },
	};
	if ( site.hubspot.consentText ) out.legalConsentOptions = { consent: { consentToProcess: true, text: site.hubspot.consentText } };
	return out;

}

async function post( url, payload ) {

	const res = await fetch( url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify( payload ) } );
	if ( res.ok ) return { ok: true };
	const answer = await res.json().catch( () => ( {} ) );
	const types = ( answer.errors ?? [] ).map( e => e.errorType );
	// a refused address is the visitor's to fix; anything else (misconfigured form, HubSpot
	// trouble) is ours, and must not lock people out of the demo
	return { ok: false, refused: types.find( t => REFUSED.has( t ) ) ?? null, status: res.status, types };

}

/**
 * Send a lead. Resolves { ok } | { ok: false, refused } (bad address) | { ok: false, queued }.
 * `api` is the Worker's base URL, or null when there is none (local server.py).
 */
export async function sendLead( site, api, lead, mesh, outcome ) {

	const hs = site.hubspot ?? {};
	if ( ! hs.formGuid ) return { ok: false, off: true };
	const payload = body( site, lead, mesh, outcome );
	const direct = `${hs.endpoint || 'https://api.hsforms.com'}/submissions/v3/integration/submit/${hs.portalId}/${hs.formGuid}`;
	let result = null;
	for ( const url of [ direct, api && new URL( 'lead', api ).href ] ) {

		if ( ! url ) continue;
		try {

			result = await post( url, payload );
			break;                       // HubSpot answered (yes or no): no point asking again

		} catch { /* blocked or offline: try the next path */ }

	}

	if ( result?.ok ) {

		write( SENT_KEY, [ ...read( SENT_KEY, [] ), `${lead.email}|${mesh}` ].slice( - 40 ) );
		return result;

	}

	if ( result?.refused ) return result;
	write( QUEUE_KEY, [ ...read( QUEUE_KEY, [] ), payload ].slice( - 10 ) );
	return { ok: false, queued: true, ...result };

}

/** Retry submissions that could not be sent on an earlier visit. */
export async function flushQueue( site, api ) {

	const hs = site.hubspot ?? {}, queue = read( QUEUE_KEY, [] );
	if ( ! hs.formGuid || ! queue.length ) return;
	const direct = `${hs.endpoint || 'https://api.hsforms.com'}/submissions/v3/integration/submit/${hs.portalId}/${hs.formGuid}`;
	const left = [];
	for ( const payload of queue ) {

		let done = false;
		for ( const url of [ direct, api && new URL( 'lead', api ).href ] ) {

			if ( ! url || done ) continue;
			try { const r = await post( url, payload ); done = r.ok || !! r.refused; } catch { /* still unreachable */ }

		}

		if ( ! done ) left.push( payload );

	}

	write( QUEUE_KEY, left );

}
