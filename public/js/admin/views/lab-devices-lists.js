// LIS_ANALYZER_LIST_V1 — ГДЕ СТОИТ ПРИБОР на экране «Анализаторы». Чистые
// функции: ни DOM, ни словаря, ни сети. Тот же приём, что у lab-devices-live.js:
// проверять надо правило, а не разметку.
//
// Три состояния (решения владельца 2026-09-28/29):
//   найден, не добавлен          added = 0                     → «Добавить прибор» → «Найдены в сети»
//   добавлен, ждёт сообщения     added = 1, last_seen_at пуст  → «Добавить прибор» → «Ждут первого сообщения»
//   добавлен и выходил на связь  added = 1, last_seen_at есть  → таблица
// Нет поля added (сервер старее миграции 228) — прибор считается добавленным:
// из таблицы ничего не должно пропадать само.
//
// LIS_DISCOVERY_FIX_V1 (экран) — и одно правило лотка «Необработанные»: какую
// строку нельзя «Привязать» (isTruncatedMessage).

/** @returns {{table:object[], found:object[], waiting:object[]}} */
export function splitDevices(devices = []) {
    const table = [], found = [], waiting = [];
    for (const d of devices) {
        const added = d.added == null ? true : Number(d.added) === 1;
        if (!added) found.push(d);
        else if (d.last_seen_at) table.push(d);
        else waiting.push(d);
    }
    return { table, found, waiting };
}

/**
 * Слушается ли порт прибора прямо сейчас (lis_listeners). Проверка связи с
 * НАШЕЙ стороны: «слушается» — Easy-Med готов, дело в настройке прибора;
 * «не поднялся» — порт занят другой программой (code 'busy') или не поднялся
 * по другой причине ('error'); «выключен» — прибор или приём выключены;
 * «неизвестно» — ответа сервера ещё нет.
 *
 * Ревью M6: причина — кодом, а не текстом сервера. Текст русский и с догадкой
 * («вероятно, Easy-Med уже запущен»), и на узбекском экране он стоял бы
 * по-русски; экран говорит своими словами.
 * @returns {{kind:'listening'|'failed'|'off'|'unknown', port:number, code?:'busy'|'error'}}
 */
export function portState(device, status) {
    const port = Number(device && device.port) || 2575;
    if (!status) return { kind: 'unknown', port };
    if ((status.listening || []).includes(port)) return { kind: 'listening', port };
    const f = (status.failed || []).find((x) => Number(x.port) === port);
    if (f) return { kind: 'failed', port, code: f.code === 'busy' ? 'busy' : 'error' };
    return { kind: 'off', port };
}

/**
 * LIS_DISCOVERY_FIX_V1 (экран) — строка лотка от ПЕРЕРОСШЕГО сообщения: прибору
 * ушёл AE, а в лотке лежит только начало текста (server/lis/index.js,
 * onOversize, «сообщение больше … — не принято»). «Привязать» такую строку
 * значило бы положить в бланк обрезанное число — PLT «25» вместо 250, — и
 * сервер эту привязку отклоняет. Другой пометки у строки нет: узнаётся по
 * статусу и началу строки журнала — тому же, что OVERSIZE_DETAIL_PREFIX в
 * server/lis/inbox.js (сервер по нему и отказывает). Сменится там — менять и здесь.
 */
export function isTruncatedMessage(m) {
    // i18n-exempt: начало строки журнала сервера (server/lis/index.js) — признак для сравнения, а не текст экрана
    return !!m && m.status === 'rejected' && String(m.detail || '').startsWith('сообщение больше ');
}

// ═══ LIS_REAL_ANALYZERS_V1 (экран) ═══════════════════════════════════════════
// Серия BS-200 в лотке, звонок прибору, служебные сообщения, подпись модели,
// проверка адреса звонка. Те же чистые правила: решение — здесь, слова — на
// экране (lab-devices.js переводит ключи словаря).

/**
 * Начало строки лотка у сообщения серии, которое ждёт остальные строки бланка
 * (прибор шлёт по тесту в сообщении — BS-200, A1000). КОПИЯ строки сервера
 * SERIES_PENDING_PREFIX (server/lis/inbox.js): тест сверяет обе. Сменится там —
 * менять и здесь.
 */
