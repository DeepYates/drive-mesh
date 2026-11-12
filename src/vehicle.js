// A small raycast vehicle: one rigid body, four suspension rays, a friction-circle tyre model.
//
// Collision is "what you see": the rays hit whichever mesh tiles are currently displayed.
// Rays are cast once per rendered frame (castRays) and turned into a contact PLANE per wheel;
// the physics substeps (step) then run against those planes, so 4 raycasts per frame support
// a 120 Hz simulation.
//
// Car frame: +X right, +Y up, -Z forward (three.js convention).
import { Quaternion, Vector3 } from 'three';

export const CAR = {
	mass: 1300,
	size: { w: 1.8, h: 1.25, l: 4.3 },      // for the inertia tensor
	wheelRadius: 0.34,
	restLength: 0.35,                        // suspension length at zero compression
	maxTravel: 0.22,                         // compression before the bump stop
	springK: 30000,                          // N/m per wheel (static sag ~0.11 m)
	damperC: 3200,                           // N s/m per wheel
	bumpStopK: 160000,
	maxWheelLoad: 3.0,                       // cap on suspension force, in car weights
	engineForce: 7500,                       // N, tapering to zero at topSpeed
	topSpeed: 38,                            // m/s forward (~85 mph)
	reverseSpeed: 9,
	brakeForce: 14000,
	mu: 1.15,                                // tyre friction
	handbrakeMu: 0.55,
	lateralGain: 0.35,                       // fraction of side-slip cancelled per substep
	rollingK: 35,                            // N per (m/s) per wheel
	dragK: 0.42,                             // N per (m/s)^2
	maxSteer: 0.6,                           // rad at standstill
	minSteer: 0.09,                          // rad at speed
	rayLift: 0.8,                            // wheel rays start this far above the mount
	bodyRayHeight: - 0.37,                   // obstacle rays, relative to the centre of mass
	wheels: [
		{ x: - 0.82, y: - 0.25, z: - 1.35, front: true },
		{ x: 0.82, y: - 0.25, z: - 1.35, front: true },
		{ x: - 0.82, y: - 0.25, z: 1.3, front: false },
		{ x: 0.82, y: - 0.25, z: 1.3, front: false },
	],
};
const G = 9.81;
const UP = new Vector3( 0, 1, 0 );

// scratch
const _a = new Vector3(), _b = new Vector3(), _c = new Vector3(), _d = new Vector3();
const _f = new Vector3(), _s = new Vector3(), _n = new Vector3(), _F = new Vector3(), _T = new Vector3();
const _q = new Quaternion();

export class Vehicle {

	constructor() {

		this.pos = new Vector3();
		this.quat = new Quaternion();
		this.vel = new Vector3();
		this.angVel = new Vector3();
		this.steer = 0;
		this.up = new Vector3( 0, 1, 0 );
		this.fwd = new Vector3( 0, 0, - 1 );
		this.right = new Vector3( 1, 0, 0 );
		const { w, h, l } = CAR.size, m = CAR.mass;
		// principal inertias about car X (pitch), Y (yaw), Z (roll)
		this.inertia = new Vector3( m / 12 * ( h * h + l * l ), m / 12 * ( w * w + l * l ), m / 12 * ( w * w + h * h ) );
		this.wheels = CAR.wheels.map( d => ( {
			local: new Vector3( d.x, d.y, d.z ), front: d.front,
			plane: null,          // { point, normal } from the last castRays
			onMesh: false,        // did the ray hit real mesh this frame?
			lastY: null,          // last real ground height, for the hold-floor fallback
			contact: false, compression: 0, length: CAR.restLength, load: 0,
		} ) );
		this.crashes = 0;
		this.lastImpact = 0;     // m/s lost in the most recent obstacle hit
		this.verticalAccel = 0;  // of the centre of mass, last substep (m/s^2, gravity removed)

	}

	get speed() {

		return this.vel.dot( this.fwd );

	}

	reset( pos, yaw ) {

		this.pos.copy( pos );
		this.quat.setFromAxisAngle( UP, yaw );
		this.vel.set( 0, 0, 0 );
		this.angVel.set( 0, 0, 0 );
		this.steer = 0;
		for ( const w of this.wheels ) {

			w.plane = null; w.lastY = null; w.onMesh = false; w.contact = false;

		}

		this._axes();

	}

	_axes() {

		this.up.set( 0, 1, 0 ).applyQuaternion( this.quat );
		this.fwd.set( 0, 0, - 1 ).applyQuaternion( this.quat );
		this.right.set( 1, 0, 0 ).applyQuaternion( this.quat );

	}

