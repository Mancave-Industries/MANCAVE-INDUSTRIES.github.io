// Unit tests for the STENCIL LAB engine. Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const C = require('../public/stencil-lab/core.js');

// paint a synthetic artwork into a darkness field (art-sized)
function art(g, fn) {
  const d = new Float32Array(g.aw * g.ah);
  for (let y = 0; y < g.ah; y++) for (let x = 0; x < g.aw; x++) d[y * g.aw + x] = fn(x / g.aw, y / g.ah);
  return d;
}
const ring = (cx, cy, r0, r1) => (u, v) => { const r = Math.hypot(u - cx, v - cy); return r >= r0 && r <= r1 ? 1 : 0; };
function run(settings, fn, layer = {}) {
  const s = { artW: 100, artH: 100, margin: 12, ...settings };
  const g = C.computeGrid(s);
  const blurred = art(g, fn);
  return { g, r: C.processLayer({ blurred, g, threshold: 0.5, detail: 6, bridgeWidth: 1.5, extra: false, manual: [], suppressed: [], layerIndex: 0, layerCount: 1, margin: s.margin, ...layer }) };
}

test('marching squares reproduces the mask exactly at pixel centres', () => {
  const s = { artW: 40, artH: 30, margin: 10 };
  const g = C.computeGrid(s);
  const mask = new Uint8Array(g.w * g.h);
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let y = g.oy; y < g.oy + g.ah; y++) for (let x = g.ox; x < g.ox + g.aw; x++) mask[y * g.w + x] = rnd() < 0.45 ? 1 : 0;
  const loops = C.trace(mask, g.w, g.h);
  const polys = [[[0, 0], [0, g.sheetH], [g.sheetW, g.sheetH], [g.sheetW, 0]]].concat(loops.map((l) => l.map(([x, y]) => C.toMM(g, x, y))));
  for (const rule of ['nonzero', 'evenodd']) {
    const r = C.rasterize(polys, g.w, g.h, g.sx, g.sy, rule);
    let diff = 0; for (let i = 0; i < r.length; i++) if (r[i] !== (mask[i] ? 0 : 1)) diff++;
    assert.strictEqual(diff, 0, rule + ' raster must equal mask');
  }
});

test('a ring ("O") has one island, which gets bridged', () => {
  const { r } = run({}, ring(0.5, 0.5, 0.25, 0.4));
  assert.strictEqual(r.islandsBefore, 1);
  assert.ok(r.bridges.length >= 1);
  assert.ok(r.validation.pass, JSON.stringify(r.validation.checks.filter((c) => !c.pass)));
  assert.strictEqual(r.validation.islands, 0);
});

test('nested target rings: every island bridged', () => {
  const fn = (u, v) => Math.max(ring(0.5, 0.5, 0.06, 0.12)(u, v), ring(0.5, 0.5, 0.18, 0.26)(u, v), ring(0.5, 0.5, 0.32, 0.45)(u, v));
  const { r } = run({}, fn);
  assert.strictEqual(r.islandsBefore, 3);
  assert.strictEqual(r.validation.islands, 0);
  assert.ok(r.validation.pass);
});

test('extra bridges are added to large islands', () => {
  const one = run({}, ring(0.5, 0.5, 0.25, 0.4)).r;
  const two = run({}, ring(0.5, 0.5, 0.25, 0.4), { extra: true }).r;
  assert.ok(two.bridges.length > one.bridges.length);
  assert.ok(two.validation.pass);
});

test('removing the only bridge reroutes it elsewhere', () => {
  const first = run({}, ring(0.5, 0.5, 0.25, 0.4)).r;
  const b = first.bridges[0].pts;
  const again = run({}, ring(0.5, 0.5, 0.25, 0.4), { suppressed: [b] }).r;
  assert.ok(again.validation.pass);
  const nb = again.bridges.find((x) => x.type === 'auto').pts;
  assert.ok(Math.hypot(nb[0][0] - b[0][0], nb[0][1] - b[0][1]) > 1.5, 'bridge moved');
});

test('a manual bridge replaces the automatic one', () => {
  const g = C.computeGrid({ artW: 100, artH: 100, margin: 12 });
  // across the ring at the top: centre (62,62), ring radius 25..40 mm
  const manual = [[[62, 62 - 20], [62, 62 - 45]]];
  const { r } = run({}, ring(0.5, 0.5, 0.25, 0.4), { manual });
  assert.strictEqual(r.bridges.filter((b) => b.type === 'auto').length, 0);
  assert.ok(r.validation.pass);
  assert.ok(g);
});

test('SVG keeps physical size, one path, marks', () => {
  const { r, g } = run({ artW: 180, artH: 120, margin: 15 }, ring(0.5, 0.5, 0.2, 0.3));
  assert.match(r.svg, /width="210mm" height="150mm" viewBox="0 0 210 150"/);
  assert.strictEqual((r.svg.match(/<path/g) || []).length, 1);
  assert.ok(r.validation.pass);
  assert.strictEqual(g.sheetW, 210);
});

test('validator rejects an island and multiple paths', () => {
  const W = 50, H = 50;
  const d = 'M0 0V50H50V0Z' + 'M10 10L40 10L40 40L10 40Z' + 'M20 20L20 30L30 30L30 20Z';
  const v = C.validateSVG(C.makeSVG(d, W, H, 't'), { sheetW: W, sheetH: H, ppm: 4 });
  assert.strictEqual(v.pass, false);
  assert.strictEqual(v.islands, 1);
  const two = C.makeSVG('M0 0V50H50V0Z', W, H, 't').replace('</svg>', '<path d="M1 1L2 2L1 2Z"/></svg>');
  assert.strictEqual(C.validateSVG(two, { sheetW: W, sheetH: H, ppm: 4 }).checks.find((c) => c.id === 'single').pass, false);
});

test('auto levels are ordered and in range', () => {
  const d = new Float32Array(1000); for (let i = 0; i < 1000; i++) d[i] = [0, 0.3, 0.6, 0.95][i % 4];
  const t = C.autoLevels(d, 3);
  assert.strictEqual(t.length, 3);
  for (let i = 1; i < 3; i++) assert.ok(t[i] > t[i - 1]);
  assert.ok(t[0] > 0 && t[2] < 1);
});
