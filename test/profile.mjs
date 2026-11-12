// Mesh road-surface noise, independent of the vehicle physics:
//   node test/profile.mjs <route> <metres along> [more "route:along" pairs...]
import puppeteer from 'puppeteer-core';
import { writeFileSync } from 'node:fs';
const spots = process.argv.slice(2).map(a => a.split(':').map(Number));
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  args: ['--ignore-gpu-blocklist','--enable-gpu','--use-angle=d3d11'], defaultViewport: { width: 1280, height: 720 } });
const page = await browser.newPage();
page.on('pageerror', e => console.log('pageerror', e.message));
await page.goto('http://127.0.0.1:8600/', { waitUntil: 'load' });
const g = e => page.evaluate(`(() => { const g = window.__game; return ${e}; })()`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wait = async s => { const t0 = Date.now(); while (await g('g.state') !== s && Date.now() - t0 < 60000) await sleep(100); };
const q = (a, f) => a.length ? a[Math.floor(f * (a.length - 1))] : NaN;
await wait('driving');
const all = [];
for (const [route, along] of spots) {
  await g(`g.spawn(${route}, ${along})`); await sleep(300); await wait('driving');
  await g(`g.setKey('Space', true)`); await sleep(3500);   // handbrake on, let tiles settle at full detail
  for (const lateral of [0, 1.5]) {
    const h = await g(`g.profile(15, 0.05, ${lateral})`);
    const ok = h.filter(v => v !== null);
    // detrend with a 1 m moving average (21 samples) so slope and crown drop out
    const res = [];
    for (let i = 10; i < h.length - 10; i++) {
      const w = h.slice(i - 10, i + 11); if (w.some(v => v === null)) continue;
      res.push(h[i] - w.reduce((a, v) => a + v, 0) / w.length);
    }
    const steps = []; for (let i = 1; i < h.length; i++) if (h[i] !== null && h[i - 1] !== null) steps.push(Math.abs(h[i] - h[i - 1]));
    steps.sort((a, b) => a - b);
    const rms = Math.sqrt(res.reduce((a, v) => a + v * v, 0) / Math.max(1, res.length));
    const row = { route, along, lateral, samples: h.length, holesPct: +(100 * (h.length - ok.length) / h.length).toFixed(1),
      rmsNoise_mm: +(rms * 1000).toFixed(1), step5cm_p50_mm: +(q(steps, .5) * 1000).toFixed(1), step5cm_p95_mm: +(q(steps, .95) * 1000).toFixed(1),
      step5cm_max_mm: +(q(steps, 1) * 1000).toFixed(1), rise_m: +(Math.max(...ok) - Math.min(...ok)).toFixed(2) };
    all.push(row); console.log(JSON.stringify(row));
  }
  console.log('  triangle edge length near car (m):', JSON.stringify(await g('g.triangleStats()')));
  await g(`g.setKey('Space', false)`);
}
writeFileSync('test/out/profile.json', JSON.stringify(all, null, 1));
await browser.close();
