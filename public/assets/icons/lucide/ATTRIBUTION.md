# Interface icons — Lucide

The icons in this folder come from **Lucide** (https://lucide.dev),
`lucide-static` v1.77.0, copyright (c) Lucide Icons and Contributors,
licensed under the **ISC License** — the full licence text is in `LICENSE`
next to this file and must travel with the icons.

Only the icons the application names in `public/js/admin/icon-map.js` are
vendored here, not the whole set.

## Changes (рисунки изменены)

`scripts/build-icon-paths.mjs` turns these files into
`public/js/admin/icon-paths.js`, and in doing so:

- converts `<circle>`, `<ellipse>`, `<rect>` and `<line>` into equivalent
  `<path>` outlines (the same drawing, expressed as arcs and line segments);
- removes the licence comment, `class`, and the `stroke`, `stroke-width` and
  `fill` attributes, so each icon takes its colour from the theme
  (`currentColor`) and its line weight from the caller.

The files in this folder themselves are kept exactly as published.
