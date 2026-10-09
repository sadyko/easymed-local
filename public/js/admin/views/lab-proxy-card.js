// LIS_PROXY_V1 — карточка «LIS Proxy» на экране Лаборатория → «Анализаторы»
// (docs/specs/2026-10-09-lis-proxy-endpoint-design.md, раздел 7).
//
// LIS Proxy — программа поставщика на лабораторном ПК: передаёт Easy-Med
// результаты BS-200, BC-780 и AutoLumo A1000 и берёт рабочий список для BS-200.
// Здесь её включают, копируют адрес для каждого лабораторного ПК и меняют ключ.
// Адрес с ключом — пропуск на запись значений прибора: его видят и меняют
// администратор и лаборант (сервер — rpc/lis-proxy.js), прочие видят только
// «включён / выключен».
import { h, Icon, Tag, toast, clear } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { supabase } from '../../supabase.js';

// Ключи словаря, а не собранные строки: tr() ищет строку целиком.
const INTRO = 'Приём через LIS Proxy: программа на лабораторном ПК передаёт Easy-Med результаты BS-200, BC-780 и AutoLumo A1000 и получает рабочий список для BS-200.';
const OFF_NOTE = 'Выключен — LIS Proxy получает ответ «адрес не найден», и его результаты теряются.';
const PASTE_NOTE = 'Вставьте этот адрес в LIS Proxy на каждом лабораторном ПК (в кавычках, после -api).';
const ROTATE_Q = 'Сменить ключ? Старый адрес перестанет работать: на каждом лабораторном ПК вставьте новый адрес в LIS Proxy, иначе его результаты будут теряться.';
const ROTATED = 'Ключ сменён — обновите адрес на лабораторных ПК';
const NO_ADDR = 'Адрес этого компьютера в сети не определился. Откройте Easy-Med с другого компьютера по адресу в сети — здесь появится готовый адрес для LIS Proxy.';
const ROLE_NOTE = 'Адрес для LIS Proxy видят и меняют администратор и лаборант.';

/**
 * Адреса для показа. Сервер даёт по адресу на каждую сетевую карту ПК;
 * не дал (адресов нет) — адрес, с которого открыт Easy-Med, если это не
 * localhost (лабораторному ПК localhost бесполезен).
 */
export function proxyUrls(st, loc = (typeof window !== 'undefined' && window.location) || null) {
    if (!st || !st.enabled || !st.key) return [];
    if (Array.isArray(st.urls) && st.urls.length) return st.urls;
    const host = String((loc && loc.hostname) || '');
    if (!host || host === 'localhost' || host.startsWith('127.') || host === '::1' || host === '[::1]') return [];
    return ['http://' + host + ':' + (st.port || 8000) + '/api/lisproxy?key=' + st.key];
}

const small = { fontSize: '12.5px' };

/**
 * Выделить адрес, чтобы его скопировали Ctrl+C. Буфер обмена браузер даёт
 * только защищённой странице (https или localhost): Easy-Med, открытый по
 * http-адресу в сети, копировать сам не может. Так же — «Копировать» у команд
 * инструкции (lab-devices.js commandBox).
 */
function selectContents(el) {
    try {
        const sel = typeof window !== 'undefined' && typeof window.getSelection === 'function' ? window.getSelection() : null;
        if (!sel || typeof document.createRange !== 'function') return;
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
    } catch { /* выделение — удобство, не обязанность */ }
}

/** Нарисовать карточку в card и прочитать настройку. */
export async function mountProxyCard(card) {
    const state = { st: null, error: null, busy: false };

    async function load() {
        const { data, error } = await supabase.rpc('lis_proxy_get', {});
        state.st = error ? null : data;
        state.error = error ? (error.message || String(error)) : null;
        paint();
    }

    async function change(args, okKey) {
        if (state.busy) return;   // двойное нажатие — один вызов
        state.busy = true;
        const { data, error } = await supabase.rpc('lis_proxy_set', args);
        state.busy = false;
        if (error) { toast(trf('Не удалось изменить LIS Proxy: {msg}', { msg: error.message || error }), 'fail'); return; }
        state.st = data;
        if (okKey) toast(tr(okKey));
        paint();
    }

    function urlRow(url) {
        const code = h('code', { class: 'cell-mono', translate: 'no', style: {
            display: 'block', flex: '1 1 260px', padding: '6px 10px', background: 'var(--ink-050, #f4f6f8)', borderRadius: '6px',
            fontSize: '12.5px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', userSelect: 'all' } }, url);
        const copy = h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => copyText(url, code) },
            Icon('Copy', { size: 13 }), ' ', tr('Копировать адрес'));
        return h('div', { style: { display: 'flex', gap: '8px', alignItems: 'flex-start', flexWrap: 'wrap', marginTop: '6px' } }, code, copy);
    }

    async function copyText(text, codeEl) {
        const cb = (typeof navigator !== 'undefined' && navigator && navigator.clipboard) || null;
        try {
            if (!cb || typeof cb.writeText !== 'function') throw new Error('no clipboard');
            await cb.writeText(text);
            toast(tr('Скопировано'), 'ok');
        } catch {
            selectContents(codeEl);   // буфера нет — адрес выделен, Ctrl+C его копирует
            toast(tr('Скопируйте вручную'), 'info');
        }
    }

    function paint() {
        clear(card);
        const st = state.st;
        card.appendChild(h('div', { class: 'card-header' },
            h('h3', null, Icon('Link', { size: 15 }), ' ', 'LIS Proxy'),
            h('span', { class: 'grow' }),
            st ? Tag(st.enabled ? tr('включён') : tr('выключен'), { kind: st.enabled ? 'success' : '' }) : null,
            st && st.can_manage
                ? h('button', { class: 'btn btn-sm ' + (st.enabled ? 'btn-outline' : 'btn-primary'), type: 'button', style: { marginLeft: '8px' },
                    onclick: () => change({ enabled: !st.enabled }) }, st.enabled ? tr('Выключить') : tr('Включить'))
                : null));
        const body = h('div', { style: { padding: '0 16px 16px' } });   // поля — как у формы прибора рядом (.ld-form)
        card.appendChild(body);
        body.appendChild(h('p', { class: 'muted', style: small }, tr(INTRO)));
        if (state.error) {
            body.appendChild(h('p', { class: 'muted', style: small }, trf('Не удалось прочитать настройку LIS Proxy: {msg}', { msg: state.error })));
            return;
        }
        if (!st) return;
        if (!st.can_manage) { body.appendChild(h('p', { class: 'muted', style: small }, tr(ROLE_NOTE))); return; }
        if (!st.enabled) { body.appendChild(h('p', { class: 'muted', style: small }, tr(OFF_NOTE))); return; }
        const urls = proxyUrls(st);
        body.appendChild(h('div', { style: { fontWeight: 600, marginTop: '6px' } }, tr('Адрес для LIS Proxy')));
        if (!urls.length) body.appendChild(h('p', { class: 'muted', style: small }, tr(NO_ADDR)));
        for (const url of urls) body.appendChild(urlRow(url));
        body.appendChild(h('p', { class: 'muted', style: { ...small, marginTop: '6px' } }, tr(PASTE_NOTE)));
        body.appendChild(h('div', { style: { marginTop: '8px' } },
            h('button', { class: 'btn btn-outline btn-sm', type: 'button',
                onclick: () => { if (window.confirm(tr(ROTATE_Q))) change({ rotate: true }, ROTATED); } },
                Icon('Key', { size: 13 }), ' ', tr('Сменить ключ'))));
    }

    paint();
    await load();
    return { reload: load };
}
