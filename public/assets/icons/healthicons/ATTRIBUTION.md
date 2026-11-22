# Medical menu icons — Healthicons

The icons in this folder come from **Healthicons** (https://healthicons.org),
package `healthicons` v3.1.0 (outline, 24px), by Resolve to Save Lives and
contributors. The icons are dedicated to the public domain under
**CC0 1.0 Universal** — see `LICENSE` next to this file. No attribution is
required; it is given anyway.

Only the icons the application names in `public/js/admin/icon-map.js`
(the `Nav…` entries for the medical sections of the menu) are vendored here.

## Changes (рисунки изменены)

`scripts/build-icon-paths.mjs` turns these files into
`public/js/admin/icon-paths.js`: it keeps each outline and its `fill-rule` /
`clip-rule`, and removes the `fill="currentColor"` on each path — the colour
is set once on the outer `<svg>` by `public/js/admin/icons.js`, which also
crops the view box to 2…22 so these icons match the optical size of the
line icons next to them.

The files in this folder themselves are kept exactly as published.
