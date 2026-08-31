// TELEPHONY_V1 — Настройки → «Телефония» (docs/plans/2026-08-23-binotel-telephony.md, Task 2).
//
// Стандартная интеграция колл-центра: администратор вводит ключи Binotel,
// проверяет связь, включает опрос звонков и — если у клиники есть публичный
// адрес — WebHook-и. Дальше «Звонки → заявки»: из каких исходов звонка
// система сама делает карточку в CRM. Внизу журнал последних звонков как
// доказательство, что интеграция живёт.
//
// TELEPHONY_ROUTING_V1 (docs/plans/2026-08-24-telephony-owns-its-routing.md)
// — карточка «Звонки → заявки» приехала сюда из настроек CRM-канбана по
// поправке владельца, и поправка верная: правило «звонок → заявка» — это
// свойство ИСТОЧНИКА, а не доски. У Binotel есть исходы звонка, у формы на
// сайте будут свои, у Instagram нет никаких. Каждый источник настраивает
// свою маршрутизацию сам, рядом со своими ключами. Хранилище не менялось:
// таблица crm_call_routing и контракт crm_config_save {routing} те же, они
// с самого начала ключевались по provider — потому переезд и оказался
// чистым переносом UI. Экран продаётся модулем «callcenter»: маршрутизатор в
// admin.js сам показывает стандартный экран «Модуль не подключён» (см. запись
// в licensed-modules.js), сюда невыкупленная клиника не доходит.
//
// Secret НИКОГДА не приезжает в браузер: сервер отдаёт только api_secret_set
// true/false (та же поза, что token_hint у Telegram-бота), поэтому поле secret
// всегда пустое, а о сохранённом значении говорит placeholder.
//
// Серверная часть строится ПАРАЛЛЕЛЬНО по тому же плану: пока её RPC не
// смержены, маршрут отвечает 501 rpc_not_implemented — на это экран отвечает
// спокойной строкой «недоступно», а не падением (isNotImplemented ниже).
// Все решения отображения — telephony-logic.js; здесь только DOM.

import { supabase } from '../../supabase.js';
import { h, Icon, PageHead, Tag, clear, toast, field, checkField } from '../ui.js';
// h() прогоняет текстовые дети через tr() сам; но всё, что меняет текст ПОСЛЕ
// отрисовки через .textContent, обходит h() — те места зовут tr() явно
// (тот же приём, что в locked-module.js).
import { tr, trf } from '../i18n.js';
import {
    DASH, secretPlaceholder, normalizeInterval, webhookUrl, shapeCalls,
    statusTime, textOrDash, isNotImplemented, shapeDispositions, pluralRu,
} from '../telephony-logic.js';
// Словарь исходов звонка и список действий берутся из CRM-логики, а не
// переписываются здесь: карточка переехала, ПРАВИЛА не менялись. Второй
// экземпляр DISPOSITION_RU разошёлся бы с сервером через один релиз —
// ровно та причина, по которой crm-settings-logic.js сам импортирует
// isNotImplemented отсюда, а не копирует его.
import {
    dispositionRu, ROUTING_ACTIONS, validateRouting, shapeConfig,
} from '../crm-settings-logic.js';

const state = {
    s: null, calls: null, callsError: null, busy: false,
    // «Звонки → заявки»: исходы с их правилами (telephony_dispositions) и
    // видимые колонки канбана для выпадающего списка (crm_config_get).
    // null = ещё грузится, [] = загрузилось и пусто — разные экраны.
    routing: null, stages: [], routingError: null,
};
let refs = { root: null, body: null, callsBody: null, routingBody: null, onNavigate: null };

async function rpc(name, args = {}) {
    const { data, error } = await supabase.rpc(name, args);
    if (error) {
        const e = new Error(error.message || 'Не удалось выполнить запрос.');
        // Код нужен isNotImplemented(): по нему «сервер старее экрана»
        // отличается от настоящей ошибки. new Error() его теряет — переносим.
        e.code = error.code;
        throw e;
    }
    return data;
}

