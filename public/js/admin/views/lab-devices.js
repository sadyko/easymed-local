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
import { liveness, groupSeries } from './lab-devices-live.js?v=live2';   // LIS_INGEST_V1 — правило связи, чистое и покрытое тестами · LIS_REAL_ANALYZERS_V1 — серия одной строкой ленты
import { splitDevices, portState, isTruncatedMessage } from './lab-devices-lists.js?v=lists4';   // LIS_ANALYZER_LIST_V1 — таблица / найдены / ждут · LIS_DISCOVERY_FIX_V1 — обрезанное в лотке
// LIS_REAL_ANALYZERS_V1 (экран) — «Идёт приём результатов» в лотке, звонок прибору (флажок,
// проверка адреса, строка состояния), служебные за сегодня, подпись модели.
import { splitTray, groupReceiving, staleSeriesRest, seriesPendingRest, isLocalIp, isIpAddress, dialLine, dialSig,
    serviceSummary, modelNote, connectionOf } from './lab-devices-lists.js?v=lists4';

// Ключи словаря, а не собранные строки: tr() ищет строку целиком.
const TRANSPORTS = [
    { key: 'mllp',   label: 'Сеть (HL7/MLLP)',    ready: true },
    { key: 'serial', label: 'Кабель COM (RS-232)', ready: false },
    { key: 'folder', label: 'Папка с файлами',     ready: false },
];
const TRANSPORT_LABEL = Object.fromEntries(TRANSPORTS.map((t) => [t.key, t.label]));
// LD_LAYOUT_V1 — сколько строк ленты и лотка видно до «Показать все».
const LIST_PREVIEW = 10;

const STATUS_RU = {
    unmatched:  'Не найден заказ',
    unmapped:   'Не сопоставлено',
    rejected:   'Не разобрано',
    superseded: 'Результат уже выдан',
    applied:    'Применено',
};

// Правило «что говорить о связи» вынесено в чистый модуль без DOM и словаря
// (lab-devices-live.js): проверять надо правило, а не разметку. Здесь остаётся
// только перевод его решения в текст экрана.
// LIS_REAL_ANALYZERS_V1 (ревью) — now: часы сервера (метку last_seen_at ставит он).
function livenessText(lastSeen, now = Date.now()) {
    const s = liveness(lastSeen, now);
    const params = s.params && s.params.when ? { ...s.params, when: fmtDateTime(s.params.when) } : s.params;
    return { kind: s.kind, text: Object.keys(params || {}).length ? trf(s.key, params) : tr(s.key) };
}

