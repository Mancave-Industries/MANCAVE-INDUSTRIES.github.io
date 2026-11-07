/* STENCIL LAB page logic. Heavy lifting happens in worker.js (core.js). */
(() => {
  'use strict';
  const C = window.StencilCore;
  const $ = (s) => document.querySelector(s);
  const IN = 25.4;
  const PALETTES = {
    1: ['#111111'], 2: ['#9a9a9a', '#111111'], 3: ['#c4c4c4', '#6e6e6e', '#111111'],
    4: ['#d2d2d2', '#9a9a9a', '#5a5a5a', '#111111'], 5: ['#dcdcdc', '#b0b0b0', '#808080', '#4a4a4a', '#111111'],
  };
  const SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="133.333mm" viewBox="0 0 240 160">
<defs><radialGradient id="g" cx="36%" cy="34%" r="72%"><stop offset="0" stop-color="#fff"/><stop offset=".5" stop-color="#8a8a8a"/><stop offset="1" stop-color="#000"/></radialGradient></defs>
<circle cx="62" cy="80" r="40" fill="url(#g)"/>
<circle cx="62" cy="80" r="52" fill="none" stroke="#000" stroke-width="7"/>
<text x="168" y="98" font-family="Arial Black, Arial, Helvetica, sans-serif" font-weight="900" font-size="46" text-anchor="middle">LAB</text>
<text x="168" y="130" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="17" letter-spacing="5" text-anchor="middle" fill="#555">MCI • SHED</text>
</svg>`;

  const st = {
    name: 'stencil', src: null, imgKey: 0, units: 'mm', aspect: 1,
    s: { name: 'stencil', artW: 200, artH: 200, margin: 15, layers: 3, invert: false, bridgeWidth: 1.5, extraBridges: true, layer: [] },
    result: null, paths: [], view: 'composite', tool: null,
    jobId: 0, jobMargin: {}, busy: false, pending: null, autoLevels: true,
  };
  for (let i = 0; i < 5; i++) st.s.layer.push({ threshold: 0.5, detail: 6, color: '#111111', manual: [], suppressed: [] });
  setPalette(3);

  /* ---------------------------------------------------------------- worker */
  const worker = new Worker('worker.js');
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') { $('#busyText').textContent = `Cutting layer ${m.done} of ${m.total}…`; return; }
    st.busy = false;
    if (m.type === 'error') { toast('Something went wrong: ' + m.message); setBusy(false); }
    if (m.type === 'result' && m.id === st.jobId) {
      if (m.thresholds) { m.thresholds.forEach((t, i) => { st.s.layer[i].threshold = t; }); renderLayerRows(); }
      st.result = m; m.margin = st.jobMargin[m.id];
      st.paths = m.layers.map((L) => {
        const holes = L.d.slice(rectD(m.grid).length);
        return { material: new Path2D(L.d), holes: new Path2D(holes) };
      });
      setBusy(false);
      renderTabs(); renderReport(); draw();
    }
    if (st.pending) { const p = st.pending; st.pending = null; send(p); }
  };
  const rectD = (g) => 'M0 0V' + C.fmt(g.sheetH) + 'H' + C.fmt(g.sheetW) + 'V0Z';

  let timer = 0;
  function schedule(opts = {}) {
    if (!st.src) return;
    if (opts.autoLevels) st.autoLevels = true;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const job = buildJob();
      if (!job) return;
      if (st.busy) st.pending = job; else send(job);
    }, opts.now ? 0 : 280);
  }
  function buildJob() {
    const g = C.computeGrid(st.s);
    const rgba = rasterArt(g);
    const job = {
      type: 'run', id: ++st.jobId, aw: g.aw, ah: g.ah, rgba, imgKey: st.imgKey + ':' + st.s.artW + 'x' + st.s.artH,
      settings: JSON.parse(JSON.stringify({ ...st.s, layer: st.s.layer.slice(0, st.s.layers) })), autoLevels: st.autoLevels,
    };
    st.autoLevels = false;
    st.jobMargin[job.id] = st.s.margin;
    return job;
  }
  function send(job) { st.busy = true; setBusy(true); worker.postMessage(job, [job.rgba.buffer]); }
  function setBusy(on) { $('#busy').hidden = !on; if (on) $('#busyText').textContent = 'Cutting…'; }

  function rasterArt(g) {
    const c = document.createElement('canvas');
    c.width = g.aw; c.height = g.ah;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, g.aw, g.ah);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(st.src.img, 0, 0, g.aw, g.ah);
    return ctx.getImageData(0, 0, g.aw, g.ah).data;
  }

  /* ---------------------------------------------------------------- loading artwork */
  async function loadFile(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const isSVG = file.type === 'image/svg+xml' || ext === 'svg';
    const ok = isSVG || ['image/png', 'image/jpeg'].includes(file.type) || ['png', 'jpg', 'jpeg'].includes(ext);
    if (!ok) { toast('That file type isn’t supported. Use JPG, PNG or SVG.'); return; }
    try {
      if (isSVG) await loadSVG(await file.text(), file.name);
      else await loadRaster(file, file.name);
    } catch (err) { toast('Couldn’t read that file: ' + err.message); }
  }
  function useImage(img, w, h, name, physical) {
    st.src = { img, w, h };
    st.imgKey++;
    st.name = name.replace(/\.[^.]+$/, '') || 'stencil';
    st.s.name = st.name;
    st.aspect = h / w;
    for (const L of st.s.layer) { L.manual = []; L.suppressed = []; }
    if (physical) { st.s.artW = +clamp(physical.w, 20, 1000).toFixed(2); st.s.artH = +clamp(physical.h, 20, 1000).toFixed(2); }
    else { st.s.artW = 200; st.s.artH = Math.round(200 * st.aspect * 10) / 10; }
    $('#fileName').textContent = name; $('#fileName').title = name;
    $('#empty').hidden = true;
    st.view = 'composite';
    syncSize(); schedule({ autoLevels: true, now: true });
  }
  function loadRaster(file, name) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { useImage(img, img.naturalWidth, img.naturalHeight, name); res(); };
      img.onerror = () => rej(new Error('not a readable image'));
      img.src = url;
    });
  }
  const UNIT_MM = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6 };
  function loadSVG(text, name) {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const svg = doc.documentElement;
    if (doc.querySelector('parsererror') || svg.nodeName.toLowerCase() !== 'svg') throw new Error('not a valid SVG');
    const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    const len = (v) => { const m = /^\s*([\d.]+)\s*([a-z%]*)\s*$/i.exec(v || ''); return m ? { n: parseFloat(m[1]), u: m[2].toLowerCase() } : null; };
    const W = len(svg.getAttribute('width')), H = len(svg.getAttribute('height'));
    let w = W && W.u !== '%' ? W.n * (UNIT_MM[W.u] ? UNIT_MM[W.u] * 96 / 25.4 : 1) : 0;
    let h = H && H.u !== '%' ? H.n * (UNIT_MM[H.u] ? UNIT_MM[H.u] * 96 / 25.4 : 1) : 0;
    if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
      if (!w && !h) { w = vb[2]; h = vb[3]; } else if (!h) h = w * vb[3] / vb[2]; else if (!w) w = h * vb[2] / vb[3];
    }
    if (!w || !h) { w = 1000; h = 1000; }
    const physical = W && H && UNIT_MM[W.u] && UNIT_MM[H.u] ? { w: W.n * UNIT_MM[W.u], h: H.n * UNIT_MM[H.u] } : null;
    // render at a decent pixel size; the canvas scales it to the cutting size
    const scale = Math.max(1, 2400 / Math.max(w, h));
    svg.setAttribute('width', String(w * scale)); svg.setAttribute('height', String(h * scale));
    if (!svg.getAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' });
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => { useImage(img, w, h, name, physical); res(); };
      img.onerror = () => rej(new Error('the SVG could not be drawn (it may use external images or fonts)'));
      img.src = URL.createObjectURL(blob);
    });
  }

  /* ---------------------------------------------------------------- controls */
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const toUnit = (mm) => st.units === 'in' ? +(mm / IN).toFixed(3) : +mm.toFixed(1);
  const fromUnit = (v) => st.units === 'in' ? v * IN : v;
  function syncSize() {
    $('#artW').value = toUnit(st.s.artW); $('#artH').value = toUnit(st.s.artH); $('#margin').value = toUnit(st.s.margin);
    const step = st.units === 'in' ? '0.01' : '1';
    ['#artW', '#artH', '#margin'].forEach((s) => { $(s).step = step; });
    const W = st.s.artW + 2 * st.s.margin, H = st.s.artH + 2 * st.s.margin;
    const fit12 = (W <= C.CRICUT.mat12.w && H <= C.CRICUT.mat12.h) || (H <= C.CRICUT.mat12.w && W <= C.CRICUT.mat12.h);
    const fit24 = (W <= C.CRICUT.mat24.w && H <= C.CRICUT.mat24.h) || (H <= C.CRICUT.mat24.w && W <= C.CRICUT.mat24.h);
    $('#sheetInfo').innerHTML = `Sheet with border: <b>${W.toFixed(1)} × ${H.toFixed(1)} mm</b> (${(W / IN).toFixed(2)} × ${(H / IN).toFixed(2)} in). `
      + (fit12 ? 'Fits a 12×12 in mat.' : fit24 ? 'Needs a 12×24 in mat.' : '<span style="color:var(--red)">Too big for a Cricut mat. Make it smaller.</span>');
  }
  function onSize(which) {
    let v = parseFloat($('#' + which).value);
    if (!isFinite(v) || v <= 0) return;
    v = fromUnit(v);
    if (which === 'margin') st.s.margin = clamp(v, C.MIN_MARGIN, 60);
    else {
      v = clamp(v, 20, 1000);
      const lock = $('#lock').checked;
      if (which === 'artW') { st.s.artW = v; if (lock) st.s.artH = +(v * st.aspect).toFixed(2); }
      else { st.s.artH = v; if (lock) st.s.artW = +(v / st.aspect).toFixed(2); }
    }
    syncSize(); schedule();
  }
  ['artW', 'artH', 'margin'].forEach((id) => $('#' + id).addEventListener('change', () => onSize(id)));
  $('#units').addEventListener('change', (e) => { st.units = e.target.value; syncSize(); });
  $('#lock').addEventListener('change', (e) => { if (e.target.checked && st.src) { st.aspect = st.src.h / st.src.w; st.s.artH = +(st.s.artW * st.aspect).toFixed(2); syncSize(); schedule(); } });
  $('#invert').addEventListener('change', (e) => { st.s.invert = e.target.checked; schedule({ autoLevels: true }); });
  $('#bridgeWidth').addEventListener('input', (e) => { st.s.bridgeWidth = +e.target.value; $('#bwOut').textContent = st.s.bridgeWidth.toFixed(1) + ' mm'; schedule(); });
  $('#bwOut').textContent = st.s.bridgeWidth.toFixed(1) + ' mm';
  $('#extra').addEventListener('change', (e) => { st.s.extraBridges = e.target.checked; schedule(); });
  document.querySelectorAll('input[name=layers]').forEach((r) => r.addEventListener('change', (e) => {
    st.s.layers = +e.target.value; setPalette(st.s.layers);
    if (typeof st.view === 'number' && st.view >= st.s.layers) st.view = 'composite';
    renderLayerRows(); schedule({ autoLevels: true });
  }));
  $('#autoTones').addEventListener('click', () => schedule({ autoLevels: true, now: true }));
  function setPalette(n) { PALETTES[n].forEach((c, i) => { st.s.layer[i].color = c; }); }

  function renderLayerRows() {
    const box = $('#layerRows');
    box.innerHTML = '';
    for (let i = 0; i < st.s.layers; i++) {
      const L = st.s.layer[i];
      const row = document.createElement('div');
      row.className = 'lrow';
      row.innerHTML = `<input type="color" class="swatch" value="${L.color}" aria-label="Preview colour for layer ${i + 1}" title="Preview colour">
        <div class="lname"><span>Layer ${i + 1}</span><span class="label muted">${i === 0 ? 'lightest' : i === st.s.layers - 1 ? 'darkest' : ''}</span></div>
        <div class="sliders">
          <label>Tone <output>${Math.round(L.threshold * 100)}%</output><input type="range" min="2" max="98" step="1" value="${Math.round(L.threshold * 100)}" data-k="threshold" aria-label="Layer ${i + 1} tone threshold"></label>
          <label>Detail <output>${L.detail}</output><input type="range" min="1" max="10" step="1" value="${L.detail}" data-k="detail" aria-label="Layer ${i + 1} detail level"></label>
        </div>`;
      row.querySelector('.swatch').addEventListener('input', (e) => { L.color = e.target.value; draw(); });
      row.querySelectorAll('input[type=range]').forEach((r) => r.addEventListener('input', () => {
        const v = +r.value;
        if (r.dataset.k === 'threshold') { L.threshold = v / 100; r.previousElementSibling.textContent = v + '%'; }
        else { L.detail = v; r.previousElementSibling.textContent = v; }
        schedule();
      }));
      box.appendChild(row);
    }
  }

  /* ---------------------------------------------------------------- file input / drop */
  $('#file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) loadFile(f); e.target.value = ''; });
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('over')));
  drop.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) loadFile(f); });
  $('#sample').addEventListener('click', () => loadSVG(SAMPLE_SVG, 'mci-sample.svg').catch((e) => toast(e.message)));

  /* ---------------------------------------------------------------- tabs + report */
  function renderTabs() {
    const t = $('#tabs');
    t.innerHTML = '';
    const mk = (key, text, ok) => {
      const b = document.createElement('button');
      b.type = 'button'; b.role = 'tab'; b.setAttribute('aria-selected', String(st.view === key));
      b.innerHTML = (ok === undefined ? '' : `<span class="dot ${ok ? 'ok' : 'bad'}"></span>`) + text;
      b.addEventListener('click', () => { st.view = key; renderTabs(); draw(); updateTools(); });
      t.appendChild(b);
    };
    mk('composite', 'Composite');
    if (st.result) st.result.layers.forEach((L, i) => mk(i, 'Layer ' + (i + 1), L.validation.pass));
    updateTools();
  }
  // set-level check: every layer has the identical sheet outline and registration crosses
  function setLevel() {
    const R = st.result;
    if (!R) return { ok: false, issues: [] };
    const g = R.grid;
    const prefix = rectD(g) + C.regMarks(g.sheetW, g.sheetH, R.margin).map(C.polyD).join('');
    const issues = R.layers.every((L) => L.d.startsWith(prefix)) ? [] : ['registration marks differ between layers'];
    return { ok: issues.length === 0, issues };
  }
  function renderReport() {
    const R = st.result, box = $('#layerReports');
    box.innerHTML = '';
    if (!R) return;
    const set = setLevel();
    const allOk = R.layers.every((L) => L.validation.pass) && set.ok;
    const g = R.grid;
    $('#badge').className = 'badge ' + (allOk ? 'ok' : 'bad');
    $('#badge').textContent = allOk ? 'Cut-ready' : 'Not cut-ready';
    const failing = R.layers.map((L, i) => (L.validation.pass ? null : i + 1)).filter(Boolean);
    $('#verdictText').textContent = allOk
      ? `All ${R.layers.length} layer${R.layers.length > 1 ? 's' : ''} passed. Each sheet is ${C.fmt(g.sheetW)} × ${C.fmt(g.sheetH)} mm.`
      : `Layer ${failing.join(', ')} failed validation${set.issues.length ? '; ' + set.issues.join(', ') : ''}. Fix it before cutting: open the layer and add a bridge to each red-ringed island.`;
    R.layers.forEach((L, i) => {
      const v = L.validation;
      const auto = L.bridges.filter((b) => b.type === 'auto').length, man = L.bridges.filter((b) => b.type === 'manual').length;
      const el = document.createElement('details');
      el.className = 'lrep';
      if (!v.pass) el.open = true;
      el.innerHTML = `<summary><b>Layer ${i + 1}</b><span class="st ${v.pass ? 'ok' : 'bad'}">${v.pass ? 'Cut-ready' : 'Failed'}</span>
        <span class="facts">${L.islandsBefore} island${L.islandsBefore === 1 ? '' : 's'} found · ${auto} auto + ${man} manual bridge${auto + man === 1 ? '' : 's'} · ${L.cutLoops} cuts · ${L.nodes} nodes</span></summary>
        <ul>${v.checks.map((c) => `<li class="${c.pass ? '' : c.severity === 'error' ? 'fail' : 'warn'}"><span>${c.pass ? '✓' : c.severity === 'error' ? '✕' : '!'}</span><span class="m">${c.label}</span><span class="d">${esc(c.detail)}</span></li>`).join('')}</ul>`;
      box.appendChild(el);
    });
    // export buttons
    $('#zipBtn').disabled = false;
    $('#zipBtn').textContent = allOk ? 'Download ZIP (cut-ready)' : 'Download ZIP (not validated)';
    const sb = $('#svgBtns'); sb.innerHTML = '';
    R.layers.forEach((L, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn small';
      b.textContent = `Layer ${i + 1} SVG`;
      b.addEventListener('click', () => saveBlob(new Blob([L.svg], { type: 'image/svg+xml' }), fileName(i)));
      sb.appendChild(b);
    });
  }
  const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

  /* ---------------------------------------------------------------- drawing */
  const canvas = $('#canvas'), ctx = canvas.getContext('2d');
  let view = { scale: 1, ox: 0, oy: 0 }, drag = null, hover = null;
  function fit() {
    const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(r.width * dpr)); canvas.height = Math.max(1, Math.round(r.height * dpr));
  }
  new ResizeObserver(() => { fit(); draw(); }).observe(canvas);
  function draw() {
    const W = canvas.width, H = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#050505'; ctx.fillRect(0, 0, W, H);
    const R = st.result;
    renderLegend();
    if (!R) return;
    const g = R.grid;
    const scale = Math.min(W / g.sheetW, H / g.sheetH) * 0.94;
    view = { scale, ox: (W - g.sheetW * scale) / 2, oy: (H - g.sheetH * scale) / 2 };
    ctx.setTransform(scale, 0, 0, scale, view.ox, view.oy);
    if (st.view === 'composite') {
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, g.sheetW, g.sheetH);
      st.paths.forEach((p, i) => { ctx.fillStyle = st.s.layer[i].color; ctx.fill(p.holes, 'nonzero'); });
      ctx.lineWidth = 1 / scale; ctx.strokeStyle = '#555'; ctx.strokeRect(0, 0, g.sheetW, g.sheetH);
      return;
    }
    const i = st.view, L = R.layers[i];
    if (!L) return;
    ctx.fillStyle = '#e8e8e4'; ctx.fill(st.paths[i].material, 'evenodd');
    // bridges
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const b of L.bridges) {
      ctx.beginPath(); b.pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.lineWidth = st.s.bridgeWidth;
      ctx.strokeStyle = hover === b ? 'rgba(217,38,44,.95)' : b.type === 'manual' ? 'rgba(80,80,255,.55)' : 'rgba(217,38,44,.5)';
      ctx.stroke();
    }
    // unbridged islands
    for (const isl of L.unbridged) {
      ctx.beginPath(); ctx.arc(isl.x, isl.y, isl.r, 0, Math.PI * 2);
      ctx.lineWidth = 3 / scale; ctx.strokeStyle = '#d9262c'; ctx.setLineDash([8 / scale, 5 / scale]); ctx.stroke(); ctx.setLineDash([]);
    }
    if (drag) {
      ctx.beginPath(); ctx.moveTo(...drag.a); ctx.lineTo(...drag.b);
      ctx.lineWidth = st.s.bridgeWidth; ctx.strokeStyle = 'rgba(80,80,255,.8)'; ctx.stroke();
    }
  }
  function renderLegend() {
    const lg = $('#legend');
    if (!st.result) { lg.innerHTML = ''; return; }
    lg.innerHTML = st.view === 'composite'
      ? 'Painted result on white, layers sprayed in order' + st.s.layer.slice(0, st.s.layers).map((L, i) => `<span><i style="background:${L.color}"></i>Layer ${i + 1}</span>`).join('')
      : '<span><i style="background:#e8e8e4"></i>Stencil sheet</span><span><i style="background:#050505"></i>Cut out</span><span><i style="background:rgba(217,38,44,.6)"></i>Auto bridge</span><span><i style="background:rgba(80,80,255,.6)"></i>Your bridge</span><span><i style="border:2px dashed #d9262c"></i>Unsupported island</span>';
  }
  window.addEventListener('resize', () => { fit(); draw(); });

  /* ---------------------------------------------------------------- bridge tools */
  function updateTools() {
    const layerView = typeof st.view === 'number';
    document.querySelectorAll('.tool').forEach((b) => { b.disabled = !layerView; b.setAttribute('aria-pressed', String(layerView && st.tool === b.dataset.tool)); });
    $('#resetBridges').disabled = !layerView;
    $('#viewer').className = 'viewer ' + (layerView && st.tool ? st.tool : '');
    $('#toolHint').textContent = !layerView ? 'Pick a layer tab to edit its bridges.'
      : st.tool === 'add' ? 'Drag across a gap, from the loose piece to the sheet, to draw a bridge.'
      : st.tool === 'remove' ? 'Tap a bridge to remove it. Automatic bridges move to the next best spot.'
      : 'Red strips are automatic bridges, blue ones are yours.';
  }
  document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => { st.tool = st.tool === b.dataset.tool ? null : b.dataset.tool; updateTools(); }));
  $('#resetBridges').addEventListener('click', () => {
    if (typeof st.view !== 'number') return;
    const L = st.s.layer[st.view]; L.manual = []; L.suppressed = []; schedule({ now: true });
  });
  const toMM = (e) => {
    const r = canvas.getBoundingClientRect(), dpr = canvas.width / r.width;
    return [((e.clientX - r.left) * dpr - view.ox) / view.scale, ((e.clientY - r.top) * dpr - view.oy) / view.scale];
  };
  function nearestBridge(p) {
    const L = st.result && st.result.layers[st.view]; if (!L) return null;
    let best = null, bd = Infinity;
    for (const b of L.bridges) for (let k = 0; k < b.pts.length - 1; k++) {
      const d = segDist(p, b.pts[k], b.pts[k + 1]); if (d < bd) { bd = d; best = b; }
    }
    const tol = Math.max(3, 14 * (canvas.width / canvas.getBoundingClientRect().width) / view.scale);
    return bd <= tol ? best : null;
  }
  function segDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-9;
    const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2, 0, 1);
    return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (typeof st.view !== 'number' || !st.tool || !st.result) return;
    const p = toMM(e);
    if (st.tool === 'add') { drag = { a: p, b: p }; canvas.setPointerCapture(e.pointerId); draw(); }
    else {
      const b = nearestBridge(p);
      if (!b) { toast('No bridge there. Tap on a red or blue strip.'); return; }
      const L = st.s.layer[st.view];
      if (b.type === 'manual') L.manual = L.manual.filter((m) => !(m[0][0] === b.pts[0][0] && m[0][1] === b.pts[0][1]));
      else L.suppressed.push(b.pts);
      hover = null; schedule({ now: true });
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (drag) { drag.b = toMM(e); draw(); return; }
    if (st.tool === 'remove' && typeof st.view === 'number') { const b = nearestBridge(toMM(e)); if (b !== hover) { hover = b; draw(); } }
  });
  canvas.addEventListener('pointerup', () => {
    if (!drag) return;
    const { a, b } = drag; drag = null;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1) { draw(); toast('Drag across the gap to draw a bridge.'); return; }
    st.s.layer[st.view].manual.push([a, b]);
    schedule({ now: true });
  });

  /* ---------------------------------------------------------------- export */
  const slug = (s) => (s || 'stencil').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'stencil';
  function fileName(i) {
    const R = st.result, n = R.layers.length, ok = R.layers[i].validation.pass && setLevel().ok;
    return `${slug(st.name)}-layer-${i + 1}-of-${n}-${ok ? 'cut-ready' : 'NOT-VALIDATED'}.svg`;
  }
  function compositeSVG() {
    const R = st.result, g = R.grid;
    return '<?xml version="1.0" encoding="UTF-8"?>\n'
      + `<svg xmlns="http://www.w3.org/2000/svg" width="${C.fmt(g.sheetW)}mm" height="${C.fmt(g.sheetH)}mm" viewBox="0 0 ${C.fmt(g.sheetW)} ${C.fmt(g.sheetH)}">\n`
      + '<title>Composite preview: NOT FOR CUTTING</title>\n'
      + `<rect width="${C.fmt(g.sheetW)}" height="${C.fmt(g.sheetH)}" fill="#ffffff"/>\n`
      + R.layers.map((L, i) => `<path fill="${st.s.layer[i].color}" d="${L.d.slice(rectD(g).length)}"/>`).join('\n') + '\n</svg>\n';
  }
  function compositePNG() {
    const g = st.result.grid, k = Math.min(6, 3000 / Math.max(g.sheetW, g.sheetH));
    const c = document.createElement('canvas'); c.width = Math.round(g.sheetW * k); c.height = Math.round(g.sheetH * k);
    const x = c.getContext('2d'); x.scale(k, k);
    x.fillStyle = '#fff'; x.fillRect(0, 0, g.sheetW, g.sheetH);
    st.paths.forEach((p, i) => { x.fillStyle = st.s.layer[i].color; x.fill(p.holes, 'nonzero'); });
    return new Promise((res) => c.toBlob(res, 'image/png'));
  }
  function reportText() {
    const R = st.result, g = R.grid, all = R.layers.every((L) => L.validation.pass) && setLevel().ok;
    const lines = [`STENCIL LAB validation report`, `Artwork: ${st.name}`, `Created: ${new Date().toISOString()}`,
      `Sheet size (every layer): ${C.fmt(g.sheetW)} x ${C.fmt(g.sheetH)} mm (${(g.sheetW / IN).toFixed(3)} x ${(g.sheetH / IN).toFixed(3)} in)`,
      `Artwork size: ${C.fmt(st.s.artW)} x ${C.fmt(st.s.artH)} mm, border ${C.fmt(st.s.margin)} mm`,
      `Bridge width: ${st.s.bridgeWidth} mm`, `Overall: ${all ? 'CUT-READY' : 'NOT VALIDATED: do not cut'}`, ''];
    R.layers.forEach((L, i) => {
      lines.push(`Layer ${i + 1} of ${R.layers.length}: ${L.validation.pass ? 'CUT-READY' : 'FAILED'}  (tone ${Math.round(st.s.layer[i].threshold * 100)}%, detail ${st.s.layer[i].detail})`);
      lines.push(`  islands found ${L.islandsBefore}, bridges ${L.bridges.length}, cuts ${L.cutLoops}, nodes ${L.nodes}`);
      L.validation.checks.forEach((c) => lines.push(`  [${c.pass ? 'PASS' : c.severity === 'error' ? 'FAIL' : 'WARN'}] ${c.label}: ${c.detail}`));
      lines.push('');
    });
    return lines.join('\r\n');
  }
  const HOWTO = [
    'HOW TO CUT THESE IN CRICUT DESIGN SPACE', '',
    '1. Upload > Upload image > choose one layer SVG > Upload > select it > Add to canvas.',
    '2. Check the size panel shows the sheet size from validation-report.txt. Do not resize.',
    '3. Each file is one cut operation. Click Make, put stencil film or vinyl on the mat and cut.',
    '4. Repeat for each layer. All layers share the same sheet outline and four corner crosses.',
    '   The small square notches along the bottom edge show the layer number.',
    '5. Spray layer 1 first (lightest). Line up the next sheet on the corner crosses and keep going.',
    '', 'Files in preview/ are for looking at only. Do not cut them.',
  ].join('\r\n');
  $('#zipBtn').addEventListener('click', async () => {
    const R = st.result; if (!R) return;
    const all = R.layers.every((L) => L.validation.pass) && setLevel().ok;
    if (!all) toast('Heads up: some layers failed validation. Their files are marked NOT-VALIDATED.');
    const zip = new JSZip();
    R.layers.forEach((L, i) => zip.file(fileName(i), L.svg));
    zip.file(`preview/${slug(st.name)}-composite-preview.png`, await compositePNG());
    zip.file(`preview/${slug(st.name)}-composite-preview-NOT-FOR-CUTTING.svg`, compositeSVG());
    zip.file('validation-report.txt', reportText());
    zip.file('HOW-TO-CUT.txt', HOWTO);
    zip.file('settings.json', JSON.stringify({ app: 'MCI Stencil Lab', ...st.s, layer: st.s.layer.slice(0, st.s.layers) }, null, 2));
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    saveBlob(blob, `${slug(st.name)}-${R.layers.length}-layer-stencil-${all ? 'cut-ready' : 'NOT-VALIDATED'}.zip`);
  });
  function saveBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  let toastT = 0;
  function toast(msg) {
    let t = $('.toast'); if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg; clearTimeout(toastT); toastT = setTimeout(() => t.remove(), 4200);
  }

  // first paint
  syncSize(); renderLayerRows(); renderTabs(); fit(); draw();
  window.__stencilLab = st; // used by the automated tests
})();