export async function renderTelephonySettings(container, { onNavigate } = {}) {
    clear(container);
    refs = { root: null, body: null, callsBody: null, routingBody: null, onNavigate: onNavigate || null };
    // tel-set — область действия базовых стилей полей ввода этого экрана.
    // Причина — в public/css/admin-views.css рядом с самим блоком: admin.html
    // не задаёт <input>/<select> ВООБЩЕ, и без этого класса каждое поле здесь
    // рисуется голым браузерным прямоугольником.
    refs.root = h('div', { class: 'fade-in tel-set' });
    container.appendChild(refs.root);

    refs.root.appendChild(PageHead({
        title: 'Телефония',
        subtitle: 'Стандартная интеграция с АТС Binotel: звонки клиники попадают в журнал и находят карту пациента по номеру телефона.',
    }));

    const body = h('div');
    refs.root.appendChild(body);
    refs.body = body;

    body.appendChild(h('div', { class: 'muted', style: { padding: '24px' } }, 'Загрузка…'));
    try {
        state.s = await rpc('telephony_settings_get', {});
    } catch (e) {
        clear(body);
        if (isNotImplemented(e)) {
            // Сервер ещё без телефонии (задача строится параллельно) — это не
            // авария, и пугать клинику красным нечем.
            body.appendChild(h('div', { class: 'empty', style: { padding: '30px' } },
                'Телефония недоступна: сервер ещё не обновлён до этой версии.'));
        } else {
            body.appendChild(h('div', { class: 'empty', style: { padding: '30px' } },
                trf('Не удалось загрузить настройки: {msg}', { msg: e.message })));
        }
        return;
    }
    state.calls = null;
    state.callsError = null;
    state.routing = null;
    state.stages = [];
    state.routingError = null;
    paint();
    // Журнал и маршрут грузятся ПОСЛЕ отрисовки настроек и перекрашивают
    // только свои карточки: полный paint() здесь стёр бы ключ, который
    // администратор уже начал вводить, пока списки ехали.
    loadCalls();
    loadRouting();
}

function paint() {
    clear(refs.body);
    refs.body.appendChild(connectionCard());
    refs.body.appendChild(pollingCard());
    refs.body.appendChild(webhooksCard());
    // Маршрут стоит ПОСЛЕ подключения и опроса и ПЕРЕД журналом: правила
    // бессмысленны, пока связь не работает (потому не выше), но это всё ещё
    // настройка, а журнал — не настройка, а доказательство жизни (потому не
    // ниже него).
    refs.body.appendChild(routingCard());
    refs.body.appendChild(callsCard());
}

