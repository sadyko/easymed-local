// LAB_SETTINGS_V1 — Настройки → «Лаборатория и диагностика».
//
// The editor this screen used to contain now lives in views/lab-panels.js
// (LAB_PANELS_EDITOR_V1, 2026-08-24). This file is what is left of the screen:
// the page head, the way back to Настройки, and the mount call. Everything the
// admin sees below the title is byte-for-byte the same editor a lab technician
// reaches through Лаборатория → «Панели» — one implementation, two entry
// points, so a fix to reference-range saving can never land on only one of them.
import { h, clear } from '../ui.js';
import { mountLabPanels, LAB_BUILD } from './lab-panels.js';

export async function renderLabSettings(container, { onNavigate } = {}) {
    clear(container);

    const body = h('div');

    container.appendChild(h('div', { class: 'fade-in' },
        h('div', { class: 'page-head' },
            h('div', { class: 'row', style: { gap: '12px', alignItems: 'center' } },
                h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => onNavigate && onNavigate('settings') }, '← Настройки'),
                h('div', { style: { minWidth: '0' } },
                    h('h1', { class: 'page-title' },
                        'Лаборатория и диагностика',
                        // Visible build marker, following the CRM's v11 pattern. Changing
                        // the hash (#settings -> #lab-settings) does NOT reload the app,
                        // so new JavaScript only arrives on a full page reload — without a
                        // marker there is no way to tell which build you are looking at,
                        // and "I can't see any changes" is impossible to diagnose.
                        h('span', { class: 'muted', style: { fontSize: '10px', opacity: '0.6', marginLeft: '8px', fontWeight: '400' } }, LAB_BUILD)),
                    h('p', { class: 'page-subtitle' }, 'Панели исследований, показатели и референсные значения. Создайте панели своей клиники и заполните референсные значения.')),
            ),
        ),
        body,
    ));

    await mountLabPanels(body);
}
