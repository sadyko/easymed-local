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