// ---------------------------------------------------------------------------
// 1. Подключение — ключи и проверка связи
// ---------------------------------------------------------------------------
function connectionCard() {
    const s = state.s;
    const card = h('div', { style: { padding: '18px' } });

    card.appendChild(field('Провайдер', h('div', { style: { fontWeight: '600' } }, 'Binotel')));
    card.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '-6px 0 14px' } },
        'Ключ и secret выдаёт поддержка Binotel — support@binotel.ua.'));

    const keyInput = h('input', {
        type: 'text', autocomplete: 'off', spellcheck: 'false', style: { width: '100%' },
        value: s.api_key || '', placeholder: 'ключ из письма Binotel',
    });
    card.appendChild(field('API-ключ (key)', keyInput));

    // type=password — secret не должен светиться на экране в регистратуре
    // (та же причина, что у токена Telegram-бота).
    const secInput = h('input', {
        type: 'password', autocomplete: 'off', spellcheck: 'false', style: { width: '100%' },
        placeholder: secretPlaceholder(!!s.api_secret_set),
    });
    const showBtn = h('button', { class: 'btn btn-sm', type: 'button',
        onclick: () => {
            secInput.type = secInput.type === 'password' ? 'text' : 'password';
            showBtn.textContent = tr(secInput.type === 'password' ? 'Показать' : 'Скрыть');
        } }, 'Показать');
    card.appendChild(field(
        s.api_secret_set ? 'Secret: сохранён (заменить)' : 'Secret',
        h('div', { class: 'row', style: { gap: '8px' } },
            h('div', { style: { flex: '1' } }, secInput), showBtn)));

    // Третий реквизит из письма Binotel — Company ID (короткий номер). Не
    // секрет: обычный text, предзаполняется как ключ. Пустым быть может — он
    // лишь включает дополнительную проверку вебхуков на сервере, поэтому
    // сохраняется вместе с ключом ВСЕГДА, в том числе пустым (очистка поля
    // должна очищать и хранилище, а не молча оставлять старый номер).
    const cidInput = h('input', {
        type: 'text', autocomplete: 'off', spellcheck: 'false', style: { width: '100%' },
        value: s.company_id || '',
    });
    card.appendChild(field('Company ID', cidInput));
    card.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '-6px 0 14px' } },
        'Номер компании в Binotel — указан в письме с данными интеграции'));

    // role="status" — живая область: результат проверки объявляется читалке,
    // где бы ни был фокус (тот же приём, что на экране «Модуль не подключён»).
    const resultLine = h('div', { role: 'status', style: { marginTop: '10px', fontSize: '13.5px', minHeight: '18px' } });
    const setResult = (ok, text) => {
        resultLine.style.color = ok ? 'var(--ok-700, #2e8b52)' : 'var(--crit-700, #b03a3a)';
        resultLine.textContent = text;
    };

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button',
        onclick: async () => {
            const key = keyInput.value.trim();
            if (!key) return toast('Введите API-ключ.', 'warn');
            await run(saveBtn, async () => {
                // Secret уходит ТОЛЬКО когда введён новый: пустое поле — это
                // «оставить сохранённый», и контракт RPC перезаписывает secret
                // лишь непустым значением.
                const payload = { api_key: key, company_id: cidInput.value.trim() };
                const sec = secInput.value.trim();
                if (sec) payload.api_secret = sec;
                await rpc('telephony_settings_save', payload);
                // save отвечает {ok} — состояние (api_secret_set и прочее)
                // перечитываем, а не додумываем.
                state.s = await rpc('telephony_settings_get', {});
                toast('Сохранено.', 'success');
                paint();
            });
        } }, Icon('Check', { size: 13 }), ' ', tr('Сохранить подключение'));

    const testBtn = h('button', { class: 'btn', type: 'button',
        onclick: async () => {
            await run(testBtn, async () => {
                // Введённые, но не сохранённые ключи проверяются как есть —
                // так администратор узнаёт про опечатку ДО сохранения. Пустые
                // поля не передаём: сервер проверит сохранённые.
                const args = {};
                const key = keyInput.value.trim();
                const sec = secInput.value.trim();
                if (key) args.api_key = key;
                if (sec) args.api_secret = sec;
                resultLine.style.color = '';
                resultLine.textContent = tr('Проверка…');
                try {
                    const res = await rpc('telephony_test', args);
                    if (res && res.ok) setResult(true, tr('Подключение работает.'));
                    // res.reason — человеческая русская фраза от сервера,
                    // динамика в словарь не ходит.
                    else setResult(false, (res && res.reason) || tr('Не удалось подключиться.'));
                } catch (e) {
                    // Честная строка вместо тоста: результат проверки должен
                    // остаться на экране, а не растаять через 2,4 секунды.
                    if (isNotImplemented(e)) setResult(false, tr('Проверка недоступна: сервер ещё не обновлён.'));
                    else setResult(false, e.message || tr('Не удалось подключиться.'));
                }
            });
        } }, Icon('Refresh', { size: 13 }), ' ', tr('Проверить подключение'));

    card.appendChild(h('div', { class: 'row', style: { gap: '8px', marginTop: '12px' } }, saveBtn, testBtn));
    card.appendChild(resultLine);

    return h('div', { class: 'card', style: { marginBottom: '16px' } },
        h('div', { class: 'card-header' }, h('h3', null, Icon('Phone', { size: 16 }), ' ', tr('Подключение'))),
        card);
}

