// Report placeholder — one report = one route in the Reports dropdown.

import { h, Icon, PageHead, clear } from '../ui.js';

export function renderReport(container, { def, onNavigate }) {
    clear(container);
    container.appendChild(h('div', { class: 'fade-in' },
        PageHead({
            title: def.label,
            subtitle: def.description || '',
            right: [
                h('button', { class: 'btn btn-outline' }, Icon('Filter',   { size: 14 }), ' Filters'),
                h('button', { class: 'btn btn-outline' }, Icon('Download', { size: 14 }), ' Export'),
            ],
        }),
        h('div', { class: 'card', style: { padding: '60px', textAlign: 'center' } },
            h('div', {
                style: {
                    width: '64px', height: '64px',
                    borderRadius: '16px',
                    background: 'var(--primary-50)',
                    color: 'var(--primary-700)',
                    display: 'grid', placeItems: 'center',
                    margin: '0 auto 14px',
                },
            }, Icon('Chart', { size: 26 })),
            h('h3', { style: { fontSize: '17px', margin: '0 0 6px', color: 'var(--ink-900)', fontWeight: 600 } }, def.label),
            h('p', { class: 'muted', style: { margin: '0 auto 18px', maxWidth: '520px', fontSize: '13.5px' } },
                def.description || 'Report to be wired up to the underlying tables.'),
        ),
    ));
}
