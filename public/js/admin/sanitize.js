// Easy-Med — shared HTML sanitizer (STORED_XSS_HARDEN_V1)
//
// Client-authored rich text (consultation notes, shared document templates)
// can be viewed by OTHER users on the same tenant. Any such value that
// re-enters the DOM via innerHTML is a stored-XSS sink. Route every one of
// those values through sanitizeRichHtml() first.
//
// This mirrors the hardened parser that already lived inside
// service-workspace.js so both the consultation editor and the Documents
// template view share one audited implementation.

const BAD_TAGS = new Set([
    'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META',
    'BASE', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SVG', 'MATH',
]);

export function escapeHtml(input) {
    return String(input == null ? '' : input)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Keeps inline style (doctor formatting: colour/highlight/bold) but strips
// script/dangerous elements, on* handlers, dangerous style values, and
// js:/data:/vbscript: URLs. Parsing happens in an inert document — nothing
// executes during sanitization.
export function sanitizeRichHtml(input) {
    const raw = String(input == null ? '' : input);
    if (!raw) return '';
    let doc;
    try {
        doc = new DOMParser().parseFromString('<div id="__em_sani">' + raw + '</div>', 'text/html');
    } catch (e) {
        return escapeHtml(raw);
    }
    const root = doc.getElementById('__em_sani');
    if (!root) return escapeHtml(raw);
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
    const kill = [];
    let node = walker.nextNode();
    while (node) {
        if (BAD_TAGS.has(node.tagName)) {
            kill.push(node);
        } else {
            for (const attr of Array.from(node.attributes)) {
                const name = attr.name.toLowerCase();
                const val = (attr.value || '')
                    .split('')
                    .filter(function (ch) { return ch.charCodeAt(0) > 32; })
                    .join('')
                    .toLowerCase();
                if (name.indexOf('on') === 0) {
                    node.removeAttribute(attr.name);
                    continue;
                }
                if (name === 'style') {
                    if (/(javascript|vbscript|expression|url\()/i.test(val)) node.removeAttribute(attr.name);
                    continue;
                }
                if ((name === 'href' || name === 'src' || name === 'xlink:href' || name === 'formaction') &&
                    /^(javascript|data|vbscript):/.test(val)) {
                    node.removeAttribute(attr.name);
                }
            }
        }
        node = walker.nextNode();
    }
    kill.forEach(function (n) { n.remove(); });
    return root.innerHTML;
}
