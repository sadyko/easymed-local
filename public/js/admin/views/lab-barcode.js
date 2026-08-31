// lab-barcode.js — self-contained Code128-B generator + printer-agnostic label printer.
// (единственный import — локальный модуль шрифтов печати; CDN по-прежнему нет.)
import { PRINT_FONT_FACE_CSS } from '../../shared/print-fonts.js';   // ONEST_TYPOGRAPHY_V1
// No external deps / no CDN (CSP-safe). Pattern table + checksum validated byte-for-byte
// against python-barcode 0.16.1 (pure-B vectors "ABCDEF", "LAB-9").
const C128 = "11011001100,11001101100,11001100110,10010011000,10010001100,10001001100,10011001000,10011000100,10001100100,11001001000,11001000100,11000100100,10110011100,10011011100,10011001110,10111001100,10011101100,10011100110,11001110010,11001011100,11001001110,11011100100,11001110100,11101101110,11101001100,11100101100,11100100110,11101100100,11100110100,11100110010,11011011000,11011000110,11000110110,10100011000,10001011000,10001000110,10110001000,10001101000,10001100010,11010001000,11000101000,11000100010,10110111000,10110001110,10001101110,10111011000,10111000110,10001110110,11101110110,11010001110,11000101110,11011101000,11011100010,11011101110,11101011000,11101000110,11100010110,11101101000,11101100010,11100011010,11101111010,11001000010,11110001010,10100110000,10100001100,10010110000,10010000110,10000101100,10000100110,10110010000,10110000100,10011010000,10011000010,10000110100,10000110010,11000010010,11001010000,11110111010,11000010100,10001111010,10100111100,10010111100,10010011110,10111100100,10011110100,10011110010,11110100100,11110010100,11110010010,11011011110,11011110110,11110110110,10101111000,10100011110,10001011110,10111101000,10111100010,11110101000,11110100010,10111011110,10111101110,11101011110,11110101110,11010000100,11010010000,11010011100".split(",");
const STOP = "1100011101011";  // stop symbol + 2-module termination bar

// Code128-B module string ("1"=bar, "0"=space). Encodes printable ASCII 32..126.
export function code128Modules(text) {
    const s = String(text == null ? "" : text);
    const vals = [104];                 // Start B
    let sum = 104;
    for (let i = 0; i < s.length; i++) {
        let v = s.charCodeAt(i) - 32;
        if (v < 0 || v > 94) v = 0;     // out-of-range -> space (safe)
        vals.push(v);
        sum += (i + 1) * v;             // weighted, 1-based
    }
    vals.push(sum % 103);               // checksum
    let out = "";
    for (const v of vals) out += C128[v];
    return out + STOP;
}

// Render the code as crisp SVG bars (runs of "1" merged into single rects).
export function barcodeSVG(text, opts) {
    const { height = 42, moduleW = 1.5, color = "#000" } = opts || {};
    const mods = code128Modules(text);
    const w = mods.length * moduleW;
    let rects = "", i = 0;
    while (i < mods.length) {
        if (mods[i] === "1") {
            let j = i; while (j < mods.length && mods[j] === "1") j++;
            rects += `<rect x="${(i * moduleW).toFixed(2)}" y="0" width="${((j - i) * moduleW).toFixed(2)}" height="${height}" fill="${color}"/>`;
            i = j;
        } else i++;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(1)}" height="${height}" viewBox="0 0 ${w.toFixed(1)} ${height}" preserveAspectRatio="none" shape-rendering="crispEdges">${rects}</svg>`;
}

const _esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// Printer-agnostic sample label: opens a label-sized print window and calls window.print()
// so the user picks any installed printer (Xprinter XP-365B or other). One label per call.
export function printBarcodeLabel(o) {
    const { code = "", patientName = "", mrn = "", dateStr = "", widthMm = 58, heightMm = 40, copies = 1 } = o || {};
    const svg = barcodeSVG(code, { height: Math.max(28, Math.round(heightMm * 1.2)), moduleW: 1.4 });
    const one = `
      <div class="lbl">
        <div class="top"><span class="acc">№ ${_esc(code)}</span><span class="date">${_esc(dateStr)}</span></div>
        <div class="name" title="${_esc(patientName)}">${_esc(patientName)}</div>
        ${mrn ? `<div class="mrn">ID: ${_esc(mrn)}</div>` : ""}
        <div class="bc">${svg}</div>
        <div class="bcnum">${_esc(code)}</div>
      </div>`;
    const pages = Array.from({ length: Math.max(1, copies) }, () => one).join("");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${_esc(code)}</title><style>
${PRINT_FONT_FACE_CSS}
      @page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }
      * { box-sizing: border-box; }
      html,body { margin:0; padding:0; background:#fff; }
      .lbl { width:${widthMm}mm; height:${heightMm}mm; padding:1.5mm 2.5mm; overflow:hidden;
             display:flex; flex-direction:column; justify-content:space-between;
             page-break-after:always; font-family:'Onest',Arial,Helvetica,sans-serif; color:#000; }
      .top { display:flex; justify-content:space-between; align-items:baseline; gap:4px; }
      .acc { font-size:12pt; font-weight:700; }
      .date { font-size:8pt; color:#000; }
      .name { font-size:10.5pt; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .mrn { font-size:8pt; margin-top:-1mm; }
      .bc { text-align:center; line-height:0; }
      .bc svg { width:100%; height:auto; max-height:${Math.round(heightMm * 0.42)}mm; }
      .bcnum { text-align:center; font-size:8pt; letter-spacing:2px; margin-top:0.3mm; }
    </style></head><body>${pages}
    <script>window.onload=function(){(document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve()).then(function(){try{window.focus();window.print();}catch(e){}setTimeout(function(){window.close();},400);});};<\/script>
    </body></html>`;
    const win = window.open("", "_blank", "width=460,height=380");
    if (!win) { alert("Разрешите всплывающие окна, чтобы печатать этикетки."); return; }
    win.document.write(html);
    win.document.close();
}
