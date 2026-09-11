# Vendored libraries

Third-party code, committed verbatim. Not ours; do not edit in place. To
change a version, re-download the exact file and update the table below.

| File | Library | Version | Licence | Source |
|---|---|---|---|---|
| `jspdf.umd.min.js` | jsPDF | 2.5.2 | MIT | https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js |
| `jspdf.plugin.autotable.min.js` | jsPDF-AutoTable | 3.8.4 | MIT | https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.4/dist/jspdf.plugin.autotable.min.js |

## Why these are committed rather than fetched

An extension page runs under `script-src 'self'`, so a CDN `<script>` is
blocked outright - a vendored copy is the only way to use a library at all.
Both builds were checked for `eval` and `new Function` (neither uses them),
which the same policy also forbids.

They back the comparison report's "Export PDF", which writes a real PDF file
to the user's downloads. The browser's own print-to-PDF was the previous
route and needed no library, but it could only ever open the print dialog.

## Fonts, and why the PDF uses ASCII marks

jsPDF's built-in fonts are the PDF base-14 set, which are WinAnsi-encoded:
they cover Latin-1 and nothing beyond it. The ballot and bullet glyphs the
report uses on screen (U+2610 / U+2611 / U+25CB / U+25CF) are outside that
range and would emit as garbage, so `compare/compare.js` draws `[x]` / `[ ]`
and `(o)` / `( )` instead. Embedding a Unicode TTF would fix that at the
cost of a few hundred KB more; it has not been worth it.
