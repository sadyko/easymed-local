// TELEPHONY_V1 — Настройки → «Телефония» (docs/plans/2026-08-23-binotel-telephony.md, Task 2).
//
// Стандартная интеграция колл-центра: администратор вводит ключи Binotel,
// проверяет связь, включает опрос звонков и — если у клиники есть публичный
// адрес — WebHook-и. Внизу журнал последних звонков как доказательство, что
// интеграция живёт. Экран продаётся модулем «callcenter»: маршрутизатор в
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
import { h, Icon, PageHead, clear, toast, field, checkField } from '../ui.js';
// h() прогоняет текстовые дети через tr() сам; но всё, что меняет текст ПОСЛЕ
// отрисовки через .textContent, обходит h() — те места зовут tr() явно
// (тот же приём, что в locked-module.js).
import { tr } from '../i18n.js';
import {
    DASH, secretPlaceholder, normalizeInterval, webhookUrl, shapeCalls,
    statusTime, textOrDash, isNotImplemented,
} from '../telephony-logic.js';

const state = { s: null, calls: null, callsError: null, busy: false };
let refs = { root: null, body: null, callsBody: null, onNavigate: null };

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
    refs = { root: null, body: null, callsBody: null, onNavigate: onNavigate || null };
    refs.root = h('div', { class: 'fade-in' });
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
                'Не удалось загрузить настройки: ' + e.message));
        }
        return;
    }
    state.calls = null;
    state.callsError = null;
    paint();
    // Журнал грузится ПОСЛЕ отрисовки настроек и перекрашивает только свою
    // карточку: полный paint() здесь стёр бы ключ, который администратор уже
    // начал вводить, пока список ехал.
    loadCalls();
}

function paint() {
    clear(refs.body);
    refs.body.appendChild(connectionCard());
    refs.body.appendChild(pollingCard());
    refs.body.appendChild(webhooksCard());
    refs.body.appendChild(callsCard());
}

// ---------------------------------------------------------------------------
// 1. Подключение — ключи и проверка связи
// ---------------------------------------------------------------------------
function connectionCard() {
    const s = state.s;
    const card = h('div', { style: { padding: '18px' } });

    card.appendChild(field('Провайдер', h('div', { style: { fontWeight: '600' } }, 'Binotel')));
    card.appendChild(h('div', { class: 'muted', style: { fontSize: '12px', margin: '-6px 0 14px' } },
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
    card.appendChild(h('div', { class: 'muted', style: { fontSize: '12px', margin: '-6px 0 14px' } },
        'Номер компании в Binotel — указан в письме с данными интеграции'));

    // role="status" — живая область: результат проверки объявляется читалке,
    // где бы ни был фокус (тот же приём, что на экране «Модуль не подключён»).
    const resultLine = h('div', { role: 'status', style: { marginTop: '10px', fontSize: '13px', minHeight: '18px' } });
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
        } }, Icon('Check', { size: 13 }), ' Сохранить подключение');

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
        } }, Icon('Refresh', { size: 13 }), ' Проверить подключение');

    card.appendChild(h('div', { class: 'row', style: { gap: '8px', marginTop: '12px' } }, saveBtn, testBtn));
    card.appendChild(resultLine);

    return h('div', { class: 'card', style: { marginBottom: '16px' } },
        h('div', { class: 'card-header' }, h('h3', null, Icon('Phone', { size: 16 }), ' Подключение')),
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
    card.appendChild(h('div', { class: 'muted', style: { fontSize: '12px', margin: '-6px 0 12px 26px' } },
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

    const statusRow = (label, value) => h('div', { class: 'muted', style: { fontSize: '13px', marginTop: '4px' } },
        label, ': ', h('span', { style: { color: 'var(--ink-700, inherit)' } }, value));
    card.appendChild(h('div', { style: { marginTop: '10px' } },
        statusRow('Последняя проверка', statusTime(s.last_poll_at)),
        statusRow('Последний звонок', statusTime(s.last_call_at)),
        statusRow('Последняя ошибка', textOrDash(s.last_error))));

    card.appendChild(h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '12px' } },
        'Звонки появляются в журнале с задержкой до одного интервала опроса. Карточка звонка прямо в момент вызова — только через WebHook-и.'));

    return h('div', { class: 'card', style: { marginBottom: '16px' } },
        h('div', { class: 'card-header' }, h('h3', null, Icon('Refresh', { size: 16 }), ' Опрос звонков')),
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
    card.appendChild(h('div', { class: 'muted', style: { fontSize: '12px', margin: '-6px 0 12px 26px' } },
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
    card.appendChild(h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '12px', lineHeight: '1.6' } },
        h('div', null, 'WebHook-и работают, только когда клиника доступна из интернета по этому адресу. Большинство локальных установок работают без них — звонки собирает опрос.'),
        h('div', null, 'Binotel присылает события только со своих серверных адресов — приём ограничен этим списком IP, чужие запросы отбрасываются.')));

    return h('div', { class: 'card', style: { marginBottom: '16px' } },
        h('div', { class: 'card-header' }, h('h3', null, Icon('Globe', { size: 16 }), ' WebHook-и')),
        card);
}

// ---------------------------------------------------------------------------
// 4. Последние звонки — доказательство жизни интеграции
// ---------------------------------------------------------------------------
function callsCard() {
    refs.callsBody = h('div');
    paintCalls();
    return h('div', { class: 'card' },
        h('div', { class: 'card-header' }, h('h3', null, Icon('Headset', { size: 16 }), ' Последние звонки')),
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
                : 'Не удалось загрузить звонки: ' + state.callsError.message));
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