// i18n-exempt: начало строки журнала сервера (server/lis/inbox.js) — признак для сравнения, а не текст экрана
export const SERIES_PENDING_PREFIX = 'серия: ждём остальные строки — ';
/** Окно серии, минут: как SERIES_WINDOW_MS приёма (server/lis/match.js). */
export const SERIES_WINDOW_MIN = 60;

/**
 * Строка серии, ждущая остальные строки бланка: unmapped, не разобрана
 * человеком, журнал начинается с SERIES_PENDING_PREFIX. Возвращает остаток
 * журнала после начала («не пришли: Креатинин (3)») или null.
 */
export function seriesPendingRest(m) {
    if (!m || m.status !== 'unmapped' || m.resolved_at) return null;
    const d = String(m.detail || '');
    return d.startsWith(SERIES_PENDING_PREFIX) ? d.slice(SERIES_PENDING_PREFIX.length) : null;
}

/** Сколько минут назад пришло: метка из будущего — 0, нечитаемая — Infinity. */
function ageMin(iso, now) {
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return Infinity;
    return Math.max(0, (now - at) / 60000);
}

/**
 * Лоток «Необработанные» и группа «Идёт приём» (спецификация, раздел 3, «Что
 * видит лаборатория»): строки серии, ждущие остальные результаты, первые 60
 * минут — не беда, а идущий приём. Они не считаются «Необработанными». Дошла
 * серия — строки стали applied и ушли сами; не дошла за час — обычная строка
 * лотка (staleSeriesRest). Нечитаемое время — в лоток: прятать нельзя.
 * @returns {{receiving:object[], tray:object[]}}
 */
export function splitTray(messages = [], now = Date.now()) {
    const receiving = [], tray = [];
    for (const m of messages) {
        if (seriesPendingRest(m) != null && ageMin(m.received_at, now) < SERIES_WINDOW_MIN) receiving.push(m);
        else tray.push(m);
    }
    return { receiving, tray };
}

/**
 * «Идёт приём результатов» — одна строка на пробу (прибор и заказ): ранняя
 * строка серии говорит, чего не хватало ТОГДА («не пришли: Мочевина,
 * Креатинин»), и рядом с поздней («не пришли: Креатинин») противоречила бы ей.
 * Остаётся самая новая — по номеру строки, а не по порядку списка: лоток
 * отсортирован по received_at, и у сообщений одной секунды порядок не задан;
 * count — сколько сообщений пробы ждут. Без заказа — по одной. Порядок групп —
 * порядок списка.
 * @returns {object[]}
 */
export function groupReceiving(rows = []) {
    const out = [];
    const byKey = new Map();
    for (const m of rows) {
        const key = m.visit_service_id ? (m.device_id == null ? '' : m.device_id) + '|' + m.visit_service_id : null;
        const i = key ? byKey.get(key) : undefined;
        if (i !== undefined) {
            const g = out[i];
            out[i] = Number(m.id) > Number(g.id) ? { ...m, count: g.count + 1 } : { ...g, count: g.count + 1 };
            continue;
        }
        out.push({ ...m, count: 1 });
        if (key) byKey.set(key, out.length - 1);
    }
    return out;
}

/**
 * Строка серии, прождавшая дольше окна: экран пишет «серия не дошла до конца:»
 * и остаток журнала, а слово «ждём» к старой строке не показывает. Иначе null —
 * журнал как есть.
 */
export function staleSeriesRest(m, now = Date.now()) {
    const rest = seriesPendingRest(m);
    return rest != null && ageMin(m.received_at, now) >= SERIES_WINDOW_MIN ? rest : null;
}

