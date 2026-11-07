// End-to-end test: drives Stencil Lab in Chromium like a user, then re-checks every exported
// file independently (Chromium's own SVG renderer + flood fill). Run: node tests/e2e.js [outDir]
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const ROOT = path.join(__dirname, '..', 'public');
const FIX = path.join(__dirname, 'fixtures');
const OUT = process.argv[2] || path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg' };
const results = [];
// serve the same headers Cloudflare Pages will (public/_headers), so the CSP is exercised
const HEADERS = Object.fromEntries(fs.readFileSync(path.join(ROOT, '_headers'), 'utf8').split('\n').filter((l) => /^\s+\S+:/.test(l)).map((l) => { const i = l.indexOf(':'); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const log = (ok, name, detail = '') => { results.push({ ok, name, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', ...HEADERS });
  fs.createReadStream(f).pipe(res);
});

async function waitDone(page) {
  await page.waitForFunction(() => { const s = window.__stencilLab; return s && s.result && !s.busy && !s.pending; }, null, { timeout: 120000 });
  await page.waitForTimeout(400); // debounce window
  await page.waitForFunction(() => { const s = window.__stencilLab; return s && s.result && !s.busy && !s.pending && s.result.id === s.jobId; }, null, { timeout: 120000 });
}

// independent check of one SVG with Chromium's renderer
async function checkSVG(page, svg, expectW, expectH) {
  return page.evaluate(async ({ svg, expectW, expectH }) => {
    const out = {};
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const root = doc.documentElement;
    out.width = root.getAttribute('width'); out.height = root.getAttribute('height');
    out.drawables = doc.querySelectorAll('path,rect,circle,ellipse,line,polyline,polygon,text,image,use').length;
    out.paths = doc.querySelectorAll('path').length;
    const img = new Image();
    img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    await img.decode();
    out.natW = img.naturalWidth; out.natH = img.naturalHeight;
    out.expectPxW = expectW * 96 / 25.4; out.expectPxH = expectH * 96 / 25.4;
    const k = 5; // px per mm
    const c = document.createElement('canvas'); c.width = Math.round(expectW * k); c.height = Math.round(expectH * k);
    const x = c.getContext('2d'); x.drawImage(img, 0, 0, c.width, c.height);
    const d = x.getImageData(0, 0, c.width, c.height).data, w = c.width, h = c.height;
    const mat = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) mat[i] = d[i * 4 + 3] > 127 ? 1 : 0;
    // bounding box of the drawn shape == sheet?
    out.cornerFilled = mat[0] && mat[w - 1] && mat[(h - 1) * w] && mat[w * h - 1];
    const seen = new Uint8Array(w * h), st = [];
    const flood = (s) => { let n = 0; st.push(s); seen[s] = 1; while (st.length) { const p = st.pop(); n++; const px = p % w, py = (p - px) / w;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = px + dx, yy = py + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; const q = yy * w + xx; if (mat[q] && !seen[q]) { seen[q] = 1; st.push(q); } } } return n; };
    flood(0);
    let islands = 0, tiny = 0;
    for (let i = 0; i < w * h; i++) if (mat[i] && !seen[i]) { const n = flood(i); if (n > 6) islands++; else tiny++; }
    out.islands = islands; out.tinyFragments = tiny;
    let holes = 0; for (let i = 0; i < w * h; i++) if (!mat[i]) holes++;
    out.cutFraction = holes / (w * h);
    return out;
  }, { svg, expectW, expectH });
}

async function runCase(browser, fixture, layerCounts, opts = {}) {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://localhost:${server.address().port}/stencil-lab/`);
  if (fixture === 'sample') await page.click('#sample');
  else await page.setInputFiles('#file', path.join(FIX, fixture));
  await waitDone(page);
  if (opts.physical) { const a = await page.evaluate(() => [window.__stencilLab.s.artW, window.__stencilLab.s.artH]); log(Math.abs(a[0] - opts.physical[0]) < 0.01 && Math.abs(a[1] - opts.physical[1]) < 0.01, `${fixture}: SVG physical size carried over`, `${a[0]} × ${a[1]} mm`); }
  if (opts.width) { await page.fill('#artW', String(opts.width)); await page.press('#artW', 'Tab'); await waitDone(page); }
  for (const n of layerCounts) {
    const tag = `${fixture} ×${n}`;
    const t0 = Date.now();
    await page.check(`input[name=layers][value="${n}"]`, { force: true });
    await waitDone(page);
    const ms = Date.now() - t0;
    const state = await page.evaluate(() => { const s = window.__stencilLab; return { s: s.s, grid: s.result.grid, n: s.result.layers.length, pass: s.result.layers.map((l) => l.validation.pass), islands: s.result.layers.map((l) => l.islandsBefore), bridges: s.result.layers.map((l) => l.bridges.length) }; });
    const badge = (await page.textContent('#badge')).trim();
    log(state.n === n, `${tag}: ${n} layers produced`, `${ms} ms`);
    log(badge === 'Cut-ready' && state.pass.every(Boolean), `${tag}: app reports cut-ready`, `islands found ${state.islands.join('/')}, bridges ${state.bridges.join('/')}`);
    const expW = state.s.artW + 2 * state.s.margin, expH = state.s.artH + 2 * state.s.margin;
    // download ZIP like a user
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#zipBtn')]);
    const zipPath = path.join(OUT, dl.suggestedFilename()); await dl.saveAs(zipPath);
    const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
    const names = Object.keys(zip.files).filter((f) => !zip.files[f].dir);
    const layerFiles = names.filter((f) => /-layer-\d+-of-\d+-.*\.svg$/.test(f)).sort();
    log(layerFiles.length === n && names.includes('validation-report.txt') && names.some((f) => /composite-preview\.png$/.test(f)) && names.some((f) => /NOT-FOR-CUTTING\.svg$/.test(f)),
      `${tag}: ZIP has ${n} layer SVGs, composite PNG+SVG, report`, dl.suggestedFilename());
    log(layerFiles.every((f) => f.includes('cut-ready')) && /cut-ready\.zip$/.test(dl.suggestedFilename()), `${tag}: files labelled cut-ready only after validation`);
    let prefix = null, marksSame = true;
    for (const f of layerFiles) {
      const svg = await zip.file(f).async('string');
      const r = await checkSVG(page, svg, expW, expH);
      log(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(svg), `${tag}: ${f} is plain ASCII`);
      const sizeOK = Math.abs(parseFloat(r.width) - expW) < 0.01 && r.width.endsWith('mm') && Math.abs(parseFloat(r.height) - expH) < 0.01 && r.height.endsWith('mm');
      const renderOK = Math.abs(r.natW - r.expectPxW) <= 1 && Math.abs(r.natH - r.expectPxH) <= 1;
      log(sizeOK && renderOK, `${tag}: ${f} keeps size`, `${r.width} × ${r.height}; renders ${r.natW}×${r.natH}px @96dpi (expected ${r.expectPxW.toFixed(1)}×${r.expectPxH.toFixed(1)})`);
      log(r.drawables === 1 && r.paths === 1, `${tag}: ${f} is one path (one cut operation)`);
      log(r.islands === 0 && r.cornerFilled, `${tag}: ${f} has no islands in Chromium's render`, `islands ${r.islands}, anti-alias specks ${r.tinyFragments}, cut ${(r.cutFraction * 100).toFixed(1)}%`);
      const d = svg.match(/ d="([^"]+)"/)[1];
      const p = d.split('Z').slice(0, 5).join('Z'); // outline + 4 crosses
      if (prefix === null) prefix = p; else if (p !== prefix) marksSame = false;
    }
    log(marksSame, `${tag}: sheet outline and registration crosses identical on every layer`);
    await page.screenshot({ path: path.join(OUT, `${fixture.replace(/\W/g, '_')}-${n}-composite.png`), fullPage: true });
  }
  if (opts.bridgeEdit) {
    // open layer 1, remove an auto bridge, then add a manual one
    await page.click('#tabs button:nth-child(2)');
    await page.locator('#viewer').scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => window.__stencilLab.result.layers[0].bridges.slice(0, 1));
    if (before.length) {
      await page.click('.tool[data-tool=remove]');
      await page.locator('#viewer').scrollIntoViewIfNeeded();
      const pt = await page.evaluate((b) => { const s = window.__stencilLab, c = document.querySelector('#canvas'), r = c.getBoundingClientRect(), g = s.result.grid;
        const W = c.width, H = c.height, sc = Math.min(W / g.sheetW, H / g.sheetH) * 0.94, ox = (W - g.sheetW * sc) / 2, oy = (H - g.sheetH * sc) / 2, dpr = W / r.width;
        const p = b[0].pts, m = [(p[0][0] + p[p.length - 1][0]) / 2, (p[0][1] + p[p.length - 1][1]) / 2];
        return [r.left + (m[0] * sc + ox) / dpr, r.top + (m[1] * sc + oy) / dpr]; }, before);
      await page.mouse.click(pt[0], pt[1]);
      await waitDone(page);
      const after = await page.evaluate(() => { const s = window.__stencilLab; return { sup: s.s.layer[0].suppressed.length, pass: s.result.layers[0].validation.pass, b: s.result.layers[0].bridges.map((x) => x.pts[0]) }; });
      log(after.sup === 1 && after.pass, 'remove bridge: bridge moved, layer still cut-ready', JSON.stringify({ sup: after.sup, pass: after.pass }));
      await page.screenshot({ path: path.join(OUT, 'bridge-removed-layer1.png') });
    }
    await page.click('.tool[data-tool=add]');
    await page.locator('#viewer').scrollIntoViewIfNeeded();
    const box = await page.locator('#canvas').boundingBox();
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.3);
    await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.32, { steps: 5 }); await page.mouse.up();
    await waitDone(page);
    const man = await page.evaluate(() => { const s = window.__stencilLab; return { m: s.s.layer[0].manual.length, inResult: s.result.layers[0].bridges.filter((b) => b.type === 'manual').length, pass: s.result.layers[0].validation.pass }; });
    log(man.m === 1 && man.inResult === 1 && man.pass, 'add bridge: manual bridge applied and layer re-validated', JSON.stringify(man));
    // detail slider
    await page.locator('.lrow input[data-k=detail]').first().fill('2');
    await waitDone(page);
    const det = await page.evaluate(() => window.__stencilLab.result.layers[0].validation.pass);
    log(det, 'detail slider: layer recomputed and still cut-ready');
    await page.screenshot({ path: path.join(OUT, 'bridge-edit-layer1.png') });
  }
  log(errors.length === 0, `${fixture}: no page errors`, errors.join(' | '));
  await ctx.close();
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const browser = await chromium.launch();
  try {
    // shelf page loads
    const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await p.goto(`http://localhost:${server.address().port}/`);
    log((await p.textContent('h1')).includes('App Shelf') && (await p.locator('a[href="stencil-lab/"]').count()) === 1, 'App Shelf page lists Stencil Lab');
    await p.screenshot({ path: path.join(OUT, 'shelf.png') });
    const m = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await m.goto(`http://localhost:${server.address().port}/stencil-lab/`);
    const sw = await m.evaluate(() => document.documentElement.scrollWidth);
    log(sw <= 390, 'phone width: no horizontal scroll', `scrollWidth ${sw}`);
    // bad file type
    fs.writeFileSync(path.join(OUT, 'notes.txt'), 'hello');
    await m.setInputFiles('#file', path.join(OUT, 'notes.txt'));
    log(/isn’t supported/.test(await m.textContent('.toast')), 'unsupported file type is rejected with a message');
    await m.close(); await p.close();

    await runCase(browser, 'sample', [3, 1, 5], { bridgeEdit: true });
    if (process.env.QUICK) return;
    await runCase(browser, 'shaded.png', [1, 2, 3, 4, 5]);
    await runCase(browser, 'shaded.jpg', [3], { width: 280 });
    await runCase(browser, 'letters.svg', [1, 3], { physical: [152.4, 76.2] });
    await runCase(browser, 'transparent.png', [1, 2]);
  } finally {
    await browser.close(); server.close();
  }
  const fail = results.filter((r) => !r.ok);
  console.log(`\n${results.length - fail.length}/${results.length} checks passed`);
  fs.writeFileSync(path.join(OUT, 'e2e-results.json'), JSON.stringify(results, null, 2));
  process.exit(fail.length ? 1 : 0);
})();
