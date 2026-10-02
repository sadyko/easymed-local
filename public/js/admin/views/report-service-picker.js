// JOURNALS_V1_SERVICE (2026-10-02) — «УСЛУГИ» ЖУРНАЛА: ОКНО ВЫБОРА.
//
// Владелец: журнал не «по услугам», а один — услуги выбирают из списка.
// Набрал «УЗИ», нажал «Выбрать все найденные» — отмечены все найденные УЗИ.
// Выбор помнится в этом браузере, и только как удобство: пропал (другой
// компьютер, очищенный браузер, закрытое хранилище) — человек выберет снова,
// отчёт от этого не меняется. Поиск — тот же, что у колл-центра и регистратуры
// (service-search.js filterServicePool): одно правило «что значит найти услугу».
//
// Окно не ходит в сеть само: каталог ему даёт вызывающий (loadCatalog), поэтому
// его проверяет тест на поддельном DOM.
import { h, clear, toast } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { filterServicePool } from './service-search.js';

/** Тот же предел, что у сервера (server/services/domain/journal-rules.js) — тест сверяет. */
export const JOURNAL_SERVICE_MAX = 2000;
/** Сколько строк рисует список; «Выбрать все найденные» отмечает все найденные. */
export const PICKER_LIST_CAP = 500;
// JOURNALS_V1_RJ2C (ревью F7) — выбор помнится у каждого СОТРУДНИКА свой: на
// общем компьютере регистратуры следующий сотрудник не видит выбор предыдущего.
// Прежний общий ключ (без сотрудника) не читается — неизвестно, чей он, — и
// убирается при первом обращении.
const LEGACY_KEY = (kind) => 'easymed_report_services_' + kind;
const validUserId = (uid) => { const n = Number(uid); return uid != null && uid !== '' && Number.isSafeInteger(n) && n > 0 ? n : null; };
/** Ключ запомненного выбора: вид отчёта + сотрудник; сотрудник неизвестен — null (не помним). */
export function rememberKey(kind, userId) {
    const uid = validUserId(userId);
    return uid == null ? null : 'easymed_report_services_' + kind + '_u' + uid;
}
/** Сотрудник этой сессии (оболочка кладёт его в window.easymed.state.user) или null. */
export function currentUserId() {
    try {
        const w = globalThis.window;
        return validUserId(w && w.easymed && w.easymed.state && w.easymed.state.user && w.easymed.state.user.id);
    } catch { return null; }
}
const tooManyText = () => trf('Не больше {max} услуг в одном журнале — уточните поиск.', { max: JOURNAL_SERVICE_MAX });

/** Целые > 0, без повторов, в порядке выбора. */
export function cleanServiceIds(ids) {
    const out = [];
    const seen = new Set();
    for (const v of Array.isArray(ids) ? ids : []) {
        const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN);
        if (Number.isSafeInteger(n) && n > 0 && !seen.has(n)) { seen.add(n); out.push(n); }
    }
    return out;
}

/** Хранилище браузера или null: доступ к нему сам может бросить (приватное окно, запрет). */
export function browserStorage() {
    try { return globalThis.localStorage || null; } catch { return null; }
}

function dropLegacy(storage, kind) {
    try { if (storage && storage.removeItem) storage.removeItem(LEGACY_KEY(kind)); } catch { /* не убралось — всё равно не читается */ }
}

// Выбор больше предела (записан старой версией или руками) не обрезается
// молча до 2000: такой выбор не наш — пусто, человек выберет снова.
export function loadRememberedServices(storage, kind, userId) {
    try {
        if (!storage) return [];
        dropLegacy(storage, kind);
        const key = rememberKey(kind, userId);
        if (!key) return [];
        const v = JSON.parse(storage.getItem(key) || '[]');
        if (!Array.isArray(v)) return [];
        const ids = cleanServiceIds(v);
        return ids.length > JOURNAL_SERVICE_MAX ? [] : ids;
    } catch { return []; }
}

/** Записать выбор; больше предела или без сотрудника — не пишется. true — записано. */
export function rememberServices(storage, kind, ids, userId) {
    try {
        if (!storage) return false;
        dropLegacy(storage, kind);
        const key = rememberKey(kind, userId);
        const clean = cleanServiceIds(ids);
        if (!key || clean.length > JOURNAL_SERVICE_MAX) return false;
        storage.setItem(key, JSON.stringify(clean));
        return true;
    } catch { return false; /* удобство, не данные: не записалось — выберут снова */ }
}

export function findServices(catalog, query) {
    return filterServicePool(catalog, { query });
}

export function selectAllFound(selected, found) {
    return cleanServiceIds([...(selected || []), ...(found || []).map((sv) => sv.id)]);
}

export function servicesButtonText(n) {
    return trf('Выбрать услуги ({n})', { n: Number(n) || 0 });
}

/**
 * Окно выбора. selected — уже выбранные id; onApply(ids) — «Готово»;
 * loadCatalog() → Promise<[{ id, name, active }]>. Возвращает { overlay, close }.
 */
