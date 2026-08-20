// Stroke-based SVG icons — vanilla port of icons.jsx.
// Usage:  icon('Patients', { size: 18 })  →  HTMLElement (<svg>)

const NS = 'http://www.w3.org/2000/svg';

function svg(size = 18, stroke = 1.75, fill = 'none', body = '') {
    return `<svg xmlns="${NS}" aria-hidden="true" focusable="false" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

const DEFS = {
    Dashboard:   '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    Patients:    '<path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="3.5"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    Calendar:    '<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M16 3v4M8 3v4M3 10h18"/>',
    Stethoscope: '<path d="M6 3v6a4 4 0 0 0 8 0V3"/><path d="M6 3h2M12 3h2"/><path d="M10 13v2a5 5 0 0 0 5 5h0a5 5 0 0 0 5-5v-1"/><circle cx="20" cy="13" r="2"/>',
    Flask:       '<path d="M9 3h6"/><path d="M10 3v6.5L4.5 18a2 2 0 0 0 1.7 3h11.6a2 2 0 0 0 1.7-3L14 9.5V3"/><path d="M7 14h10"/>',
    Pill:        '<rect x="2.5" y="8" width="19" height="8" rx="4" transform="rotate(-30 12 12)"/><path d="M14.5 6.7l-6 10.4"/>',
    Wallet:      '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h12A2.5 2.5 0 0 1 20 7.5V8H5a2 2 0 0 0-2 2V7.5z"/><rect x="3" y="8" width="18" height="12" rx="2"/><circle cx="16.5" cy="14" r="1.25" fill="currentColor" stroke="none"/>',
    Chart:       '<path d="M4 20h16"/><path d="M7 17V9M12 17V5M17 17v-6"/>',
    Settings:    '<path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.36.16.7.4 1 .76"/>',
    Search:      '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    Bell:        '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10 21a2 2 0 0 0 4 0"/>',
    Msg:         '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
    Plus:        '<path d="M12 5v14M5 12h14"/>',
    ChevronDown: '<polyline points="6 9 12 15 18 9"/>',
    ChevronRight:'<polyline points="9 6 15 12 9 18"/>',
    ChevronLeft: '<polyline points="15 6 9 12 15 18"/>',
    ArrowRight:  '<path d="M5 12h14"/><polyline points="13 5 20 12 13 19"/>',
    ArrowUp:     '<path d="M12 19V5"/><polyline points="5 12 12 5 19 12"/>',
    ArrowDown:   '<path d="M12 5v14"/><polyline points="19 12 12 19 5 12"/>',
    Camera:      '<path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h2L9 4h6l1.5 2h2A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z"/><circle cx="12" cy="13" r="4"/>',
    // PACS / imaging viewer icons
    Scan:        '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><line x1="3" y1="12" x2="21" y2="12"/>',
    Image:       '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
    ZoomIn:      '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>',
    Contrast:    '<circle cx="12" cy="12" r="9"/><path d="M12 3v18a9 9 0 0 0 0-18z" fill="currentColor" stroke="none"/>',
    Ruler:       '<path d="M21.3 8.7l-12.6 12.6a1 1 0 0 1-1.4 0L2.7 16.7a1 1 0 0 1 0-1.4L15.3 2.7a1 1 0 0 1 1.4 0l4.6 4.6a1 1 0 0 1 0 1.4z"/><path d="M7 14l2 2"/><path d="M10 11l2 2"/><path d="M13 8l2 2"/><path d="M16 5l2 2"/>',
    Move:        '<polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/>',
    Grid:        '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    Phone:       '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.72 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0 1 22 16.92z"/>',
    Mail:        '<rect x="3" y="5" width="18" height="14" rx="2"/><polyline points="3 7 12 13 21 7"/>',
    MapPin:      '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
    Heart:       '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
    Pulse:       '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    Droplet:     '<path d="M12 2.5s7 8 7 13a7 7 0 1 1-14 0c0-5 7-13 7-13z"/>',
    Thermo:      '<path d="M10 14V4a2 2 0 1 1 4 0v10a4 4 0 1 1-4 0z"/><circle cx="12" cy="17" r="2" fill="currentColor" stroke="none"/>',
    Lungs:       '<path d="M12 4v8"/><path d="M12 12c-1.5-3-5-4-7-2-1.5 1.5-1 6 0 9 .8 2.4 3 3 4.5 1.5C11 19 12 17 12 14"/><path d="M12 12c1.5-3 5-4 7-2 1.5 1.5 1 6 0 9-.8 2.4-3 3-4.5 1.5C13 19 12 17 12 14"/>',
    Edit:        '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>',
    Trash:       '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1.5 14a2 2 0 0 1-2 1.8h-7a2 2 0 0 1-2-1.8L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>',
    Dot3:        '<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
    Filter:      '<path d="M4 5h16l-6 8v6l-4-2v-4z"/>',
    Download:    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    Print:       '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
    Check:       '<polyline points="20 6 9 17 4 12"/>',
    X:           '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    ID:          '<rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="9" cy="12" r="2.5"/><path d="M14 10h4M14 13h3"/>',
    User:        '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    Clock:       '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
    Lock:        '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',   // LICENCE_CORE_V1 — locked-module marker
    Doc:         '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/>',
    Receipt:     '<path d="M5 3v18l2.5-1.5L10 21l2-1.5L14 21l2.5-1.5L19 21V3l-2.5 1.5L14 3l-2 1.5L10 3 7.5 4.5z"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="13" y2="16"/>',
    Folder:      '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    Warning:     '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><circle cx="12" cy="17" r="0.8" fill="currentColor" stroke="none"/>',
    Help:        '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 1 1 5.8 1c0 2-3 2-3 4"/><circle cx="12" cy="17" r="0.7" fill="currentColor" stroke="none"/>',
    Building:    '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 7h2M11 7h2M15 7h2M7 11h2M11 11h2M15 11h2M7 15h2M11 15h2M15 15h2"/>',
    Bed:         '<path d="M2 20v-8a3 3 0 0 1 3-3h17v11"/><path d="M2 16h20"/><circle cx="8" cy="13" r="2"/>',
    Activity:    '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    Refresh:     '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"/>',
    Send:        '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
    Paperclip:   '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    Globe:       '<circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    Target:      '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
    Sparkles:    '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
    Megaphone:   '<path d="M3 11v2a2 2 0 0 0 2 2h2l9 5V4L7 9H5a2 2 0 0 0-2 2z"/><path d="M18 8a4 4 0 0 1 0 8"/>',
    Coins:       '<ellipse cx="9" cy="7" rx="6" ry="3"/><path d="M3 7v5c0 1.66 2.7 3 6 3"/><path d="M3 12v5c0 1.66 2.7 3 6 3"/><ellipse cx="15" cy="13" rx="6" ry="3"/><path d="M9 18c0 1.66 2.7 3 6 3s6-1.34 6-3v-5"/>',
    Layers:      '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
    Trend:       '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
    Flag:        '<path d="M4 22V4a2 2 0 0 1 2-2h11l-2 5 2 5H6"/><line x1="4" y1="22" x2="4" y2="15"/>',
    Bot:         '<rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/>',
    Headset:     '<path d="M3 14v-2a9 9 0 0 1 18 0v2"/><path d="M21 14v3a2 2 0 0 1-2 2h-1v-7h1a2 2 0 0 1 2 2z"/><path d="M3 14v3a2 2 0 0 0 2 2h1v-7H5a2 2 0 0 0-2 2z"/>',
    PhoneIn:     '<polyline points="16 2 16 8 22 8"/><line x1="22" y1="2" x2="16" y2="8"/><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.72 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0 1 22 16.92z"/>',
    PhoneOut:    '<polyline points="23 7 23 1 17 1"/><line x1="17" y1="7" x2="23" y2="1"/><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.72 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0 1 22 16.92z"/>',
    PhoneMissed: '<line x1="23" y1="1" x2="17" y2="7"/><line x1="17" y1="1" x2="23" y2="7"/><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.72 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0 1 22 16.92z"/>',
    Mic:         '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/>',
    Stop:        '<rect x="5" y="5" width="14" height="14" rx="2"/>',
    Repeat:      '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
    Pause:       '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
};

export function iconHtml(name, { size = 18, stroke = 1.75 } = {}) {
    const body = DEFS[name];
    if (!body) return svg(size, stroke, 'none', `<circle cx="12" cy="12" r="8"/>`);
    const fill = (name === 'Cross') ? 'currentColor' : 'none';
    return svg(size, stroke, fill, body);
}

export function icon(name, opts = {}) {
    const wrap = document.createElement('span');
    wrap.className = 'i';
    wrap.style.display = 'inline-flex';
    wrap.innerHTML = iconHtml(name, opts);
    return wrap.firstElementChild;
}

export const I = new Proxy({}, { get: (_, name) => (opts = {}) => iconHtml(String(name), opts) });