	/**
	 * cast( origin, dir, far ) -> { point, normal, distance } | null.
	 * Call once per frame, before the substeps.
	 */
	castRays( cast, frameDt ) {

		this._axes();
		const dir = _d.copy( this.up ).negate();
		const far = CAR.rayLift + CAR.restLength + CAR.wheelRadius + 0.45;
		const misses = [];
		for ( const w of this.wheels ) {

			const mount = _a.copy( w.local ).applyQuaternion( this.quat ).add( this.pos );
			const origin = _b.copy( mount ).addScaledVector( this.up, CAR.rayLift );
			const hit = cast( origin, dir, far );
			if ( hit ) {

				w.onMesh = true;
				w.lastY = hit.point.y;
				// Near-vertical faces (curb sides, lumps) would shove the car sideways if used as
				// the contact normal; treat them as a flat step at the hit height instead.
				const n = hit.normal.y >= 0.7 ? hit.normal.clone() : UP.clone();
				w.plane = { point: hit.point.clone(), normal: n };

			} else {

				// Hole, unloaded tile or the edge of the capture: roll on an invisible flat patch
				// at the last real ground height so the car never falls through the world.
				w.onMesh = false;
				w.plane = w.lastY === null ? null : { point: new Vector3( mount.x, w.lastY, mount.z ), normal: UP.clone() };
				if ( w.lastY === null ) misses.push( [ w, mount.clone() ] );

			}

		}

		// A wheel that has never touched mesh (spawned overhanging an edge) has no height of its
		// own to hold, so it borrows the mean of the wheels that do. Without this the car tips
		// off the lip of the mesh the moment it spawns.
		if ( misses.length && misses.length < this.wheels.length ) {

			const known = this.wheels.filter( w => w.lastY !== null );
			const y = known.reduce( ( a, w ) => a + w.lastY, 0 ) / known.length;
			for ( const [ w, mount ] of misses ) {

				w.lastY = y;
				w.plane = { point: new Vector3( mount.x, y, mount.z ), normal: UP.clone() };

			}

		}

		// Obstacles: three horizontal rays along the direction of travel at bumper height.
		// Anything steeper than ~60 degrees stops the car (walls, poles, baked-in parked cars).
		const hv = _c.set( this.vel.x, 0, this.vel.z );
		const hs = hv.length();
		if ( hs > 0.5 ) {

			hv.multiplyScalar( 1 / hs );
			const reach = CAR.size.l / 2 + 0.15 + hs * frameDt;
			for ( const side of [ 0, - 0.75, 0.75 ] ) {

				const origin = _b.copy( this.pos ).addScaledVector( this.up, CAR.bodyRayHeight ).addScaledVector( this.right, side );
				const hit = cast( origin, hv, reach );
				if ( ! hit || hit.normal.y > 0.5 ) continue;
				const nh = _n.set( hit.normal.x, 0, hit.normal.z );
				if ( nh.lengthSq() < 1e-6 ) continue;
				nh.normalize();
				const vn = this.vel.dot( nh );
				if ( vn < 0 ) {

					this.vel.addScaledVector( nh, - vn * 1.15 );
					this.angVel.multiplyScalar( 0.6 );
					this.lastImpact = - vn;
					if ( - vn > 1.5 ) this.crashes ++;

				}

				break;

			}

		}

	}

