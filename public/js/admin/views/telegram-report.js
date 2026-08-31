// TELEGRAM_BROADCAST_V1 — «Отчёты → Telegram-бот».
//
// TELEGRAM_BROADCAST_V2 — рассылка ПЕРЕЕХАЛА отсюда в «Чат с пациентами».
// Отчёт смотрят раз в месяц, а сообщение пациентам отправляют оттуда же, где
// им отвечают, — поэтому здесь остались только подключения и охват, а форма
// рассылки открывается поп-апом из шапки чата. Код формы не переписан, а
// вынесен в openBroadcastModal(): один и тот же экран, другое место вызова.
//
// Про аудиторию важно понимать одно: бот может написать ТОЛЬКО тому, кто сам
// его открыл, — это ограничение Telegram, а не выбор клиники. Поэтому «все
// пациенты» здесь недостижимы в принципе, а фильтры лишь сужают подключившихся.
//
// Рассылка admin-only на СЕРВЕРЕ (rpc/telegram.js: requireAdmin на stats /
// preview / send), тогда как сам чат выдаётся ролям через уровень доступа.
// Поэтому кнопку в чате видит только админ — иначе это кнопка, которая всегда
// отвечает отказом (см. telegram-chat.js о том, почему так делать нельзя).

import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { fileTo16x9Jpeg } from './image-16x9.js';   // TELEGRAM_BROADCAST_IMG_V1

const state = { stats: null, links: null, linksError: null, preview: null, sending: null, busy: false };

// TELEGRAM_BROADCAST_IMG_V1 — то же число, что и в services/telegram/broadcast.js.
// Здесь оно нужно только чтобы ПРЕДУПРЕДИТЬ администратора: решение «подпись
// или отдельное сообщение» принимает сервер, браузер ничего не обрезает.
const CAPTION_LIMIT = 1024;
const MEDIA_BUCKET = 'telegram-media';

async function rpc(name, args = {}) {
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw new Error(error.message || 'Не удалось выполнить запрос.');
    return data;
}

export function openTelegramReport() {
    const overlay = h('div', { style: {
        position: 'fixed', inset: '0', zIndex: '150',
        background: 'var(--ink-25, #f6f8f9)', display: 'flex', flexDirection: 'column',
    } });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);

    overlay.appendChild(h('header', { style: {
        display: 'flex', alignItems: 'center', gap: '14px', padding: '14px 22px',
        background: 'var(--white, #fff)', borderBottom: '1px solid var(--ink-100)', flex: '0 0 auto',
    } },
        h('div', { style: { width: '36px', height: '36px', borderRadius: '10px', background: 'var(--primary-50)', color: 'var(--primary-700)', display: 'grid', placeItems: 'center' } },
            Icon('Bot', { size: 17 })),
        h('div', null,
            h('div', { style: { fontSize: '17px', fontWeight: 700, color: 'var(--ink-900)' } }, 'Telegram-бот'),
            // TELEGRAM_BROADCAST_V2 — больше не обещаем здесь рассылку: она в чате.
            h('div', { style: { fontSize: '12.5px', color: 'var(--ink-500)' } },
                'Кто подключился к боту и что он им выдал')),
        h('span', { class: 'grow', style: { flex: '1' } }),
        h('button', { class: 'btn', type: 'button', onclick: close }, 'Закрыть')));

    const body = h('div', { style: { flex: '1', overflow: 'auto', padding: '20px 22px' } });
    overlay.appendChild(body);
    document.body.appendChild(overlay);

    paint(body);
    return overlay;
}

async function paint(body) {
    clear(body);
    body.appendChild(h('div', { class: 'muted' }, 'Загрузка…'));
    try { state.stats = await rpc('telegram_stats'); }
    catch (e) {
        clear(body);
        body.appendChild(h('div', { class: 'empty', style: { padding: '30px' } }, trf('Не удалось загрузить: {msg}', { msg: e.message })));
        return;
    }
    // TG_LINKS_IN_REPORT_V1 — список подключённых грузим ОТДЕЛЬНО от статистики:
    // это два независимых запроса, и если упадёт список, цифры всё равно нужно
    // показать. Обратное тоже верно, но статистика — заголовок отчёта, без неё
    // показывать нечего, поэтому её ошибка выше закрывает экран.
    state.linksError = null;
    try { state.links = await rpc('telegram_links_list'); }
    catch (e) { state.links = null; state.linksError = e.message; }

    clear(body);
    body.appendChild(h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
        // Плитки со статистикой читаются колонкой нормальной ширины, растянутые
        // на весь монитор — хуже. Список подключений, наоборот, широкий: имя,
        // телефон, перечень карт и кнопка в одной строке.
        h('div', { style: { maxWidth: '760px' } }, statsCard()),
        linksCard(body)));
}

