// TEST_DATA_WIPE_V1 (docs/specs/2026-10-29-3190-refund-swap-test-wipe-design.md,
// раздел 3) — красная карточка «Удалить тестовые данные» на «Данных клиники»
// (views/clinic-data.js). Два вызова (server/services/rpc/backup.js):
//   test_data_wipe_status {}          → {paired, pending, last}
//   test_data_wipe {password, confirm} → {ok, restarting:true, backup}
// после чего сервер выходит с кодом 75, а удаление идёт при следующем запуске
// (services/test-data-wipe.js applyPendingTestDataWipe). Итог показывается
// здесь же, когда экран откроется снова.
//
// Не рисуется для не-администратора — как «Опасная зона» (system-danger.js):
// у него на этой странице нет ни одной кнопки. Слово УДАЛИТЬ, пароль и отказ
// связанной клинике сервер проверяет сам; проверки здесь — чтобы человек не
// дошёл до необратимого шага на автомате.

import { h, Icon, clear, field } from '../ui.js';
import { tr, trf, getLang } from '../i18n.js';
import { supabase } from '../../supabase.js';
import { confirmWordOk, noSpaceText, formatRuDateTime, DASH } from '../system-logic.js';
import {
    WIPE_DELETES, WIPE_KEEPS, WIPE_CALENDAR_WARNING, PAIRED_TEXT,
    wipeSummaryRows, wipeLastNotes, wipeRequestInfo, wipeHadData, isWrongPassword,
} from '../test-wipe-logic.js';

// Ревью C5 (M1) — удаление уже ждёт перезапуска: та же фраза и строкой в
// карточке, и подсказкой на мёртвой кнопке.
const PENDING_NOTE = 'Удаление уже ждёт перезапуска программы.';
import { showRestartOverlay } from './system-restart.js';

export async function renderTestWipeCard(root, { admin }) {
    if (!admin) return;
    // Тело карточки собирается после ответа сервера; шаг между строками — как
    // у самой .upd-card (10px), а не 4px строки галочки в окне сброса.
    const body = h('div', { class: 'sys-wipe-row', style: { gap: '10px' } });
    root.appendChild(h('div', { class: 'card upd-card sys-card sys-danger' },
        h('div', { class: 'sys-card-head' }, Icon('Trash', { size: 16 }),
            h('span', null, 'Удалить тестовые данные')),
        h('p', { class: 'sys-note sys-danger-text' },
            'Для клиники, которая училась на выдуманных пациентах: удаляются визиты, деньги и движения склада, а пациенты (ФИО, телефоны, номера карт), CRM и все настройки остаются.'),
        body));

    // Состояние не пришло (старый сервер, сбой сети) — кнопка всё равно есть:
    // сервер сам откажет связанной клинике и объяснит почему.
    let status = {};
    try {
        const { data, error } = await supabase.rpc('test_data_wipe_status', {});
        if (!error && data && typeof data === 'object') status = data;
    } catch (e) { status = {}; }
    const last = status.last && typeof status.last === 'object' ? status.last : null;
    const who = await requesterName(wipeRequestInfo(last).by);

    clear(body);
    const pending = status.pending === true;
    if (pending) {
        body.appendChild(h('p', { class: 'sys-note' }, Icon('Clock', { size: 14 }), ' ', PENDING_NOTE));
    }
    if (status.paired === true) {
        body.appendChild(h('p', { class: 'sys-modal-warn' }, Icon('Warning', { size: 14 }), ' ', PAIRED_TEXT));
    }
    paintLast(body, last, who);
    // Мертва для связанной клиники и пока удаление ждёт перезапуска: второй
    // просьбе сервер всё равно откажет (pending-action.json уже занят).
    const openBtn = h('button', {
        type: 'button', class: 'btn btn-danger',
        title: pending ? PENDING_NOTE : null,
        onclick: () => { if (!openBtn.disabled) openWipeModal(); },
    }, Icon('Trash', { size: 14 }), ' ', 'Удалить тестовые данные…');
    openBtn.disabled = status.paired === true || pending;
    body.appendChild(h('div', null, openBtn));
}

// Имя сотрудника, который попросил удалить, — из списка сотрудников (их
// удаление не трогает). Не нашлось — экран назовёт номер.
async function requesterName(id) {
    if (id == null) return null;
    try {
        const { data } = await supabase.from('users').select('id, full_name').eq('id', id).maybeSingle();
        const name = data && typeof data.full_name === 'string' ? data.full_name.trim() : '';
        return name || null;
    } catch (e) { return null; }
}

// Строка, уже переведённая trf(), — textContent, а не ребёнок h(): h() прогнал
// бы её через tr() второй раз, и фраза, совпавшая с запомненным отказом
// сервера (shared/server-messages.js), вернулась бы с числами сервера —
// «2.1 ГБ» на русском экране.
function textLine(cls, text) {
    const p = h('p', { class: cls });
    p.textContent = text;
    return p;
}