// LIS_REAL_ANALYZERS_V1 (экран) — время соединения часами («подключено с
// 10:02»), если это сегодня; иначе — дата и время, как в остальном экране.
function clockOf(iso) {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '—';
    if (d.toDateString() !== new Date().toDateString()) return fmtDateTime(iso);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// LIS_REAL_ANALYZERS_V1 (экран) — одна часть решения чистого правила
// (lab-devices-lists.js: dialLine, serviceSummary) — ключ словаря и
// подстановки — в текст экрана. Перевод СНАЧАЛА, подстановка ПОТОМ.
function partText(p) {
    const params = p.params || {};
    if (!Object.keys(params).length) return tr(p.key);
    return trf(p.key, params.time ? { ...params, time: clockOf(params.time) } : params);
}

// LIS_REAL_ANALYZERS_V1 (экран) — подписи, которые цитируют друг друга: флажок
// формы и подсказки, называющие его (тест сверяет кавычки и на uz/en).
const DIAL_LABEL = 'Easy-Med подключается к прибору сам';
const DIAL_ADD_HINT = 'Анализатор сам не звонит, а ждёт программу LIS? «Добавить по адресу» — и отметьте «Easy-Med подключается к прибору сам».';
const CONNECT_UNKNOWN_HINT = 'Если в настройках LIS прибора нет адреса сервера, а есть только «порт прибора», — отметьте «Easy-Med подключается к прибору сам».';

// Живая лента опрашивает сервер, пока экран открыт. Таймер модульный и гасится
// при следующем монтировании и при уходе с вкладки (laboratory.js): иначе
// переход в другой режим оставлял бы за собой работающий опрос, и через десяток
// переходов их было бы десять.
let liveTimer = null;
const LIVE_MS = 5000;

export function stopLabDevicesLive() {
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
}

export async function mountLabDevices(container) {
    stopLabDevicesLive();
    clear(container);

    // LIS_ANALYZER_LIST_V1 — listeners: какие порты слушаются (lis_listeners);
    // formMode: что открыто под таблицей ('add' | 'adopt' | 'edit' | null) —
    // живой опрос перерисовывает окно «Добавить прибор», но не форму, в которой печатают.
    // backToAdd (ревью M3): форма открыта из окна «Добавить прибор» и вернётся туда.
    // addSig (ревью M9): подпись того, что сейчас видно в окне «Добавить прибор».
    // sigs, rawOpen (LIS_DISCOVERY_FIX_V1): подписи таблицы, живой ленты и лотка;
    // сообщения лотка, у которых человек раскрыл «Сырое».
    const state = { devices: [], profiles: [], messages: [], recent: [], loadError: null, listeners: null, formMode: null, backToAdd: false, addSig: null,
        sigs: { devices: null, live: null, tray: null }, rawOpen: new Set(),
        showAll: { live: false, tray: false },   // LD_LAYOUT_V1 — «Показать все» у ленты и лотка
        // LIS_REAL_ANALYZERS_V1 (экран) — counts: служебные за сегодня
        // (lis_service_counts); dialNodes: строки состояния звонка, которые
        // опрос обновляет НА МЕСТЕ — «сигнал 2 с назад» меняется каждые 5 с,
        // и перестройка таблицы ради него снова уносила бы кнопку из-под курсора.
        counts: [], dialNodes: { table: [], add: [] },
        // LIS_REAL_ANALYZERS_V1 (ревью) — на сколько часы сервера впереди часов
        // этого компьютера (lis_listeners.now). Метки лотка, ленты и звонков
        // ставит сервер: часы лабораторного ПК могут отставать на часы, и серия,
        // просроченная по серверу, пряталась бы в «Идёт приём результатов».
        clockOffset: 0 };
    const serverNow = () => Date.now() + state.clockOffset;

    const devicesCard = h('div', { class: 'card' });
    const formCard = h('div', { class: 'card', style: { display: 'none' } });
    const liveCard = h('div', { class: 'card' });
    const trayCard = h('div', { class: 'card' });
    const guideCard = h('div', { class: 'card' });
    // LAB_COMPACT_V1 — владелец: «too much noise and text … fix the listings».
    // Карточки — сеткой с общим зазором: приборы во всю ширину, «последние
    // результаты» и «необработанные» рядом, инструкция — свёрнутой внизу.
    // appendChild, а не append: так во всём остальном коде, и тестовый DOM
    // (lab-panels-mode.test.mjs) реализует именно его.
    const grid = h('div', { class: 'ld' });
    grid.appendChild(devicesCard);
    grid.appendChild(formCard);
    const pair = h('div', { class: 'ld-grid' });
    pair.appendChild(liveCard);
    pair.appendChild(trayCard);
    grid.appendChild(pair);
    grid.appendChild(guideCard);
    container.appendChild(grid);
    paintGuide();

    // ---------- загрузка ----------

    async function reload() {
        state.loadError = null;
        // Ошибки ЗАХВАТЫВАЮТСЯ, а не отбрасываются: экран без приборов и экран,
        // который не смог их прочитать, выглядели бы одинаково — а это разные
        // беды, и лечатся они по-разному.
        const [devRes, msgRes, profRes, recentRes, lisRes, countsRes] = await Promise.all([
            supabase.from('lab_devices').select('*').order('name'),
            // LIS_MINDRAY_CODES_V1 (ревью R1) — принятые отсеиваются В ЗАПРОСЕ,
            // до limit. Их никто не разбирает (resolved_at остаётся пустым), а с
            // «тихим лотком» они — большинство: сотня заполнялась ими, настоящая
            // беда (смазанный штрихкод) выпадала из окна, и экран говорил «Все
            // результаты разложены по бланкам».
            supabase.from('lab_device_messages').select('*').is('resolved_at', null).neq('status', 'applied').order('received_at', { ascending: false }).limit(100),
            supabase.rpc('lis_profiles', {}),
            supabase.rpc('lis_recent', { limit: 30 }),
            supabase.rpc('lis_listeners', {}),
            supabase.rpc('lis_service_counts', {}),   // LIS_REAL_ANALYZERS_V1 — контроль, калибровка, запросы за сегодня
        ]);
        if (devRes.error) state.loadError = devRes.error.message || String(devRes.error);
        // LIS_REAL_ANALYZERS_V1 — счётчик не обязателен: не ответил — строки нет.
        state.counts = (countsRes && Array.isArray(countsRes.data)) ? countsRes.data : [];
        state.devices = devRes.data || [];
        // Фильтр на клиенте остаётся: лишний раз не повредит.
        state.messages = (msgRes.data || []).filter((m) => m.status !== 'applied');
        state.profiles = profRes.data || [];
        state.recent = recentRes.data || [];
        state.listeners = (lisRes && lisRes.data) || null;   // LIS_ANALYZER_LIST_V1
        // LIS_REAL_ANALYZERS_V1 (ревью) — часы сервера; не ответил — прежнее смещение.
        const srvNow = state.listeners && Date.parse(state.listeners.now);
        if (Number.isFinite(srvNow)) state.clockOffset = srvNow - Date.now();
        // LIS_DISCOVERY_FIX_V1 (экран) — и таблица, живая лента и лоток
        // перерисовываются, только когда изменилось то, что они показывают
        // (тот же приём, что у окна ниже). Раньше опрос каждые 5 с строил их
        // заново: раскрытое «Сырое» схлопывалось, а нажатие «Изменить» или
        // «Привязать» приходилось в кнопку, которой уже нет.
        if (devicesSig() !== state.sigs.devices) paintDevices();
        if (liveSig() !== state.sigs.live) paintLive();
        if (traySig() !== state.sigs.tray) paintTray();
        // LIS_ANALYZER_LIST_V1 — список живой. Ревью M9: но перерисовка — только
        // когда изменилось видимое: окно, перестроенное каждые 5 с, убирало
        // кнопку из-под курсора, и нажатие терялось.
        if (state.formMode === 'add' && addWindowSig() !== state.addSig) paintAddWindow();
        // LIS_REAL_ANALYZERS_V1 — секунды сигнала и повтора — на месте.
        refreshDialNodes();
    }

    const profileOf = (key) => state.profiles.find((p) => p.key === key) || null;

    // ---------- звонок прибору (LIS_REAL_ANALYZERS_V1) ----------
    //
    // Прибор, который ждёт звонка LIS (lab_devices.dial = 1: Mindray BC-3600,
    // возможно BC-780), Easy-Med набирает сам. Состояние соединения — живое, из
    // lis_listeners.dialing, а не из базы: «подключено с 10:02 · сигнал 2 с
    // назад», «нет ответа · повтор через 30 с». Слова — у чистого правила
    // (dialLine), здесь — перевод.

    const countsOf = (d) => state.counts.find((c) => Number(c.device_id) === Number(d.id)) || null;

    /** Запись lis_listeners.dialing этого прибора; null — нет (или сервер о звонках не знает). */
    function dialEntry(d) {
        const list = state.listeners && Array.isArray(state.listeners.dialing) ? state.listeners.dialing : null;
        return list ? (list.find((x) => Number(x.device_id) === Number(d.id)) || null) : null;
    }

    /** Строка состояния звонка: { kind, text } или null — прибор не звонимый, выключен или ответа сервера нет. */
    function dialView(d) {
        if (Number(d.dial) !== 1 || d.transport !== 'mllp' || !d.enabled) return null;
        if (!state.listeners || !Array.isArray(state.listeners.dialing)) return null;
        const line = dialLine(dialEntry(d), serverNow()) || { kind: 'warn', parts: [{ key: 'Easy-Med сейчас не подключается к прибору', params: {} }] };
        return { kind: line.kind, text: line.parts.map(partText).join(' · ') };
    }

    function paintDialNode(el, d) {
        const v = dialView(d);
        const cls = 'tag' + (v && v.kind ? ' tag-' + v.kind : '');
        if (el.className !== cls) el.className = cls;
        const text = v ? v.text : '';
        if (el.textContent !== text) el.textContent = text;
        el.style.display = v ? '' : 'none';
    }

    /** Узел строки состояния; bucket — 'table' или 'add' (окно «Добавить прибор»). */
    function dialNode(d, bucket) {
        const el = h('span', { class: 'tag' });
        state.dialNodes[bucket].push({ id: d.id, el });
        paintDialNode(el, d);
        return el;
    }

    function refreshDialNodes() {
        for (const bucket of ['table', 'add']) {
            for (const n of state.dialNodes[bucket]) {
                const d = state.devices.find((x) => x.id === n.id);
                if (d) paintDialNode(n.el, d);
            }
        }
    }

    /**
     * Подпись ответа lis_listeners для решения «перерисовать»: порты и
     * состояния звонков без секунд (dialSig) — секунды обновляет refreshDialNodes.
     */
    function listenersSig() {
        const l = state.listeners;
        if (!l) return null;
        return JSON.stringify([l.listening || [], (l.failed || []).map((f) => [f.port, f.code]),
            Array.isArray(l.dialing) ? l.dialing.map((x) => [x.device_id, dialSig(x)]) : null]);
    }

    // ---------- список приборов ----------

    // LIS_DISCOVERY_FIX_V1 (экран) — всё, что видно в карточке «Анализаторы»:
    // ошибка чтения, число находок на кнопке, строки таблицы с текстом связи
    // (он меняется и сам, со временем) и модели. Сырой метки last_seen_at здесь
    // нет — она меняется с каждой пробой (как у окна «Добавить прибор»).
    function devicesSig() {
        const split = splitDevices(state.devices);
        return JSON.stringify([
            state.loadError,
            split.found.length,
            split.table.map((d) => [d.id, d.name, d.profile, d.discovered, d.model_confirmed, d.transport, d.host, d.port, d.enabled,
                livenessText(d.last_seen_at, serverNow()).text,
                // LIS_REAL_ANALYZERS_V1 — звонок (состояние без секунд) и служебные за сегодня
                d.dial, dialSig(dialEntry(d)), countsOf(d)]),
            state.profiles.map((p) => [p.key, p.vendor, p.model, p.channelsSource, p.wireSource]),
            !!(state.listeners && Array.isArray(state.listeners.dialing)),
        ]);
    }

    function paintDevices() {
        state.sigs.devices = devicesSig();   // LIS_DISCOVERY_FIX_V1
        state.dialNodes.table = [];   // LIS_REAL_ANALYZERS_V1 — строки состояния звонка рисуются заново
        clear(devicesCard);
        const split = splitDevices(state.devices);   // LIS_ANALYZER_LIST_V1
        devicesCard.appendChild(h('div', { class: 'card-header' },
            h('h3', null, tr('Анализаторы')),
            h('span', { class: 'grow' }),
            h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: openAddWindow },
                Icon('Plus', { size: 13 }), ' ',
                split.found.length ? trf('Добавить прибор · найдено {n}', { n: split.found.length }) : tr('Добавить прибор'))));

        if (state.loadError) {
            devicesCard.appendChild(h('div', { class: 'empty', style: { padding: '26px' } },
                trf('Не удалось прочитать список приборов: {msg}', { msg: state.loadError })));
            return;
        }
        // LIS_ANALYZER_LIST_V1 — в таблице только добавленные и выходившие на
        // связь (решение владельца 2026-09-28). Находки и молчащие — в окне
        // «Добавить прибор».
        if (!split.table.length) {
            devicesCard.appendChild(h('div', { class: 'empty', style: { padding: '26px 20px' } },
                h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, tr('Подключённых анализаторов нет.')),
                h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                    split.found.length
                        ? trf('Найдено новых: {n} — откройте «Добавить прибор».', { n: split.found.length })
                        : tr('Откройте «Добавить прибор»: там появится анализатор, как только пришлёт первую пробу.'))));
            return;
        }

        const tb = h('tbody');
        for (const d of split.table) {
            const p = profileOf(d.profile);
            const live = livenessText(d.last_seen_at, serverNow());
            // LIS_REAL_ANALYZERS_V1 — кто кому звонит, служебные за сегодня, подпись модели.
            const conn = connectionOf(d);
            const dials = conn && Number(d.dial) === 1;
            const sum = serviceSummary(countsOf(d));
            const note = modelNote(p);
            tb.appendChild(h('tr', null,
                h('td', { style: { fontWeight: 600 } }, d.name),
                h('td', { class: 'muted' },
                    p ? p.vendor + ' ' + p.model
                      : (d.profile ? trf('{key} — профиль не найден', { key: d.profile }) : tr('модель не выбрана')),
                    // Найденный прибор: модель ПОДОБРАНА по тому, как он себя
                    // назвал. Это догадка, и лаборант обязан её увидеть прежде,
                    // чем привяжет прибор к панели. LIS_ANALYZER_LIST_V1 — пока
                    // модель не проверил человек («Добавить» или «Изменить» с
                    // выбранной моделью ставят model_confirmed); discovered —
                    // правило приёма, его не трогаем.
                    d.discovered && !Number(d.model_confirmed)
                        ? h('div', null, Tag(tr('найден сам — проверьте модель'), { kind: 'warn' }))
                        : null,
                    // Откуда известны список показателей и формат модели. Лаборант
                    // обязан знать, что коды в выпадающем списке — ожидание, а не
                    // факт. LIS_REAL_ANALYZERS_V1 — словами по источнику: раньше
                    // всё, что не «документировано», называлось «типовым» — и
                    // BS-200, у которого типового списка нет вовсе.
                    note ? h('div', { class: 'muted', style: { fontSize: '12.5px' } }, tr(note)) : null),
                // LIS_REAL_ANALYZERS_V1 — «Подключение»: кто кому звонит; у
                // сетевого прибора, который звонит сам, — его адрес строкой ниже;
                // у прибора, которому звонит Easy-Med, — состояние соединения.
                h('td', { style: { fontSize: '12.5px' } },
                    conn ? h('div', null, trf(conn.key, conn.params)) : h('div', null, tr(TRANSPORT_LABEL[d.transport] || d.transport)),
                    conn && !dials ? h('div', { class: 'cell-mono muted', style: { fontSize: '12.5px' } }, d.host || tr('любой адрес')) : null,
                    dials ? h('div', { style: { marginTop: '4px' } }, dialNode(d, 'table')) : null),
                h('td', null, d.enabled ? Tag(tr('включён'), { kind: 'success' }) : Tag(tr('выключен'))),
                h('td', null, live.kind === 'idle'
                    ? h('span', { class: 'muted', style: { fontSize: '12.5px' } }, live.text)
                    : Tag(live.text, { kind: live.kind }),
                    // LIS_REAL_ANALYZERS_V1 — служебные сообщения за сегодня: в
                    // бланки и «Необработанные» они не идут, видно только их число.
                    sum ? h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } },
                        trf('сегодня: {list}', { list: sum.parts.map(partText).join(', ') })) : null,
                    sum && sum.queryHint ? h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                        tr('прибор спрашивает рабочий список — Easy-Med заказов не отдаёт, выключите запрос в настройках LIS прибора')) : null),
                // LIS_DISCOVERY_FIX_V1 — строка теперь переживает опросы, поэтому
                // форма открывается по СВЕЖЕЙ строке прибора, а не по той, с
                // которой её нарисовали.
                h('td', { style: { textAlign: 'right' } },
                    h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => openForm(state.devices.find((x) => x.id === d.id) || d) },
                        Icon('Edit', { size: 13 }), ' ', tr('Изменить')))));
        }
        devicesCard.appendChild(h('table', { class: 'list' },
            h('thead', null, h('tr', null,
                h('th', null, tr('Название')), h('th', null, tr('Модель')), h('th', null, tr('Подключение')),
                h('th', null, tr('Состояние')),
                // LAB_COMPACT_V1 — объяснение «что значит на связи» — подсказкой к
                // колонке, а не абзацем под списком.
                h('th', { title: tr('«На связи» — прислал результат за последние 5 минут: прибор соединяется только на время передачи.') }, tr('Связь')),
                h('th', null, ''))),
            tb));

    }

    // ---------- живая лента ----------
    //
    // Отвечает не на «настроен ли прибор», а на вопрос, который лаборант задаёт
    // на самом деле: «мою пробу приняли, и чья она?». Поэтому строка идёт
    // связкой «время → номер пробы → ПАЦИЕНТ → значения»: номер пробы сам по
    // себе человеку не говорит ничего.

    // LIS_DISCOVERY_FIX_V1 (экран) — лента показывает ответ lis_recent как есть.
    // LIS_REAL_ANALYZERS_V1 — и состояние строк серии: «идёт приём» через час
    // становится бедой само, без нового ответа сервера.
    const liveSig = () => JSON.stringify([state.recent, groupSeries(state.recent, serverNow()).map((g) => g.status)]);

    function paintLive() {
        state.sigs.live = liveSig();   // LIS_DISCOVERY_FIX_V1
        clear(liveCard);
        liveCard.appendChild(h('div', { class: 'card-header' },
            h('h3', null, tr('Последние результаты')),
            h('span', { class: 'grow' }),
            h('span', { class: 'muted', style: { fontSize: '12.5px' } }, tr('обновляется само'))));

        // LIS_REAL_ANALYZERS_V1 — сообщения одной серии (BS-200 шлёт по тесту)
        // — одной строкой: «LAB-000123 · Иванов · BS-200 · сообщений: 5 · Применено».
        const groups = groupSeries(state.recent, serverNow());
        if (!groups.length) {
            liveCard.appendChild(h('div', { class: 'empty', style: { padding: '26px 20px' } }, tr('Приборы пока ничего не присылали.')));
            return;
        }

        const tb = h('tbody');
        for (const r of previewRows(groups, 'live')) {   // LD_LAYOUT_V1
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
                h('td', { class: 'muted', style: { fontSize: '12.5px' } }, r.device_name || '—',
                    r.count > 1 ? h('div', null, trf('сообщений: {n}', { n: r.count })) : null),   // LIS_REAL_ANALYZERS_V1
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
                // LIS_REAL_ANALYZERS_V1 — серия ещё идёт: «идёт приём», а не «Не сопоставлено».
                h('td', null, r.status === 'receiving'
                    ? Tag(tr('идёт приём'))
                    : Tag(tr(STATUS_RU[r.status] || r.status), {
                        kind: r.status === 'applied' ? 'success' : (r.status === 'superseded' ? 'warn' : ''),
                    }))));
        }
        liveCard.appendChild(h('table', { class: 'list' },
            h('thead', null, h('tr', null,
                h('th', null, tr('Получено')), h('th', null, tr('Прибор')), h('th', null, tr('Номер пробы')),
                h('th', null, tr('Пациент')), h('th', null, tr('Значения')), h('th', null, tr('Состояние')))),
            tb));
        const more = moreToggle(groups.length, 'live', paintLive);
        if (more) liveCard.appendChild(more);
    }

    // LD_LAYOUT_V1 — лента и лоток показывали по сотне строк рядом, в
    // половину ширины: имена и названия разламывались на пять строк, а
    // страница уходила на шесть с половиной тысяч точек вниз. Теперь обе
    // карточки во всю ширину (admin-views.css .ld-grid), и в каждой сначала
    // последние десять строк (LIST_PREVIEW); остальные — по «Показать все», не теряются.
    function previewRows(rows, which) {
        return state.showAll[which] ? rows : rows.slice(0, LIST_PREVIEW);
    }
    function moreToggle(total, which, repaint) {
        if (total <= LIST_PREVIEW) return null;
        return h('div', { class: 'ld-more' },
            h('button', { class: 'btn btn-ghost btn-sm', type: 'button',
                onclick: () => { state.showAll[which] = !state.showAll[which]; repaint(); } },
                state.showAll[which] ? tr('Свернуть') : trf('Показать все · {n}', { n: total })));
    }

    // ---------- форма прибора ----------

    function openForm(device, { fromAdd = false } = {}) {
        state.formMode = 'edit';   // LIS_ANALYZER_LIST_V1
        state.backToAdd = fromAdd;   // ревью M3
        formCard.style.display = '';
        clear(formCard);
        state.dialNodes.add = [];   // LIS_REAL_ANALYZERS_V1 — окно «Добавить прибор» больше не на экране

        const d = device || { name: '', profile: (state.profiles[0] || {}).key || '', transport: 'mllp', host: '', port: 2575, enabled: 1, dial: 0 };
        const dialsNow = Number(d.dial) === 1;   // LIS_REAL_ANALYZERS_V1

        const nameInp = h('input', { type: 'text', value: d.name, placeholder: tr('Например: Гематология') });
        // LIS_ANALYZER_LIST_V1 (ревью I2) — первый пункт «модель не выбрана».
        // Без него у прибора без модели не было выбранного пункта, браузер
        // показывал первый (Mindray BC-20), и «Изменить → Сохранить» молча
        // ставил BC-20. Модель, которой нет среди профилей (профиль убрали или
        // lis_profiles не ответил), — своим пунктом: сохранение её не стирает.
        // Новый прибор по-прежнему начинает с первой модели (d выше).
        const profSel = h('select', null,
            h('option', { value: '', selected: !d.profile ? true : null }, tr('модель не выбрана')),
            d.profile && !profileOf(d.profile)
                ? h('option', { value: d.profile, selected: true }, trf('{key} — профиль не найден', { key: d.profile }))
                : null,
            ...state.profiles.map((p) =>
                h('option', { value: p.key, selected: p.key === d.profile ? true : null }, p.vendor + ' ' + p.model)));
        // LIS_DISCOVERY_FIX_V1 (экран) — решение владельца 2026-09-29: новый
        // прибор руками — только СЕТЕВОЙ. Анализатор на кабеле COM приходит
        // через переадресатор на лабораторном ПК и появляется в «Найдены в
        // сети» сам, а строка «Кабель COM» или «Папка», заведённая руками, не
        // принимала ничего и только путала приём. Поэтому у нового прибора
        // выбора «Подключение» нет вовсе. У заведённой строки — сеть и её
        // прежнее значение, если оно другое: иначе «Изменить → Сохранить»
        // молча превращало бы кабель в сеть, а человек этого не просил.
        const transKeys = ['mllp'];
        if (device && d.transport && d.transport !== 'mllp') transKeys.push(d.transport);
        const transSel = device
            ? h('select', { onchange: () => syncTransport() }, ...transKeys.map((k) =>
                h('option', { value: k, selected: k === (d.transport || 'mllp') ? true : null },
                    TRANSPORT_LABEL[k] ? tr(TRANSPORT_LABEL[k]) : k)))
            : null;
        const transport = () => (transSel ? transSel.value : 'mllp');
        const hostInp = h('input', { type: 'text', value: d.host || '', placeholder: tr('адрес анализатора в сети, например 10.0.0.20'),
            oninput: () => syncTransport() });
        // LIS_REAL_ANALYZERS_V1 — у прибора, которому звонит Easy-Med, порт —
        // ЕГО порт, и по умолчанию пусто: 2575 тут ни при чём.
        const portInp = h('input', { type: 'number', value: dialsNow ? (d.port || '') : (d.port || 2575), min: '1', max: '65535' });
        const enabledInp = h('input', { type: 'checkbox', checked: d.enabled ? true : null });
        // LIS_REAL_ANALYZERS_V1 (спецификация, раздел 8) — прибор, который сам не
        // звонит, а ждёт звонка программы LIS (Mindray BC-3600, возможно BC-780):
        // Easy-Med подключается к нему сам. Нужны IP-адрес локальной сети и порт
        // прибора; сервер другой адрес и так не наберёт (bad_address), но
        // /api/db строку сохранит — поэтому проверка здесь, до записи.
        const defaultPort = () => (profileOf(profSel.value) || {}).defaultPort || 2575;
        const dialInp = h('input', { type: 'checkbox', checked: dialsNow ? true : null, onchange: () => {
            if (dialInp.checked) {
                const p = String(portInp.value == null ? '' : portInp.value).trim();
                if (p === String(defaultPort()) || p === '2575') portInp.value = '';
            } else if (!String(portInp.value == null ? '' : portInp.value).trim()) {
                portInp.value = String(defaultPort());
            }
            syncTransport();
        } });
        const dialRow = h('label', { class: 'ld-form-check' }, dialInp,
            h('span', null, tr(DIAL_LABEL),
                h('span', { class: 'muted', style: { marginLeft: '6px' } }, tr('(прибор ждёт звонка, как Mindray BC-3600)'))));
        const dialNote = h('p', null,
            tr('Easy-Med сам подключится к этому адресу и порту и будет держать соединение. Адрес — только IP локальной сети, порт — из настроек LIS прибора.'));
        // У модели, про которую неизвестно, кто звонит (BC-780, connect: 'unknown').
        const connectHint = h('p', null, tr(CONNECT_UNKNOWN_HINT));
        const dialOn = () => transport() === 'mllp' && !!dialInp.checked;

        const notReady = h('p', null,
            tr('Этот транспорт пока не поддерживается — настройка сохранится, но приём по нему не заработает.'));
        // Адрес обязателен только новому прибору (сохранение ниже). Старая
        // строка без адреса законна — сервер отдаёт ей только сетевой прибор
        // на её порту и с первой пробы запоминает его, — но человек должен
        // видеть, что адрес лучше вписать.
        // LD_LAYOUT_V1 — владелец: «fix the layout of the analyzator window».
        // Поля стояли вплотную к краю карточки двумя неровными рядами, а
        // кнопки — прижаты к низу. Теперь все поля — одной сеткой с общими
        // колонками (ld-form-fields), пояснения — одним блоком под ней, кнопки —
        // отдельной строкой с чертой. Адрес и порт прячутся по одному, а не
        // своим рядом: у кабеля COM их нет.
        const hostField = field(tr('Адрес прибора'), hostInp, { required: !device });
        hostField.style.gridColumn = 'span 2';   // LD_LAYOUT_V1 — подсказка адреса длинная
        const portField = field(tr('Порт'), portInp);
        const noHostHint = device
            ? h('p', null,
                tr('Без адреса прибор примет пробы только от сетевого анализатора на своём порту и запомнит первого — лучше укажите адрес.'))
            : null;

        function syncTransport() {
            const key = transport();
            const t = TRANSPORTS.find((x) => x.key === key);
            hostField.style.display = key === 'mllp' ? '' : 'none';
            portField.style.display = key === 'mllp' ? '' : 'none';
            notReady.style.display = t && t.ready ? 'none' : '';
            // LIS_REAL_ANALYZERS_V1 — флажок звонка — только у сетевого прибора.
            // Звонит Easy-Med — адрес только IP, пояснение про соединение; у
            // модели «кто звонит — неизвестно» — подсказка про флажок.
            const dialing = dialOn();
            dialRow.style.display = key === 'mllp' ? '' : 'none';
            dialNote.style.display = dialing ? '' : 'none';
            const prof = profileOf(profSel.value);
            connectHint.style.display = key === 'mllp' && !dialing && prof && prof.connect === 'unknown' ? '' : 'none';
            hostInp.setAttribute('placeholder', dialing ? tr('IP-адрес прибора, например 10.0.0.30') : tr('адрес анализатора в сети, например 10.0.0.20'));
            if (noHostHint) noHostHint.style.display = key === 'mllp' && !dialing && !hostInp.value.trim() ? '' : 'none';
        }
        // LIS_REAL_ANALYZERS_V1 — слушатель, а не свойство onchange: смена модели
        // ещё и показывает или прячет подсказку про звонок (syncTransport).
        // Порт по умолчанию модели — только новому прибору, который звонит сам.
        profSel.addEventListener('change', () => {
            if (!device && !dialOn()) portInp.value = String(defaultPort());
            syncTransport();
        });

        formCard.appendChild(h('div', { class: 'card-header' },
            h('h3', null, device ? trf('Анализатор: {name}', { name: d.name }) : tr('Новый анализатор'))));
        const body = h('div', { class: 'ld-form' });   // LD_LAYOUT_V1
        body.appendChild(h('div', { class: 'ld-form-fields' },
            field(tr('Название'), nameInp), field(tr('Модель'), profSel), transSel ? field(tr('Подключение'), transSel) : null,
            hostField, portField));
        body.appendChild(dialRow);   // LIS_REAL_ANALYZERS_V1
        const notes = h('div', { class: 'ld-form-notes muted' });
        if (noHostHint) notes.appendChild(noHostHint);
        notes.appendChild(notReady);
        notes.appendChild(dialNote);      // LIS_REAL_ANALYZERS_V1
        notes.appendChild(connectHint);   // LIS_REAL_ANALYZERS_V1
        // LIS_REAL_ANALYZERS_V1 — строки «прибор-сервер пока не поддержан»
        // больше нет: его заменил флажок «Easy-Med подключается к прибору сам».
        if (!device) {
            // LIS_DISCOVERY_FIX_V1 (экран) — куда делся «Кабель COM»: такой
            // прибор руками не заводят, он приходит сам.
            notes.appendChild(h('p', null,
                tr('Анализатор на кабеле COM подключается через переадресатор на лабораторном компьютере и появится в «Найдены в сети» сам — добавлять его здесь не нужно.')));
        }
        body.appendChild(notes);
        body.appendChild(h('label', { class: 'ld-form-check' },
            enabledInp, h('span', null, tr('Включён — слушать этот прибор'))));

        body.appendChild(h('div', { class: 'ld-form-foot' },
            h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: save }, tr('Сохранить')),
            h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: leaveForm }, tr('Отмена')),
            h('span', { class: 'grow' }),
            device ? h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => removeDevice(device) }, tr('Удалить')) : null));
        formCard.appendChild(body);

        syncTransport();
        nameInp.focus();

        async function save() {
            const dial = dialOn();   // LIS_REAL_ANALYZERS_V1
            const payload = {
                name: nameInp.value.trim(),
                profile: profSel.value,
                transport: transport(),
                host: hostInp.value.trim(),
                port: Number(portInp.value) || 2575,
                enabled: enabledInp.checked ? 1 : 0,
                dial: dial ? 1 : 0,   // LIS_REAL_ANALYZERS_V1 — Easy-Med подключается к прибору сам
            };
            if (!payload.name) { toast(tr('Укажите название прибора'), 'warn'); return; }
            // LIS_DISCOVERY_FIX_V1 (экран) — новый прибор — только с адресом
            // (решение владельца 2026-09-29): по адресу сервер узнаёт прибор, а
            // строка без адреса забирала бы первый попавшийся сетевой прибор на
            // своём порту.
            if (!device && !payload.host) {
                toast(tr('Укажите адрес анализатора в сети — например, 10.0.0.20'), 'warn');
                hostInp.focus();
                return;
            }
            // LIS_REAL_ANALYZERS_V1 — звонит Easy-Med: адрес — только IP
            // локальной сети (те же правила, что у сервера, dial.js isLocalIp),
            // порт — обязателен и свой у прибора.
            if (dial) {
                if (!payload.host) { toast(tr('Укажите IP-адрес анализатора — Easy-Med подключится к нему сам'), 'warn'); hostInp.focus(); return; }
                if (!isIpAddress(payload.host)) { toast(tr('Нужен IP-адрес анализатора, например 10.0.0.30, — имя не подходит'), 'warn'); hostInp.focus(); return; }
                if (!isLocalIp(payload.host)) { toast(tr('Адрес не из локальной сети — анализатор в интернете означает ошибку в адресе'), 'warn'); hostInp.focus(); return; }
                const rawPort = String(portInp.value == null ? '' : portInp.value).trim();
                const port = /^\d+$/.test(rawPort) ? Number(rawPort) : NaN;
                if (!Number.isInteger(port) || port < 1 || port > 65535) {
                    toast(tr('Укажите порт анализатора — он в настройках LIS прибора'), 'warn');
                    portInp.focus();
                    return;
                }
                payload.port = port;
            }

            // LIS_ANALYZER_LIST_V1 — сохранение найденного прибора с выбранной
            // моделью и есть проверка модели человеком: пометка «проверьте
            // модель» снимается. Только в правке — у вставки такой колонки нет.
            const res = device
                ? await supabase.from('lab_devices').update(
                    device.discovered ? { ...payload, model_confirmed: payload.profile ? 1 : 0 } : payload).eq('id', device.id)
                : await supabase.from('lab_devices').insert(payload);
            if (res.error) { toast(trf('Не удалось сохранить прибор: {msg}', { msg: res.error.message || res.error }), 'fail'); return; }

            // Перезапуск слушателей: без него смена порта требовала бы
            // перезапуска всей клиники ради одного прибора.
            const { error } = await supabase.rpc('lis_restart', {});
            if (error) toast(trf('Прибор сохранён, но слушатель не перезапустился: {msg}', { msg: error.message || error }), 'fail');
            else toast(tr('Прибор сохранён'));
            // LIS_ANALYZER_LIST_V1 — новый прибор по адресу ждёт первого
            // сообщения: показать его там, где он теперь стоит. Ревью M3: и
            // правка из окна «Добавить прибор» возвращает в окно, а не
            // закрывает его. Сначала перечитать (форма пока на экране), потом
            // — туда, откуда открыли.
            const back = state.backToAdd || !device;
            await reload();
            if (back) openAddWindow(); else closeForm();
        }
    }

    // Ревью M3 — форма, открытая из окна «Добавить прибор», возвращает туда
    // («Отмена» здесь, «Сохранить» и «Удалить» — так же); открытая из таблицы
    // — закрывается, как прежде.
    function leaveForm() {
        if (state.backToAdd) openAddWindow(); else closeForm();
    }

    // LIS_ANALYZER_LIST_V1 — удаление вынесено из openForm: «Удалить» есть и у
    // строк окна «Добавить прибор» (находка, ждущий), а не только в форме.
    //
    // Ревью C2 — через RPC lis_device_delete, а не голым DELETE в /api/db: у
    // найденного анализатора всегда есть сообщения, они держат строку внешним
    // ключом (мигр. 123), и «Удалить» не срабатывало ни разу. Сервер
    // отвязывает сообщения (они остаются целиком), отказывает, если прибор
    // стоит у панели, и сам перезапускает слушатели. Поэтому и вопрос —
    // просто «Удалить?»: «панели перестанут принимать результаты» больше не
    // случается, сервер такое удаление не делает.
    async function removeDevice(dev) {
        // Ревью M3: откуда позвали — туда и вернуться. Строка окна «Добавить
        // прибор» или форма, открытая из него, — снова окно; форма из таблицы
        // — закрыть.
        const back = state.formMode === 'add' || state.backToAdd;
        if (!window.confirm(trf('Удалить «{name}»?', { name: dev.name }))) return;
        const { error } = await supabase.rpc('lis_device_delete', { id: dev.id });
        if (error) {
            // Отказ по делу — его же словами: в нём названы панели, и «Не
            // удалось удалить прибор:» перед ним было бы лишним.
            if (error.code === 'device_in_use') toast(error.message, 'warn');
            else toast(trf('Не удалось удалить прибор: {msg}', { msg: error.message || error }), 'fail');
            return;
        }
        toast(tr('Прибор удалён'));
        await reload();
        if (back) openAddWindow(); else closeForm();
    }

    // ---------- окно «Добавить прибор» (LIS_ANALYZER_LIST_V1) ----------
    //
    // Владелец (2026-09-28): «list of the analyzers when adding a dynamic list,
    // which will be empty if analyzer not plugged or connected». Здесь только те,
    // кто что-то присылал и ждёт нажатия «Добавить»; добавленные руками, но ещё
    // молчащие — ниже, со строкой о порте. Ручной путь — ссылкой внизу.

    function openAddWindow() {
        state.formMode = 'add';
        state.backToAdd = false;   // ревью M3: окно — не форма, возвращаться некуда
        formCard.style.display = '';
        paintAddWindow();
    }

    // Ревью M9 — всё, от чего зависит окно: строки находок и ждущих, текст связи
    // находки (он меняется и сам, со временем), ответ lis_listeners, ошибка
    // чтения, пуста ли таблица (от неё — пустое состояние, I1), модели.
    // LIS_DISCOVERY_FIX_V1 (экран) — сырой метки last_seen_at здесь нет: она
    // меняется с каждой пробой, и работающий анализатор перестраивал окно на
    // каждом опросе — нажатие «Добавить» опять терялось. Видимое от неё —
    // текст связи — в подписи есть.
    function addWindowSig() {
        const split = splitDevices(state.devices);
        return JSON.stringify([
            state.loadError,
            split.table.length > 0,
            split.found.map((d) => [d.id, d.name, d.sending_app, d.host, d.port, d.enabled, d.profile, livenessText(d.last_seen_at, serverNow()).text]),
            split.waiting.map((d) => [d.id, d.name, d.host, d.port, d.enabled, d.profile, d.transport, d.dial]),
            // LIS_REAL_ANALYZERS_V1 — порты и состояния звонков без секунд:
            // «повтор через 30 с» обновляется на месте (refreshDialNodes), окно
            // ради него не перестраивается.
            listenersSig(),
            state.profiles.map((p) => p.key),
        ]);
    }

    function paintAddWindow() {
        clear(formCard);
        state.dialNodes.add = [];   // LIS_REAL_ANALYZERS_V1
        state.addSig = addWindowSig();   // ревью M9
        const split = splitDevices(state.devices);
        formCard.appendChild(h('div', { class: 'card-header' },
            h('h3', null, tr('Добавить анализатор')),
            h('span', { class: 'grow' }),
            h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: closeForm }, tr('Закрыть'))));

        // LD_LAYOUT_V1 — подзаголовки окна стояли вплотную к краю карточки.
        formCard.appendChild(h('div', { class: 'ld-subhead' }, tr('Найдены в сети')));
        if (state.loadError) {
            // Ревью I1: список не прочитался — так и сказать. Пустой список
            // здесь значит «не знаем», а не «никого нет».
            formCard.appendChild(h('div', { class: 'empty', style: { padding: '18px 16px' } },
                trf('Не удалось прочитать список приборов: {msg}', { msg: state.loadError })));
        } else if (!split.found.length) {
            // Ревью I1: «ни один не выходил на связь» — только когда пусто всё:
            // таблица, находки и ждущие. Раньше фраза стояла и при kjkj в
            // таблице — просто потому, что новых находок не было.
            const nothingAtAll = !split.table.length && !split.waiting.length;
            // LD_LAYOUT_V1 — «укажите адрес адрес этого компьютера»: когда
            // программа открыта как localhost, адреса мы не знаем, и подставлялась
            // фраза, сама начинающаяся со слова «адрес». Для этого случая — своё
            // целое предложение.
            const guideIp = guideHostKnown();
            formCard.appendChild(h('div', { class: 'empty', style: { padding: '18px 16px' } },
                h('div', { style: { fontWeight: 600, marginBottom: '6px' } },
                    nothingAtAll ? tr('Ни один анализатор пока не выходил на связь.') : tr('Новых анализаторов пока нет.')),
                h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                    guideIp
                        ? trf('На анализаторе в настройках связи (LIS) укажите адрес {ip}, порт 2575, протокол HL7 и отправьте пробу — анализатор появится здесь сам.', { ip: guideIp })
                        : tr('На анализаторе в настройках связи (LIS) укажите адрес этого компьютера в сети, порт 2575, протокол HL7 и отправьте пробу — анализатор появится здесь сам.'))));
        } else {
            const tb = h('tbody');
            for (const d of split.found) {
                const p = profileOf(d.profile);
                const live = livenessText(d.last_seen_at, serverNow());
                tb.appendChild(h('tr', null,
                    // LIS_DISCOVERY_FIX_V1 (экран) — «Как назвался» — как прибор
                    // назвал себя сам (MSH-3, lab_devices.sending_app, мигр. 229):
                    // его пишет только сервер, а имя человек может поменять.
                    // Строка без него (сервер старее миграции) — по имени, как раньше.
                    h('td', { style: { fontWeight: 600 } }, d.sending_app || d.name),
                    h('td', { class: 'muted' }, p ? p.vendor + ' ' + p.model : tr('модель не определена')),
                    h('td', { class: 'cell-mono', style: { fontSize: '12.5px' } }, d.host || tr('адрес неизвестен')),
                    h('td', null, live.kind === 'idle'
                        ? h('span', { class: 'muted', style: { fontSize: '12.5px' } }, live.text)
                        : Tag(live.text, { kind: live.kind })),
                    h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
                        h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => openAdopt(d) }, Icon('Plus', { size: 13 }), ' ', tr('Добавить')),
                        ' ',
                        h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => removeDevice(d) }, tr('Удалить')))));
            }
            formCard.appendChild(h('table', { class: 'list' },
                h('thead', null, h('tr', null,
                    h('th', null, tr('Как назвался')), h('th', null, tr('Модель')), h('th', null, tr('Адрес')),
                    h('th', null, tr('Связь')), h('th', null, ''))),
                tb));
        }

        if (split.waiting.length) {
            formCard.appendChild(h('div', { class: 'ld-subhead' }, tr('Ждут первого сообщения')));   // LD_LAYOUT_V1
            const tb = h('tbody');
            for (const d of split.waiting) {
                // Ревью M5: строка о порте — только у СЕТЕВОГО прибора: у кабеля
                // COM и папки порта нет, и «порт 2575 слушается» у них — неправда.
                // Выключенный — «выключен», а не порт: порт по умолчанию
                // слушается всегда, и строка обещала бы приём, которого нет.
                let lineTag = null;
                if (!d.enabled) lineTag = Tag(tr('выключен'));
                // LIS_REAL_ANALYZERS_V1 — прибору, который ждёт звонка, Easy-Med
                // звонит сам: его порт не слушается, и строка о порте была бы
                // неправдой — вместо неё состояние соединения.
                else if (d.transport === 'mllp' && Number(d.dial) === 1) lineTag = dialNode(d, 'add');
                else if (d.transport === 'mllp') {
                    const ps = portState(d, state.listeners);
                    // Ревью M6: не поднявшийся порт — своими словами по коду, без
                    // сырого текста сервера (он русский и с догадкой о причине).
                    const portText = ps.kind === 'listening' ? trf('порт {port} слушается — ждём первое сообщение', { port: ps.port })
                        : ps.kind === 'failed'
                            ? (ps.code === 'busy' ? trf('порт {port} занят другой программой', { port: ps.port }) : trf('порт {port} не слушается', { port: ps.port }))
                        : ps.kind === 'off' ? trf('порт {port} сейчас не слушается', { port: ps.port })
                        : '';
                    if (portText) lineTag = Tag(portText, { kind: ps.kind === 'listening' ? '' : 'warn' });
                }
                tb.appendChild(h('tr', null,
                    h('td', { style: { fontWeight: 600 } }, d.name),
                    h('td', { class: 'cell-mono', style: { fontSize: '12.5px' } },
                        d.transport === 'mllp'
                            ? trf('{host}:{port}', { host: d.host || tr('любой адрес'), port: d.port || 2575 })
                            : tr(TRANSPORT_LABEL[d.transport] || d.transport)),
                    h('td', null, lineTag),
                    h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
                        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => openForm(d, { fromAdd: true }) }, Icon('Edit', { size: 13 }), ' ', tr('Изменить')),
                        ' ',
                        h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => removeDevice(d) }, tr('Удалить')))));
            }
            formCard.appendChild(h('table', { class: 'list' }, tb));
        }

        formCard.appendChild(h('div', { class: 'ld-add-foot' },   // LD_LAYOUT_V1
            h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => openForm(null, { fromAdd: true }) },
                tr('Анализатор не появился? Добавить по адресу')),
            // LIS_REAL_ANALYZERS_V1 — прибор-сервер найти нельзя: он не звонит.
            h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '4px 8px 0' } }, tr(DIAL_ADD_HINT))));
    }

    // «Добавить» у находки: название подставлено, модель — догадка по имени;
    // человек проверяет и нажимает — прибор уходит в таблицу.
    //
    // Ревью C1: discovered здесь НЕ пишется — это правило приёма, а не
    // пометка для глаз. Для discover.js discovered = 0 значит «заведён
    // человеком на этот адрес», и модель у такой строки не сверяется: после
    // одного «Добавить» всё, что шлёт с того же адреса (переадресаторы COM на
    // одном ПК, 127.0.0.1, симулятор), ложилось бы в эту строку. «Добавить»
    // меняет место прибора на экране, а не приём.
    function openAdopt(d) {
        state.formMode = 'adopt';
        clear(formCard);
        state.dialNodes.add = [];   // LIS_REAL_ANALYZERS_V1 — окно «Добавить прибор» больше не на экране
        const nameInp = h('input', { type: 'text', value: d.name || '' });
        const profSel = h('select', null,
            h('option', { value: '', selected: !d.profile ? true : null }, tr('модель не определена')),
            ...state.profiles.map((p) => h('option', { value: p.key, selected: p.key === d.profile ? true : null }, p.vendor + ' ' + p.model)));
        formCard.appendChild(h('div', { class: 'card-header' }, h('h3', null, trf('Добавить «{name}»', { name: d.name }))));
        formCard.appendChild(h('div', { class: 'row', style: { gap: '14px', flexWrap: 'wrap', marginBottom: '10px' } },
            field(tr('Название'), nameInp), field(tr('Модель'), profSel)));
        formCard.appendChild(h('p', { class: 'muted', style: { fontSize: '12.5px' } },
            profileOf(d.profile)
                ? tr('Модель подобрана по тому, как прибор себя назвал, — проверьте её.')
                : tr('Модель по имени прибора не определилась — выберите её сами.')));
        formCard.appendChild(h('div', { class: 'row', style: { gap: '8px', marginTop: '6px' } },
            h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: save }, tr('Добавить')),
            h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: openAddWindow }, tr('Назад'))));

        async function save() {
            const name = nameInp.value.trim();
            if (!name) { toast(tr('Укажите название прибора'), 'warn'); return; }
            // Ревью I2: модель — только выбранная. «модель не определена» ('')
            // не шлётся вовсе: иначе стиралась бы догадка сервера — и тогда,
            // когда lis_profiles не ответил и в списке один пустой пункт.
            const values = { name, added: 1 };
            // Модель выбрана — её проверил человек: пометка «найден сам —
            // проверьте модель» в таблице больше не нужна.
            if (profSel.value) { values.profile = profSel.value; values.model_confirmed = 1; }
            const { error } = await supabase.from('lab_devices').update(values).eq('id', d.id);
            if (error) { toast(trf('Не удалось добавить прибор: {msg}', { msg: error.message || error }), 'fail'); return; }
            toast(trf('Прибор «{name}» добавлен', { name }));
            closeForm();
            await reload();
        }
    }

    function closeForm() {
        state.formMode = null;   // LIS_ANALYZER_LIST_V1
        state.backToAdd = false;   // ревью M3
        formCard.style.display = 'none';
        clear(formCard);
        state.dialNodes.add = [];   // LIS_REAL_ANALYZERS_V1
    }

    // ---------- инструкция по подключению ----------
    //
    // Единственное место, где человек, стоящий у прибора, прочитает, что
    // нажать. Раньше эти шаги жили в переписке с разработчиком — то есть нигде.
    // Инструкция честная: сетевой прибор подключается настройкой на нём самом
    // (или в программе прибора на его компьютере — BS-200); прибор, который сам
    // не звонит, Easy-Med набирает сам; прибор только на кабеле COM — через
    // переадресатор на лабораторном компьютере. Что сделано по документам, а не
    // проверено на приборе, сказано прямо (LIS_REAL_ANALYZERS_V1).

    // LD_LAYOUT_V1 — настоящий адрес, если программа открыта по нему; иначе ''.
    function guideHostKnown() {
        const hn = (typeof location !== 'undefined' && location && location.hostname) || '';
        return (!hn || hn === 'localhost' || hn === '127.0.0.1') ? '' : hn;
    }
    function hostForGuide() {
        return guideHostKnown() || tr('адрес этого компьютера в сети');
    }

    function paintGuide() {
        clear(guideCard);
        const body = h('div', { style: { display: 'none' } });
        const toggle = h('button', { class: 'btn btn-outline btn-sm', type: 'button',
            onclick: () => {
                const open = body.style.display === 'none';
                body.style.display = open ? '' : 'none';
                toggle.textContent = open ? tr('Свернуть') : tr('Показать');
            } }, tr('Показать'));

        guideCard.appendChild(h('div', { class: 'card-header' },
            h('h3', null, tr('Как подключить анализатор')),
            h('span', { class: 'grow' }),
            toggle));

        const step = (text) => h('li', { style: { marginBottom: '6px' } }, text);
        // LIS_REAL_ANALYZERS_V1 — и три настоящих прибора клиники: BC-780, BS-200, A1000 по сети.
        body.appendChild(h('p', { style: { fontWeight: 600, marginBottom: '6px' } }, tr('Прибор с сетевым разъёмом (BC-20, BC-5300, BC-780, BS-200, BS-240, CL-900i, AutoLumo A1000)')));
        // LIS_DISCOVERY_FIX_V1 (экран) — «ничего настраивать не нужно» было
        // неправдой: прибор ещё надо «Добавить».
        body.appendChild(h('p', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '8px' } },
            tr('В Easy-Med настраивать почти ничего не нужно: прибор появится в «Добавить прибор» → «Найдены в сети» — останется нажать «Добавить».')));
        body.appendChild(h('ol', { style: { paddingLeft: '20px', marginBottom: '12px' } },
            step(tr('Подключите прибор сетевым кабелем к той же сети, где стоит компьютер с Easy-Med.')),
            // LIS_REAL_ANALYZERS_V1 — путь меню был только гематологии Mindray;
            // у BS-200 связь с LIS — в программе прибора на его компьютере.
            step(tr('Откройте на приборе настройки связи с LIS: у гематологии Mindray — Настройка → Системные настройки → Связь (Setup → System Setup → Communication); у BS-200 — в программе прибора на его компьютере.')),
            step(tr('Связь: «сетевой порт» (Network port), а не «последовательный порт».')),
            // location может отсутствовать (тестовый DOM); а localhost человеку у
            // прибора бесполезен — ему нужен адрес компьютера В СЕТИ клиники.
            step(trf('Адрес назначения: адрес компьютера с Easy-Med — {ip}. Порт: 2575. Протокол: HL7.', { ip: hostForGuide() })),
            // LIS_REAL_ANALYZERS_V1 — Easy-Med только принимает результаты.
            step(tr('Передача — в одну сторону: прибор только отправляет результаты. Запрос заказов из LIS (рабочий список, «загрузка из LIS») выключите — Easy-Med заказов не отдаёт.')),
            step(tr('Включите «Автоматическая передача» (Auto Communicate) — тогда прибор отправляет каждую готовую пробу сам.')),
            // Ревью M2: находка ждёт в окне «Добавить прибор», а не появляется
            // «в списке выше» сама — инструкция ведёт туда, где она есть.
            step(tr('Прогоните одну пробу. Прибор появится в «Добавить прибор» → «Найдены в сети»: нажмите «Добавить», затем в «Панелях» выберите его у панели и подтвердите поля.')),
            // LIS_DISCOVERY_FIX_V1 (экран) — ручной путь: адрес обязателен, и
            // прибор ждёт первую пробу в своём разделе окна.
            step(tr('Анализатор не появился? В «Добавить прибор» → «Добавить по адресу» укажите его адрес и порт — он будет ждать в «Ждут первого сообщения», пока не пришлёт пробу.')),
            // LIS_REAL_ANALYZERS_V1 — входящий 2575 в брандмауэре Windows
            // открывает только администратор, и без него прибор молчит.
            step(tr('Прибор не появляется, хотя адрес и порт верны? На компьютере с Easy-Med разрешите входящий TCP-порт 2575 в брандмауэре Windows — это делается с правами администратора.'))));

        // LIS_REAL_ANALYZERS_V1 — три настоящих прибора клиники, у каждого своё.
        body.appendChild(h('p', { style: { fontWeight: 600, marginBottom: '6px' } }, tr('Особенности моделей')));
        body.appendChild(h('ul', { style: { paddingLeft: '20px', fontSize: '12.5px', marginBottom: '12px' } },
            h('li', { style: { marginBottom: '4px' } }, tr('Mindray BS-200 — связь с LIS настраивается в программе прибора на его компьютере: адрес этого компьютера, порт 2575. Номер пробирки прибор передаёт из поля «Штрихкод» (Barcode): сканируйте этикетку LAB-… или впишите её номер в это поле, а не в «Номер пробы» (Sample ID) — это место в штативе, Easy-Med его не читает. Тесты приходят по одному: пока проба не пришла целиком, она видна в «Необработанные» → «Идёт приём результатов».')),
            h('li', { style: { marginBottom: '4px' } }, tr('Mindray BC-780 — если в настройках LIS прибора есть адрес сервера, укажите адрес этого компьютера и порт 2575: прибор позвонит сам. Если есть только «порт прибора» — прибор ждёт звонка: «Добавить по адресу», впишите IP-адрес и порт прибора и отметьте «Easy-Med подключается к прибору сам».')),
            h('li', null, tr('Autobio AutoLumo A1000 — лучше по сети: связь с LIS по TCP/IP, протокол HL7, тип порта «As client», адрес этого компьютера и порт 2575, приоритет LIS «только локальный» (2), «Get from LIS…» выключите. Если сетевой разъём занят — кабелем COM через переадресатор (FORWARD-AutoLumo-A1000.bat), на приборе протокол ASTM.'))));

        // LIS_REAL_ANALYZERS_V1 — A1000 больше не «только кабелем COM»: основной путь у него — сеть.
        body.appendChild(h('p', { style: { fontWeight: 600, marginBottom: '6px' } }, tr('Прибор, подключённый к компьютеру только кабелем COM (BC-2800, BC-3000 Plus и другие)')));
        body.appendChild(h('p', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '12px' } },
            tr('Такой прибор не умеет отправлять по сети — за него это делает переадресатор на том же компьютере. Папку «analyzers» выдаёт разработчик: скопируйте её целиком на лабораторный компьютер и запустите файл своей модели — FORWARD-BC-2800.bat, FORWARD-AutoLumo-A1000.bat и так далее. При первом запуске он спросит COM-порт, скорость и адрес этого компьютера с Easy-Med. Дальше результаты приходят сюда так же, как с сетевого прибора.')));
        // LIS_DISCOVERY_FIX_V1 (экран) — решение владельца 2026-09-29: в ручной
        // форме кабеля COM больше нет.
        body.appendChild(h('p', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '12px' } },
            tr('Прибор на кабеле COM руками не добавляйте — через переадресатор он появится в «Найдены в сети» сам.')));
        body.appendChild(h('p', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '12px' } },
            tr('COM-порт может держать только одна программа: пока работает переадресатор, ПО производителя этот прибор не видит. Чтобы работали оба, прибору нужен второй последовательный порт или разветвитель.')));

        body.appendChild(h('p', { style: { fontWeight: 600, marginBottom: '6px' } }, tr('Важно')));
        body.appendChild(h('ul', { style: { paddingLeft: '20px', fontSize: '12.5px' } },
            h('li', { style: { marginBottom: '4px' } }, tr('Прибор отправляет результаты только по ОДНОМУ адресу. Если он сейчас направлен на другую программу, после переключения та программа результаты получать перестанет.')),
            h('li', { style: { marginBottom: '4px' } }, tr('Результат никогда не выдаётся сам: прибор заполняет бланк, а проверяет и выдаёт лаборант.')),
            // LIS_REAL_ANALYZERS_V1 — что сделано по документам, а не на приборе;
            // единицы; служебные сообщения.
            h('li', { style: { marginBottom: '4px' } }, tr('Первую пробу каждого нового прибора сверьте построчно с распечаткой прибора: BS-200 сделан по руководству производителя, AutoLumo A1000 — по рабочим программам других LIS, BC-780 — по документам соседних моделей.')),
            h('li', { style: { marginBottom: '4px' } }, tr('Единицы не пересчитываются: настройте на приборе те же единицы, что в панели.')),
            h('li', { style: { marginBottom: '4px' } }, tr('Контроль качества, калибровка и запросы заказов в бланки и «Необработанные» не идут — их число за сегодня видно у прибора в таблице.')),
            // Ревью M2: пробы находки ложатся и до «Добавить» — значит, условие
            // не «появился в списке», а «уже присылал пробы».
            h('li', null, tr('Если прибор уже присылал пробы, но значения не ложатся — смотрите «Необработанные»: там написано, чего именно не хватает.'))));

        guideCard.appendChild(body);
    }

    // ---------- лоток ----------

    // LIS_DISCOVERY_FIX_V1 (экран) — что видно в строке лотка. Текст «Сырого»
    // у сообщения не меняется, а статус и строка журнала — могут.
    // LIS_REAL_ANALYZERS_V1 — и раскладка по времени: строка серии через 60
    // минут переходит из «Идёт приём результатов» в лоток сама, без нового ответа сервера.
    const traySig = () => {
        const split = splitTray(state.messages, serverNow());
        return JSON.stringify([state.messages.map((m) => [m.id, m.status, m.detail, m.sample_id, m.received_at]),
            split.receiving.map((m) => m.id)]);
    };

    // LIS_REAL_ANALYZERS_V1 (спецификация, раздел 3, «Что видит лаборатория») —
    // прибор шлёт по тесту в сообщении (BS-200, A1000): пока не пришли остальные
    // строки бланка, сообщения серии ждут — это идущий приём, а не беда.
    // Приглушённой группой, без кнопок разбора и не в счёт «Необработанных».
    // Одна строка на пробу (groupReceiving): самая новая говорит, чего не хватает сейчас.
    function receivingBlock(groups) {
        const tb = h('tbody');
        for (const m of groups) {
            const dev = state.devices.find((d) => d.id === m.device_id);
            tb.appendChild(h('tr', null,
                h('td', { class: 'muted', style: { fontSize: '12.5px', whiteSpace: 'nowrap' } }, fmtDateTime(m.received_at)),
                h('td', { class: 'cell-mono muted' }, m.sample_id || '—'),
                h('td', { class: 'muted', style: { fontSize: '12.5px' } }, dev ? dev.name : '—',
                    m.count > 1 ? h('div', null, trf('сообщений: {n}', { n: m.count })) : null),
                h('td', { class: 'muted', style: { fontSize: '12.5px' } }, seriesPendingRest(m) || '—')));
        }
        return h('div', { style: { opacity: '0.85' } },
            h('div', { class: 'ld-subhead' }, tr('Идёт приём результатов')),
            h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '0 14px 6px' } },
                tr('Анализатор присылает тесты по одному: строка ждёт остальные результаты бланка до 60 минут.')),
            h('table', { class: 'list' }, tb));
    }

    function paintTray() {
        state.sigs.tray = traySig();   // LIS_DISCOVERY_FIX_V1
        // LIS_DISCOVERY_FIX_V1 — раскрытое «Сырое» переживает и перерисовку
        // лотка: неверно настроенный прибор кладёт сюда каждую пробу, и лоток
        // меняется как раз тогда, когда человек читает сырое сообщение.
        const shown = new Set(state.messages.map((m) => m.id));
        for (const id of state.rawOpen) if (!shown.has(id)) state.rawOpen.delete(id);
        clear(trayCard);
        // LIS_REAL_ANALYZERS_V1 — идущая серия — отдельно и не в счёт.
        const { receiving: receivingRows, tray } = splitTray(state.messages, serverNow());
        const receiving = groupReceiving(receivingRows);
        trayCard.appendChild(h('div', { class: 'card-header' },
            h('h3', null, tr('Необработанные')),
            h('span', { class: 'grow' }),
            h('span', { class: 'muted', style: { fontSize: '12.5px' } },
                tray.length ? trf('ждут разбора: {n}', { n: tray.length })
                    : receiving.length ? trf('идёт приём: {n}', { n: receiving.length }) : tr('пусто'))));

        if (receiving.length) trayCard.appendChild(receivingBlock(receiving));
        if (!tray.length) {
            // Идёт приём — «всё разложено» было бы неправдой: бланк ещё не полон.
            if (!receiving.length) trayCard.appendChild(h('div', { class: 'empty', style: { padding: '26px 20px' } }, tr('Все результаты разложены по бланкам.')));
            return;
        }

        const tb = h('tbody');
        for (const m of previewRows(tray, 'tray')) {   // LD_LAYOUT_V1
            const raw = h('pre', {
                style: {
                    display: state.rawOpen.has(m.id) ? '' : 'none', margin: '8px 0 0', padding: '10px', background: 'var(--ink-050, #f4f6f8)',
                    borderRadius: '6px', fontSize: '12.5px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                },
            }, (m.raw || '').split('\r').join('\n'));
            // LIS_DISCOVERY_FIX_V1 (экран) — от переросшего сообщения здесь только
            // начало: «Привязать» положило бы в бланк обрезанное число, и сервер
            // такую привязку отклоняет. Кнопки нет; «Отклонить» остаётся — строку
            // убирают из лотка, а пробу прибор отправляет заново.
            const truncated = isTruncatedMessage(m);
            // LIS_REAL_ANALYZERS_V1 — серия не дошла за 60 минут: «серия не
            // дошла до конца: не пришли: …», а слова «ждём» к старой строке нет.
            const staleRest = staleSeriesRest(m, serverNow());

            tb.appendChild(h('tr', null,
                h('td', { class: 'muted', style: { fontSize: '12.5px', whiteSpace: 'nowrap' } }, fmtDateTime(m.received_at)),
                h('td', { class: 'cell-mono' }, m.sample_id || '—'),
                h('td', null, Tag(tr(STATUS_RU[m.status] || m.status), { kind: m.status === 'superseded' ? 'warn' : '' })),
                h('td', { class: 'muted', style: { fontSize: '12.5px' } },
                    staleRest != null ? trf('серия не дошла до конца: {rest}', { rest: staleRest }) : (m.detail || '—'),
                    h('button', {
                        class: 'btn btn-outline btn-sm', type: 'button', style: { marginLeft: '8px' },
                        onclick: () => {
                            const open = raw.style.display === 'none';
                            raw.style.display = open ? '' : 'none';
                            if (open) state.rawOpen.add(m.id); else state.rawOpen.delete(m.id);
                        },
                    }, tr('Сырое')),
                    truncated
                        ? h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } },
                            tr('пришло не целиком — пусть прибор отправит пробу ещё раз'))
                        : null,
                    raw),
                h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
                    truncated ? null : h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => attach(m) }, tr('Привязать')),
                    truncated ? null : ' ',
                    h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => dismiss(m) }, tr('Отклонить')))));
        }
        trayCard.appendChild(h('table', { class: 'list' },
            h('thead', null, h('tr', null,
                h('th', null, tr('Получено')), h('th', null, tr('Номер пробы')), h('th', null, tr('Состояние')),
                h('th', null, tr('Подробности')), h('th', null, ''))),
            tb));
        const more = moreToggle(tray.length, 'tray', paintTray);   // LD_LAYOUT_V1
        if (more) trayCard.appendChild(more);
    }

    async function attach(m) {
        const answer = window.prompt(
            tr('Номер заказа — число, напечатанное на пробирке после LAB-'),
            String(m.sample_id || '').replace(/^lab[-_ ]?/i, '').replace(/^0+/, ''));
        if (answer == null) return;
        // LIS_REAL_ANALYZERS_V1 (ревью R1, п. 10) — номер или этикетка целиком
        // («LAB-000123»), как принимает сервер; прочее — не номер.
        const typed = String(answer).trim();
        const fromLabel = /^lab-(\d+)$/i.exec(typed);
        const vsId = fromLabel ? Number(fromLabel[1]) : (/^\d+$/.test(typed) ? Number(typed) : 0);
        if (!vsId) { toast(tr('Нужен номер заказа'), 'warn'); return; }

        const { data, error } = await supabase.rpc('lis_message_attach', { id: m.id, visit_service_id: vsId });
        if (error) {
            // LIS_DISCOVERY_FIX_V1 (экран) — отказ по правилу, а не сбой: сообщение,
            // пришедшее не целиком, сервер не привязывает (409 — иначе в бланк
            // легло бы обрезанное число); так же он отвечает «Сообщение не
            // найдено» (404) и «Недостаточно прав» (403). Отказ — его же словами и
            // предупреждением; лоток перечитывается: строка могла измениться.
            // Сбой сервера (internal) и связи (кода нет) — как прежде.
            if (error.code && error.code !== 'internal') {
                toast(error.message || String(error.code), 'warn');
                await reload();
                return;
            }
            toast(trf('Не удалось привязать сообщение: {msg}', { msg: error.message || error }), 'fail');
            return;
        }
        // ok=false здесь — НЕ сбой связи: приём мог отказать по своим правилам
        // (заказ не лабораторный, поле не подтверждено). Человеку надо сказать,
        // что именно, а не «готово».
        // LIS_MINDRAY_CODES_V1 (ревью R9) — и ok=true ещё не «готово»: ACK
        // значит «принято и сохранено». Сервер отдаёт статус новой строки
        // лотка; принято, но бланк заполнен не весь — предупреждение с тем,
        // чего не хватило, а сама строка ждёт в лотке.
        if (data && data.ok && data.status === 'applied') toast(tr('Сообщение применено'));
        else if (data && data.ok && data.status === 'unmapped') {
            toast(trf('Сообщение принято, но бланк заполнен не полностью: {detail}', { detail: data.detail || '—' }), 'warn');
        } else toast(tr('Приём не применил сообщение — смотрите лоток'), 'fail');
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
