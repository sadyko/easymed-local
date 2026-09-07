// UI_DATEFIELD_V1 (2026-09-05) — КАЛЕНДАРЬ ПРОГРАММЫ, А НЕ КАЛЕНДАРЬ БРАУЗЕРА.
//
// Владелец: «please fix the dialogue windows and dropdowns and calendar
// pickers design».
//
// Календарь <input type="date"> рисует браузер, и он же выбирает язык месяцев
// по настройке системы: на узбекском интерфейсе клиники он открывался
// по-русски, а иногда и вовсе «1994 M11». Ни вид, ни язык этого окна правилами
// страницы не задаются.
//
// РОДНОЕ ПОЛЕ НЕ ВЫБРАСЫВАЕТСЯ — оно прячется и остаётся источником правды:
// пятьдесят с лишним мест читают `input.value` в виде «ГГГГ-ММ-ДД» и слушают
// `change`. Меняется только то, что видит человек: подпись словами на его
// языке («2 мая 2019», «2-may, 2019») и своя сетка месяца.
//
// Арифметика календаря — в чистом ../shared/month-grid.js: високосный год,
// начало недели и переход через месяц проверяются числами, а не глазами.

import { h, Icon, fmtDate } from './ui.js';
import { tr } from './i18n.js';
import { monthName } from './i18n.js';
import { monthGrid, parseIso, shiftMonth, todayIso, withinRange } from '../shared/month-grid.js?v=mg1';
import { watchValue, insideEditable } from './ui-select.js?v=uisel1';

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

let openInstance = null;