// ---------------------------------------------------------------------------
// Подключения и охват
// ---------------------------------------------------------------------------
function tile(label, value, note) {
    return h('div', { style: {
        padding: '14px 16px', background: 'var(--white,#fff)', border: '1px solid var(--ink-100)',
        borderRadius: '12px',
    } },
        h('div', { style: { fontSize: '24px', fontWeight: 700, color: 'var(--ink-900)' } }, String(value)),
        h('div', { style: { fontSize: '12.5px', color: 'var(--ink-600)', marginTop: '2px' } }, label),
        note ? h('div', { style: { fontSize: '12.5px', color: 'var(--ink-500)', marginTop: '4px' } }, note) : null);
}

// TG_STATS_ONE_LINE_V1 — карточка сжата до одной строки плиток.
//
// Полоса охвата и столбики «новые подключения по неделям» убраны с экрана: при
// двух подключённых чатах график из одного столбца во всю ширину не сообщает
// ничего, а полоса охвата занимала место под цифру, которая и так есть в
// плитках. Сами показатели с сервера НЕ удалены (botStats продолжает считать
// coverage_pct и weekly) — вернуть их на экран это одна строка, и когда
// подключений станет много, они снова начнут что-то значить.
function statsCard() {
    const s = state.stats;
    const box = h('div', { style: { padding: '18px' } });

    const tiles = [
        tile('Подключено чатов', s.chats_active),
        tile('Открыто карт пациентов', s.cards_reachable, 'один номер — часто вся семья'),
        tile('Документов выдано', s.documents_sent),
        // TG_DAILY_30_V1 — «сколько человек подключилось за месяц». Ноль здесь
        // ПОКАЗЫВАЕТСЯ, в отличие от плиток отвязанных/заблокировавших ниже:
        // те нули — про отсутствие проблемы, а этот — ответ на вопрос «работает
        // ли стойка сейчас», и молчание выглядело бы как сломанный отчёт.
        tile('Новых за 30 дней', s.started_30d ?? 0),
    ];
    // Отвязанные и заблокировавшие показываются, только когда они есть: нули в
    // ряду плиток занимают место и не отвечают ни на один вопрос.
    if (s.chats_revoked) tiles.push(tile('Отвязано клиникой', s.chats_revoked));
    if (s.chats_blocked) tiles.push(tile('Заблокировали бота', s.chats_blocked));

    box.appendChild(h('div', { style: {
        display: 'grid', gap: '10px',
        gridTemplateColumns: `repeat(${tiles.length}, minmax(0, 1fr))`,
    } }, ...tiles));

    // График рисуется только когда подключения есть: тридцать пустых
    // столбиков не сообщают ничего — тот же довод, каким TG_STATS_ONE_LINE_V1
    // убрал отсюда недельные столбцы при двух подключениях. Плитка выше
    // отвечает «ноль» и без графика.
    if (s.started_30d) box.appendChild(daily30Chart(s));

    return h('div', { class: 'card' },
        h('div', { class: 'card-header' }, h('h3', null, Icon('Patients', { size: 16 }), ' Подключения')),
        box);
}