function paintLast(body, last, whoName) {
    if (!last) return;
    const when = formatRuDateTime(last.at);
    if (when) {
        body.appendChild(textLine('sys-block-title', last.ok === true
            ? trf('Последнее удаление тестовых данных: {date}', { date: when })
            : trf('Последняя попытка удалить тестовые данные: {date}', { date: when })));
    }
    const asked = wipeRequestInfo(last);
    if (asked.by !== null || asked.at !== null) {
        const who = whoName || (asked.by !== null ? trf('сотрудник № {id}', { id: asked.by }) : DASH);
        body.appendChild(textLine('sys-note',
            trf('Кто и когда попросил: {who}, {date}', { who, date: formatRuDateTime(asked.at) || DASH })));
    }
    // Нули не показываются: таблица — о том, что было, а не перечень таблиц.
    const rows = wipeSummaryRows(last).filter((r) => r.n > 0);
    if (rows.length) {
        const tb = h('tbody');
        for (const r of rows) tb.appendChild(h('tr', null, h('td', null, r.label), h('td', null, String(r.n))));
        body.appendChild(h('table', { class: 'tbl sys-backups-tbl' },
            h('thead', null, h('tr', null, h('th', null, 'Что'), h('th', null, 'Количество'))), tb));
    } else if (last.ok === true && !wipeHadData(last)) {
        // Ревью C5 — решают все числа итога, а не строки таблицы.
        body.appendChild(h('p', { class: 'sys-note' }, 'Удалять было нечего: учебных данных не нашлось.'));
    }
    for (const n of wipeLastNotes(last, getLang())) {
        body.appendChild(textLine(last.ok === true ? 'sys-note' : 'sys-modal-warn', trf(n.template, n.params)));
    }
}

function openWipeModal() {
    const ov = h('div', { class: 'modal', style: { zIndex: '150' } });
    const close = () => ov.remove();
    ov.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const wordInput = h('input', { type: 'text', class: 'sys-modal-input', autocomplete: 'off', spellcheck: 'false' });
    const pass = h('input', { type: 'password', class: 'sys-modal-input', autocomplete: 'current-password' });
    const statusEl = h('p', { class: 'sys-modal-status', role: 'status' });
    const confirmBtn = h('button', { type: 'button', class: 'btn btn-danger' },
        Icon('Trash', { size: 14 }), ' ', 'Удалить тестовые данные');
    confirmBtn.disabled = true;

    // Кнопка мертва, пока слово не точное И пароль не введён — не ради
    // сервера (он проверяет оба), а чтобы до необратимого не дойти на автомате.
    function refreshEnabled() {
        confirmBtn.disabled = !(confirmWordOk(wordInput.value) && pass.value !== '');
    }
    wordInput.addEventListener('input', refreshEnabled);
    pass.addEventListener('input', refreshEnabled);

    // Ход — серым (копия базы может идти минуту), отказ — красным.
    const say = (text, isError) => {
        statusEl.className = isError ? 'sys-modal-status' : 'sys-modal-note';
        statusEl.textContent = text;
    };

    let busy = false;   // disabled — ещё и признак «форма заполнена», повтор держит свой флаг
    confirmBtn.addEventListener('click', async () => {
        if (busy || confirmBtn.disabled) return;
        busy = true;
        confirmBtn.disabled = true;
        say(tr('Делается копия перед удалением…'), false);
        try {
            const { data, error } = await supabase.rpc('test_data_wipe', { password: pass.value, confirm: wordInput.value.trim() });
            if (error) throw error;
            if (!data || data.ok !== true) throw new Error('wipe refused');
            close();
            showRestartOverlay();
        } catch (e) {
            busy = false;
            // Ревью C5 (M3): неверный пароль стирается — следующий набирается
            // заново, кнопка мертва до него. Другие отказы пароль не трогают.
            if (isWrongPassword(e)) {
                pass.value = '';
                try { pass.focus(); } catch (err) { /* без фокуса — не беда */ }
            }
            refreshEnabled();
            // Отказ сервера — его словами на языке экрана: «связана со зданиями»,
            // «уже ждёт перезапуска», «неверный пароль», «нет места» (с числами — noSpaceText).
            say((e && e.message && e.message !== 'wipe refused')
                ? (noSpaceText(e, getLang(), tr) || tr(e.message))
                : tr('Не удалось запросить удаление. Попробуйте ещё раз.'), true);
        }
    });

    ov.appendChild(h('div', { class: 'modal-card', style: { width: '560px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Warning', { size: 16 }), ' ', 'Удаление тестовых данных'),
            h('button', { class: 'modal-close', type: 'button', onclick: close }, '×')),
        h('div', { class: 'modal-body sys-modal-body' },
            h('p', { class: 'sys-modal-warn' }, Icon('Warning', { size: 14 }), ' ', 'Будут удалены:'),
            h('ul', { class: 'sys-death-list' }, WIPE_DELETES.map((s) => h('li', null, s))),
            h('p', { class: 'sys-modal-warn' }, Icon('Calendar', { size: 14 }), ' ', WIPE_CALENDAR_WARNING),
            h('p', { class: 'sys-modal-lead' }, 'Останутся:'),
            h('ul', { class: 'sys-death-list' }, WIPE_KEEPS.map((s) => h('li', null, s))),
            h('p', { class: 'sys-modal-note' },
                'Номера счетов, депозитов, продаж карт, госпитализаций и закупок снова начнутся с 1. Номера проб не повторяются.'),
            h('p', { class: 'sys-modal-note' },
                'Сначала будет сделана копия «Перед удалением тестовых данных» — это путь назад. Восстановление из неё вернёт клинику к моменту копии: всё, что будет сделано после удаления, при этом пропадёт.'),
            h('p', { class: 'sys-modal-note' },
                'Клинике, связанной с другими зданиями (экран «Филиалы»), удаление недоступно: оно ушло бы и туда.'),
            field('Введите УДАЛИТЬ, чтобы подтвердить', wordInput),
            field('Пароль администратора', pass),
            h('p', { class: 'sys-modal-note' },
                'Программа перезапустится сама — около минуты, на большой базе дольше. Не перезапускайте её вручную: удаление пройдёт при запуске, итог появится на этой странице.'),
            statusEl),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', type: 'button', onclick: close }, 'Отмена'),
            h('span', { class: 'grow' }),
            confirmBtn)));

    document.body.appendChild(ov);
    setTimeout(() => { try { wordInput.focus(); } catch (e) {} }, 30);
}
