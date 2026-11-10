/*
 * STENCIL LAB core engine. No DOM: runs in the web worker, the page and Node tests.
 *
 * Model
 *   A layer is a sheet of stencil material. Mask value 1 = cut away (paint goes through),
 *   0 = material that stays. The sheet has a solid margin all round.
 *   An "island" is a piece of material that is not connected (4-connected) to the margin:
 *   once cut it would fall out. Every island gets a bridge (a strip of material) back to
 *   the connected sheet, or the layer fails validation.
 *
 * Exported SVG per layer: one <path>, solid fill, sheet outline + every cut as sub-paths,
 * outline wound opposite to the cuts so even-odd and non-zero fill give the same shape.
 * Width/height in millimetres, viewBox in millimetres.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StencilCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CRICUT = {
    mat12: { w: 292.1, h: 292.1, name: '12×12 in mat (11.5×11.5 in cut area)' },
    mat24: { w: 292.1, h: 596.9, name: '12×24 in mat (11.5×23.5 in cut area)' },
  };
  const MAX_WORK_PIXELS = 2.2e6;
  const MAX_PPM = 10; // pixels per mm
  const MIN_MARGIN = 8;

  /* ---------------------------------------------------------------- geometry of the work grid */
  function computeGrid(s) {
    const sheetW = s.artW + 2 * s.margin;
    const sheetH = s.artH + 2 * s.margin;
    let ppm = Math.min(MAX_PPM, Math.sqrt(MAX_WORK_PIXELS / (sheetW * sheetH)));
    const w = Math.max(16, Math.round(sheetW * ppm));
    const h = Math.max(16, Math.round(sheetH * ppm));
    const sx = w / sheetW, sy = h / sheetH; // px per mm on each axis
    const ox = Math.round(s.margin * sx), oy = Math.round(s.margin * sy);
    const aw = Math.max(1, Math.min(w - 2 * ox, Math.round(s.artW * sx)));
    const ah = Math.max(1, Math.min(h - 2 * oy, Math.round(s.artH * sy)));
    return { sheetW, sheetH, w, h, sx, sy, ppm: (sx + sy) / 2, ox, oy, aw, ah };
  }

  /* ---------------------------------------------------------------- image prep */
  function darkness(rgba, w, h, invert) {
    const out = new Float32Array(w * h);
    for (let i = 0, j = 0; i < out.length; i++, j += 4) {
      const a = rgba[j + 3] / 255;
      const lum = (0.2126 * rgba[j] + 0.7152 * rgba[j + 1] + 0.0722 * rgba[j + 2]) / 255;
      const d = invert ? lum : 1 - lum;
      out[i] = a * d; // transparent = nothing to paint
    }
    return out;
  }

  function boxBlur(src, w, h, r) {
    if (r < 1) return src;
    let a = Float32Array.from(src), b = new Float32Array(src.length);
    const pass = (from, to, horiz) => {
      const len = horiz ? w : h, lines = horiz ? h : w;
      const step = horiz ? 1 : w, lineStep = horiz ? w : 1, inv = 1 / (2 * r + 1);
      for (let l = 0; l < lines; l++) {
        const base = l * lineStep;
        let acc = 0;
        for (let k = -r; k <= r; k++) acc += from[base + Math.min(len - 1, Math.max(0, k)) * step];
        for (let i = 0; i < len; i++) {
          to[base + i * step] = acc * inv;
          const add = Math.min(len - 1, i + r + 1), rem = Math.max(0, i - r);
          acc += from[base + add * step] - from[base + rem * step];
        }
      }
    };
    for (let it = 0; it < 2; it++) { pass(a, b, true); pass(b, a, false); }
    return a;
  }

  /* k-means on the tone histogram: n layers -> n thresholds, lightest first */
  function autoLevels(dark, n) {
    const hist = new Float64Array(256);
    for (let i = 0; i < dark.length; i++) hist[Math.min(255, (dark[i] * 255) | 0)]++;
    const k = n + 1;
    let lo = 0, hi = 255;
    while (lo < 255 && hist[lo] === 0) lo++;
    while (hi > 0 && hist[hi] === 0) hi--;
    if (hi <= lo) { lo = 0; hi = 255; }
    let c = Array.from({ length: k }, (_, i) => lo + ((hi - lo) * (i + 0.5)) / k);
    for (let it = 0; it < 40; it++) {
      const sum = new Float64Array(k), cnt = new Float64Array(k);
      for (let v = 0; v < 256; v++) {
        if (!hist[v]) continue;
        let best = 0, bd = Infinity;
        for (let j = 0; j < k; j++) { const d = Math.abs(v - c[j]); if (d < bd) { bd = d; best = j; } }
        sum[best] += v * hist[v]; cnt[best] += hist[v];
      }
      c = c.map((x, j) => (cnt[j] ? sum[j] / cnt[j] : x));
    }
    c.sort((x, y) => x - y);
    const t = [];
    for (let j = 0; j < n; j++) t.push((c[j] + c[j + 1]) / 2 / 255);
    for (let j = 0; j < n; j++) {
      t[j] = Math.min(0.97, Math.max(0.03, t[j]));
      if (j && t[j] <= t[j - 1] + 0.02) t[j] = Math.min(0.98, t[j - 1] + 0.02);
    }
    return t.map((x) => Math.round(x * 100) / 100);
  }

  /* ---------------------------------------------------------------- connected components */
  // value: which mask value to label. conn8: 8- vs 4-connectivity.
  function label(mask, w, h, value, conn8) {
    const N = w * h, lab = new Int32Array(N), stack = new Int32Array(N);
    const sizes = [0];
    let count = 0;
    for (let s = 0; s < N; s++) {
      if (mask[s] !== value || lab[s]) continue;
      count++;
      let sp = 0, size = 0;
      stack[sp++] = s; lab[s] = count;
      while (sp) {
        const p = stack[--sp]; size++;
        const x = p % w, y = (p - x) / w;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            if (!conn8 && dx && dy) continue;
            const xx = x + dx; if (xx < 0 || xx >= w) continue;
            const q = yy * w + xx;
            if (mask[q] === value && !lab[q]) { lab[q] = count; stack[sp++] = q; }
          }
        }
      }
      sizes.push(size);
    }
    return { lab, count, sizes };
  }

  // material islands: material (0) components, 4-connected, other than the one holding pixel 0
  function findIslands(mask, w, h) {
    const L = label(mask, w, h, 0, false);
    const main = L.lab[0];
    return { ...L, main, islands: L.count - (main ? 1 : 0) };
  }

  function removeSmall(mask, w, h, minArea) {
    if (minArea <= 1) return;
    const H = label(mask, w, h, 1, true);
    for (let p = 0; p < mask.length; p++) if (H.lab[p] && H.sizes[H.lab[p]] < minArea) mask[p] = 0;
    const M = findIslands(mask, w, h);
    for (let p = 0; p < mask.length; p++) {
      const l = M.lab[p];
      if (l && l !== M.main && M.sizes[l] < minArea) mask[p] = 1;
    }
  }

  /* ---------------------------------------------------------------- bridges */
  function rdp(pts, tol) {
    if (pts.length < 3) return pts.slice();
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const st = [[0, pts.length - 1]];
    while (st.length) {
      const [a, b] = st.pop();
      const [ax, ay] = pts[a], [bx, by] = pts[b];
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
      let md = -1, mi = -1;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs(dy * (pts[i][0] - ax) - dx * (pts[i][1] - ay)) / len;
        if (d > md) { md = d; mi = i; }
      }
      if (md > tol) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  // px (pixel-centre coords) <-> mm
  const toMM = (g, x, y) => [(x + 0.5) / g.sx, (y + 0.5) / g.sy];
  const toPX = (g, x, y) => [x * g.sx - 0.5, y * g.sy - 0.5];

  function near(a, b, tol) { return Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol; }
  function sameBridge(a, b, tol) {
    const a0 = a[0], a1 = a[a.length - 1], b0 = b[0], b1 = b[b.length - 1];
    return (near(a0, b0, tol) && near(a1, b1, tol)) || (near(a0, b1, tol) && near(a1, b0, tol));
  }

  /*
   * Dijkstra (Dial's buckets, chamfer 10/14) through cut pixels, growing out from the
   * connected sheet. Reaching an unconnected island records the route as a bridge, the island
   * joins the connected set and the search carries on from it. Routes the user removed
   * (suppressed, in mm) are skipped so the search looks for the next-best route.
   */
  function autoBridges(mask, w, h, g, suppressed, tolMM) {
    const I = findIslands(mask, w, h);
    if (!I.islands) return { bridges: [], islandCount: 0, info: I };
    const N = w * h, lab = I.lab;
    const connected = new Uint8Array(I.count + 1);
    connected[I.main] = 1;
    // boundary pixels of each material component (CSR)
    const isB = (p) => {
      const x = p % w, y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && mask[yy * w + xx] === 1) return true;
      }
      return false;
    };
    const cnt = new Int32Array(I.count + 2);
    const bflag = new Uint8Array(N);
    for (let p = 0; p < N; p++) if (lab[p] && isB(p)) { bflag[p] = 1; cnt[lab[p] + 1]++; }
    for (let i = 1; i < cnt.length; i++) cnt[i] += cnt[i - 1];
    const blist = new Int32Array(cnt[cnt.length - 1]);
    const fill = cnt.slice();
    for (let p = 0; p < N; p++) if (bflag[p]) blist[fill[lab[p]]++] = p;

    const dist = new Int32Array(N).fill(0x7fffffff);
    const parent = new Int32Array(N).fill(-1);
    const C = 15, buckets = Array.from({ length: C }, () => []);
    let pending = 0, cur = 0;
    const push = (p, d) => { buckets[d % C].push(p); pending++; };
    const seed = (l, d) => {
      for (let i = cnt[l]; i < cnt[l + 1]; i++) { const p = blist[i]; dist[p] = d; parent[p] = -1; push(p, d); }
    };
    seed(I.main, 0);
    const bridges = [];
    let left = I.islands;
    const supTol = tolMM;
    while (pending && left) {
      let bucket = buckets[cur % C];
      while (!bucket.length) { cur++; bucket = buckets[cur % C]; }
      const p = bucket.pop(); pending--;
      if (dist[p] !== cur) continue;
      const x = p % w, y = (p - x) / w;
      for (let k = 0; k < 8; k++) {
        const dx = [1, -1, 0, 0, 1, 1, -1, -1][k], dy = [0, 0, 1, -1, 1, -1, 1, -1][k];
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx;
        if (mask[q] === 0) {
          const l = lab[q];
          if (connected[l]) continue;
          // route: q (island) <- p <- parent ... <- source on connected sheet
          const path = [[xx, yy]];
          for (let r = p; r !== -1; r = parent[r]) path.push([r % w, (r / w) | 0]);
          const simp = rdp(path, 1.0).map(([px, py]) => toMM(g, px, py));
          if (suppressed && suppressed.some((s) => sameBridge(s, simp, supTol))) continue;
          connected[l] = 1; left--;
          bridges.push({ pts: simp, type: 'auto', island: l });
          seed(l, cur);
        } else {
          const nd = cur + (dx && dy ? 14 : 10);
          if (nd < dist[q]) { dist[q] = nd; parent[q] = p; push(q, nd); }
        }
      }
    }
    return { bridges, islandCount: I.islands, info: I };
  }

  // A second bridge on large islands, from the far side of the island to any other material.
  function extraBridges(mask, w, h, g, firstBridges, info, minAreaPx, suppressed, tolMM) {
    const out = [];
    const lab = info.lab;
    for (const b of firstBridges) {
      const l = b.island;
      if (!l || info.sizes[l] < minAreaPx) continue;
      const end = toPX(g, ...b.pts[0]); // island end of the route
      // farthest boundary pixel of the island from the first bridge
      let far = -1, fd = -1;
      for (let p = 0; p < lab.length; p++) {
        if (lab[p] !== l) continue;
        const x = p % w, y = (p - x) / w;
        let edge = false;
        for (let k = 0; k < 4 && !edge; k++) {
          const xx = x + [1, -1, 0, 0][k], yy = y + [0, 0, 1, -1][k];
          if (mask[yy * w + xx] === 1) edge = true;
        }
        if (!edge) continue;
        const d = (x - end[0]) ** 2 + (y - end[1]) ** 2;
        if (d > fd) { fd = d; far = p; }
      }
      if (far < 0) continue;
      // BFS through cut pixels from `far` to the nearest material that is not this island
      const prev = new Map([[far, -1]]);
      let qd = [far], found = -1, from = -1, visits = 0;
      outer: while (qd.length && visits < 400000) {
        const nx = [];
        for (const p of qd) {
          visits++;
          const x = p % w, y = (p - x) / w;
          for (let k = 0; k < 8; k++) {
            const xx = x + [1, -1, 0, 0, 1, 1, -1, -1][k], yy = y + [0, 0, 1, -1, 1, -1, 1, -1][k];
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const q = yy * w + xx;
            if (prev.has(q)) continue;
            if (mask[q] === 0) {
              if (lab[q] === l) continue;
              found = q; from = p; break outer;
            }
            prev.set(q, p); nx.push(q);
          }
        }
        qd = nx;
      }
      if (found < 0) continue;
      const path = [[found % w, (found / w) | 0]];
      for (let r = from; r !== -1 && r !== undefined; r = prev.get(r)) path.push([r % w, (r / w) | 0]);
      const simp = rdp(path, 1.0).map(([px, py]) => toMM(g, px, py));
      if (suppressed && suppressed.some((s) => sameBridge(s, simp, tolMM))) continue;
      out.push({ pts: simp, type: 'auto', island: l, extra: true });
    }
    return out;
  }

  // paint material (0) along a polyline in mm, `width` mm wide, ends pushed into the material
  function stampBridge(mask, w, h, g, ptsMM, widthMM) {
    if (ptsMM.length < 2) return;
    const r = Math.max(1.05, (widthMM / 2) * g.ppm);
    const pts = ptsMM.map(([x, y]) => toPX(g, x, y));
    // extend both ends so the strip overlaps the material it joins
    const ext = (a, b) => {
      const dx = a[0] - b[0], dy = a[1] - b[1], L = Math.hypot(dx, dy) || 1;
      return [a[0] + (dx / L) * (r + 1), a[1] + (dy / L) * (r + 1)];
    };
    pts[0] = ext(pts[0], pts[1]);
    pts[pts.length - 1] = ext(pts[pts.length - 1], pts[pts.length - 2]);
    const r2 = r * r;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-9;
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r)), x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + r));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r)), y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + r));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        let t = ((x - ax) * dx + (y - ay) * dy) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = ax + t * dx - x, ey = ay + t * dy - y;
        if (ex * ex + ey * ey <= r2) mask[y * w + x] = 0;
      }
    }
  }

  /* ---------------------------------------------------------------- tracing (marching squares) */
  /*
   * Directed segments, cut on the right-hand side (clockwise round cuts on screen, y down).
   * Corner bits: TL=8 TR=4 BR=2 BL=1 (1 = cut). Edge midpoints T,R,B,L.
   * Saddles join the cut pixels (cuts are 8-connected, material 4-connected), matching findIslands.
   */
  const SEG = {
    1: [['L', 'B']], 2: [['B', 'R']], 3: [['L', 'R']], 4: [['R', 'T']], 5: [['L', 'T'], ['R', 'B']],
    6: [['B', 'T']], 7: [['L', 'T']], 8: [['T', 'L']], 9: [['T', 'B']], 10: [['T', 'R'], ['B', 'L']],
    11: [['T', 'R']], 12: [['R', 'L']], 13: [['R', 'B']], 14: [['B', 'L']],
  };
  function trace(mask, w, h) {
    const W2 = 2 * w;
    const key = (X, Y) => Y * W2 + X; // doubled coords
    const mid = (e, x, y) => e === 'T' ? key(2 * x + 1, 2 * y) : e === 'R' ? key(2 * x + 2, 2 * y + 1)
      : e === 'B' ? key(2 * x + 1, 2 * y + 2) : key(2 * x, 2 * y + 1);
    const next = new Int32Array(W2 * 2 * h).fill(-1);
    const starts = [];
    for (let y = 0; y < h - 1; y++) {
      const r0 = y * w, r1 = r0 + w;
      for (let x = 0; x < w - 1; x++) {
        const c = (mask[r0 + x] << 3) | (mask[r0 + x + 1] << 2) | (mask[r1 + x + 1] << 1) | mask[r1 + x];
        if (c === 0 || c === 15) continue;
        for (const [a, b] of SEG[c]) { const ka = mid(a, x, y); next[ka] = mid(b, x, y); starts.push(ka); }
      }
    }
    const loops = [];
    for (const s of starts) {
      if (next[s] < 0) continue;
      const loop = [];
      let k = s;
      while (k >= 0 && next[k] >= 0) {
        const n = next[k]; next[k] = -1;
        loop.push([(k % W2) / 2, Math.floor(k / W2) / 2]);
        k = n;
      }
      if (loop.length >= 3) loops.push(loop);
    }
    return loops;
  }

  function simplifyLoop(loop, tol) {
    // drop collinear points
    const n = loop.length, pts = [];
    for (let i = 0; i < n; i++) {
      const a = loop[(i + n - 1) % n], b = loop[i], c = loop[(i + 1) % n];
      if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) !== 0) pts.push(b);
    }
    if (tol <= 0 || pts.length < 8) return pts.length >= 3 ? pts : loop;
    // split at the point farthest from pts[0], RDP each half
    let fi = 0, fd = -1;
    for (let i = 1; i < pts.length; i++) {
      const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2;
      if (d > fd) { fd = d; fi = i; }
    }
    const A = rdp(pts.slice(0, fi + 1), tol), B = rdp(pts.slice(fi).concat([pts[0]]), tol);
    const out = A.concat(B.slice(1, -1));
    return out.length >= 3 ? out : pts;
  }

  const fmt = (v) => {
    const s = v.toFixed(3);
    return s.indexOf('.') >= 0 ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  };

  /* ---------------------------------------------------------------- registration + layer marks (mm) */
  function regMarks(sheetW, sheetH, margin) {
    const a = Math.min(5, margin * 0.3), t = Math.max(0.9, Math.min(1.2, margin * 0.08));
    const c = margin / 2;
    const cross = (cx, cy) => [
      [cx - t / 2, cy - a], [cx + t / 2, cy - a], [cx + t / 2, cy - t / 2], [cx + a, cy - t / 2], [cx + a, cy + t / 2],
      [cx + t / 2, cy + t / 2], [cx + t / 2, cy + a], [cx - t / 2, cy + a], [cx - t / 2, cy + t / 2], [cx - a, cy + t / 2],
      [cx - a, cy - t / 2], [cx - t / 2, cy - t / 2],
    ];
    return [cross(c, c), cross(sheetW - c, c), cross(sheetW - c, sheetH - c), cross(c, sheetH - c)];
  }
  function layerNotches(sheetW, sheetH, margin, k) {
    const s = Math.min(2.5, margin * 0.22), gap = s * 1.4;
    const total = 5 * s + 4 * gap; // same slots on every layer, so the notches stack up
    const y = sheetH - margin / 2 - s / 2;
    const out = [];
    for (let i = 0; i < k; i++) {
      const x = sheetW / 2 - total / 2 + i * (s + gap);
      out.push([[x, y], [x + s, y], [x + s, y + s], [x, y + s]]);
    }
    return out;
  }

  const polyD = (p) => 'M' + p.map(([x, y]) => fmt(x) + ' ' + fmt(y)).join('L') + 'Z';

  /* ---------------------------------------------------------------- one layer, end to end */
  /*
   * opts: { dark (Float32Array art-sized), g (grid), threshold, detail(1..10), bridgeWidth (mm),
   *         extra (bool), manual: [[x,y]...][] (mm), suppressed: [[x,y]...][] (mm), layerIndex, layerCount, margin }
   */
  function detailParams(detail, g) {
    const t = (Math.min(10, Math.max(1, detail)) - 1) / 9;
    const smoothMM = 0.8 * (1 - t);
    const featMM = 2.5 * (1 - t) + 0.3 * t;
    const tolMM = 0.15 * (1 - t) + 0.03 * t;
    return {
      blurPx: Math.round(smoothMM * g.ppm * 0.5),
      minAreaPx: Math.PI * ((featMM / 2) * g.ppm) ** 2,
      tolPx: tolMM * g.ppm,
      featMM,
    };
  }

  function buildMask(dark, g, threshold) {
    const mask = new Uint8Array(g.w * g.h);
    for (let y = 0; y < g.ah; y++) {
      const row = (y + g.oy) * g.w + g.ox, src = y * g.aw;
      for (let x = 0; x < g.aw; x++) if (dark[src + x] >= threshold) mask[row + x] = 1;
    }
    return mask;
  }

  function processLayer(o) {
    const g = o.g, w = g.w, h = g.h;
    const dp = detailParams(o.detail, g);
    const mask = buildMask(o.blurred, g, o.threshold);
    removeSmall(mask, w, h, dp.minAreaPx);
    const cutPixelsRaw = mask.reduce((a, v) => a + v, 0);

    const islandsBefore = findIslands(mask, w, h).islands;
    const bridges = [];
    for (const m of o.manual || []) {
      stampBridge(mask, w, h, g, m, o.bridgeWidth);
      bridges.push({ pts: m, type: 'manual' });
    }
    const supTol = Math.max(1.5, o.bridgeWidth * 1.5);
    const A = autoBridges(mask, w, h, g, o.suppressed, supTol);
    let extras = [];
    if (o.extra && A.bridges.length) {
      const bigArea = 80 * g.ppm * g.ppm; // islands over ~80 mm² get a second bridge
      extras = extraBridges(mask, w, h, g, A.bridges, A.info, bigArea, o.suppressed, supTol);
    }
    for (const b of A.bridges.concat(extras)) { stampBridge(mask, w, h, g, b.pts, o.bridgeWidth); bridges.push(b); }

    // trace -> svg -> re-rasterise the exact exported path -> any island left? bridge it and go again
    let tol = dp.tolPx, svg = null, d = null, val = null, loops = null;
    const marks = regMarks(g.sheetW, g.sheetH, o.margin);
    const notches = layerNotches(g.sheetW, g.sheetH, o.margin, o.layerIndex + 1);
    const fixed = 'M0 0V' + fmt(g.sheetH) + 'H' + fmt(g.sheetW) + 'V0Z' + marks.map(polyD).join('') + notches.map(polyD).join('');
    for (let attempt = 0; attempt < 5; attempt++) {
      loops = trace(mask, w, h).map((l) => simplifyLoop(l, tol));
      d = fixed + loops.map((l) => polyD(l.map(([x, y]) => toMM(g, x, y)))).join('');
      svg = makeSVG(d, g.sheetW, g.sheetH, o.title || 'Stencil layer');
      val = validateSVG(svg, { sheetW: g.sheetW, sheetH: g.sheetH, ppm: g.ppm, marks: fixed });
      if (val.pass) break;
      const rr = val.raster;
      if (val.fillRuleMismatch) { tol = tol > 0.35 ? tol / 2 : 0; continue; }
      if (val.islands > 0) {
        const more = autoBridges(rr.mask, rr.w, rr.h, rr.g, o.suppressed, supTol);
        if (!more.bridges.length) break; // islands the user chose not to bridge
        for (const b of more.bridges) { stampBridge(mask, w, h, g, b.pts, o.bridgeWidth); bridges.push(b); }
        continue;
      }
      break;
    }
    const cutPixels = mask.reduce((a, v) => a + v, 0);
    return {
      d, svg, bridges, validation: stripRaster(val), islandsBefore,
      unbridged: val.islandList || [], cutLoops: loops.length,
      nodes: loops.reduce((a, l) => a + l.length, 0),
      cutAreaMM2: cutPixels / (g.sx * g.sy), cutAreaRawMM2: cutPixelsRaw / (g.sx * g.sy),
      featMM: dp.featMM,
    };
  }
  function stripRaster(v) { const { raster, ...rest } = v; return rest; }

  function makeSVG(d, W, H, title) {
    // ASCII only: entity-escape anything outside printable ASCII
    const esc = (s) => String(s).replace(/[<>&"]|[^\x20-\x7e]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] || '&#' + c.codePointAt(0) + ';'));
    return '<?xml version="1.0" encoding="UTF-8"?>\n'
      + `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${fmt(W)}mm" height="${fmt(H)}mm" viewBox="0 0 ${fmt(W)} ${fmt(H)}">\n`
      + `<title>${esc(title)}</title>\n`
      + `<path fill="#000000" fill-rule="evenodd" stroke="none" d="${d}"/>\n</svg>\n`;
  }

  /* ---------------------------------------------------------------- validation */
  function parseD(d) {
    const toks = d.match(/[MLHVZmlhvzCcSsQqTtAa]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
    const polys = [];
    let cur = null, x = 0, y = 0, cmd = null, bad = null;
    for (let i = 0; i < toks.length;) {
      const t = toks[i];
      if (/[A-Za-z]/.test(t)) { cmd = t; i++; if (cmd === 'Z') { if (cur) polys.push(cur); cur = null; } continue; }
      const n = (k) => parseFloat(toks[i + k]);
      if (cmd === 'M') { if (cur) { bad = 'open sub-path'; } x = n(0); y = n(1); i += 2; cur = [[x, y]]; cmd = 'L'; }
      else if (cmd === 'L') { x = n(0); y = n(1); i += 2; cur.push([x, y]); }
      else if (cmd === 'H') { x = n(0); i += 1; cur.push([x, y]); }
      else if (cmd === 'V') { y = n(0); i += 1; cur.push([x, y]); }
      else { bad = 'unsupported command ' + cmd; break; }
    }
    if (cur) bad = bad || 'open sub-path';
    return { polys, bad };
  }

  // scan-line fill at pixel centres; returns Uint8Array, 1 = filled (material)
  function rasterize(polys, w, h, sx, sy, rule) {
    const rows = Array.from({ length: h }, () => []);
    for (const p of polys) {
      for (let i = 0; i < p.length; i++) {
        const a = p[i], b = p[(i + 1) % p.length];
        const ay = a[1] * sy - 0.5, by = b[1] * sy - 0.5;
        if (ay === by) continue;
        const dir = by > ay ? 1 : -1;
        const y0 = Math.max(0, Math.ceil(Math.min(ay, by))), y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by)) - 1);
        const ax = a[0] * sx - 0.5, bx = b[0] * sx - 0.5;
        for (let y = y0; y <= y1; y++) rows[y].push(ax + ((y - ay) / (by - ay)) * (bx - ax), dir);
      }
    }
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const r = rows[y]; if (!r.length) continue;
      const idx = []; for (let i = 0; i < r.length; i += 2) idx.push(i);
      idx.sort((i, j) => r[i] - r[j]);
      let wind = 0;
      for (let k = 0; k < idx.length - 1; k++) {
        wind += r[idx[k] + 1];
        const inside = rule === 'evenodd' ? (k + 1) % 2 === 1 : wind !== 0;
        if (!inside) continue;
        const xs = Math.max(0, Math.ceil(r[idx[k]])), xe = Math.min(w - 1, Math.ceil(r[idx[k + 1]]) - 1);
        for (let x = xs; x <= xe; x++) out[y * w + x] = 1;
      }
    }
    return out;
  }

  /*
   * Checks one exported layer SVG. expect: { sheetW, sheetH, ppm, marks (the fixed outline+marks d) }
   */
  function validateSVG(svg, expect) {
    const checks = [];
    const add = (id, label, pass, detail, severity = 'error') => checks.push({ id, label, pass: !!pass, detail, severity });
    const root = (svg.match(/<svg\b[^>]*>/) || [''])[0];
    const attr = (s, n) => { const m = s.match(new RegExp('\\s' + n + '="([^"]*)"')); return m ? m[1] : null; };
    const wa = attr(root, 'width'), ha = attr(root, 'height'), vb = attr(root, 'viewBox');
    const W = expect.sheetW, H = expect.sheetH;
    const mmOK = wa && ha && /mm$/.test(wa) && /mm$/.test(ha)
      && Math.abs(parseFloat(wa) - W) < 0.01 && Math.abs(parseFloat(ha) - H) < 0.01;
    add('units', 'Size set in millimetres', mmOK, `${wa} × ${ha} (expected ${fmt(W)}mm × ${fmt(H)}mm)`);
    const vbn = (vb || '').split(/[\s,]+/).map(Number);
    add('viewbox', 'viewBox matches physical size', vbn.length === 4 && vbn[0] === 0 && vbn[1] === 0
      && Math.abs(vbn[2] - W) < 0.01 && Math.abs(vbn[3] - H) < 0.01, `viewBox="${vb}"`);
    const shapes = svg.match(/<(path|rect|circle|ellipse|line|polyline|polygon|text|image|use|foreignObject)\b/g) || [];
    const paths = shapes.filter((s) => s === '<path');
    add('single', 'One cut path (one operation in Design Space)', shapes.length === 1 && paths.length === 1,
      `${shapes.length} drawable element(s)`);
    const forbidden = /<(style|g|clipPath|mask|defs|linearGradient|radialGradient|pattern|symbol|script)\b|transform=|stroke-width/.test(svg);
    add('plain', 'No groups, transforms, styles or strokes', !forbidden, forbidden ? 'found unsupported markup' : 'plain path only');
    const pathTag = (svg.match(/<path\b[^>]*>/) || [''])[0];
    const fillOK = /fill="#000000"/.test(pathTag) && /stroke="none"/.test(pathTag);
    add('fill', 'Solid fill, no stroke', fillOK, fillOK ? 'fill #000000' : 'fill/stroke not as expected');

    const d = attr(pathTag, 'd') || '';
    const P = parseD(d);
    add('closed', 'Only closed straight-line sub-paths', !P.bad && P.polys.length > 0, P.bad || `${P.polys.length} closed sub-paths`);
    let inBounds = true;
    for (const p of P.polys) for (const [x, y] of p) if (x < -1e-6 || y < -1e-6 || x > W + 1e-6 || y > H + 1e-6) inBounds = false;
    add('bounds', 'Every cut inside the sheet', inBounds, inBounds ? 'all points within sheet' : 'points outside sheet');
    add('marks', 'Registration marks present', expect.marks ? d.startsWith(expect.marks) : true, 'four corner crosses + layer notches');

    const ppm = expect.ppm;
    const w = Math.max(16, Math.round(W * ppm)), h = Math.max(16, Math.round(H * ppm));
    const g = { w, h, sx: w / W, sy: h / H, ppm: (w / W + h / H) / 2, sheetW: W, sheetH: H };
    const nz = rasterize(P.polys, w, h, g.sx, g.sy, 'nonzero');
    const eo = rasterize(P.polys, w, h, g.sx, g.sy, 'evenodd');
    let diff = 0; for (let i = 0; i < nz.length; i++) if (nz[i] !== eo[i]) diff++;
    add('fillrule', 'Same shape under even-odd and non-zero fill', diff === 0, diff ? `${diff} pixels differ` : 'identical');
    const cut = new Uint8Array(nz.length); let cutCount = 0;
    for (let i = 0; i < nz.length; i++) { cut[i] = nz[i] ? 0 : 1; cutCount += cut[i]; }
    const I = findIslands(cut, w, h);
    const islandList = [];
    if (I.islands) {
      const acc = new Map();
      for (let p = 0; p < I.lab.length; p++) {
        const l = I.lab[p]; if (!l || l === I.main) continue;
        const x = p % w, y = (p - x) / w;
        const a = acc.get(l) || { n: 0, sx: 0, sy: 0, x0: x, x1: x, y0: y, y1: y };
        a.n++; a.sx += x; a.sy += y; a.x0 = Math.min(a.x0, x); a.x1 = Math.max(a.x1, x); a.y0 = Math.min(a.y0, y); a.y1 = Math.max(a.y1, y);
        acc.set(l, a);
      }
      for (const a of acc.values()) {
        const [cx, cy] = toMM(g, a.sx / a.n, a.sy / a.n);
        islandList.push({ x: cx, y: cy, r: Math.max(a.x1 - a.x0, a.y1 - a.y0) / g.ppm / 2 + 1.5, areaMM2: a.n / (g.sx * g.sy) });
      }
    }
    add('islands', 'No unsupported islands', I.islands === 0, I.islands ? `${I.islands} island(s) would fall out` : 'every piece is attached');
    add('hascuts', 'Layer has something to cut', cutCount > 0, cutCount ? 'ok' : 'empty layer', 'warning');
    const fit12 = (W <= CRICUT.mat12.w && H <= CRICUT.mat12.h) || (H <= CRICUT.mat12.w && W <= CRICUT.mat12.h);
    const fit24 = (W <= CRICUT.mat24.w && H <= CRICUT.mat24.h) || (H <= CRICUT.mat24.w && W <= CRICUT.mat24.h);
    add('mat', 'Fits a Cricut cutting mat', fit24, fit12 ? 'fits a 12×12 in mat' : fit24 ? 'needs a 12×24 in mat' : 'larger than a 12×24 in mat', fit12 ? 'error' : fit24 ? 'warning' : 'error');
    const nodes = P.polys.reduce((a, p) => a + p.length, 0);
    add('nodes', 'Path complexity', nodes < 60000, `${nodes} nodes${nodes > 25000 ? ' (heavy: Design Space may be slow)' : ''}`, 'warning');
    const pass = checks.every((c) => c.pass || c.severity !== 'error');
    return { pass, checks, islands: I.islands, islandList, fillRuleMismatch: diff > 0, raster: { mask: cut, w, h, g } };
  }

  return {
    CRICUT, MIN_MARGIN, computeGrid, darkness, boxBlur, autoLevels, label, findIslands, removeSmall,
    autoBridges, stampBridge, trace, simplifyLoop, regMarks, layerNotches, processLayer, detailParams,
    makeSVG, parseD, rasterize, validateSVG, toMM, toPX, fmt, polyD,
  };
});