// ── адрес звонка: только IP локальной сети ────────────────────────────────────
// Те же правила, что у сервера (server/lis/dial.js isLocalIp; тест сверяет
// оба на таблице адресов). Сервер такой адрес и так не наберёт (bad_address),
// но /api/db строку сохранит — поэтому форма проверяет до записи. IP — по тем
// же выражениям, что net.isIP у Node: имя (bc780.local) — обращение к DNS.
const V4SEG = '(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])';
const V4 = '(?:' + V4SEG + '\\.){3}' + V4SEG;
const IPV4_RE = new RegExp('^' + V4 + '$');
const V6 = '(?:[0-9a-fA-F]{1,4})';
const IPV6_RE = new RegExp('^(?:'
    + '(?:' + V6 + ':){7}(?:' + V6 + '|:)|'
    + '(?:' + V6 + ':){6}(?:' + V4 + '|:' + V6 + '|:)|'
    + '(?:' + V6 + ':){5}(?::' + V4 + '|(?::' + V6 + '){1,2}|:)|'
    + '(?:' + V6 + ':){4}(?:(?::' + V6 + '){0,1}:' + V4 + '|(?::' + V6 + '){1,3}|:)|'
    + '(?:' + V6 + ':){3}(?:(?::' + V6 + '){0,2}:' + V4 + '|(?::' + V6 + '){1,4}|:)|'
    + '(?:' + V6 + ':){2}(?:(?::' + V6 + '){0,3}:' + V4 + '|(?::' + V6 + '){1,5}|:)|'
    + '(?:' + V6 + ':){1}(?:(?::' + V6 + '){0,4}:' + V4 + '|(?::' + V6 + '){1,6}|:)|'
    + '(?::(?:(?::' + V6 + '){0,5}:' + V4 + '|(?::' + V6 + '){1,7}|:))'
    + ')(?:%[0-9a-zA-Z-.:]{1,})?$');

function ipv4Local(a) {
    const p = a.split('.').map(Number);
    if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return false;
    return p[0] === 10
        || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
        || (p[0] === 192 && p[1] === 168)
        || (p[0] === 169 && p[1] === 254)
        || p[0] === 127;
}