// TG_DAILY_30_V1 — подключения по дням за последние 30 дней.
//
// Дни строятся в UTC — тем же календарём, каким date(linked_at) на сервере
// раскладывает подключения по вёдрам: локальная полночь на границе суток
// рисовала бы столбик, в который ничего не может попасть.
//
// Один ряд — один цвет продукта; подписи и значения — чернильными токенами,
// цвет несёт только столбик. Число видно по наведению (столбик в 10px не
// вместит подпись), а масштаб — по «макс. N в день» в заголовке блока.
function daily30Chart(s) {
    const byDay = new Map((s.daily_30d || []).map((d) => [d.day, d.c]));
    const days = [];
    const now = new Date();
    for (let i = 29; i >= 0; i--) {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
        const iso = d.toISOString().slice(0, 10);
        days.push({ iso, c: byDay.get(iso) || 0 });
    }
    const max = Math.max(...days.map((d) => d.c), 1);

    const tip = h('div', { style: {
        position: 'absolute', display: 'none', pointerEvents: 'none', zIndex: '5',
        padding: '3px 8px', borderRadius: '7px', whiteSpace: 'nowrap',
        background: 'var(--ink-900,#13272e)', color: '#fff', fontSize: '12.5px',
        fontVariantNumeric: 'tabular-nums', transform: 'translateX(-50%)',
    } });

    const CHART_H = 64;
    const bars = h('div', { style: {
        display: 'flex', alignItems: 'flex-end', gap: '2px', height: CHART_H + 'px',
        borderBottom: '1px solid var(--ink-100)',
    } });
    for (const d of days) {
        // Колонка на всю высоту — цель наведения крупнее самого столбика.
        const fill = h('div', { style: d.c
            ? { height: Math.max(Math.round((d.c / max) * CHART_H), 3) + 'px',
                background: 'var(--primary-500, #0d9488)', borderRadius: '3px 3px 0 0' }
            // Пустой день существует видимо (2px чернильной подложки), но
            // читается как ноль, а не как маленькое значение.
            : { height: '2px', background: 'var(--ink-100, #e4eaec)' } });
        const col = h('div', { style: { flex: '1', minWidth: '0', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' } }, fill);
        col.addEventListener('mouseenter', () => {
            tip.textContent = shortDate(d.iso) + ' — ' + d.c;
            tip.style.left = (col.offsetLeft + col.offsetWidth / 2) + 'px';
            tip.style.bottom = (CHART_H + 6) + 'px';
            tip.style.display = 'block';
        });
        col.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
        bars.appendChild(col);
    }

    const axisLabel = (t) => h('span', { style: { fontSize: '12.5px', color: 'var(--ink-500)', fontVariantNumeric: 'tabular-nums' } }, t);
    return h('div', { style: { marginTop: '16px' } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '8px' } },
            h('div', { style: { fontSize: '12.5px', fontWeight: 600, color: 'var(--ink-700)' } }, 'Новые подключения по дням'),
            h('span', { style: { fontSize: '12.5px', color: 'var(--ink-500)' } }, trf('макс. {n} в день', { n: max }))),
        h('div', { style: { position: 'relative' } }, tip, bars),
        h('div', { style: { display: 'flex', justifyContent: 'space-between', marginTop: '4px' } },
            axisLabel(shortDate(days[0].iso)), axisLabel('сегодня')));
}

// ---------------------------------------------------------------------------
// Подключённые пациенты — TG_LINKS_IN_REPORT_V1
// ---------------------------------------------------------------------------
// Переехал сюда из «Настройки → Telegram-бот». Настройки отвечают на вопрос
// «как бот устроен» (токен, что он выдаёт); «кто именно подключён и сколько
// карт это открывает» — это уже наблюдение за работой бота, то есть отчёт, и
// стоять оно должно рядом с охватом, который считает ровно этих людей.
//
// «Отвязать» переехало ВМЕСТЕ со списком, а не осталось в настройках: кнопка
// без списка не на чем работать, а список без кнопки не даёт закрыть доступ,
// когда номер перешёл к другому человеку. Обе ручки — admin-only на сервере
// (rpc/telegram.js: requireAdmin), ровно как и telegram_stats выше, поэтому
// аудитория экрана не меняется.
//
// Доступ по одному номеру телефона открывает документы ВСЕХ пациентов на этом
// номере — решение принято сознательно, и здесь видно его последствия: сколько
// карт открывает каждый чат.

// TG_LINKS_PREVIEW_V1 — в карточке отчёта видны только первые строки, остальные
// открываются поп-апом «Показать все». Подключённых становится больше с каждым
// пациентом, а отчёт открывают ради охвата и подключений сверху: таблица во всю
// длину отодвигала цифры и превращала обзор в бесконечную прокрутку.
const LINKS_PREVIEW = 10;

// Строка — на КАЖДУЮ карту, а не на чат: чат на семейном номере открывает
// несколько карт, и в карточном виде они слипались в одну строку через запятую
// — по такому списку нельзя ни найти пациента по номеру карты, ни отсортировать.
//
// Сверху — кто приходил недавно: это те, с кем клиника работает сейчас.
function linksRows() {
    const rows = [];
    for (const l of state.links || []) {
        if (!l.patients.length) {
            rows.push({ link: l, p: null });
        } else {
            for (const p of l.patients) rows.push({ link: l, p });
        }
    }
    rows.sort((a, b) => String((b.p && b.p.last_visit) || '').localeCompare(String((a.p && a.p.last_visit) || '')));
    return rows;
}

// Одна и та же таблица рисуется дважды: в карточке (первые LINKS_PREVIEW строк)
// и в поп-апе (все). `onRevoked` — что перерисовать после «Отвязать»: карточке
// достаточно перерисовать отчёт, поп-апу нужно ещё и обновить себя, иначе
// отвязанная строка осталась бы на экране активной.
function linksTable(rows, bodyEl, onRevoked) {
    const th = (t, w) => h('th', { style: {
        textAlign: 'left', padding: '8px 10px', fontSize: '12.5px', fontWeight: '700',
        letterSpacing: '.03em', textTransform: 'uppercase', color: 'var(--ink-500)',
        borderBottom: '1px solid var(--ink-100)', whiteSpace: 'nowrap',
        ...(w ? { width: w } : {}),
    } }, t);
    // Ячейка в один ярус. Длинное ФИО переносится по словам — это
    // единственное место, где вторая строка допустима, и она вынужденная,
    // а не заложенная в вёрстку.
    const td = (content, extra = {}) => h('td', { style: {
        padding: '8px 10px', fontSize: '13.5px', borderBottom: '1px solid var(--ink-50,#f1f4f5)',
        verticalAlign: 'middle', lineHeight: '1.35', ...extra,
    } }, content);

    const tbody = h('tbody');
    for (const { link: l, p } of rows) {
        const revokeBtn = h('button', { class: 'btn btn-sm btn-danger', type: 'button',
            style: { display: l.revoked ? 'none' : '' },
            title: l.patients.length > 1
                ? trf('Отвязать Telegram — доступ закроется ко всем {n} картам на этом номере', { n: l.patients.length })
                : 'Отвязать Telegram',
            onclick: async () => {
                const extra = l.patients.length > 1
                    ? trf('\n\nНа этом номере {n} карт(ы) — доступ закроется ко всем.', { n: l.patients.length }) : '';
                if (!confirm(tr('Отвязать этот Telegram? Человек перестанет получать документы, пока не подключится заново.') + extra)) return;
                await run(revokeBtn, async () => {
                    state.links = await rpc('telegram_link_revoke', { id: l.id });
                    toast('Отвязано.', 'info');
                    // Отвязка меняет и охват, и число подключённых чатов, а
                    // они стоят на этом же экране — перерисовываем целиком,
                    // иначе цифры вверху противоречили бы списку внизу.
                    onRevoked();
                });
            } }, 'Отвязать');

        // Одна строка = одна строка. Ни в одной ячейке нет второго яруса:
        // номер карты и telegram-имя раньше стояли подписями под основным
        // значением, и таблица из-за них была вдвое выше без единого
        // нового столбца. Номер карты уехал в собственную колонку,
        // telegram-имя — в подсказку у ника.
        tbody.appendChild(h('tr', { style: { opacity: l.revoked ? '.55' : '1' } },
            td(p ? h('span', { style: { fontVariantNumeric: 'tabular-nums', color: 'var(--ink-500)' } }, String(p.id)) : '—'),
            td(p
                ? h('span', { style: { fontWeight: '600' } }, p.name)
                : h('span', { class: 'muted' }, 'карта не найдена')),
            td(p && p.mrn
                ? h('span', { style: { fontVariantNumeric: 'tabular-nums', color: 'var(--ink-600)' } }, p.mrn)
                : h('span', { class: 'muted' }, '—'), { whiteSpace: 'nowrap' }),
            td(h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, '+' + l.phone), { whiteSpace: 'nowrap' }),
            td(h('span', { title: l.tg_name || '', style: { whiteSpace: 'nowrap' } },
                l.tg_username
                    ? h('span', { style: { color: 'var(--primary-700)' } }, '@' + l.tg_username)
                    : h('span', null, l.tg_name || '—'),
                l.revoked ? h('span', { class: 'muted', style: { fontSize: '12.5px' } }, ' · отвязан') : null),
                { whiteSpace: 'nowrap' }),
            td(p && p.last_visit
                // Числовая дата, а не «17 августа 2026 г.»: в таблице важно,
                // чтобы колонка была узкой и даты сравнивались взглядом.
                ? h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, shortDate(p.last_visit))
                : h('span', { class: 'muted' }, 'не приходил'), { whiteSpace: 'nowrap' }),
            td(revokeBtn, { textAlign: 'right', whiteSpace: 'nowrap' })));
    }

    return h('div', { style: { overflowX: 'auto' } },
        h('table', { style: { width: '100%', borderCollapse: 'collapse' } },
            h('thead', null, h('tr', null,
                th('ID', '70px'), th('Пациент'), th('Карта', '130px'), th('Телефон', '150px'),
                th('Telegram', '160px'), th('Последний визит', '130px'), th('', '110px'))),
            tbody));
}