	/** input: { throttle -1..1, steer -1..1 (left positive), brake 0..1, handbrake bool } */
	step( dt, input ) {

		this._axes();
		const speed = this.speed;

		// speed-sensitive steering, eased toward the target
		const steerMax = CAR.minSteer + ( CAR.maxSteer - CAR.minSteer ) / ( 1 + Math.abs( speed ) / 9 );
		const target = input.steer * steerMax;
		this.steer += ( target - this.steer ) * Math.min( 1, dt * 9 );

		const F = _F.set( 0, - CAR.mass * G, 0 );
		const T = _T.set( 0, 0, 0 );

		// engine / brake demand, shared across the four wheels (AWD keeps the prototype simple)
		let drive = 0, brake = input.brake;
		if ( input.throttle > 0 ) {

			if ( speed < - 0.5 ) brake = Math.max( brake, input.throttle );
			else drive = input.throttle * CAR.engineForce * Math.max( 0, 1 - speed / CAR.topSpeed );

		} else if ( input.throttle < 0 ) {

			if ( speed > 0.5 ) brake = Math.max( brake, - input.throttle );
			else drive = input.throttle * CAR.engineForce * 0.6 * Math.max( 0, 1 + speed / CAR.reverseSpeed );

		}

		const quarter = CAR.mass / 4;
		for ( const w of this.wheels ) {

			w.contact = false; w.load = 0; w.compression = 0; w.length = CAR.restLength;
			if ( ! w.plane ) continue;
			const n = w.plane.normal;
			const mount = _a.copy( w.local ).applyQuaternion( this.quat ).add( this.pos );
			const denom = - this.up.dot( n );                // ray dir = -up
			if ( denom > - 0.3 ) continue;                  // car is on its side relative to this plane
			let t = _b.copy( w.plane.point ).sub( mount ).dot( n ) / denom;
			if ( t < 0 ) t = 0;
			const length = t - CAR.wheelRadius;
			const comp = CAR.restLength - length;
			if ( comp <= 0 ) continue;                      // wheel is in the air
			w.contact = true;
			w.compression = comp;
			w.length = Math.max( length, CAR.restLength - CAR.maxTravel - 0.05 );

			// velocity of the contact patch
			const contact = _b.copy( mount ).addScaledVector( this.up, - t );
			const rc = contact.sub( this.pos );
			const vc = _c.copy( this.angVel ).cross( rc ).add( this.vel );

			// suspension: spring + damper along the ground normal, plus a stiff bump stop
			let fs = CAR.springK * comp - CAR.damperC * vc.dot( n );
			if ( comp > CAR.maxTravel ) fs += CAR.bumpStopK * ( comp - CAR.maxTravel );
			fs = Math.min( Math.max( fs, 0 ), CAR.maxWheelLoad * CAR.mass * G );
			w.load = fs;

			// tyre frame on the ground plane
			const f = _f.copy( this.fwd );
			if ( w.front ) f.applyQuaternion( _q.setFromAxisAngle( this.up, this.steer ) );
			f.addScaledVector( n, - f.dot( n ) ).normalize();
			const s = _s.copy( f ).cross( n );
			const vLong = vc.dot( f ), vLat = vc.dot( s );

			let fLat = - vLat * quarter / dt * CAR.lateralGain;
			let fLong = drive / 4 - vLong * CAR.rollingK;
			let wheelBrake = brake * CAR.brakeForce / 4;
			if ( input.handbrake && ! w.front ) wheelBrake = CAR.brakeForce;
			if ( wheelBrake > 0 ) fLong -= Math.sign( vLong ) * Math.min( wheelBrake, Math.abs( vLong ) * quarter / dt );

			const grip = ( input.handbrake && ! w.front ? CAR.handbrakeMu : CAR.mu ) * fs;
			const mag = Math.hypot( fLat, fLong );
			if ( mag > grip && mag > 0 ) {

				fLat *= grip / mag; fLong *= grip / mag;

			}

			// Apply at the suspension mount, not the contact patch: a shorter lever arm for the
			// tyre forces keeps body roll (and rollovers) in check without an anti-roll bar.
			const wheelForce = _d.copy( n ).multiplyScalar( fs ).addScaledVector( f, fLong ).addScaledVector( s, fLat );
			F.add( wheelForce );
			T.add( _b.copy( mount ).sub( this.pos ).cross( wheelForce ) );

		}

		// aerodynamic drag
		const v = this.vel.length();
		F.addScaledVector( this.vel, - CAR.dragK * v );

		// integrate (semi-implicit Euler)
		const ay = F.y / CAR.mass;
		this.verticalAccel = ay;                           // gravity already included -> 0 at rest
		this.vel.addScaledVector( F, dt / CAR.mass );

		// torque -> angular acceleration in the body frame (diagonal inertia)
		_q.copy( this.quat ).invert();
		const tl = T.applyQuaternion( _q );
		tl.set( tl.x / this.inertia.x, tl.y / this.inertia.y, tl.z / this.inertia.z ).applyQuaternion( this.quat );
		this.angVel.addScaledVector( tl, dt );
		this.angVel.multiplyScalar( Math.max( 0, 1 - 0.8 * dt ) );

		this.pos.addScaledVector( this.vel, dt );
		const wl = this.angVel.length();
		if ( wl > 1e-6 ) {

			_q.setFromAxisAngle( _a.copy( this.angVel ).multiplyScalar( 1 / wl ), wl * dt );
			this.quat.premultiply( _q ).normalize();

		}

		this._axes();

	}

}