// ---------------------------------------------------------------------------
// 2. Опрос звонков — работает и в полностью локальной клинике
// ---------------------------------------------------------------------------
function pollingCard() {
    const s = state.s;
    const card = h('div', { style: { padding: '18px' } });

    // Выключатель сохраняется СРАЗУ по щелчку — тот же урок, что у галочки
    // «Бот включён» в telegram-settings.js: выключатель, ждущий отдельной
    // кнопки, оставляют «включённым» и уходят.
    const enabled = h('input', { type: 'checkbox', checked: !!s.enabled,
        onchange: async () => {
            enabled.disabled = true;
            try {
                await rpc('telephony_settings_save', { enabled: enabled.checked });
                state.s.enabled = enabled.checked;
                toast(enabled.checked ? 'Опрос звонков включён.' : 'Опрос звонков выключен.', 'success');
            } catch (e) {
                enabled.checked = !enabled.checked;   // не сохранилось — не врём галочкой
                toast(e.message || 'Не удалось сохранить.', 'error');
            } finally { enabled.disabled = false; }
        } });
    card.appendChild(checkField('Опрос включён', enabled));
    card.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '-6px 0 12px 26px' } },
        'Сохраняется сразу. Система сама опрашивает Binotel и записывает новые звонки в журнал.'));

    const intInput = h('input', {
        type: 'number', min: '10', step: '1', style: { width: '120px' },
        value: s.poll_interval_sec != null ? String(s.poll_interval_sec) : '30',
    });
    const intBtn = h('button', { class: 'btn', type: 'button',
        onclick: async () => {
            const v = normalizeInterval(intInput.value);
            // Отказ, а не подмена: молча превратить «5» в 10 значит сохранить
            // то, чего администратор не вводил.
            if (v == null) return toast('Интервал опроса — целое число, не меньше 10 секунд.', 'warn');
            await run(intBtn, async () => {
                await rpc('telephony_settings_save', { poll_interval_sec: v });
                state.s.poll_interval_sec = v;
                toast('Сохранено.', 'success');
            });
        } }, 'Сохранить интервал');
    card.appendChild(field('Интервал опроса, секунд',
        h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, intInput, intBtn)));

    const statusRow = (label, value) => h('div', { class: 'muted', style: { fontSize: '13.5px', marginTop: '4px' } },
        label, ': ', h('span', { style: { color: 'var(--ink-700, inherit)' } }, value));
    card.appendChild(h('div', { style: { marginTop: '10px' } },
        statusRow('Последняя проверка', statusTime(s.last_poll_at)),
        statusRow('Последний звонок', statusTime(s.last_call_at)),
        statusRow('Последняя ошибка', textOrDash(s.last_error))));

    card.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '12px' } },
        'Звонки появляются в журнале с задержкой до одного интервала опроса. Карточка звонка прямо в момент вызова — только через WebHook-и.'));

    return h('div', { class: 'card', style: { marginBottom: '16px' } },
        h('div', { class: 'card-header' }, h('h3', null, Icon('Refresh', { size: 16 }), ' ', tr('Опрос звонков'))),
        card);
}