const LINKS_HINT = 'Строка — на каждую карту. Один Telegram может открывать несколько карт, '
    + 'если они записаны на один номер: «Отвязать» закрывает доступ ко всем сразу.';

function linksCard(bodyEl) {
    const box = h('div', { style: { padding: '18px' } });
    let allBtn = null;

    if (state.linksError) {
        box.appendChild(h('div', { class: 'muted' }, trf('Не удалось загрузить список: {msg}', { msg: state.linksError })));
    } else if (!state.links || !state.links.length) {
        box.appendChild(h('div', { class: 'muted' },
            'Пока никто не подключился. Пациент открывает бота, нажимает «Поделиться номером» — и появляется здесь.'));
    } else {
        const rows = linksRows();
        const shown = rows.slice(0, LINKS_PREVIEW);
        box.appendChild(linksTable(shown, bodyEl, () => paint(bodyEl)));

        if (rows.length > shown.length) {
            // Кнопка стоит и в шапке карточки, и под таблицей: в шапку смотрят,
            // когда прикидывают «сколько их всего», под таблицу — когда дочитали
            // последнюю строку и хотят продолжения. Возвращаться к заголовку
            // ради этого не нужно.
            allBtn = h('button', { class: 'btn btn-sm', type: 'button',
                onclick: () => openLinksModal(bodyEl) }, trf('Показать все · {n}', { n: rows.length }));
            box.appendChild(h('div', { style: {
                display: 'flex', alignItems: 'center', gap: '10px', marginTop: '12px',
            } },
                h('button', { class: 'btn btn-sm', type: 'button',
                    onclick: () => openLinksModal(bodyEl) }, trf('Показать все · {n}', { n: rows.length })),
                h('span', { class: 'muted', style: { fontSize: '12.5px' } },
                    trf('показано {shown} из {total}', { shown: shown.length, total: rows.length }))));
        }

        box.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '10px' } }, LINKS_HINT));
    }

    return h('div', { class: 'card' },
        h('div', { class: 'card-header' },
            h('h3', null, Icon('Patients', { size: 16 }), ' Подключённые пациенты'),
            allBtn),
        box);
}

