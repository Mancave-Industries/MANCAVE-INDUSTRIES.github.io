/* STENCIL LAB worker: runs the heavy image work off the main thread. */
importScripts('core.js');
const C = self.StencilCore;
let cache = { key: null, dark: null, blurred: new Map() };

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'levels') {
      const dark = getDark(m);
      const g = C.computeGrid(m.settings);
      const bl = C.boxBlur(dark, g.aw, g.ah, Math.round(0.3 * g.ppm));
      self.postMessage({ type: 'levels', id: m.id, thresholds: C.autoLevels(bl, m.settings.layers) });
      return;
    }
    if (m.type === 'run') {
      const s = m.settings;
      const g = C.computeGrid(s);
      if (g.aw !== m.aw || g.ah !== m.ah) throw new Error('artwork raster size mismatch');
      const dark = getDark(m);
      let thresholds = null;
      if (m.autoLevels) {
        const bl = C.boxBlur(dark, g.aw, g.ah, Math.round(0.3 * g.ppm));
        thresholds = C.autoLevels(bl, s.layers);
        thresholds.forEach((t, i) => { s.layer[i].threshold = t; });
      }
      const layers = [];
      for (let i = 0; i < s.layers; i++) {
        const L = s.layer[i];
        const dp = C.detailParams(L.detail, g);
        let blurred = cache.blurred.get(dp.blurPx);
        if (!blurred) { blurred = C.boxBlur(dark, g.aw, g.ah, dp.blurPx); cache.blurred.set(dp.blurPx, blurred); }
        const r = C.processLayer({
          blurred, g, threshold: L.threshold, detail: L.detail, bridgeWidth: s.bridgeWidth, extra: s.extraBridges,
          manual: L.manual, suppressed: L.suppressed, layerIndex: i, layerCount: s.layers, margin: s.margin,
          title: `${s.name} - layer ${i + 1} of ${s.layers}`,
        });
        layers.push(r);
        self.postMessage({ type: 'progress', id: m.id, done: i + 1, total: s.layers });
      }
      self.postMessage({ type: 'result', id: m.id, grid: g, layers, thresholds });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) });
  }
};

function getDark(m) {
  const key = m.imgKey + '|' + m.aw + 'x' + m.ah + '|' + (m.settings.invert ? 1 : 0);
  if (cache.key !== key) cache = { key, dark: C.darkness(m.rgba, m.aw, m.ah, m.settings.invert), blurred: new Map() };
  return cache.dark;
}
