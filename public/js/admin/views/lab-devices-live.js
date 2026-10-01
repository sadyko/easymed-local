// LIS_INGEST_V1 — ЧТО ГОВОРИТЬ О СВЯЗИ с анализатором. Чистая функция: ни DOM,
// ни словаря, ни базы — только метка времени на входе и решение на выходе.
// Тот же приём, что у lab-grouping.js и lab-doc.js: правило живёт отдельно от
// экрана, потому что проверять надо правило, а не разметку.
//
// ПОЧЕМУ ЗДЕСЬ НЕТ ЛАМПОЧКИ «ОНЛАЙН».
// Связь по MLLP не постоянная, и это устройство протокола, а не наша недоделка:
// прибор соединяется, отдаёт пробу, получает ACK и разъединяется. Между пробами
// соединения нет НИ У РАБОТАЮЩЕГО прибора, ни у выключенного — наблюдать
// нечего, и «подключён ли он сейчас» вопрос без ответа. Индикатор «онлайн»
// врал бы в обе стороны: гас бы на исправном приборе между пробами и горел бы
// на выключенном, пока кто-нибудь не заметит.
//
// Единственный честный признак — КОГДА от прибора в последний раз что-то
// пришло. Он же и полезнее: «молчит 40 минут» говорит лаборанту ровно то, что
// ему нужно решить.

// LIS_REAL_ANALYZERS_V1 (экран) — строка серии «ждём» и окно серии: одно правило
// с лотком (lab-devices-lists.js; тот же ?v=, что у lab-devices.js, — один модуль).
import { seriesPendingRest, SERIES_WINDOW_MIN } from './lab-devices-lists.js?v=lists4';

/** Окно, внутри которого прибор считается работающим. */
export const LIVE_WINDOW_MIN = 5;

/**
 * @param {string|null} lastSeen  ISO-метка последнего принятого сообщения
 * @param {number} now            «сейчас» в мс (в тестах фиксируется)
 * @returns {{kind:'idle'|'success'|'warn', key:string, params:object}}
 *          key — строка-источник для словаря; экран сам её переводит.
 */
export function liveness(lastSeen, now = Date.now()) {
    const NEVER = { kind: 'idle', key: 'ни одного сообщения', params: {} };
    if (!lastSeen) return NEVER;

    const at = new Date(lastSeen).getTime();
    // Часы прибора могут уехать вперёд. Метка из будущего — повод не верить ей,
    // а не показывать «на связи»: иначе выключенный прибор с кривыми часами
    // выглядел бы работающим.
    if (!Number.isFinite(at) || now - at < 0) return NEVER;

    const min = Math.floor((now - at) / 60000);
    if (min < LIVE_WINDOW_MIN) return { kind: 'success', key: 'на связи', params: {} };
    if (min < 60) return { kind: 'warn', key: 'молчит {n} мин', params: { n: min } };

    const hours = Math.floor(min / 60);
    if (hours < 24) return { kind: 'warn', key: 'молчит {n} ч', params: { n: hours } };
    return { kind: 'warn', key: 'не отвечает с {when}', params: { when: lastSeen } };
}

// ═══ LIS_REAL_ANALYZERS_V1 (экран) — серия в живой ленте ═════════════════════
//
// BS-200 и A1000 шлют по тесту в сообщении: проба из пяти тестов — пять строк
// ленты, и десять строк ленты показывали бы две пробы. Сообщения одной серии
// (один прибор, один заказ, не дальше 60 минут от самого нового — как у приёма,
// server/lis/match.js) собираются в одну строку: «LAB-000123 · Иванов · BS-200 ·
// 5 сообщений · принято». Склеиваются только принятые и ждущие (applied,
// unmapped) — как серия приёма; «Не найден заказ», «Результат уже выдан» и
// неразобранное идут по одному, как прежде. Значения у всех строк одного заказа
// одни (lis_recent берёт их из бланка) — в строке они и показаны.

/** Ключ серии строки ленты: прибор (номер, у старого сервера — имя) и заказ; null — строку не склеивать. */
function seriesKey(r) {
    if (!r || !r.visit_service_id) return null;
    if (r.status !== 'applied' && r.status !== 'unmapped') return null;
    const dev = r.device_id != null ? 'id:' + r.device_id : 'name:' + (r.device_name || '');
    return dev + '|' + r.visit_service_id;
}

function freshPending(r, now) {
    if (seriesPendingRest(r) == null) return false;
    const at = Date.parse(r.received_at);
    return Number.isFinite(at) && (now - at) / 60000 < SERIES_WINDOW_MIN;
}

/**
 * Состояние строки ленты: 'unmapped' — в серии есть беда, ждущая человека
 * (повтор, неподтверждённое, серия, не дошедшая за час); 'receiving' — серия ещё
 * идёт; иначе — состояние самого нового сообщения (applied и прочие, как прежде).
 */
function groupStatus(rows, now) {
    if (rows.some((r) => r.status === 'unmapped' && !r.resolved_at && !freshPending(r, now))) return 'unmapped';
    if (rows.some((r) => freshPending(r, now))) return 'receiving';
    return rows[0].status;
}

/**
 * @param {object[]} rows  ответ lis_recent — от новых к старым
 * @param {number} now     «сейчас» в мс (в тестах фиксируется)
 * @returns {object[]} строки ленты: самое новое сообщение серии + count, ids, status
 */
export function groupSeries(rows = [], now = Date.now()) {
    const groups = [];
    const open = new Map();
    for (const r of rows || []) {
        const key = seriesKey(r);
        const at = Date.parse(r.received_at);
        const g = key ? open.get(key) : null;
        if (g && Number.isFinite(at) && Number.isFinite(g.at) && g.at - at >= 0 && g.at - at <= SERIES_WINDOW_MIN * 60000) {
            g.rows.push(r);
            continue;
        }
        const ng = { at, rows: [r] };
        groups.push(ng);
        if (key) open.set(key, ng);
    }
    return groups.map((g) => ({ ...g.rows[0], count: g.rows.length, ids: g.rows.map((r) => r.id), status: groupStatus(g.rows, now) }));
}