// TG_LINKS_PREVIEW_V1 — полный список подключённых.
//
// БЕЗ .modal-compact, в отличие от рассылки ниже: MODAL_COMPACT_OPTOUT_V1
// (admin.css) даёт таким окнам почти полный экран, и здесь это то, что нужно —
// семь колонок и сотни строк в карточке шириной 620px читать невозможно.
function openLinksModal(bodyEl) {
    // ВЫШЕ отчёта. «Отчёты → Telegram-бот» — сам полноэкранный слой с z-index
    // 150 (см. openTelegramReport) и НЕПРОЗРАЧНЫМ фоном, а .modal в admin.css
    // объявлен со 100. Поп-ап, открытый отсюда, честно создавался и тут же
    // скрывался за отчётом: кнопка выглядела мёртвой, хотя работала.
    //
    // Поднимаем именно этот слой, а не .modal глобально: та сотня стоит под
    // всеми обычными экранами и трогать её ради одного окна нельзя.
    const overlay = h('div', { class: 'modal', style: { zIndex: '200' } });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    // display:block — .modal-body по умолчанию grid с растягиванием строк, а
    // здесь обычный вертикальный поток (см. openBroadcastModal ниже).
    const box = h('div', { class: 'modal-body', style: { display: 'block' } });
    const listBox = h('div', null);
    const countEl = h('span', { class: 'muted', style: { fontSize: '12.5px', whiteSpace: 'nowrap' } });

    // Поиск, а не одна прокрутка: список отсортирован по дате последнего визита,
    // и найти в нём конкретного человека глазами нельзя. Ищем по всему, что
    // видно в строке, — имя, карта, телефон, ник.
    const search = h('input', {
        type: 'search', placeholder: 'Поиск по имени, номеру карты, телефону или @нику',
        style: {
            flex: '1', minWidth: '0', height: '36px', padding: '0 12px', fontFamily: 'inherit',
            fontSize: '13.5px', border: '1px solid var(--ink-200)', borderRadius: '9px',
        },
    });

    const fill = () => {
        const q = search.value.trim().toLowerCase();
        const digits = q.replace(/\D/g, '');
        const all = linksRows();
        const hit = ({ link: l, p }) => {
            if (!q) return true;
            if (p && (p.name || '').toLowerCase().includes(q)) return true;
            if (p && String(p.mrn || '').toLowerCase().includes(q)) return true;
            if (digits && String(l.phone || '').includes(digits)) return true;
            if ((l.tg_username || '').toLowerCase().includes(q)) return true;
            if ((l.tg_name || '').toLowerCase().includes(q)) return true;
            return false;
        };
        const rows = all.filter(hit);
        countEl.textContent = q ? trf('найдено: {n} из {total}', { n: rows.length, total: all.length }) : trf('всего: {n}', { n: all.length });
        clear(listBox);
        if (!rows.length) {
            listBox.appendChild(h('div', { class: 'empty', style: { padding: '30px' } }, 'Никого не найдено.'));
            return;
        }
        // Отвязка перерисовывает и отчёт за поп-апом, и сам список: иначе
        // строка осталась бы активной там, где её уже нет.
        listBox.appendChild(linksTable(rows, bodyEl, () => { paint(bodyEl); fill(); }));
    };
    search.addEventListener('input', fill);

    box.appendChild(h('div', { style: {
        display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px',
    } }, search, countEl));
    box.appendChild(listBox);
    box.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '10px' } }, LINKS_HINT));

    overlay.appendChild(h('div', { class: 'modal-card' },
        h('header', { class: 'modal-head', style: { gap: '12px' } },
            h('div', { style: {
                width: '36px', height: '36px', borderRadius: '10px', flex: '0 0 auto',
                background: 'var(--primary-50)', color: 'var(--primary-700)',
                display: 'grid', placeItems: 'center',
            } }, Icon('Patients', { size: 17 })),
            h('div', { style: { flex: '1', minWidth: '0' } },
                h('h2', null, 'Подключённые пациенты'),
                h('div', { style: { fontSize: '12.5px', color: 'var(--ink-500)', marginTop: '2px', lineHeight: 1.4 } },
                    'Все, кто открыл бота и поделился номером телефона')),
            h('button', { class: 'modal-close', type: 'button', onclick: close }, '×')),
        box));

    document.body.appendChild(overlay);
    fill();
    search.focus();
}

