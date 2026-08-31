// Placeholder card for workflow / report / unknown sections.

import { h, Icon, PageHead, clear } from '../ui.js';

export function renderPlaceholder(container, { def, view, onNavigate }) {
    const meta = def || { label: view || 'Easy-Med', description: '' };
    clear(container);
    container.appendChild(h('div', { class: 'fade-in' },
        PageHead({ title: meta.label, subtitle: meta.description || '' }),
        h('div', { class: 'card', style: { padding: '60px', textAlign: 'center' } },
            h('div', {
                style: {
                    width: '64px', height: '64px', borderRadius: '16px',
                    background: 'var(--primary-50)', color: 'var(--primary-700)',
                    display: 'grid', placeItems: 'center', margin: '0 auto 14px',
                },
            }, Icon('Settings', { size: 26 })),
            h('h3', { style: { fontSize: '17px', margin: '0 0 6px', color: 'var(--ink-900)', fontWeight: 600 } }, meta.label + ' module'),
            h('p', { class: 'muted', style: { margin: '0 auto 18px', maxWidth: '520px', fontSize: '13.5px' } },
                meta.description || 'Pick a section from the top menus to get started.'),
        ),
    ));
}