// ---------------------------------------------------------------------------
// 3. WebHook-и — честно: нужен публичный адрес, у большинства его нет
// ---------------------------------------------------------------------------
function webhooksCard() {
    const s = state.s;
    const card = h('div', { style: { padding: '18px' } });

    const wh = h('input', { type: 'checkbox', checked: !!s.webhooks_enabled,
        onchange: async () => {
            wh.disabled = true;
            try {
                await rpc('telephony_settings_save', { webhooks_enabled: wh.checked });
                state.s.webhooks_enabled = wh.checked;
                toast(wh.checked ? 'WebHook-и включены.' : 'WebHook-и выключены.', 'success');
            } catch (e) {
                wh.checked = !wh.checked;
                toast(e.message || 'Не удалось сохранить.', 'error');
            } finally { wh.disabled = false; }
        } });
    card.appendChild(checkField('WebHook-и включены', wh));
    card.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '-6px 0 12px 26px' } },
        'Сохраняется сразу. По умолчанию выключено — включайте только после настройки адреса у Binotel.'));

    const urlInput = h('input', {
        type: 'text', autocomplete: 'off', spellcheck: 'false', style: { width: '100%' },
        value: s.public_base_url || '', placeholder: 'https://clinic.example.uz',
    });
    const urlBtn = h('button', { class: 'btn', type: 'button',
        onclick: async () => {
            await run(urlBtn, async () => {
                await rpc('telephony_settings_save', { public_base_url: urlInput.value.trim() });
                state.s.public_base_url = urlInput.value.trim();
                toast('Сохранено.', 'success');
                paint();   // строка с адресом для Binotel собирается из этого поля
            });
        } }, 'Сохранить адрес');
    card.appendChild(field('Публичный адрес клиники',
        h('div', { class: 'row', style: { gap: '8px' } },
            h('div', { style: { flex: '1' } }, urlInput), urlBtn)));

    const url = webhookUrl(s.public_base_url);
    if (url) {
        card.appendChild(h('div', { style: { marginTop: '4px' } },
            h('div', { style: { fontWeight: '600', marginBottom: '4px' } }, 'Адрес для Binotel'),
            h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } },
                h('input', { readonly: '', value: url, class: 'cell-mono',
                    style: { flex: '1', height: '34px', padding: '0 10px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '12.5px' },
                    onclick: (e) => e.target.select() }),
                h('button', { class: 'btn btn-sm', type: 'button',
                    onclick: () => { navigator.clipboard.writeText(url).then(() => toast('Адрес скопирован.', 'success')); } },
                    'Копировать'))));
    } else {
        card.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } },
            'Укажите публичный адрес клиники (https://…) — из него собирается адрес для Binotel.'));
    }

    // Честные ограничения — прямо на экране, не в документации: у большинства
    // локальных установок публичного адреса нет, и обещать им всплывающую
    // карточку звонка было бы враньём.
    card.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '12px', lineHeight: '1.6' } },
        h('div', null, 'WebHook-и работают, только когда клиника доступна из интернета по этому адресу. Большинство локальных установок работают без них — звонки собирает опрос.'),
        h('div', null, 'Binotel присылает события только со своих серверных адресов — приём ограничен этим списком IP, чужие запросы отбрасываются.')));

    return h('div', { class: 'card', style: { marginBottom: '16px' } },
        h('div', { class: 'card-header' }, h('h3', null, Icon('Globe', { size: 16 }), ' WebHook-и')),
        card);
}

// ---------------------------------------------------------------------------
// 4. Звонки → заявки — маршрут исходов звонка в колонки канбана
// ---------------------------------------------------------------------------
// Статусы здесь НЕ вписываются руками. Их два источника, и оба честные:
//   наблюдённые — то, что АТС этой клиники реально прислала (таблица calls);
//                 у Binotel нет метода «перечисли все исходы», так что это и
//                 есть настоящий ответ на вопрос «какие статусы мы получаем»;
//   вендорские  — список из документации, засеянный миграцией 077, чтобы
//                 правило можно было задать ДО первого такого звонка.
// Оба приезжают одним вызовом telephony_dispositions, уже с текущим правилом
// в каждой строке — склеивать два ответа в браузере значит однажды нарисовать
// правило напротив чужого исхода.
function routingCard() {
    refs.routingBody = h('div');
    paintRouting();
    return h('div', { class: 'card', style: { marginBottom: '16px' } },
        h('div', { class: 'card-header' }, h('h3', null, Icon('Headset', { size: 16 }), ' ', tr('Звонки → заявки'))),
        refs.routingBody);
}

