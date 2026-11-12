// Watch the ground under the spawn point while tiles refine.
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  args: ['--ignore-gpu-blocklist','--enable-gpu','--use-angle=d3d11'], defaultViewport: { width: 1280, height: 720 } });
const page = await browser.newPage();
page.on('pageerror', e => console.log('pageerror', e.message));
await page.goto('http://127.0.0.1:8600/' + (process.argv[2] || ''), { waitUntil: 'load' });
const g = e => page.evaluate(`(() => { const g = window.__game; return ${e}; })()`);
const t0 = Date.now();
while (await g('g.state') !== 'driving' && Date.now() - t0 < 60000) await new Promise(r => setTimeout(r, 50));
const sp = (await g('g.spawnLog'))[0];
console.log('spawn', JSON.stringify(sp));
for (let i = 0; i < 16; i++) {
  const c = await g('g.car'), t = await g('g.tiles');
  console.log(`+${String(Date.now() - t0).padStart(5)}ms car.y=${c.y.toFixed(2)} onMesh=${c.onMesh.map(Number).join('')} shown=${t.visible} dl=${t.downloading} parse=${t.parsing} groundAt=${JSON.stringify(await g(`g.groundAt(${sp.x}, ${sp.z})`))} surfaces=${JSON.stringify(await g(`g.surfacesAt(${sp.x}, ${sp.z})`))}`);
  await new Promise(r => setTimeout(r, 200));
}
console.log('spawnLog', JSON.stringify(await g('g.spawnLog')));
console.log('perf', JSON.stringify((await g('g.report()')).perf));
await browser.close();