// Дата визита в таблице — числом. fmtDate даёт «17 августа 2026 г.»: для
// подписи под документом это правильно, для колонки, которую сканируют
// взглядом сверху вниз, — слишком длинно.
function shortDate(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return String(iso || '').slice(0, 10);
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// ---------------------------------------------------------------------------
// Рассылка
// ---------------------------------------------------------------------------
// TELEGRAM_BROADCAST_V2 — поп-ап «Сообщение пациентам», который открывает
// кнопка в шапке «Чата с пациентами». `onDone` вызывается после завершения
// рассылки: отчёт использует его, чтобы пересчитать охват (блокировки бота
// меняют статистику), чату обновлять нечего — он его не передаёт.
//
// .modal-compact обязателен, а не косметика: MODAL_COMPACT_OPTOUT_V1
// (admin.css) растягивает КАЖДУЮ карточку без этого класса на весь экран, и
// короткая форма превратилась бы в пустыню — та же ловушка, что описана в
// IMPORTER_UI_V2.
export function openBroadcastModal({ onDone } = {}) {
    const overlay = h('div', { class: 'modal' });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    // display:block — .modal-body по умолчанию grid с растягиванием строк, а
    // здесь обычный вертикальный поток полей (см. .imx-body).
    const box = h('div', { class: 'modal-body', style: { display: 'block' } });

    const ru = h('textarea', { rows: '4', placeholder: 'Текст на русском', style: { width: '100%' } });
    const uz = h('textarea', { rows: '3', placeholder: 'Matn o‘zbek tilida (ixtiyoriy)', style: { width: '100%' } });
    const from = h('input', { type: 'date', style: { width: '100%' } });
    const to = h('input', { type: 'date', style: { width: '100%' } });
    const unpaid = h('input', { type: 'checkbox' });

    const filters = () => {
        const f = {};
        if (from.value) f.visited_from = from.value;
        if (to.value) f.visited_to = to.value;
        if (unpaid.checked) f.unpaid = true;
        return f;
    };

    // TELEGRAM_BROADCAST_IMG_V1 — путь загруженной картинки внутри корзины
    // telegram-media (без имени корзины). null — рассылка без баннера, то есть
    // ровно прежнее поведение.
    let imagePath = null;

    // Счётчик существует не ради красоты: с картинкой подпись вмещает 1024
    // символа против 4096 у обычного сообщения, и длинный текст уедет ВТОРЫМ
    // сообщением. Пусть это будет видно заранее, а не выяснится у пациента.
    const counter = h('div', { style: { fontSize: '12.5px', textAlign: 'right', marginTop: '5px', color: 'var(--ink-500)' } });
    const composedLength = () => {
        const r = ru.value.trim(), u = uz.value.trim();
        return (u ? r + '\n\n' + u : r).length;
    };
    const syncCounter = () => {
        const n = composedLength();
        const split = !!imagePath && n > CAPTION_LIMIT;
        counter.textContent = split
            ? trf('{n} символов · с картинкой уйдёт двумя сообщениями (в подпись помещается {limit})', { n, limit: CAPTION_LIMIT })
            : trf('{n} символов', { n });
        counter.style.color = split ? 'var(--warn-700, #b45309)' : 'var(--ink-500)';
    };
    ru.addEventListener('input', syncCounter);
    uz.addEventListener('input', syncCounter);

    box.appendChild(section('Сообщение',
        h('div', { class: 'field' }, h('label', null, 'Текст на русском'), ru),
        h('div', { class: 'field', style: { marginTop: '10px' } }, h('label', null, 'Тот же текст по-узбекски'), uz),
        hint('Узбекский текст уходит тем же сообщением, следом за русским.'),
        counter));

    box.appendChild(section('Картинка 16:9 · необязательно', imageField()));

    box.appendChild(section('Кому',
        h('div', { style: { display: 'grid', gap: '10px', gridTemplateColumns: '1fr 1fr' } },
            h('div', { class: 'field' }, h('label', null, 'Приходил с'), from),
            h('div', { class: 'field' }, h('label', null, 'по'), to)),
        h('div', { class: 'field checkbox', style: { marginTop: '6px' } },
            unpaid, h('label', null, 'Только с неоплаченным счётом')),
        hint('Бот пишет только тем, кто открыл его сам. Фильтры сужают этот список, а не расширяют.')));

    // ── Загрузка картинки ────────────────────────────────────────────────────
    // Кадрирование и сжатие делает image-16x9.js; здесь только сцена: пустая
    // зона -> превью с кнопкой «убрать». Показываем ИМЕННО результат кадра,
    // а не исходник, — чтобы неудачная обрезка была видна сразу, а не у
    // пациента в Telegram.
    function imageField() {
        const wrap = h('div');
        const input = h('input', {
            type: 'file', accept: 'image/*', style: { display: 'none' },
            onchange: () => {
                const f = input.files && input.files[0];
                input.value = '';           // тот же файл можно выбрать повторно
                if (f) accept(f);
            },
        });

        const idle = () => {
            zone.style.borderColor = 'var(--ink-200, #d6dde0)';
            zone.style.background = 'var(--ink-25, #f6f8f9)';
        };
        const hot = () => {
            zone.style.borderColor = 'var(--primary-400)';
            zone.style.background = 'var(--primary-50)';
        };

        const zone = h('div', {
            title: 'Нажмите или перетащите картинку',
            style: {
                position: 'relative', width: '100%', aspectRatio: '16 / 9',
                border: '1.5px dashed var(--ink-200, #d6dde0)', borderRadius: '12px',
                background: 'var(--ink-25, #f6f8f9)', color: 'var(--ink-500)',
                display: 'grid', placeItems: 'center', textAlign: 'center',
                cursor: 'pointer', overflow: 'hidden',
                transition: 'border-color .12s, background .12s',
            },
            onclick: () => { if (!imagePath) input.click(); },
            onmouseenter: () => { if (!imagePath) hot(); },
            onmouseleave: () => { if (!imagePath) idle(); },
            ondragover: (e) => { e.preventDefault(); hot(); },
            ondragleave: () => { if (!imagePath) idle(); },
            ondrop: (e) => {
                e.preventDefault();
                idle();
                const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
                if (f) accept(f);
            },
        });

        paintEmpty();
        wrap.appendChild(zone);
        wrap.appendChild(input);
        return wrap;

        function paintEmpty() {
            imagePath = null;
            idle();
            zone.style.cursor = 'pointer';
            clear(zone);
            zone.appendChild(h('div', { style: { padding: '16px' } },
                h('div', { style: { color: 'var(--primary-600)' } }, Icon('Image', { size: 22 })),
                h('div', { style: { fontSize: '13.5px', fontWeight: 600, color: 'var(--ink-700)', marginTop: '6px' } },
                    'Перетащите картинку или нажмите'),
                h('div', { style: { fontSize: '12.5px', marginTop: '3px' } },
                    'Любой размер — обрежем по центру до 16:9')));
            syncCounter();
        }

        function paintBusy(label) {
            clear(zone);
            zone.style.cursor = 'default';
            zone.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } }, label));
        }

        // Не paintPreview: этим именем ниже зовётся предпросмотр ПОЛУЧАТЕЛЕЙ,
        // и две функции с одним именем в соседних областях видимости — ровно
        // та мелочь, на которой потом ломают не тот блок.
        function paintImage(url) {
            clear(zone);
            zone.style.cursor = 'default';
            zone.style.borderStyle = 'solid';
            zone.style.borderColor = 'var(--ink-100)';
            zone.style.background = 'var(--ink-900)';
            zone.appendChild(h('img', {
                src: url, alt: 'Картинка рассылки',
                style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
            }));
            zone.appendChild(h('button', {
                type: 'button', class: 'btn btn-sm',
                title: 'Убрать картинку',
                style: {
                    position: 'absolute', top: '8px', right: '8px',
                    background: 'rgba(11,20,24,0.72)', color: '#fff', border: '0',
                },
                onclick: (e) => { e.stopPropagation(); zone.style.borderStyle = 'dashed'; paintEmpty(); },
            }, 'Убрать'));
        }

        async function accept(file) {
            let blob;
            paintBusy('Обрабатываем картинку…');
            try { blob = await fileTo16x9Jpeg(file); }
            catch (e) { toast(e.message || 'Не удалось обработать картинку.', 'error'); return paintEmpty(); }

            paintBusy('Загружаем…');
            const objectPath = `broadcast/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
            const { error } = await supabase.storage.from(MEDIA_BUCKET).upload(objectPath, blob);
            if (error) {
                toast(trf('Не удалось загрузить картинку: {msg}', { msg: error.message || error }), 'error');
                return paintEmpty();
            }
            imagePath = objectPath;
            paintImage(URL.createObjectURL(blob));
            syncCounter();
        }
    }

    const result = h('div', { style: { marginTop: '10px' } });

    const previewBtn = h('button', { class: 'btn', type: 'button', onclick: async () => {
        await run(previewBtn, async () => {
            state.preview = await rpc('telegram_broadcast_preview', { filters: filters() });
            paintPreview();
        });
    } }, Icon('Search', { size: 13 }), ' Показать получателей');

    const sendBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
        if (!ru.value.trim()) return toast('Введите текст сообщения.', 'warn');
        // Считаем получателей заново прямо перед отправкой: между
        // предпросмотром и нажатием кто-то мог подключиться или отвязаться.
        let p;
        try { p = await rpc('telegram_broadcast_preview', { filters: filters() }); }
        catch (e) { return toast(e.message, 'error'); }
        if (!p.count) return toast('Под эти условия не подходит ни один подключённый пациент.', 'warn');

        // Подтверждение числом, а не «ОК»: перепечатать количество — это
        // секунда, а отозвать сообщение, ушедшее не тем людям, нельзя.
        const typed = prompt(
            trf('Сообщение получат {count} чел. (карт: {cards}).\n\n', { count: p.count, cards: p.cards }) +
            (imagePath ? tr('К сообщению приложена картинка.\n') : '') +
            tr('Отменить отправку будет нельзя.\n') +
            trf('Чтобы подтвердить, введите число получателей: {count}', { count: p.count }));
        if (typed === null) return;
        if (String(typed).trim() !== String(p.count)) return toast('Число не совпало — отправка отменена.', 'info');

        await run(sendBtn, async () => {
            const started = await rpc('telegram_broadcast_send', {
                text_ru: ru.value, text_uz: uz.value, filters: filters(), confirm_count: p.count,
                image_path: imagePath,   // TELEGRAM_BROADCAST_IMG_V1 — null, если картинки нет
            });
            toast(trf('Рассылка запущена: {n} получателей.', { n: started.audience_count }), 'success');
            ru.value = ''; uz.value = '';
            watch(started.id);
        });
    } }, Icon('Send', { size: 13 }), ' Отправить');

    box.appendChild(result);

    function paintPreview() {
        clear(result);
        const p = state.preview;
        if (!p) return;
        if (!p.count) {
            result.appendChild(h('div', { class: 'muted' }, 'Под эти условия не подходит ни один подключённый пациент.'));
            return;
        }
        result.appendChild(h('div', null,
            h('b', null, trf('Получателей: {n}', { n: p.count })),
            h('span', { class: 'muted' }, ' · ', trf('карт пациентов: {n}', { n: p.cards }))));
        result.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '6px' } },
            p.sample.map((x) => x.name || x.tg).join(' · ') + (p.count > p.sample.length ? ' …' : '')));
    }

    // Рассылка идёт на сервере; здесь просто показываем ход.
    async function watch(id) {
        clear(result);
        const line = h('div', { class: 'muted' }, 'Отправка…');
        result.appendChild(line);
        for (let i = 0; i < 600; i++) {
            let st;
            try { st = await rpc('telegram_broadcast_status', { id }); }
            catch { break; }
            clear(line);
            line.appendChild(h('span', null,
                trf('Отправлено {sent} из {total}', { sent: st.sent_count, total: st.audience_count }) +
                (st.failed_count ? ' · ' + trf('не доставлено {n}', { n: st.failed_count }) : '') +
                (st.blocked_count ? ' ' + trf('(заблокировали бота: {n})', { n: st.blocked_count }) : '')));
            if (st.status !== 'running') {
                line.appendChild(h('div', { style: { marginTop: '4px' } },
                    st.failed_count ? '' : trf('✅ Готово · {when}', { when: fmtDateTime(st.finished_at) })));
                if (onDone) onDone();   // обновить статистику: блокировки меняют охват
                break;
            }
            await new Promise((r) => setTimeout(r, 1000));
        }
    }

    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '620px' } },
        h('header', { class: 'modal-head', style: { gap: '12px' } },
            // Плитка с иконкой — та же, что в шапке отчёта: два входа в одну
            // тему бота должны выглядеть роднёй, а не двумя разными экранами.
            h('div', { style: {
                width: '36px', height: '36px', borderRadius: '10px', flex: '0 0 auto',
                background: 'var(--primary-50)', color: 'var(--primary-700)',
                display: 'grid', placeItems: 'center',
            } }, Icon('Megaphone', { size: 17 })),
            h('div', { style: { flex: '1', minWidth: '0' } },
                h('h2', null, 'Сообщение пациентам'),
                h('div', { style: { fontSize: '12.5px', color: 'var(--ink-500)', marginTop: '2px', lineHeight: 1.4 } },
                    'Уйдёт всем, кто подключил Telegram-бота и подходит под фильтр')),
            h('button', { class: 'modal-close', type: 'button', onclick: close }, '×')),
        box,
        h('footer', { class: 'modal-foot' }, previewBtn, sendBtn)));

    document.body.appendChild(overlay);
    syncCounter();
    ru.focus();
    return overlay;
}

// TELEGRAM_BROADCAST_IMG_V1 — блок формы с заголовком-рубрикой.
//
// Раньше поля шли сплошным столбцом, и дата с галочкой «неоплаченный счёт»
// висели без объяснения, к чему они относятся. Три рубрики — «Сообщение»,
// «Картинка», «Кому» — отвечают на это одним взглядом.
function section(title, ...children) {
    return h('div', { style: { marginBottom: '18px' } },
        h('div', { style: {
            fontSize: '12.5px', fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase',
            color: 'var(--ink-500)', marginBottom: '9px',
            paddingBottom: '7px', borderBottom: '1px solid var(--ink-100)',
        } }, title),
        ...children);
}

function hint(text) {
    return h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '6px', lineHeight: 1.45 } }, text);
}

// Кнопку только блокируем. Раньше здесь ещё и восстанавливали
// `btn.textContent`, а это стирало <svg> иконки внутри кнопки: после первого
// же «Показать получателей» лупа с самолётиком исчезали до перерисовки.
async function run(btn, fn) {
    if (state.busy) return;
    state.busy = true;
    btn.disabled = true;
    try { await fn(); }
    catch (e) { toast(e.message || 'Не удалось выполнить операцию.', 'error'); }
    finally { state.busy = false; try { btn.disabled = false; } catch (_) { /* перерисовано */ } }
}