async function loadRouting() {
    try {
        // Один заход, два вопроса: какие исходы бывают (со своими правилами)
        // и в какие колонки их вообще можно класть. Колонки живут в CRM и
        // читаются её же RPC — второй список колонок здесь разошёлся бы с
        // доской в первый же раз, когда владелец переименует колонку.
        const [disp, cfg] = await Promise.all([
            rpc('telephony_dispositions', {}),
            rpc('crm_config_get', {}),
        ]);
        state.routing = shapeDispositions(disp);
        // Только видимые: правило, ведущее в скрытую колонку, сервер и так
        // отказывается сохранять (saveRouting) — заявка легла бы туда, где её
        // никто не увидит, что для клиники неотличимо от потерянной заявки.
        state.stages = shapeConfig(cfg).stages.filter((s) => s.is_active);
        state.routingError = null;
    } catch (e) {
        state.routing = null;
        state.routingError = e;
    }
    if (refs.routingBody) paintRouting();
}

function paintRouting() {
    const box = refs.routingBody;
    if (!box) return;
    clear(box);

    if (state.routingError) {
        box.appendChild(h('div', { class: 'muted', style: { padding: '24px' } },
            isNotImplemented(state.routingError)
                ? 'Маршрут звонков недоступен: сервер ещё не обновлён.'
                // Две РАЗНЫЕ текстовые дети, а не склейка: h() прогоняет tr()
                // по каждой строке-источнику отдельно, и «…маршрут: <ошибка>»
                // одним куском не нашлось бы в словаре никогда.
                : ['Не удалось загрузить маршрут: ', state.routingError.message]));
        return;
    }
    if (state.routing === null) {
        box.appendChild(h('div', { class: 'muted', style: { padding: '24px' } }, 'Загрузка…'));
        return;
    }

    box.appendChild(h('div', { class: 'muted tel-route-note', style: { padding: '18px 18px 0' } },
        'Телефония сообщает, чем закончился каждый звонок. Здесь решается, из каких звонков система сама делает заявку и в какую колонку её кладёт.'));

    if (!state.routing.length) {
        // Ни одного звонка и ни одного правила: у свежей установки такого не
        // бывает (миграция засевает вендорский список), поэтому сюда попадают
        // только клиники с вычищенной таблицей — и им нужна спокойная фраза,
        // а не пустая таблица.
        box.appendChild(h('div', { class: 'empty', style: { padding: '30px 20px' } },
            h('p', null, 'Исходов звонков пока нет.'),
            h('p', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } },
                'Они появятся сами, как только Binotel пришлёт первый звонок.')));
        box.appendChild(routingFootnote());
        return;
    }

    const tb = h('tbody');
    for (const r of state.routing) {
        // Исход, для которого у экрана нет русского слова, dispositionRu
        // возвращает сырым кодом — и тогда строка ниже его не повторяет.
        // Три SMS-* правила все называются «SMS» и различаются ТОЛЬКО кодом,
        // поэтому для известных исходов код обязателен.
        const ru = dispositionRu(r.disposition);
        const nameIsCode = ru === r.disposition;
        // Список действий управляет списком колонок: у «не создавать» колонки
        // нет, и поле выключается, а не притворяется, что выбор ещё важен.
        const stageSel = h('select', { class: 'tel-route-stage', disabled: r.action !== 'create' },
            ...state.stages.map((st) => h('option', { value: st.key, selected: r.stage_key === st.key }, st.label)));
        stageSel.addEventListener('change', () => { r.stage_key = stageSel.value; });

        const actionSel = h('select', { class: 'tel-route-action' },
            ...ROUTING_ACTIONS.map((a) => h('option', { value: a.value, selected: r.action === a.value }, a.label)));
        actionSel.addEventListener('change', () => {
            r.action = actionSel.value;
            // Переключение на «создать заявку» без колонки собрало бы правило,
            // которое сервер откажется сохранять. Кладём в первую видимую —
            // владелец переставит, а правило до тех пор валидно.
            if (r.action === 'create' && !state.stages.some((st) => st.key === r.stage_key)) {
                r.stage_key = state.stages.length ? state.stages[0].key : null;
            }
            paintRouting();
        });

        tb.appendChild(h('tr', null,
            h('td', null,
                h('div', { class: r.seen_count ? null : 'tel-route-unseen' },
                    ru,
                    // «Новое» — исход, которого нет ни в одном правиле: Binotel
                    // придумал его после установки. Такой звонок сейчас не
                    // создаёт НИЧЕГО, и владелец должен узнать об этом здесь,
                    // а не через три недели по отсутствию карточек.
                    r.documented ? null : [' ', Tag('новое', { kind: 'warn' })]),
                // Сырой код остаётся на виду: им говорят поддержка Binotel и
                // журнал звонков, а исход, которого экран не знает, только им
                // и опознаётся.
                h('div', { class: 'cell-mono muted tel-route-code' },
                    ...(nameIsCode ? [] : [r.disposition, ' · ']),
                    // Число и слово — РАЗНЫЕ текстовые дети: tr() ищет перевод
                    // по всей строке-источнику, и склеенное «15 звонков» не
                    // нашлось бы в словаре никогда, а «звонков» находится.
                    ...(r.seen_count
                        ? [String(r.seen_count), ' ', pluralRu(r.seen_count, 'звонок', 'звонка', 'звонков')]
                        : [h('span', { class: 'tel-route-unseen' }, 'ещё не встречалось')]))),
            h('td', null, actionSel),
            h('td', null, stageSel),
        ));
    }

    box.appendChild(h('table', { class: 'tbl tel-route-tbl', style: { width: '100%' } },
        h('thead', null, h('tr', null,
            h('th', null, 'Исход звонка'),
            h('th', null, 'Что делать'),
            h('th', null, 'В какую колонку'))),
        tb));

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button',
        onclick: () => run(saveBtn, async () => {
            const routing = state.routing.map((r) => ({
                // Какая АТС — из настроек этого же экрана: строка правила
                // ключуется по (provider, disposition), и второй вендор
                // когда-нибудь — это данные, а не миграция.
                provider: (state.s && state.s.provider) || 'binotel',
                disposition: r.disposition,
                action: r.action,
                // «Не создавать» колонку не хранит: правилу, которое ничего не
                // создаёт, некуда её класть, а сохранённый ключ воскресил бы
                // имя удалённой колонки при следующем чтении.
                stage_key: r.action === 'create' ? r.stage_key : null,
            }));
            const v = validateRouting(routing, state.stages, tr);
            if (!v.ok) { toast(v.error, 'warn'); return; }
            await rpc('crm_config_save', { routing });
            toast('Маршрут сохранён.', 'success');
            // Перечитываем, а не догадываемся: значок «новое» и признак
            // «вендорский» считает сервер, и у исхода, которому правило
            // только что задали, значка больше быть не должно.
            await loadRouting();
        }) }, Icon('Check', { size: 13 }), ' ', tr('Сохранить маршрут'));
    box.appendChild(h('div', { class: 'row', style: { gap: '8px', padding: '14px 18px 0' } }, saveBtn));
    box.appendChild(routingFootnote());
}

