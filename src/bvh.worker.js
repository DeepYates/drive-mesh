// Builds a raycast BVH for one tile mesh off the main thread.
//
// The main thread sends COPIES of the position and index arrays and keeps the originals, so
// the tile stays renderable and (brute-force) raycastable while this runs - the stock
// three-mesh-bvh worker transfers the originals away, and a wheel ray cast in that window
// would miss real road. The tree is built `indirect` so the index buffer is not reordered and
// the result can be attached to the untouched geometry.
import { BufferAttribute, BufferGeometry } from 'three';
import { MeshBVH } from 'three-mesh-bvh';

onmessage = ( { data } ) => {

	const { id, position, itemSize, normalized, index, groups } = data;
	try {

		const t0 = performance.now();
		const geometry = new BufferGeometry();
		geometry.setAttribute( 'position', new BufferAttribute( position, itemSize, normalized ) );
		if ( index ) geometry.setIndex( new BufferAttribute( index, 1 ) );
		for ( const g of groups ) geometry.addGroup( g.start, g.count, g.materialIndex );
		const bvh = new MeshBVH( geometry, { indirect: true } );
		const { roots, indirectBuffer } = MeshBVH.serialize( bvh, { cloneBuffers: false } );
		postMessage( { id, roots, indirectBuffer, ms: performance.now() - t0 }, [ ...roots, indirectBuffer.buffer ] );

	} catch ( err ) {

		postMessage( { id, error: String( err && err.message || err ) } );

	}

};
