# MCI App Shelf

Source for **apps.mancaveindustries.store**: the Mancave Industries App Shelf and its first app, **Stencil Lab**.
It is separate from the shop site (repo root, GitHub Pages) and from the Game Shed (`Gameshed` repo). Nothing here changes either.

Static site, no build step. `public/` is what gets deployed (Cloudflare Pages project `mci-app-shelf`).

```
public/
  index.html            App Shelf landing page
  shelf.css             shared MCI look (black/white industrial, red for warnings)
  _headers              security headers + CSP for Cloudflare Pages
  stencil-lab/
    index.html app.css app.js   the interface
    worker.js           runs the image work off the main thread
    core.js             the engine: tones, islands, bridges, tracing, SVG export, validation
    vendor/jszip.min.js ZIP export (JSZip 3.10.1)
tests/
  core.test.js          engine unit tests      (npm run test:unit)
  e2e.js                browser tests in Chromium, re-checks every exported file independently
  fixtures/             PNG, JPG, SVG test artwork
```

## How Stencil Lab works

1. Artwork (JPG/PNG/SVG) is drawn at the cutting size, up to 10 px/mm (about 2.2 MP per sheet).
2. Tones are split into 1–5 layers (k-means on the tone histogram; adjustable per layer). Layers are cumulative:
   layer 1 is the lightest tone and is sprayed first; each later layer adds darker tones on top.
3. Detail (per layer) sets smoothing, the smallest cut/piece kept, and how tightly paths follow the artwork.
4. Islands = pieces of sheet not attached to the border (4-connected). Each gets a bridge along the shortest
   route back to the sheet (Dijkstra through the cut area); large islands get a second bridge from the far side.
   Users can add bridges by dragging and remove them by tapping (a removed automatic bridge moves to the next best route).
5. Cuts are traced (marching squares), simplified, and written as **one `<path>`**: sheet outline + four corner
   registration crosses + layer-number notches + all cuts. The outline is wound opposite to the cuts, so
   even-odd and non-zero fill give the same shape. Size is in `mm`, viewBox in mm.
6. Validation re-reads the exported SVG text, rasterises it under both fill rules and re-checks for islands.
   If tracing created one, it bridges it and traces again. Files are only named `cut-ready` when every check passes.

## Test

```
npm install
npm test        # unit + browser tests (needs Playwright's Chromium)
```

## Deploy

Preview: `npm run deploy:preview` (needs a Cloudflare API token with Pages edit rights).
Production (apps.mancaveindustries.store) is a separate, approved step.
