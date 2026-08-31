// TELEGRAM_BOT_V1 — Настройки → «Telegram-бот».
//
// Пациент получает свои документы в Telegram; здесь администратор вводит токен
// бота и решает, что именно бот выдаёт. Это первый слайс: хранение токена,
// проверка связи и режимы. Сам опрос Telegram, связывание чатов по номеру
// телефона и выдача PDF приходят следующими слайсами — поэтому переключатель
// «Бот включён» честно подписан как «пока ничего не делает».
//
// Токен НИКОГДА не приезжает в браузер: сервер отдаёт только последние четыре
// символа (token_hint), чтобы администратор узнал сохранённый токен, не увидев
// его. Всё общение — через admin-only RPC; таблица telegram_settings намеренно
// не зарегистрирована в schema-registry, поэтому через /api/db её не прочитать.

import { supabase } from '../../supabase.js';
import { h, Icon, PageHead, clear, toast, field, checkField, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ

const DOC_KINDS = [
    ['lab',        'Результаты анализов',      'Готовый результат из лаборатории'],
    ['conclusion', 'Заключения консультаций',  'Подписанное заключение врача'],
    ['diag',       'Диагностические заключения', 'УЗИ, рентген и другая диагностика'],
    ['invoice',    'Счета и чеки',             'Только по запросу пациента — автоматически не рассылаются'],
    ['file',       'Загруженные файлы',        'Сканы и файлы, прикреплённые к визиту'],
];

const state = { s: null, busy: false };
let refs = { root: null };

// TG_FOLD_V1 — карточка «Что и как выдаёт бот» складывается.
//
// Состояние живёт в localStorage, а не в модуле: paint() перерисовывает всю
// страницу после каждого сохранения, и сложенная карточка иначе раскрывалась бы
// сама при первом же щелчке по галочке внутри неё.
//
// По умолчанию РАЗВЁРНУТА: настройки, которые не видно, считаются выключенными,
// а тут выключенным считается бот. Свернул — запомнили.
const FOLD_KEY = 'easymed_tg_mode_collapsed';
function foldRead() {
    try { return localStorage.getItem(FOLD_KEY) === '1'; } catch (_) { return false; }
}
function foldWrite(collapsed) {
    try { localStorage.setItem(FOLD_KEY, collapsed ? '1' : '0'); } catch (_) { /* приватный режим — просто не запомним */ }
}

async function rpc(name, args = {}) {
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw new Error(error.message || 'Не удалось выполнить запрос.');
    return data;
}

export async function renderTelegramSettings(container, { onNavigate } = {}) {
    clear(container);
    refs.root = h('div', { class: 'fade-in' });
    container.appendChild(refs.root);

    refs.root.appendChild(PageHead({
        title: 'Telegram-бот',
        subtitle: 'Пациент подтверждает номер телефона в Telegram и получает свои документы. Токен бота хранится на сервере в зашифрованном виде.',
    }));

    const body = h('div');
    refs.root.appendChild(body);
    refs.body = body;

    body.appendChild(h('div', { class: 'muted', style: { padding: '24px' } }, 'Загрузка…'));
    try {
        state.s = await rpc('telegram_settings_get');
    } catch (e) {
        clear(body);
        body.appendChild(h('div', { class: 'empty', style: { padding: '30px' } },
            trf('Не удалось загрузить настройки: {msg}', { msg: e.message })));
        return;
    }
    paint();
}

function paint() {
    clear(refs.body);
    refs.body.appendChild(tokenCard());
    refs.body.appendChild(modeCard());
    refs.body.appendChild(helpCard());
}

// TG_LINKS_IN_REPORT_V1 — «Подключённые пациенты» (список чатов + «Отвязать»)
// переехали отсюда в «Отчёты → Telegram-бот» (views/telegram-report.js).
// Настройки отвечают на вопрос «как бот устроен» — токен и что он выдаёт; «кто
// подключён и сколько карт это открывает» — наблюдение за его работой, и место
// ему рядом с охватом, который считает ровно этих людей.

// ---------------------------------------------------------------------------
// Статус — одной строкой, потому что это первое, что администратор ищет глазами
// ---------------------------------------------------------------------------
function statusRow() {
    const s = state.s;
    if (!s.has_token) {
        return banner('warn', 'Warning', 'Токен не задан', 'Бот не работает. Создайте бота в @BotFather и вставьте токен ниже.');
    }
    if (s.last_check_status === 'ok') {
        const who = s.bot_username ? '@' + s.bot_username : tr('бот подтверждён');
        return banner('ok', 'Check', trf('Связь с Telegram установлена · {who}', { who }),
            s.last_check_at ? trf('Последняя проверка: {when}', { when: fmtDateTime(s.last_check_at) }) : '');
    }
    if (s.last_check_status === 'error') {
        return banner('err', 'Warning', 'Telegram отклонил токен', s.last_check_error || '');
    }
    return banner('warn', 'Warning', 'Токен сохранён, связь не проверялась',
        'Нажмите «Проверить связь», чтобы убедиться, что токен рабочий.');
}

const BANNER_STYLE = {
    ok:   { bg: '#e8f6ed', fg: '#2e8b52' },
    warn: { bg: '#fdf3e1', fg: '#b07d1f' },
    err:  { bg: '#fbe8e8', fg: '#b03a3a' },
};
function banner(kind, icon, title, note) {
    const c = BANNER_STYLE[kind] || BANNER_STYLE.warn;
    return h('div', { class: 'row', style: {
        gap: '10px', alignItems: 'flex-start', background: c.bg, color: c.fg,
        padding: '12px 14px', borderRadius: '10px', marginBottom: '16px',
    } },
        h('span', { style: { flex: '0 0 auto', marginTop: '1px' } }, Icon(icon, { size: 15 })),
        h('div', null,
            h('div', { style: { fontWeight: '600' } }, title),
            note ? h('div', { style: { fontSize: '13.5px', opacity: '.85', marginTop: '2px' } }, note) : null),
    );
}

// ---------------------------------------------------------------------------
// Карточка токена
// ---------------------------------------------------------------------------
function tokenCard() {
    const s = state.s;
    const card = h('div', { style: { padding: '18px' } });
    card.appendChild(statusRow());

    // type=password — токен не должен светиться на экране в регистратуре, где
    // за спиной администратора стоит очередь.
    const input = h('input', {
        type: 'password', autocomplete: 'off', spellcheck: 'false', style: { width: '100%' },
        placeholder: s.has_token ? 'Введите новый токен, чтобы заменить' : '1234567890:AAE…',
    });
    const showBtn = h('button', { class: 'btn btn-sm', type: 'button',
        onclick: () => {
            input.type = input.type === 'password' ? 'text' : 'password';
            showBtn.textContent = input.type === 'password' ? 'Показать' : 'Скрыть';
        } }, 'Показать');

    card.appendChild(field(
        s.has_token ? trf('Сохранённый токен: …{hint} (заменить)', { hint: s.token_hint }) : 'Токен из @BotFather',
        h('div', { class: 'row', style: { gap: '8px' } },
            h('div', { style: { flex: '1' } }, input), showBtn)));

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button',
        onclick: async () => {
            const v = input.value.trim();
            if (!v) return toast('Введите токен.', 'warn');
            await run(saveBtn, async () => {
                // Один шаг вместо трёх: сервер сам проверяет связь и включает
                // бота. Раньше здесь было «сохранить → проверить → включить»,
                // и пропуск любого шага давал молча неработающего бота.
                const res = await rpc('telegram_settings_save', { bot_token: v });
                state.s = res;
                input.value = '';
                if (res.check_error) toast(trf('Токен сохранён, но Telegram его не принял: {msg}', { msg: res.check_error }), 'error');
                else if (res.auto_enabled) toast(trf('Готово! Бот @{bot} включён и отвечает пациентам.', { bot: res.bot_username || '' }), 'success');
                else toast('Токен сохранён.', 'success');
                paint();
                // TG_LINKS_IN_REPORT_V1 — здесь был loadLinks(): список чатов
                // переехал в «Отчёты → Telegram-бот» и грузится там.
            });
        } }, Icon('Check', { size: 13 }), ' Сохранить токен');

    // h() ставит checked/disabled только на ИСТИННОЕ значение, поэтому здесь
    // именно булево: `disabled: ''` тихо не сработало бы.
    const testBtn = h('button', { class: 'btn', type: 'button', disabled: !s.has_token,
        onclick: async () => {
            await run(testBtn, async () => {
                const res = await rpc('telegram_test_connection');
                state.s = res.settings;
                if (res.ok) toast(trf('Связь есть: @{bot}', { bot: res.bot.username || tr('бот') }), 'success');
                else toast(res.error, 'error');
                paint();
            });
        } }, Icon('Refresh', { size: 13 }), ' Проверить связь');

    const clearBtn = h('button', { class: 'btn btn-danger', type: 'button',
        style: { display: s.has_token ? '' : 'none' },
        onclick: async () => {
            // Удаление выключает бота — говорим об этом до, а не после.
            if (!confirm(tr('Удалить токен? Бот будет выключен, и пациенты перестанут получать документы.'))) return;
            await run(clearBtn, async () => {
                state.s = await rpc('telegram_token_clear');
                toast('Токен удалён, бот выключен.', 'info');
                paint();
            });
        } }, 'Удалить токен');

    card.appendChild(h('div', { class: 'row', style: { gap: '8px', marginTop: '12px' } },
        saveBtn, testBtn, h('span', { class: 'grow' }), clearBtn));

    if (s.bot_username) {
        const link = 'https://t.me/' + s.bot_username;
        card.appendChild(h('div', { class: 'muted', style: { marginTop: '14px', fontSize: '13.5px' } },
            'Ссылка для пациентов: ',
            h('a', { href: link, target: '_blank', rel: 'noopener' }, link),
            ' · ',
            h('button', { class: 'btn btn-sm', type: 'button',
                onclick: () => { navigator.clipboard.writeText(link).then(() => toast('Ссылка скопирована.', 'success')); } },
                'Копировать')));
    }
    return h('div', { class: 'card', style: { marginBottom: '16px' } },
        h('div', { class: 'card-header' }, h('h3', null, Icon('Bot', { size: 16 }), ' Токен бота')),
        card);
}