// Честное ограничение прямо на экране, а не в документации: эти правила не
// делают ничего, пока модуль «Колл-центр» не подключён и опрос звонков не
// включён — иначе звонки в систему не попадают и заявки создавать не из чего.
function routingFootnote() {
    return h('div', { class: 'muted tel-route-note', style: { padding: '12px 18px 18px' } },
        'Правила работают, только пока подключён модуль «Колл-центр» и включён опрос звонков выше — иначе звонки в систему не попадают и заявки создавать не из чего.');
}

// ---------------------------------------------------------------------------
// 5. Последние звонки — доказательство жизни интеграции
// ---------------------------------------------------------------------------
function callsCard() {
    refs.callsBody = h('div');
    paintCalls();
    return h('div', { class: 'card' },
        h('div', { class: 'card-header' }, h('h3', null, Icon('Headset', { size: 16 }), ' ', tr('Последние звонки'))),
        refs.callsBody);
}

async function loadCalls() {
    try {
        state.calls = shapeCalls(await rpc('telephony_recent_calls', {}));
        state.callsError = null;
    } catch (e) {
        state.calls = null;
        state.callsError = e;
    }
    if (refs.callsBody) paintCalls();
}

function paintCalls() {
    const box = refs.callsBody;
    if (!box) return;
    clear(box);

    if (state.callsError) {
        box.appendChild(h('div', { class: 'muted', style: { padding: '24px' } },
            isNotImplemented(state.callsError)
                ? 'Список звонков недоступен: сервер ещё не обновлён.'
                : trf('Не удалось загрузить звонки: {msg}', { msg: state.callsError.message })));
        return;
    }
    if (state.calls === null) {
        box.appendChild(h('div', { class: 'muted', style: { padding: '24px' } }, 'Загрузка…'));
        return;
    }
    if (!state.calls.length) {
        box.appendChild(h('div', { class: 'empty', style: { padding: '34px 20px' } },
            h('p', null, 'Звонков пока нет.'),
            h('p', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } },
                'Включите опрос — новые звонки появятся здесь сами.')));
        return;
    }

    const tb = h('tbody');
    for (const c of state.calls) {
        tb.appendChild(h('tr', null,
            h('td', { class: 'muted', style: { fontSize: '12.5px', whiteSpace: 'nowrap' } }, c.time),
            // Стрелку направления несёт сама иконка (PhoneIn/PhoneOut);
            // слово рядом — для читалки и для того, кто не выучил стрелки.
            h('td', { style: { whiteSpace: 'nowrap' } },
                h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
                    Icon(c.direction.icon, { size: 14 }), c.direction.label)),
            h('td', { class: 'cell-mono', style: { fontSize: '12.5px' } }, c.external),
            h('td', null, c.patient_id
                ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button',
                    onclick: () => openPatient(c) },
                    c.patient_name || 'Карта пациента')
                : DASH),
            h('td', { class: 'cell-mono', style: { fontSize: '12.5px' } }, c.duration),
            h('td', null, c.disposition),
        ));
    }
    box.appendChild(h('table', { class: 'tbl', style: { width: '100%' } },
        h('thead', null, h('tr', null,
            h('th', null, 'Время'),
            // НЕ голое «Направление»: этот исходный ключ уже занят в словаре
            // медицинским «Referral», и tr() перевёл бы шапку не тем словом.
            h('th', null, 'Направление звонка'),
            h('th', null, 'Номер'),
            h('th', null, 'Пациент'),
            h('th', null, 'Длительность'),
            h('th', null, 'Итог'))),
        tb));
}

// Карта открывается так же, как из CRM (crm.js): добираем пациента из базы и
// отдаём navigate('patient-card', {...}) — журнал звонков хранит только id.
async function openPatient(c) {
    try {
        const { data, error } = await supabase.from('patients')
            .select('id, full_name, mrn, phone').eq('id', c.patient_id).single();
        if (error || !data) { toast('Не удалось открыть карту.', 'fail'); return; }
        if (refs.onNavigate) refs.onNavigate('patient-card', { id: data.id, full_name: data.full_name, mrn: data.mrn, phone: data.phone });
    } catch (_) {
        toast('Не удалось открыть карту.', 'fail');
    }
}

// Одна кнопка за раз: два параллельных сохранения настроек — это гонка,
// в которой побеждает случайное (дословно правило telegram-settings.js).
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