export function enhanceDateField(input) {
    if (!input || input.tagName !== 'INPUT') return null;
    if ((input.getAttribute('type') || '').toLowerCase() !== 'date') return null;
    if (input.dataset.uiDate === 'on' || input.dataset.noEnhance != null) return null;
    if (input.closest && input.closest('[data-no-enhance]')) return null;
    if (insideEditable(input)) return null;   // бланк приёма правится как текст
    input.dataset.uiDate = 'on';

    // DATE_TYPING_V1 — набирать дату можно прямо здесь. Значок слева открывает
    // календарь; раньше вся эта полоса была одной кнопкой, и клавиатура не
    // работала вовсе.
    // DATE_NUMERIC_V1 — поле с data-date-numeric показывает дату ЦИФРАМИ
    // («15.11.1994»), а не словами («15 ноября 1994 г.»). Так помечена дата
    // рождения: её СВЕРЯЮТ с паспортом, где она цифрами, и сличать «ноября» с
    // «11» — лишняя работа глазами. Дату приёма, наоборот, читают, и там
    // словесная запись остаётся.
    //
    // Календарь при этом на месте: набирать дату рождения удобнее руками, но
    // поправить день, когда месяц и год уже стоят, проще щелчком.
    //
    // Читаем АТРИБУТ, а не dataset: разметку сюда приносит h(), то есть
    // setAttribute, и атрибут — то, что действительно стоит на элементе.
    const numeric = (input.getAttribute && input.getAttribute('data-date-numeric') != null)
        || input.dataset.dateNumeric != null;
    const calBtn = h('button', {
        type: 'button', class: 'uidate-ic', tabindex: -1,
        title: 'Открыть календарь', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
    }, Icon('Calendar', { size: 14 }));
    const field = h('input', {
        type: 'text', class: 'uidate-field', inputmode: 'numeric',
        // Подсказка браузера: у даты рождения она называется «bday». Поле само
        // говорит, чем оно является (data-autocomplete), иначе для фильтров
        // отчётов автозаполнение было бы вредным.
        autocomplete: input.getAttribute('autocomplete') || 'off',
    });
    // Сообщение об ошибке: рядом с полем и вслух для читалок экрана.
    const errEl = h('div', { class: 'uidate-err', role: 'status', 'aria-live': 'polite' });
    // Крестик появляется только когда есть что сбрасывать и поле не обязательное:
    // у обязательного поля «очистить» — это предложение сделать форму неверной.
    const clearBtn = h('button', {
        type: 'button', class: 'uidate-clear', title: 'Очистить',
        onclick: (e) => { e.stopPropagation(); commit(''); },
    }, Icon('X', { size: 12 }));

    const wrap = h('div', { class: 'uidate' }, calBtn, field, clearBtn, errEl);
    if (input.parentNode) input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    input.classList.add('uidate-native');
    input.tabIndex = -1;   // KEYBOARD_FLOW_V1 — см. ui-select.js: иначе лишняя остановка Tab

    // Пустое поле обязано говорить, ЧТО оно фильтрует. «Выберите дату» ничего
    // не объясняет: владелец, увидев такое поле в строке поиска пациентов,
    // спросил «что это за календарь?» — и был прав. Подпись берётся у самого
    // поля: сначала placeholder, затем title (у фильтра даты рождения он есть
    // и звучит как «Поиск по дате рождения»), и только потом общая строка.
    const emptyLabel = () => input.getAttribute('placeholder')
        || input.getAttribute('title')
        || tr('Выберите дату');

    // Пока идёт набор, текст поля НЕ ПЕРЕПИСЫВАЕТСЯ. Раньше это держалось на
    // document.activeElement — то есть на догадке, что курсор именно здесь. При
    // автозаполнении браузером или программной подстановке догадка неверна, и
    // «15.11.1994» на глазах превращалось в «15 ноября 1994 г.» посреди набора.
    let typing = false;
    // Как дата выглядит в покое: цифрами или словами.
    function showDate(iso) {
        if (!numeric) return fmtDate(iso);
        const p = parseIso(iso);
        // parseIso отдаёт месяц С НУЛЯ (как Date.getMonth), поэтому +1. Без
        // него ноябрь показывался октябрём — у КАЖДОГО пациента и молча.
        return p ? `${String(p.day).padStart(2, '0')}.${String(p.month + 1).padStart(2, '0')}.${p.year}` : '';
    }
    function paintField() {
        const iso = input.value;
        if (!typing && document.activeElement !== field) field.value = iso ? showDate(iso) : '';
        field.placeholder = emptyLabel();
        field.disabled = !!input.disabled;
        wrap.classList.toggle('is-disabled', !!input.disabled);
        clearBtn.style.display = (iso && !input.required && !input.disabled) ? '' : 'none';
    }

    // DATE_TYPING_V1 — разбор набранного. Берём ЦИФРЫ, разделители любые:
    // «12.04.1978», «12/04/1978», «12 04 1978», «12041978». Двузначный год НЕ
    // достраиваем: для даты рождения «78» — это и 1978, и 2078, и угадывать
    // за регистратора год пациента нельзя.
    // Точки расставляются сами — руками их набирать не должен никто.
    function maskTyped(text) {
        const d = String(text || '').replace(/\D+/g, '').slice(0, 8);
        if (d.length <= 2) return d;
        if (d.length <= 4) return d.slice(0, 2) + '.' + d.slice(2);
        return d.slice(0, 2) + '.' + d.slice(2, 4) + '.' + d.slice(4);
    }

    function setError(msg) {
        errEl.textContent = msg ? tr(msg) : '';
        wrap.classList.toggle('is-bad', !!msg);
        if (field.setAttribute) field.setAttribute('aria-invalid', msg ? 'true' : 'false');
    }

    // Почему набранное не стало датой — словами. Молчащее поле человек
    // объяснить себе не может: он видит, что возраст рядом не посчитался, и
    // всё.
    function complain(text) {
        const d = String(text || '').replace(/\D+/g, '');
        if (!d.length) return setError('');
        if (d.length < 8) return setError('');            // ещё набирает — не мешаем
        if (parseTyped(text)) {
            const iso = parseTyped(text);
            if (iso > todayIso()) return setError('Дата рождения не может быть в будущем');
            return setError('');
        }
        const day = Number(d.slice(0, 2)), mon = Number(d.slice(2, 4));
        if (mon < 1 || mon > 12) return setError('Такого месяца нет — второе число это месяц');
        if (day < 1 || day > 31) return setError('Такого дня нет — первое число это день');
        return setError('Такой даты не существует');
    }

    function parseTyped(text) {
        const d = String(text || '').replace(/\D+/g, '');
        if (d.length !== 8) return null;
        const day = Number(d.slice(0, 2)), mon = Number(d.slice(2, 4)), yr = Number(d.slice(4, 8));
        if (!day || !mon || mon > 12 || day > 31 || yr < 1000) return null;
        const iso = `${yr}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        // Проверяем существование дня: 31 февраля календарь бы принял, а база нет.
        const probe = new Date(yr, mon - 1, day);
        if (probe.getFullYear() !== yr || probe.getMonth() !== mon - 1 || probe.getDate() !== day) return null;
        return iso;
    }

    function commit(iso) {
        input.value = iso;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        paintField();
    }

    let pop = null, view = null, reposition = null;

    function close() {
        if (!pop) return;
        pop.remove(); pop = null; view = null;
        calBtn.setAttribute('aria-expanded', 'false');
        if (reposition) {
            window.removeEventListener('scroll', reposition, true);
            window.removeEventListener('resize', reposition);
            reposition = null;
        }
        document.removeEventListener('mousedown', onOutside, true);
        document.removeEventListener('keydown', onKey, true);
        if (openInstance === close) openInstance = null;
    }

    function onOutside(e) {
        if (pop && !pop.contains(e.target) && !wrap.contains(e.target)) close();
    }
    function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(); field.focus(); }
    }

    function limits() {
        return { min: input.getAttribute('min') || '', max: input.getAttribute('max') || '' };
    }

    function paintPop() {
        pop.replaceChildren();
        const { min, max } = limits();
        const cur = input.value;
        const today = todayIso();

        // DATE_TYPING_V1 — МЕСЯЦ И ГОД ВЫБИРАЮТ СПИСКОМ.
        //
        // Раньше в шапке стояли только стрелки «месяц назад / вперёд». До
        // апреля 1978 от сентября 2026 — 581 нажатие. Стрелки остались (соседний
        // месяц ими удобнее), но год и месяц теперь просто выбирают.
        //
        // Границы года берём у самого поля (min/max), а если их нет — 120 лет
        // назад и 5 вперёд: поле даты в этой системе почти всегда либо дата
        // рождения, либо дата приёма, и оба случая сюда попадают.
        const yFrom = min ? Number(min.slice(0, 4)) : (new Date().getFullYear() - 120);
        const yTo   = max ? Number(max.slice(0, 4)) : (new Date().getFullYear() + 5);
        const monthSel = h('select', { class: 'uidate-pick', 'data-no-enhance': '',
            onchange: (e) => { view = { year: view.year, month: Number(e.currentTarget.value) }; paintPop(); } },
            ...Array.from({ length: 12 }, (_, i) => h('option',
                { value: String(i + 1), selected: view.month === i + 1 ? '' : null },
                monthName(i + 1, { standalone: true }))));
        const yearSel = h('select', { class: 'uidate-pick', 'data-no-enhance': '',
            onchange: (e) => { view = { year: Number(e.currentTarget.value), month: view.month }; paintPop(); } },
            ...Array.from({ length: Math.max(1, yTo - yFrom + 1) }, (_, i) => {
                const y = yTo - i;   // сверху ближайшие годы: чаще нужны они
                return h('option', { value: String(y), selected: view.year === y ? '' : null }, String(y));
            }));
        const head = h('div', { class: 'uidate-head' },
            h('button', {
                type: 'button', class: 'uidate-nav', title: 'Предыдущий месяц',
                onclick: () => { view = shiftMonth(view, -1); paintPop(); },
            }, Icon('ChevronLeft', { size: 14 })),
            h('div', { class: 'uidate-title' }, monthSel, yearSel),
            h('button', {
                type: 'button', class: 'uidate-nav', title: 'Следующий месяц',
                onclick: () => { view = shiftMonth(view, 1); paintPop(); },
            }, Icon('ChevronRight', { size: 14 })),
        );

        const grid = h('div', { class: 'uidate-grid' });
        for (const w of WEEKDAYS) grid.appendChild(h('div', { class: 'uidate-wd' }, tr(w)));
        for (const week of monthGrid(view.year, view.month)) {
            for (const c of week) {
                const off = !withinRange(c.iso, { min, max });
                grid.appendChild(h('button', {
                    type: 'button',
                    class: 'uidate-day'
                        + (c.inMonth ? '' : ' is-out')
                        + (c.iso === cur ? ' is-on' : '')
                        + (c.iso === today ? ' is-today' : '')
                        + (off ? ' is-off' : ''),
                    disabled: off || null,
                    onclick: () => { commit(c.iso); close(); field.focus(); },
                }, String(c.day)));
            }
        }

        const foot = h('div', { class: 'uidate-foot' },
            h('button', {
                type: 'button', class: 'btn btn-outline btn-sm',
                disabled: !withinRange(today, { min, max }) || null,
                onclick: () => { commit(today); close(); field.focus(); },
            }, tr('Сегодня')),
            h('span', { class: 'grow' }),
            input.required ? null : h('button', {
                type: 'button', class: 'btn btn-ghost btn-sm',
                onclick: () => { commit(''); close(); field.focus(); },
            }, tr('Очистить')),
        );

        pop.append(head, grid, foot);
    }

    function place() {
        if (!pop) return;
        const r = field.getBoundingClientRect();
        const vh = window.innerHeight || 800;
        const vw = window.innerWidth || 1200;
        const h0 = pop.offsetHeight || 320;
        const up = (vh - r.bottom - 8) < h0 && r.top > h0;
        pop.style.left = Math.max(8, Math.min(r.left, vw - pop.offsetWidth - 8)) + 'px';
        if (up) { pop.style.top = 'auto'; pop.style.bottom = (vh - r.top + 4) + 'px'; }
        else { pop.style.bottom = 'auto'; pop.style.top = (r.bottom + 4) + 'px'; }
    }

    function open() {
        if (pop || input.disabled) return;
        if (openInstance) openInstance();
        const parsed = parseIso(input.value) || parseIso(todayIso());
        view = { year: parsed.year, month: parsed.month };
        pop = h('div', { class: 'uidate-pop', role: 'dialog', 'aria-label': tr('Выберите дату') });
        document.body.appendChild(pop);
        paintPop();
        place();
        calBtn.setAttribute('aria-expanded', 'true');
        reposition = () => place();
        window.addEventListener('scroll', reposition, true);
        window.addEventListener('resize', reposition);
        document.addEventListener('mousedown', onOutside, true);
        document.addEventListener('keydown', onKey, true);
        openInstance = close;
    }

    // DATE_TYPING_V1 — календарь открывает ЗНАЧОК, а поле принимает набор.
    calBtn.addEventListener('click', (e) => {
        e.preventDefault(); if (pop) close(); else { open(); field.focus(); }
    });
    field.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' && !pop) { e.preventDefault(); open(); return; }
        // Enter в поле даты НЕ должен уходить наверх и сохранять форму, пока
        // набранное не разобрано: сначала дата, потом всё остальное.
        if (e.key === 'Enter') {
            const iso = parseTyped(field.value);
            if (iso && iso !== input.value) { e.preventDefault(); e.stopPropagation(); commit(iso); close(); }
        }
    });
    // Внутри поля дата выглядит как её набирают — 12.04.1978. Снаружи она
    // читается словами («11 сентября 2026»), но править словесную запись
    // нельзя: чтобы изменить год, пришлось бы стирать её целиком.
    field.addEventListener('focus', () => {
        const p2 = parseIso(input.value);
        if (p2) field.value = `${String(p2.day).padStart(2, '0')}.${String(p2.month).padStart(2, '0')}.${p2.year}`;
        if (field.select) field.select();
    });
    // Разбираем на лету: как только цифр стало восемь, дата уходит в поле.
    field.addEventListener('input', () => {
        // Маску ставим только когда курсор в конце: иначе правка середины
        // («поменять месяц») уводила бы курсор в хвост на каждом нажатии.
        const atEnd = field.selectionStart == null || field.selectionStart >= String(field.value).length;
        const masked = maskTyped(field.value);
        if (atEnd && masked !== field.value) {
            field.value = masked;
            if (field.setSelectionRange) { try { field.setSelectionRange(masked.length, masked.length); } catch { /* фейковый DOM */ } }
        }
        complain(field.value);
        const iso = parseTyped(field.value);
        if (iso && iso <= todayIso()) {
            if (iso !== input.value) { typing = true; try { commit(iso); } finally { typing = false; } }
            const p = parseIso(iso);
            if (pop && p) { view = { year: p.year, month: p.month }; paintPop(); }
        } else if (!String(field.value).replace(/\D+/g, '')) {
            if (input.value) commit('');   // стёрли всё — значит дата снята
        }
    });
    // Ушли из поля — приводим текст к единому виду или возвращаем прежний.
    field.addEventListener('blur', () => {
        const iso = parseTyped(field.value);
        if (iso && iso <= todayIso()) { setError(''); commit(iso); }
        else complain(field.value);
        if (!wrap.classList.contains('is-bad')) paintField();
    });
    // Дату ставят снаружи (предзаполнение формы, «сегодня» кнопкой соседнего
    // фильтра) — подпись обязана следовать за значением.
    input.addEventListener('change', paintField);
    watchValue(input, paintField);
    if (typeof MutationObserver === 'function') {
        new MutationObserver(paintField).observe(input, {
            attributes: true, attributeFilter: ['value', 'min', 'max', 'disabled', 'required', 'placeholder'],
        });
    }

    paintField();
    return wrap;
}

export function enhanceDateFieldsIn(root) {
    if (!root || !root.querySelectorAll) return 0;
    let n = 0;
    for (const el of root.querySelectorAll('input[type="date"]')) if (enhanceDateField(el)) n++;
    return n;
}