// ---------------------------------------------------------------------------
// Карточка режимов
// ---------------------------------------------------------------------------
function modeCard() {
    const s = state.s;
    const card = h('div', { style: { padding: '18px' } });

    // Главный выключатель сохраняется СРАЗУ по щелчку, а не по кнопке внизу.
    // Так было не всегда, и это стоило одного «почему бот не работает»: на
    // странице две кнопки сохранения, и галочку «Бот включён» легко отметить,
    // нажать «Сохранить токен» — и уйти, считая бота включённым. Выключатель
    // должен выключать, а не ждать подтверждения.
    const enabled = h('input', { type: 'checkbox', checked: !!s.enabled,
        onchange: async () => {
            enabled.disabled = true;
            try {
                state.s = await rpc('telegram_settings_save', { enabled: enabled.checked });
                toast(state.s.enabled ? 'Бот включён — пациенты могут им пользоваться.' : 'Бот выключен.', 'success');
                paint();
            } catch (e) {
                enabled.checked = !enabled.checked;   // не сохранилось — не врём галочкой
                toast(e.message || 'Не удалось сохранить.', 'error');
            } finally { enabled.disabled = false; }
        } });
    const push = h('input', { type: 'checkbox', checked: !!s.push_enabled });
    card.appendChild(checkField('Бот включён', enabled));
    card.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '-6px 0 12px 26px' } },
        'Сохраняется сразу. Пока выключено, бот не отвечает пациентам и ничего не рассылает.'));
    card.appendChild(checkField('Отправлять документ сразу, как он готов', push));
    card.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '-6px 0 14px 26px' } },
        'Без этого бот молчит и отдаёт документы только по запросу пациента. Счета не рассылаются автоматически в любом случае.'));

    const boxes = DOC_KINDS.map(([key, label, note]) => {
        const cb = h('input', { type: 'checkbox', checked: s.doc_kinds.includes(key) });
        return { key, cb, node: h('div', null,
            checkField(label, cb),
            h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '-6px 0 10px 26px' } }, note)) };
    });
    card.appendChild(h('div', { style: { marginTop: '6px' } },
        h('div', { style: { fontWeight: '600', marginBottom: '8px' } }, 'Какие документы разрешено выдавать'),
        ...boxes.map((b) => b.node)));

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button',
        onclick: async () => {
            await run(saveBtn, async () => {
                // enabled сюда НЕ передаём: у него собственное мгновенное
                // сохранение выше, и дублировать его здесь значит поймать
                // гонку между двумя источниками правды.
                state.s = await rpc('telegram_settings_save', {
                    push_enabled: push.checked,
                    doc_kinds: boxes.filter((b) => b.cb.checked).map((b) => b.key),
                });
                toast('Сохранено.', 'success');
                paint();
            });
        } }, 'Сохранить остальное');
    card.appendChild(h('div', { style: { marginTop: '12px' } }, saveBtn));

    // TG_FOLD_V1 — заголовок стал кнопкой: щелчок по нему складывает карточку.
    // Разметка та же (.card-header уже flex со space-between), поэтому шеврон
    // встаёт справа сам и вид карточки не меняется.
    let collapsed = foldRead();
    const chevron = h('span', {
        style: { display: 'inline-flex', color: 'var(--ink-400)', transition: 'transform 150ms ease' },
    }, Icon('ChevronDown', { size: 16 }));
    const bodyWrap = h('div', null, card);
    const apply = () => {
        bodyWrap.style.display = collapsed ? 'none' : '';
        chevron.style.transform = collapsed ? 'rotate(-90deg)' : '';
        // Свёрнутая карточка не должна оставлять висящую линию под заголовком.
        head.style.borderBottom = collapsed ? '0' : '';
    };
    const head = h('button', {
        type: 'button', class: 'card-header',
        title: 'Свернуть или развернуть',
        'aria-expanded': collapsed ? 'false' : 'true',
        style: {
            width: '100%', border: '0', background: 'transparent', cursor: 'pointer',
            font: 'inherit', textAlign: 'left', color: 'inherit',
        },
        onclick: () => {
            collapsed = !collapsed;
            foldWrite(collapsed);
            head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
            apply();
        },
    },
        h('h3', null, Icon('Doc', { size: 16 }), ' Что и как выдаёт бот'),
        chevron);
    apply();

    return h('div', { class: 'card', style: { marginBottom: '16px', overflow: 'hidden' } }, head, bodyWrap);
}

