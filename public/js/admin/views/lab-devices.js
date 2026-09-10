// LIS_INGEST_V1 — Лаборатория → «Анализаторы».
//
// Два вопроса, на которые обязан отвечать этот экран:
//   1. какие приборы у клиники и как они подключены;
//   2. РАБОТАЮТ ли они прямо сейчас.
//
// Второй важнее первого. Приём результатов отказывает молча — кабель выдернули,
// прибор переставили, порт занял кто-то другой, — и без колонки «Связь» такой
// отказ длится неделю, пока врач не спросит, где анализ. Поэтому молчание
// прибора показано предупреждающим тоном, а не пустой клеткой.
//
// Лоток ниже — обратная сторона инварианта «ничего не теряется»: сообщение, не
// нашедшее заказ, лежит здесь целиком, и привязать его стоит одного клика.
import { h, Icon, Tag, toast, clear, field, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { supabase } from '../../supabase.js';

// Ключи словаря, а не собранные строки: tr() ищет строку целиком.
const TRANSPORTS = [
    { key: 'mllp',   label: 'Сеть (HL7/MLLP)',    ready: true },
    { key: 'serial', label: 'Кабель COM (RS-232)', ready: false },
    { key: 'folder', label: 'Папка с файлами',     ready: false },
];
const TRANSPORT_LABEL = Object.fromEntries(TRANSPORTS.map((t) => [t.key, t.label]));

const STATUS_RU = {
    unmatched:  'Не найден заказ',
    unmapped:   'Не сопоставлено',
    rejected:   'Не разобрано',
    superseded: 'Результат уже выдан',
    applied:    'Применено',
};

/** «На связи» / «молчит» по последнему принятому сообщению. */
function liveness(lastSeen) {
    if (!lastSeen) return { kind: '', text: tr('сообщений не было') };
    const ageMin = (Date.now() - new Date(lastSeen).getTime()) / 60000;
    if (!Number.isFinite(ageMin)) return { kind: '', text: tr('сообщений не было') };
    if (ageMin < 60) return { kind: 'success', text: tr('получает результаты') };
    return { kind: 'warn', text: trf('молчит с {when}', { when: fmtDateTime(lastSeen) }) };
}

// Живая лента опрашивает сервер, пока экран открыт. Таймер модульный и гасится
// при следующем монтировании: иначе уход на другую вкладку оставлял бы за собой
// работающий опрос, и через десяток переходов их было бы десять.
let liveTimer = null;
const LIVE_MS = 5000;

export function stopLabDevicesLive() {
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
}

export async function mountLabDevices(container) {
    stopLabDevicesLive();
    clear(container);

    const state = { devices: [], profiles: [], messages: [], recent: [], loadError: null };

    const devicesCard = h('div', { class: 'card', style: { marginBottom: '16px' } });
    const formCard = h('div', { class: 'card', style: { marginBottom: '16px', display: 'none' } });
    const liveCard = h('div', { class: 'card', style: { marginBottom: '16px' } });
    const trayCard = h('div', { class: 'card' });
    // appendChild, а не append: так во всём остальном коде, и тестовый DOM
    // (lab-panels-mode.test.mjs) реализует именно его.
    container.appendChild(devicesCard);
    container.appendChild(formCard);
    container.appendChild(liveCard);
    container.appendChild(trayCard);

    // ---------- загрузка ----------

    async function reload() {
        state.loadError = null;
        // Ошибки ЗАХВАТЫВАЮТСЯ, а не отбрасываются: экран без приборов и экран,
        // который не смог их прочитать, выглядели бы одинаково — а это разные
        // беды, и лечатся они по-разному.
        const [devRes, msgRes, profRes, recentRes] = await Promise.all([
            supabase.from('lab_devices').select('*').order('name'),
            supabase.from('lab_device_messages').select('*').is('resolved_at', null).order('received_at', { ascending: false }).limit(100),
            supabase.rpc('lis_profiles', {}),
            supabase.rpc('lis_recent', { limit: 30 }),
        ]);
        if (devRes.error) state.loadError = devRes.error.message || String(devRes.error);
        state.devices = devRes.data || [];
        state.messages = (msgRes.data || []).filter((m) => m.status !== 'applied');
        state.profiles = profRes.data || [];
        state.recent = recentRes.data || [];
        paintDevices();
        paintLive();
        paintTray();
    }

    const profileOf = (key) => state.profiles.find((p) => p.key === key) || null;

    // ---------- список приборов ----------

    function paintDevices() {
        clear(devicesCard);
        devicesCard.appendChild(h('div', { class: 'card-header' },
            h('h3', null, tr('Анализаторы')),
            h('span', { class: 'grow' }),
            h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => openForm(null) },
                Icon('Plus', { size: 13 }), ' ', tr('Добавить прибор'))));

        if (state.loadError) {
            devicesCard.appendChild(h('div', { class: 'empty', style: { padding: '26px' } },
                trf('Не удалось прочитать список приборов: {msg}', { msg: state.loadError })));
            return;
        }
        if (!state.devices.length) {
            devicesCard.appendChild(h('div', { class: 'empty', style: { padding: '34px 20px' } },
                h('p', null, tr('Приборов пока нет.')),
                h('p', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } },
                    tr('Заводить прибор заранее не нужно: запустите пробу на анализаторе, и он появится здесь сам. Дальше — выберите его у панели в «Панелях» и подтвердите поля показателей.'))));
            return;
        }

        const tb = h('tbody');
        for (const d of state.devices) {
            const p = profileOf(d.profile);
            const live = liveness(d.last_seen_at);
            tb.appendChild(h('tr', null,
                h('td', { style: { fontWeight: 600 } }, d.name),
                h('td', { class: 'muted' },
                    p ? p.vendor + ' ' + p.model
                      : (d.profile ? trf('{key} — профиль не найден', { key: d.profile }) : tr('модель не выбрана')),
                    // Найденный прибор: модель ПОДОБРАНА по тому, как он себя
                    // назвал. Это догадка, и лаборант обязан её увидеть прежде,
                    // чем привяжет прибор к панели.
                    d.discovered
                        ? h('div', null, Tag(tr('найден сам — проверьте модель'), { kind: 'warn' }))
                        : null),
                h('td', { class: 'cell-mono', style: { fontSize: '12.5px' } },
                    d.transport === 'mllp'
                        ? trf('{host}:{port}', { host: d.host || tr('любой адрес'), port: d.port || 2575 })
                        : tr(TRANSPORT_LABEL[d.transport] || d.transport)),
                h('td', null, d.enabled ? Tag(tr('включён'), { kind: 'success' }) : Tag(tr('выключен'))),
                h('td', null, live.kind
                    ? Tag(live.text, { kind: live.kind })
                    : h('span', { class: 'muted', style: { fontSize: '12.5px' } }, live.text)),
                h('td', { style: { textAlign: 'right' } },
                    h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => openForm(d) }, tr('Изменить')))));
        }
        devicesCard.appendChild(h('table', { class: 'table' },
            h('thead', null, h('tr', null,
                h('th', null, tr('Название')), h('th', null, tr('Модель')), h('th', null, tr('Подключение')),
                h('th', null, tr('Состояние')), h('th', null, tr('Связь')), h('th', null, ''))),
            tb));

        devicesCard.appendChild(h('p', { class: 'muted', style: { fontSize: '12.5px', marginTop: '10px' } },
            tr('Колонка «Связь» — единственный способ заметить, что прибор перестал присылать результаты.')));
    }

    // ---------- живая лента ----------
    //
    // Отвечает не на «настроен ли прибор», а на вопрос, который лаборант задаёт
    // на самом деле: «мою пробу приняли, и чья она?». Поэтому строка идёт
    // связкой «время → номер пробы → ПАЦИЕНТ → значения»: номер пробы сам по
    // себе человеку не говорит ничего.

    function paintLive() {
        clear(liveCard);
        liveCard.appendChild(h('div', { class: 'card-header' },
            h('h3', null, tr('Что приходит с приборов')),
            h('span', { class: 'grow' }),
            h('span', { class: 'muted', style: { fontSize: '12.5px' } }, tr('обновляется само'))));

        if (!state.recent.length) {
            liveCard.appendChild(h('div', { class: 'empty', style: { padding: '30px 20px' } },
                h('p', null, tr('Приборы пока ничего не присылали.')),
                h('p', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } },
                    tr('Запустите пробу на анализаторе — он появится здесь сам, заводить его заранее не нужно.'))));
            return;
        }

        const tb = h('tbody');
        for (const r of state.recent) {
            const vals = r.values || [];
            const valueCell = vals.length
                ? h('span', { style: { display: 'inline-flex', gap: '6px', flexWrap: 'wrap' } },
                    ...vals.slice(0, 8).map((v) => Tag(
                        trf('{param} {value}', { param: v.parameter, value: v.value + (v.unit ? ' ' + v.unit : '') }),
                        { kind: v.flag === 'critical' ? 'danger' : (v.flag === 'high' || v.flag === 'low' ? 'warn' : '') })),
                    vals.length > 8 ? h('span', { class: 'muted', style: { fontSize: '12.5px' } },
                        trf('и ещё {n}', { n: vals.length - 8 })) : null)
                : h('span', { class: 'muted', style: { fontSize: '12.5px' } }, tr('в бланк ничего не легло'));

            tb.appendChild(h('tr', null,
                h('td', { class: 'muted', style: { fontSize: '12.5px', whiteSpace: 'nowrap' } }, fmtDateTime(r.received_at)),
                h('td', { class: 'muted', style: { fontSize: '12.5px' } }, r.device_name || '—'),
                h('td', { class: 'cell-mono' }, r.sample_id || '—'),
                // Имя пациента — обязательное поле этой строки, а не украшение.
                h('td', null,
                    r.patient_name
                        ? h('span', { style: { fontWeight: 600 } }, r.patient_name)
                        : h('span', { class: 'muted', style: { fontSize: '12.5px' } }, tr('пациент не определён')),
                    r.service_name
                        ? h('div', { class: 'muted', style: { fontSize: '12.5px' } }, r.service_name)
                        : null),
                h('td', null, valueCell),
                h('td', null, Tag(tr(STATUS_RU[r.status] || r.status), {
                    kind: r.status === 'applied' ? 'success' : (r.status === 'superseded' ? 'warn' : ''),
                }))));
        }
        liveCard.appendChild(h('table', { class: 'table' },
            h('thead', null, h('tr', null,
                h('th', null, tr('Получено')), h('th', null, tr('Прибор')), h('th', null, tr('Номер пробы')),
                h('th', null, tr('Пациент')), h('th', null, tr('Значения')), h('th', null, tr('Что случилось')))),
            tb));
    }

    // ---------- форма прибора ----------

    function openForm(device) {
        formCard.style.display = '';
        clear(formCard);

        const d = device || { name: '', profile: (state.profiles[0] || {}).key || '', transport: 'mllp', host: '', port: 2575, enabled: 1 };

        const nameInp = h('input', { type: 'text', value: d.name, placeholder: tr('Например: Гематология') });
        const profSel = h('select', null, ...state.profiles.map((p) =>
            h('option', { value: p.key, selected: p.key === d.profile ? '' : null }, p.vendor + ' ' + p.model)));
        const transSel = h('select', null, ...TRANSPORTS.map((t) =>
            h('option', { value: t.key, selected: t.key === d.transport ? '' : null }, tr(t.label))));
        const hostInp = h('input', { type: 'text', value: d.host || '', placeholder: tr('пусто — принимать с любого адреса') });
        const portInp = h('input', { type: 'number', value: d.port || 2575, min: '1', max: '65535', style: { width: '110px' } });
        const enabledInp = h('input', { type: 'checkbox', checked: d.enabled ? '' : null });

        const notReady = h('p', { class: 'muted', style: { fontSize: '12.5px' } },
            tr('Этот транспорт пока не поддерживается — настройка сохранится, но приём по нему не заработает.'));
        const netRow = h('div', { class: 'row', style: { gap: '14px', flexWrap: 'wrap' } },
            field(tr('Адрес прибора'), hostInp), field(tr('Порт'), portInp));

        function syncTransport() {
            const t = TRANSPORTS.find((x) => x.key === transSel.value);
            netRow.style.display = transSel.value === 'mllp' ? '' : 'none';
            notReady.style.display = t && t.ready ? 'none' : '';
        }
        transSel.onchange = () => {
            const p = profileOf(profSel.value);
            if (transSel.value === 'mllp' && p && !device) portInp.value = p.defaultPort;
            syncTransport();
        };
        profSel.onchange = () => { if (!device) portInp.value = (profileOf(profSel.value) || {}).defaultPort || 2575; };

        formCard.appendChild(h('div', { class: 'card-header' },
            h('h3', null, device ? trf('Анализатор: {name}', { name: d.name }) : tr('Новый анализатор'))));
        formCard.appendChild(h('div', { class: 'row', style: { gap: '14px', flexWrap: 'wrap', marginBottom: '10px' } },
            field(tr('Название'), nameInp), field(tr('Модель'), profSel), field(tr('Подключение'), transSel)));
        formCard.appendChild(netRow);
        formCard.appendChild(notReady);
        formCard.appendChild(h('label', { style: { display: 'flex', gap: '7px', alignItems: 'center', margin: '12px 0' } },
            enabledInp, h('span', null, tr('Включён — слушать этот прибор'))));

        formCard.appendChild(h('div', { class: 'row', style: { gap: '8px', marginTop: '6px' } },
            h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: save }, tr('Сохранить')),
            h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: closeForm }, tr('Отмена')),
            h('span', { class: 'grow' }),
            device ? h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => remove(device) }, tr('Удалить')) : null));

        syncTransport();
        nameInp.focus();

        async function save() {
            const payload = {
                name: nameInp.value.trim(),
                profile: profSel.value,
                transport: transSel.value,
                host: hostInp.value.trim(),
                port: Number(portInp.value) || 2575,
                enabled: enabledInp.checked ? 1 : 0,
            };
            if (!payload.name) { toast(tr('Укажите название прибора'), 'warn'); return; }

            const res = device
                ? await supabase.from('lab_devices').update(payload).eq('id', device.id)
                : await supabase.from('lab_devices').insert(payload);
            if (res.error) { toast(trf('Не удалось сохранить прибор: {msg}', { msg: res.error.message || res.error }), 'fail'); return; }

            // Перезапуск слушателей: без него смена порта требовала бы
            // перезапуска всей клиники ради одного прибора.
            const { error } = await supabase.rpc('lis_restart', {});
            if (error) toast(trf('Прибор сохранён, но слушатель не перезапустился: {msg}', { msg: error.message || error }), 'fail');
            else toast(tr('Прибор сохранён'));
            closeForm();
            await reload();
        }

        async function remove(dev) {
            if (!window.confirm(trf('Удалить «{name}»? Панели, привязанные к нему, перестанут принимать результаты.', { name: dev.name }))) return;
            const { error } = await supabase.from('lab_devices').delete().eq('id', dev.id);
            if (error) { toast(trf('Не удалось удалить прибор: {msg}', { msg: error.message || error }), 'fail'); return; }
            await supabase.rpc('lis_restart', {});
            toast(tr('Прибор удалён'));
            closeForm();
            await reload();
        }
    }

    function closeForm() {
        formCard.style.display = 'none';
        clear(formCard);
    }

    // ---------- лоток ----------

    function paintTray() {
        clear(trayCard);
        trayCard.appendChild(h('div', { class: 'card-header' },
            h('h3', null, tr('Необработанные')),
            h('span', { class: 'grow' }),
            h('span', { class: 'muted', style: { fontSize: '12.5px' } },
                state.messages.length ? trf('ждут разбора: {n}', { n: state.messages.length }) : tr('пусто'))));

        if (!state.messages.length) {
            trayCard.appendChild(h('div', { class: 'empty', style: { padding: '30px 20px' } },
                h('p', null, tr('Все пришедшие результаты разложены по бланкам.')),
                h('p', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } },
                    tr('Сюда попадает то, что не удалось применить: неизвестный номер пробы, неподтверждённое поле, результат по уже выданному анализу. Ничего не теряется.'))));
            return;
        }

        const tb = h('tbody');
        for (const m of state.messages) {
            const raw = h('pre', {
                style: {
                    display: 'none', margin: '8px 0 0', padding: '10px', background: 'var(--ink-050, #f4f6f8)',
                    borderRadius: '6px', fontSize: '12.5px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                },
            }, (m.raw || '').split('\r').join('\n'));

            tb.appendChild(h('tr', null,
                h('td', { class: 'muted', style: { fontSize: '12.5px', whiteSpace: 'nowrap' } }, fmtDateTime(m.received_at)),
                h('td', { class: 'cell-mono' }, m.sample_id || '—'),
                h('td', null, Tag(tr(STATUS_RU[m.status] || m.status), { kind: m.status === 'superseded' ? 'warn' : '' })),
                h('td', { class: 'muted', style: { fontSize: '12.5px' } },
                    m.detail || '—',
                    h('button', {
                        class: 'btn btn-outline btn-sm', type: 'button', style: { marginLeft: '8px' },
                        onclick: () => { raw.style.display = raw.style.display === 'none' ? '' : 'none'; },
                    }, tr('Сырое')),
                    raw),
                h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
                    h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => attach(m) }, tr('Привязать')),
                    ' ',
                    h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => dismiss(m) }, tr('Отклонить')))));
        }
        trayCard.appendChild(h('table', { class: 'table' },
            h('thead', null, h('tr', null,
                h('th', null, tr('Получено')), h('th', null, tr('Номер пробы')), h('th', null, tr('Что случилось')),
                h('th', null, tr('Подробности')), h('th', null, ''))),
            tb));
    }

    async function attach(m) {
        const answer = window.prompt(
            tr('Номер заказа — число, напечатанное на пробирке после LAB-'),
            String(m.sample_id || '').replace(/^lab[-_ ]?/i, '').replace(/^0+/, ''));
        if (answer == null) return;
        const vsId = Number(String(answer).trim());
        if (!vsId) { toast(tr('Нужен номер заказа'), 'warn'); return; }

        const { data, error } = await supabase.rpc('lis_message_attach', { id: m.id, visit_service_id: vsId });
        if (error) { toast(trf('Не удалось привязать сообщение: {msg}', { msg: error.message || error }), 'fail'); return; }
        // ok=false здесь — НЕ сбой связи: приём мог отказать по своим правилам
        // (заказ не лабораторный, поле не подтверждено). Человеку надо сказать,
        // что именно, а не «готово».
        if (data && data.ok) toast(tr('Сообщение применено'));
        else toast(tr('Приём не применил сообщение — смотрите лоток'), 'fail');
        await reload();
    }

    async function dismiss(m) {
        if (!window.confirm(tr('Отклонить это сообщение? Оно останется в базе, но перестанет требовать внимания.'))) return;
        const { error } = await supabase.rpc('lis_message_dismiss', { id: m.id });
        if (error) { toast(trf('Не удалось отклонить сообщение: {msg}', { msg: error.message || error }), 'fail'); return; }
        await reload();
    }

    await reload();

    // Живой опрос. Молча: сетевой сбой на фоне не должен сыпать тостами поверх
    // работы лаборанта — экран просто останется на прежних данных, а следующая
    // попытка через пять секунд его догонит. Останавливается, когда контейнер
    // ушёл из документа (лаборант переключил вкладку) — иначе опрос пережил бы
    // экран.
    liveTimer = setInterval(() => {
        if (container && container.isConnected === false) { stopLabDevicesLive(); return; }
        reload().catch(() => {});
    }, LIVE_MS);
    // Опрос НИКОГДА не держит процесс живым — то же правило, что у таймеров
    // телефонии. В браузере unref нет, поэтому вызов необязательный; под Node
    // (тесты экрана) без него `node --test` ждал бы вечно, что и случилось.
    if (liveTimer && typeof liveTimer.unref === 'function') liveTimer.unref();
}