/** IP-адрес локальной сети: 10/8, 172.16/12, 192.168/16, 169.254/16, 127/8; fc00::/7, fe80::/10, ::1. */
export function isLocalIp(host) {
    const h = String(host == null ? '' : host).trim();
    if (IPV4_RE.test(h)) return ipv4Local(h);
    if (!IPV6_RE.test(h)) return false;
    const lower = h.toLowerCase().split('%')[0];
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return ipv4Local(mapped[1]);
    if (lower === '::1') return true;
    const first = lower.startsWith('::') ? 0 : parseInt(lower.split(':')[0], 16);
    if (!Number.isFinite(first)) return false;
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

/** Похоже ли на IP вообще (для слов отказа: «нужен IP-адрес» или «не из локальной сети»). */
export function isIpAddress(host) {
    const h = String(host == null ? '' : host).trim();
    return IPV4_RE.test(h) || IPV6_RE.test(h);
}

// ── звонок прибору: строка состояния ──────────────────────────────────────────
// Ответ lis_listeners.dialing (server/lis/index.js listenerStatus): state —
// connecting / connected / waiting / closed (dial.js) или off (клиент не поднят:
// code bad_address / self / duplicate); у waiting code — причина обрыва.

const WAIT_REASON = {
    refused: 'отказано в соединении — порт прибора закрыт',
    timeout: 'нет ответа',
    unreachable: 'адрес недоступен',
    closed: 'прибор закрыл соединение',
    silent: 'прибор замолчал',
};

const P = (key, params = {}) => ({ key, params });

/**
 * Что сказать о соединении с прибором. Части — ключи словаря с подстановками;
 * экран переводит каждую и соединяет через « · ». params.time — ISO-метка (экран
 * пишет её часами).
 * @returns {{kind:''|'success'|'warn', parts:Array<{key:string, params:object}>}|null}
 */
export function dialLine(entry, now = Date.now()) {
    if (!entry) return null;
    switch (entry.state) {
        case 'connected': {
            const parts = [P('подключено с {time}', { time: entry.since })];
            const rx = Date.parse(entry.last_rx_at);
            if (entry.last_rx_at && Number.isFinite(rx)) {
                const s = Math.max(0, Math.floor((now - rx) / 1000));
                parts.push(s < 120 ? P('сигнал {n} с назад', { n: s }) : P('сигнал {n} мин назад', { n: Math.floor(s / 60) }));
            }
            return { kind: 'success', parts };
        }
        case 'connecting':
            return { kind: '', parts: [P('подключаемся к {host}:{port}…', { host: entry.host, port: entry.port })] };
        case 'waiting': {
            const parts = [P(WAIT_REASON[entry.code] || 'ошибка соединения')];
            const at = Date.parse(entry.retry_at);
            // Время повтора прошло — клиент вот-вот подключается: «через 0 с» не пишем.
            const left = Math.ceil((at - now) / 1000);
            if (entry.retry_at && Number.isFinite(at) && left > 0) parts.push(P('повтор через {n} с', { n: left }));
            return { kind: 'warn', parts };
        }
        case 'off': {
            let key = 'адрес не из локальной сети — не подключаемся';
            if (entry.code === 'self') key = 'это порт самого Easy-Med — не подключаемся';
            else if (entry.code === 'duplicate') key = 'этот адрес и порт уже у другого прибора — не подключаемся';
            else if (!String(entry.host == null ? '' : entry.host).trim()) key = 'адрес прибора не задан — не подключаемся';
            else if (entry.port == null || entry.port === '') key = 'порт прибора не задан — не подключаемся';
            return { kind: 'warn', parts: [P(key)] };
        }
        case 'closed':
            return { kind: '', parts: [P('соединение закрыто')] };
        default:
            return { kind: '', parts: [P('состояние соединения неизвестно')] };
    }
}

/**
 * Подпись строки состояния для решения «перерисовать таблицу»: без секунд
 * («сигнал N с назад», «повтор через N с» меняются каждые 5 с — их экран
 * обновляет на месте, не перестраивая строку с кнопками).
 */
export function dialSig(entry) {
    if (!entry) return '';
    return [entry.state, entry.code || '', entry.since || '', entry.last_rx_at ? 1 : 0, entry.host || '', entry.port || ''].join('|');
}

// ── служебные сообщения за сегодня (lis_service_counts) ──────────────────────

/** Столько запросов рабочего списка за день — повод подсказать выключить запрос на приборе. */
export const QUERY_HINT_MIN = 5;

/**
 * «сегодня: контроль 3, калибровка 1, запросы 12» — только ненулевые части.
 * @returns {{parts:Array<{key:string, params:{n:number}}>, queryHint:boolean}|null}
 */
export function serviceSummary(c) {
    if (!c) return null;
    const parts = [];
    if (Number(c.qc) > 0) parts.push(P('контроль {n}', { n: Number(c.qc) }));
    if (Number(c.calibration) > 0) parts.push(P('калибровка {n}', { n: Number(c.calibration) }));
    if (Number(c.query) > 0) parts.push(P('запросы {n}', { n: Number(c.query) }));
    if (!parts.length) return null;
    return { parts, queryHint: Number(c.query) >= QUERY_HINT_MIN };
}

// ── подпись модели в таблице ─────────────────────────────────────────────────

/**
 * Откуда известны список показателей и формат модели (lis_profiles:
 * channelsSource, wireSource). Раньше всё, что не 'documented', называлось
 * «набор типовой» — и BS-200, у которого типового списка нет вовсе (номера
 * тестов задаёт клиника), и BC-780, сделанный по соседним моделям.
 * @returns {string|null} ключ словаря
 */
export function modelNote(p) {
    if (!p) return null;
    if (p.wireSource === 'driver') return 'формат — по программам других LIS: сверьте первую пробу';
    if (p.wireSource === 'siblings' || p.channelsSource === 'siblings') return 'по документам соседних моделей: сверьте первую пробу';
    if (p.channelsSource === 'device') return 'формат документирован; показатели — из проб прибора';
    if (p.channelsSource === 'documented') return 'формат документирован';
    if (p.channelsSource === 'screenshot') return 'список показателей — со снимка экрана прибора, сверьте по прибору';
    return 'список показателей типовой — сверьте по прибору';
}

// ── колонка «Подключение» ────────────────────────────────────────────────────

/**
 * Кто кому звонит: «сеть · прибор звонит на 2575» или «сеть · Easy-Med звонит
 * 10.0.0.30:5600». Не сеть (старые строки «Кабель COM», «Папка») — null:
 * экран пишет подпись транспорта, как прежде.
 */
export function connectionOf(d) {
    if (!d || d.transport !== 'mllp') return null;
    if (Number(d.dial) === 1) return P('сеть · Easy-Med звонит {host}:{port}', { host: d.host || '—', port: d.port || '—' });
    return P('сеть · прибор звонит на {port}', { port: d.port || 2575 });
}