function helpCard() {
    const card = h('div', { style: { padding: '18px' } });
    const ol = h('ol', { style: { margin: '0 0 0 18px', lineHeight: '1.9' } },
        h('li', null, 'Откройте в Telegram чат с ', h('b', null, '@BotFather'), '.'),
        h('li', null, 'Отправьте команду ', h('code', null, '/newbot'), ' и придумайте имя бота — например, «Клиника · Мои документы».'),
        h('li', null, 'BotFather пришлёт строку вида ', h('code', null, '1234567890:AAE…'), ' — это и есть токен.'),
        h('li', null, 'Вставьте его в поле выше и нажмите «Проверить связь».'),
    );
    card.appendChild(ol);
    card.appendChild(h('div', { class: 'muted', style: { marginTop: '14px', fontSize: '13.5px' } },
        'Токен — это полный доступ к боту и переписке с пациентами. Не пересылайте его в чатах и не храните в текстовых файлах: ' +
        'на сервере он лежит зашифрованным и обратно в браузер не выдаётся. Если токен всё же куда-то попал — отзовите его ' +
        'в @BotFather командой /revoke и сохраните здесь новый.'));
    return h('div', { class: 'card' },
        h('div', { class: 'card-header' }, h('h3', null, Icon('Help', { size: 16 }), ' Как получить токен')),
        card);
}

// Одна кнопка за раз: два параллельных сохранения настроек — это гонка,
// в которой побеждает случайное.
async function run(btn, fn) {
    if (state.busy) return;
    state.busy = true;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';
    try { await fn(); }
    catch (e) { toast(e.message || 'Не удалось выполнить операцию.', 'error'); }
    finally {
        state.busy = false;
        try { btn.disabled = false; btn.textContent = label; } catch (_) { /* перерисовано */ }
    }
}