export function openReportServicePicker({ selected = [], onApply, loadCatalog }) {
    let chosen = new Set(cleanServiceIds(selected));
    let catalog = [];
    let query = '';
    // Конструктор отчёта лежит на z-index 150 — окно выбора над ним.
    const overlay = h('div', { class: 'modal', style: { zIndex: '160' } });
    // Конструктор закрывается по Esc своим слушателем документа. Esc здесь
    // закрывает только окно выбора: слушатель — в фазе перехвата, событие дальше
    // не идёт (иначе закрылся бы и конструктор, а окно повисло бы над хабом).
    const onKey = (e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        close();
    };
    function close() {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
    }
    document.addEventListener('keydown', onKey, true);
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
    const countEl = h('span', { class: 'muted', style: { fontSize: '12.5px' } });
    const list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', maxHeight: '52vh', overflow: 'auto', marginTop: '10px' } },
        h('div', { class: 'muted', style: { fontSize: '13.5px', padding: '12px 0' } }, tr('Загрузка…')));
    const search = h('input', {
        class: 'inp', type: 'text', placeholder: 'Найти услугу…', 'aria-label': 'Найти услугу…',
        style: { width: '100%', boxSizing: 'border-box' },
        oninput: (e) => { query = String((e.target || e.currentTarget).value || ''); paintList(); },
    });
    const paintCount = () => { countEl.textContent = trf('Выбрано: {n}', { n: chosen.size }); };
    function row(sv) {
        const id = Number(sv.id);
        const cb = h('input', {
            type: 'checkbox', checked: chosen.has(id),
            onchange: (e) => {
                const box = e.target || e.currentTarget;
                if (box.checked) {
                    // JOURNALS_V1_RJ2C (ревью F7) — предел и у отдельной галочки.
                    if (!chosen.has(id) && chosen.size >= JOURNAL_SERVICE_MAX) {
                        box.checked = false;
                        toast(tooManyText(), 'fail');
                        return;
                    }
                    chosen.add(id);
                } else chosen.delete(id);
                paintCount();
            },
        });
        return h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 4px', fontSize: '13.5px', cursor: 'pointer' } },
            cb, h('span', null, sv.name || '—'),
            Number(sv.active) === 0 ? h('span', { class: 'muted', style: { fontSize: '12.5px' } }, tr('не активна')) : null);
    }
    function paintList() {
        clear(list);
        const found = findServices(catalog, query);
        if (!found.length) list.appendChild(h('div', { class: 'muted', style: { fontSize: '13.5px', padding: '12px 0' } }, tr('Ничего не найдено.')));
        for (const sv of found.slice(0, PICKER_LIST_CAP)) list.appendChild(row(sv));
        if (found.length > PICKER_LIST_CAP) {
            list.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '8px 4px' } },
                trf('Показаны первые {n} из {total} — уточните поиск. «Выбрать все найденные» отметит все {total}.', { n: PICKER_LIST_CAP, total: found.length })));
        }
        paintCount();
    }
    const allBtn = h('button', {
        class: 'btn btn-outline btn-sm', type: 'button',
        onclick: () => {
            const next = selectAllFound([...chosen], findServices(catalog, query));
            if (next.length > JOURNAL_SERVICE_MAX) {
                toast(tooManyText(), 'fail');
                return;
            }
            chosen = new Set(next);
            paintList();
        },
    }, tr('Выбрать все найденные'));
    const noneBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => { chosen = new Set(); paintList(); } }, tr('Снять все'));
    const applyBtn = h('button', {
        class: 'btn btn-primary btn-sm', type: 'button',
        onclick: () => {
            // JOURNALS_V1_RJ2C (ревью F7) — выбор больше предела (пришёл снаружи)
            // не уходит: сервер ответил бы 400. Окно остаётся — снимите лишнее.
            if (chosen.size > JOURNAL_SERVICE_MAX) { toast(tooManyText(), 'fail'); return; }
            if (onApply) onApply([...chosen]);
            close();
        },
    }, tr('Готово'));
    overlay.appendChild(h('div', {
        class: 'modal-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Выбор услуг',
        style: { width: '620px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 64px)', display: 'flex', flexDirection: 'column' },
    },
        h('div', { style: { padding: '16px 20px', borderBottom: '1px solid var(--ink-100)', fontWeight: '700', fontSize: '15px' } }, tr('Выбор услуг')),
        h('div', { style: { padding: '14px 20px', overflow: 'auto' } },
            search,
            h('div', { class: 'row', style: { gap: '8px', marginTop: '10px', alignItems: 'center', flexWrap: 'wrap' } },
                allBtn, noneBtn, h('span', { style: { flex: '1 1 auto' } }), countEl),
            list),
        h('div', { style: { padding: '12px 20px', borderTop: '1px solid var(--ink-100)', display: 'flex', justifyContent: 'flex-end', gap: '10px' } },
            h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: close }, tr('Отмена')),
            applyBtn)));
    document.body.appendChild(overlay);
    search.focus();
    Promise.resolve().then(() => loadCatalog()).then((rows) => {
        catalog = Array.isArray(rows) ? rows : [];
        paintList();
    }).catch((e) => {
        clear(list);
        list.appendChild(h('div', { class: 'muted', style: { fontSize: '13.5px', padding: '12px 0' } },
            trf('Не удалось загрузить услуги: {msg}', { msg: (e && e.message) || String(e) })));
    });
    return { overlay, close };
}
