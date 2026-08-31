# One typeface, one scale: Onest across the system

Approved by the owner 2026-08-31: «unify the fonts in the system. Onest — from
12.5 to 40px. Cyrillic and Latin share the same rhythm… setup fonts in the
system folder so whenever clinic uses the system gets his updates».

Two owner decisions taken explicitly:
- **The floor is real.** ~250 declarations below 12.5px are raised to 12.5.
  Dense screens get bigger text and fewer rows; that is the spec working.
- **Print is included for the FAMILY only.** Receipts, счёт/акт, lab sheets and
  labels render in Onest, but their SIZES stay their tested metrics — a thermal
  receipt bumped 25% cuts off mid-line. The 12.5 floor is a screen rule.
  **The owner test-prints one receipt and one lab sheet before release**; that
  verification is physical and cannot be automated here.

## Delivery — why this satisfies "clinics get it with updates"

`public/fonts/` carries the Onest variable font (woff2, weights 100–900,
cyrillic + latin subsets) plus `OFL.txt` (its licence requires shipping it).
Clinics are OFFLINE: no CDN, no fonts.googleapis.com at runtime — the files
live in the app folder, ride the signed release bundle like any other file, and
arrive through the normal update pipeline. One verification step: the release
bundle build must be shown to include `public/fonts/` (open the tar, look).

`@font-face` with `font-display: swap` and full fallback stack
(`'Onest', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`) so a
half-updated or font-blocked browser still renders text.

## The scale

Eight steps: **12.5 / 13.5 / 15 / 17 / 20 / 24 / 30 / 40** px, declared as
tokens (`--fs-1`…`--fs-8`) in `admin.css` `:root`. Every existing screen
font-size — CSS and inline-in-JS alike — snaps to the NEAREST step, ties
rounding UP; nothing on screen below 12.5. The implementation carries the exact
old→new census table so the rewrite is mechanical.

`--font-mono` stays monospaced (codes, barcodes, MRNs) — Onest has no mono cut.
Line-heights and spacing are deliberately untouched in this pass: moving them
with the sizes would make any breakage undiagnosable.

## The guard

`public/js/admin/__tests__/type-scale.test.mjs`, same pattern as the i18n
guard: scans every stylesheet and every view/logic module for `font-size`
values; fails on any value outside the eight steps. Named exclusions, each with
a reason in the test: the print-document files (family enforced, floor not),
`--font-mono` contexts, and third-party-free (there are none). A stray `11px`
becomes a red build, not a screenshot.

## Out of scope, deliberately

Line-height/spacing rhythm; a mono replacement; the public patient site
(`public-site.js` renders admin-side settings — included; the actual patient
booking pages if separate — checked and included only if they share admin.css);
font subsetting beyond cyrillic+latin (uzbek latin needs latin-ext — verify
Onest's latin subset covers ʻ/oʻ/gʻ apostrophe forms, and include latin-ext if
not).
