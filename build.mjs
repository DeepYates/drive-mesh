// Bundle src/main.js -> static/bundle.js and copy the Draco + Basis decoders next to it.
// The tiles REQUIRE both (KHR_draco_mesh_compression, KHR_texture_basisu), so the page is
// useless without them; serving them locally keeps the game free of CDN dependencies.
import { build, context } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const libs = join(here, 'node_modules', 'three', 'examples', 'jsm', 'libs');
for (const [from, to] of [[join(libs, 'draco', 'gltf'), 'draco'], [join(libs, 'basis'), 'basis']]) {
	mkdirSync(join(here, 'static', 'libs', to), { recursive: true });
	cpSync(from, join(here, 'static', 'libs', to), { recursive: true });
}

const options = {
	// Two outputs: the page bundle and the BVH build worker (loaded as a module worker).
	entryPoints: { bundle: join(here, 'src', 'main.js'), 'bvh.worker': join(here, 'src', 'bvh.worker.js') },
	outdir: join(here, 'static'),
	bundle: true,
	format: 'esm',
	target: 'es2022',
	// Where the page fetches tiles: <base><mesh id>/tileset.json. Relative = resolved against
	// the bundle's URL (the local server.py proxy); a hosted build passes the Worker's
	// absolute .../tiles/ URL, which also tells the page where the Worker's other routes are.
	define: { __TILES_BASE__: JSON.stringify((process.env.TILES_BASE || './tiles/').replace(/\/?$/, '/')) },
	minify: !process.argv.includes('--watch'),
	sourcemap: true,
	logLevel: 'info',
};

if (process.argv.includes('--watch')) {
	const ctx = await context(options);
	await ctx.watch();
} else {
	await build(options);
}
