// WGS84 <-> a local metre frame centred on the mesh.
//
// The tiles are positioned in Earth-centred (ECEF) coordinates, ~6.4e6 m from the origin.
// At 32-bit float precision that is ~0.5 m of jitter, so everything is re-expressed in an
// east-north-up frame anchored at the mesh centre. three.js is Y-up, so the mapping is
//   +X = east, +Y = up, +Z = south   (i.e. -Z = north)
// All of this runs in JS doubles; only the final camera-relative matrices reach the GPU.
import { Matrix4 } from 'three';

const A = 6378137.0;
const F = 1 / 298.257223563;
const E2 = F * ( 2 - F );

export function ecef( lon, lat, h ) {

	const sl = Math.sin( lat ), cl = Math.cos( lat );
	const n = A / Math.sqrt( 1 - E2 * sl * sl );
	return [ ( n + h ) * cl * Math.cos( lon ), ( n + h ) * cl * Math.sin( lon ), ( n * ( 1 - E2 ) + h ) * sl ];

}

const dot = ( a, b ) => a[ 0 ] * b[ 0 ] + a[ 1 ] * b[ 1 ] + a[ 2 ] * b[ 2 ];

/** lon0/lat0 in radians, h0 in metres. */
export function makeFrame( lon0, lat0, h0 ) {

	const o = ecef( lon0, lat0, h0 );
	const sl = Math.sin( lat0 ), cl = Math.cos( lat0 ), so = Math.sin( lon0 ), co = Math.cos( lon0 );
	const east = [ - so, co, 0 ];
	const north = [ - sl * co, - sl * so, cl ];
	const up = [ cl * co, cl * so, sl ];

	return {
		lon0, lat0, h0,
		/** radians + metres -> [x, y, z] local */
		toLocal( lon, lat, h = h0 ) {

			const p = ecef( lon, lat, h );
			const d = [ p[ 0 ] - o[ 0 ], p[ 1 ] - o[ 1 ], p[ 2 ] - o[ 2 ] ];
			return [ dot( d, east ), dot( d, up ), - dot( d, north ) ];

		},
		/** Matrix taking ECEF points into the local frame (apply to the tiles group). */
		ecefToLocal() {

			return new Matrix4().set(
				east[ 0 ], east[ 1 ], east[ 2 ], - dot( east, o ),
				up[ 0 ], up[ 1 ], up[ 2 ], - dot( up, o ),
				- north[ 0 ], - north[ 1 ], - north[ 2 ], dot( north, o ),
				0, 0, 0, 1,
			);

		},
	};

}
