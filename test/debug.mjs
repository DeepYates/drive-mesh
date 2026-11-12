import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  args: ['--ignore-gpu-blocklist','--enable-gpu','--use-angle=d3d11'], defaultViewport: { width: 1280, height: 720 } });
const page = await browser.newPage();
page.on('response', r => { if (r.status() >= 400) console.log('HTTP', r.status(), new URL(r.url()).pathname); });
page.on('pageerror', e => console.log('pageerror', e.message));
await page.goto('http://127.0.0.1:8600/', { waitUntil: 'load' });
await new Promise(r => setTimeout(r, Number(process.argv[2] || 8000)));
console.log(JSON.stringify(await page.evaluate(() => ({ state: window.__game.state, tiles: window.__game.tiles, dbg: window.__game.debug() })), null, 1));
await page.screenshot({ path: 'test/out/debug.png' });
await browser.close();
