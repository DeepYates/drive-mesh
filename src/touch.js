// On-screen driving controls for phones and tablets. Marketing links are mostly opened on a
// phone, and the game is otherwise keyboard-only. Each button holds down the same key code
// the keyboard handler uses, so the driving code does not know the difference.
const BUTTONS = [
	[ 'touchLeft', 'ArrowLeft' ], [ 'touchRight', 'ArrowRight' ], [ 'touchBrake', 'ArrowDown' ], [ 'touchGas', 'ArrowUp' ],
];

/** True on a device whose main pointer is a finger. `?touch=1` forces it on (for testing). */
export const isTouch = params => params.get( 'touch' ) === '1' || ( params.get( 'touch' ) !== '0' && matchMedia( '(pointer: coarse)' ).matches );

/**
 * Wire the buttons in #touch to the `keys` set. `onUse` fires on every press (the game uses
 * it to hand control back from autopilot the moment the driver touches anything).
 */
export function initTouch( keys, onUse ) {

	document.body.classList.add( 'touch' );
	document.getElementById( 'touch' ).hidden = false;
	for ( const [ id, code ] of BUTTONS ) {

		const el = document.getElementById( id );
		const down = e => { e.preventDefault(); el.setPointerCapture?.( e.pointerId ); keys.add( code ); el.classList.add( 'held' ); onUse(); };
		const up = () => { keys.delete( code ); el.classList.remove( 'held' ); };
		el.addEventListener( 'pointerdown', down );
		for ( const type of [ 'pointerup', 'pointercancel', 'lostpointercapture' ] ) el.addEventListener( type, up );
		el.addEventListener( 'contextmenu', e => e.preventDefault() );    // a long press is not a right-click

	}

}
