// lab-devices-lists.test.mjs — где стоит прибор на экране «Анализаторы»
// (LIS_ANALYZER_LIST_V1). Чистое правило: список на входе, раскладка на выходе.
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitDevices, portState, isTruncatedMessage } from './lab-devices-lists.js';
// LIS_REAL_ANALYZERS_V1 (экран) — серия, звонок прибору, служебные, подпись модели, адрес.
import { SERIES_PENDING_PREFIX, SERIES_WINDOW_MIN, splitTray, staleSeriesRest, seriesPendingRest,
  isLocalIp, dialLine, dialSig, serviceSummary, QUERY_HINT_MIN, modelNote, connectionOf, groupReceiving } from './lab-devices-lists.js';
import { SERIES_PENDING_PREFIX as SERVER_PREFIX } from '../../../../server/lis/inbox.js';
import { SERIES_WINDOW_MS } from '../../../../server/lis/match.js';
import { isLocalIp as serverIsLocalIp } from '../../../../server/lis/dial.js';

const D = (id, added, last_seen_at, extra = {}) => ({ id, name: 'П' + id, added, last_seen_at, port: 2575, ...extra });

test('три места: таблица, «Найдены в сети», «Ждут первого сообщения»', () => {
  const s = splitDevices([
    D(1, 1, '2026-09-28T13:52:09Z'),   // добавлен и говорил — таблица
    D(2, 0, '2026-09-29T08:00:00Z'),   // найден сам — ждёт «Добавить»
    D(3, 1, null),                     // добавлен руками, молчит — ждёт сообщения
  ]);
  assert.deepEqual(s.table.map((d) => d.id), [1]);
  assert.deepEqual(s.found.map((d) => d.id), [2]);
  assert.deepEqual(s.waiting.map((d) => d.id), [3]);
});

test('сервер до миграции 228 (added нет) — прибор не пропадает из таблицы', () => {
  const s = splitDevices([{ id: 7, name: 'Старый', last_seen_at: '2026-09-10T17:56:20Z' }]);
  assert.deepEqual(s.table.map((d) => d.id), [7]);
});

test('порт ждущего прибора: слушается, не поднялся, выключен, неизвестно', () => {
  const st = { listening: [2575], failed: [
    { port: 5100, code: 'busy', error: 'LIS: порт 5100 уже занят — вероятно, Easy-Med уже запущен' },
    { port: 5200, code: 'error', error: 'listen EACCES: permission denied 0.0.0.0:5200' },
  ] };
  assert.deepEqual(portState({ port: 2575 }, st), { kind: 'listening', port: 2575 });
  // Ревью M6: причина — кодом; сырой текст сервера (русский, с догадкой о
  // причине) до экрана не доходит — экран говорит своими словами.
  assert.deepEqual(portState({ port: 5100 }, st), { kind: 'failed', port: 5100, code: 'busy' });
  assert.deepEqual(portState({ port: 5200 }, st), { kind: 'failed', port: 5200, code: 'error' });
  assert.deepEqual(portState({ port: 5300 }, { listening: [], failed: [{ port: 5300, error: 'x' }] }),
    { kind: 'failed', port: 5300, code: 'error' }, 'сервер без кода — просто «не слушается»');
  assert.deepEqual(portState({ port: 6000 }, st), { kind: 'off', port: 6000 });
  assert.deepEqual(portState({ port: 2575 }, null), { kind: 'unknown', port: 2575 });
  assert.equal(portState({}, st).port, 2575, 'порт не задан — значит, порт по умолчанию');
});

// LIS_DISCOVERY_FIX_V1 (экран), C2 — от переросшего сообщения в лотке лежит
// только начало; привязать его значит положить в бланк обрезанное число.
test('обрезанное переросшее сообщение узнаётся по статусу и началу строки журнала', () => {
  const cut = { status: 'rejected', detail: 'сообщение больше 4 МБ — не принято; в лотке только его начало' };
  assert.equal(isTruncatedMessage(cut), true);
  assert.equal(isTruncatedMessage({ ...cut, detail: 'сообщение больше 512 КБ — не принято; в лотке только его начало' }), true, 'потолок любой');
  assert.equal(isTruncatedMessage({ ...cut, status: 'unmatched' }), false, 'только «Не разобрано» (rejected)');
  assert.equal(isTruncatedMessage({ status: 'rejected', detail: 'нет сегмента MSH' }), false, 'другое «Не разобрано» — не обрезанное');
  assert.equal(isTruncatedMessage({ status: 'rejected', detail: 'заказ: сообщение больше 4 МБ' }), false, 'признак — НАЧАЛО строки журнала');
  assert.equal(isTruncatedMessage({ status: 'rejected', detail: null }), false);
  assert.equal(isTruncatedMessage({ status: 'rejected' }), false);
  assert.equal(isTruncatedMessage(null), false);
});

// ── LIS_REAL_ANALYZERS_V1 (экран) ─────────────────────────────────────────────
// Серия BS-200 в лотке, звонок прибору, служебные сообщения, подпись модели,
// проверка адреса. Чистые правила: экран лишь переводит их решения.
const NOW = Date.parse('2026-10-01T10:00:00Z');
const minAgo = (m) => new Date(NOW - m * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const M = (id, status, min, detail, extra = {}) => ({ id, status, detail, received_at: minAgo(min), resolved_at: null, ...extra });

test('серия: начало строки «ждём» и окно 60 минут — те же, что у сервера', () => {
  assert.equal(SERIES_PENDING_PREFIX, SERVER_PREFIX, 'экран держит копию строки сервера (server/lis/inbox.js)');
  assert.equal(SERIES_WINDOW_MIN * 60000, SERIES_WINDOW_MS, 'окно серии — как у приёма (server/lis/match.js)');
});

test('лоток: строки «ждём» моложе 60 минут — в «Идёт приём», остальное — в «Необработанные»', () => {
  const pend = (id, min) => M(id, 'unmapped', min, SERIES_PENDING_PREFIX + 'не пришли: Креатинин (3)');
  const s = splitTray([
    pend(1, 5),
    pend(2, 59),
    pend(3, 60),                                              // ровно час — серия уже не идёт
    M(4, 'unmapped', 1, 'не пришли: Креатинин (3)'),          // обычная беда — в лоток
    M(5, 'unmatched', 1, SERIES_PENDING_PREFIX + 'x'),         // не unmapped — в лоток
    pend(6, 1),
    { ...pend(7, 1), resolved_at: '2026-10-01T09:59:00Z' },    // разобрана человеком — не «ждём»
    { ...pend(8, 1), received_at: 'не дата' },                 // время не читается — не прячем
  ], NOW);
  assert.deepEqual(s.receiving.map((m) => m.id), [1, 2, 6]);
  assert.deepEqual(s.tray.map((m) => m.id), [3, 4, 5, 7, 8]);
  assert.equal(seriesPendingRest(pend(1, 5)), 'не пришли: Креатинин (3)');
  assert.equal(seriesPendingRest(M(4, 'unmapped', 1, 'не пришли: X')), null);
  assert.equal(seriesPendingRest(null), null);
  assert.deepEqual(splitTray([], NOW), { receiving: [], tray: [] });
});

test('лоток: метка из будущего (часы компьютера отстают) — серия ещё идёт', () => {
  const m = M(1, 'unmapped', -3, SERIES_PENDING_PREFIX + 'не пришли: X (1)');
  assert.deepEqual(splitTray([m], NOW).receiving.map((x) => x.id), [1]);
  assert.equal(staleSeriesRest(m, NOW), null);
});

test('«Идёт приём результатов»: одна проба (прибор и заказ) — одна строка, самая новая, со счётом сообщений', () => {
  const p = (id, dev, vs, min, rest) => M(id, 'unmapped', min, SERIES_PENDING_PREFIX + rest, { device_id: dev, visit_service_id: vs });
  const g = groupReceiving([
    p(5, 1, 123, 1, 'не пришли: Креатинин (102)'),
    p(4, 1, 124, 2, 'не пришли: Глюкоза (2)'),
    p(3, 1, 123, 3, 'не пришли: Мочевина (3), Креатинин (102)'),
    p(2, 2, 123, 4, 'не пришли: X (1)'),          // другой прибор — своя строка
    p(1, 1, null, 5, 'не пришли: Y (1)'),         // без заказа — по одной
    p(0, 1, null, 6, 'не пришли: Z (1)'),
  ]);
  assert.deepEqual(g.map((x) => [x.id, x.count]), [[5, 2], [4, 1], [2, 1], [1, 1], [0, 1]]);
  assert.deepEqual(groupReceiving([]), []);
  // Лоток отсортирован по received_at — у сообщений одной секунды порядок не
  // задан, и раньше «самой новой» становилась первая попавшаяся. Новее — номер строки.
  const tie = groupReceiving([p(10, 1, 123, 1, 'не пришли: Мочевина (3), Креатинин (102)'), p(11, 1, 123, 1, 'не пришли: Креатинин (102)')]);
  assert.deepEqual(tie.map((x) => [x.id, x.count, seriesPendingRest(x)]), [[11, 2, 'не пришли: Креатинин (102)']]);
});

test('серия не дошла за 60 минут — «не дошла до конца» с остатком строки, без слова «ждём»', () => {
  const m = M(1, 'unmapped', 61, SERIES_PENDING_PREFIX + 'не пришли: Креатинин (3)');
  assert.equal(staleSeriesRest(m, NOW), 'не пришли: Креатинин (3)');
  assert.equal(staleSeriesRest({ ...m, received_at: minAgo(10) }, NOW), null, 'серия ещё идёт');
  assert.equal(staleSeriesRest(M(2, 'unmapped', 90, 'не пришли: X'), NOW), null, 'обычная строка — как есть');
});

test('адрес звонка: те же правила, что у сервера (server/lis/dial.js isLocalIp)', () => {
  const cases = ['10.0.0.30', '10.255.255.255', '172.16.0.1', '172.31.255.255', '172.15.0.1', '172.32.0.1',
    '192.168.1.20', '192.169.1.1', '169.254.3.4', '127.0.0.1', '127.9.9.9', '8.8.8.8', '1.1.1.1', '0.0.0.0',
    '255.255.255.255', ' 10.0.0.30 ', '010.0.0.1', '10.0.0.01', '10.0.0', '10.0.0.0.1', '256.1.1.1', '10.0.0.-1',
    'bc780.local', 'localhost', '', null, undefined, '::1', '::', '::ffff:10.0.0.1', '::ffff:8.8.8.8', '::FFFF:192.168.0.1',
    'fc00::1', 'fd12:3456::1', 'fe80::1', 'FE80::1', 'fe80::1%eth0', 'fe80::1%1', 'fe80::1%', 'fe80::1%eth 0',
    'fec0::1', '2001:db8::1', '2a00:1450::1', '1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8:9', '1::2::3', 'g::1', '[::1]',
    '12345::1', '::1.2.3.4', '::ffff:0a00:0001', '1:2:3:4:5:6:1.2.3.4', 'fd00::10.0.0.1', '10.0.0.30:5600', 5600, '10 .0.0.1',
    'fe80::', 'fe80:0:0:0:0:0:0:1', '1:2:3:4:5:6:7::', '::2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8::', 'fd00::1%eth0.5', 'fd00::1%a:b'];
  for (const c of cases) assert.equal(isLocalIp(c), serverIsLocalIp(c), JSON.stringify(c));
  assert.equal(isLocalIp('10.0.0.30'), true);
  assert.equal(isLocalIp('8.8.8.8'), false);
  assert.equal(isLocalIp('bc780.local'), false, 'имя — обращение к DNS, не принимается');
});

test('звонок прибору: подключено — с какого времени и когда был сигнал', () => {
  const now = Date.parse('2026-10-01T10:02:30Z');
  const e = { device_id: 7, host: '10.0.0.30', port: 5600, state: 'connected', since: '2026-10-01T10:02:00Z', last_rx_at: '2026-10-01T10:02:28Z', code: null, retry_at: null };
  assert.deepEqual(dialLine(e, now), { kind: 'success', parts: [
    { key: 'подключено с {time}', params: { time: '2026-10-01T10:02:00Z' } },
    { key: 'сигнал {n} с назад', params: { n: 2 } },
  ] });
  assert.deepEqual(dialLine({ ...e, last_rx_at: '2026-10-01T09:55:00Z' }, now).parts[1], { key: 'сигнал {n} мин назад', params: { n: 7 } });
  assert.equal(dialLine({ ...e, last_rx_at: null }, now).parts.length, 1, 'сигнала не было — о нём ни слова');
  assert.deepEqual(dialLine({ ...e, last_rx_at: '2026-10-01T10:02:40Z' }, now).parts[1], { key: 'сигнал {n} с назад', params: { n: 0 } }, 'часы вперёд — не минус');
});

test('звонок прибору: ждём повтора — причина словами и через сколько повтор', () => {
  const now = Date.parse('2026-10-01T10:00:00Z');
  const w = (code) => dialLine({ device_id: 7, host: '10.0.0.30', port: 5600, state: 'waiting', since: '2026-10-01T09:59:58Z', last_rx_at: null, code, retry_at: '2026-10-01T10:00:29.200Z' }, now);
  const reasons = { refused: 'отказано в соединении — порт прибора закрыт', timeout: 'нет ответа', unreachable: 'адрес недоступен',
    closed: 'прибор закрыл соединение', silent: 'прибор замолчал', error: 'ошибка соединения', other: 'ошибка соединения' };
  for (const [code, key] of Object.entries(reasons)) {
    assert.deepEqual(w(code), { kind: 'warn', parts: [{ key, params: {} }, { key: 'повтор через {n} с', params: { n: 30 } }] }, code);
  }
  const late = dialLine({ state: 'waiting', code: 'timeout', retry_at: '2026-10-01T09:59:00Z' }, now);
  assert.equal(late.parts.length, 1, 'время повтора прошло — клиент вот-вот подключается: «через 0 с» не пишем');
  assert.equal(dialLine({ state: 'waiting', code: 'timeout', retry_at: null }, now).parts.length, 1);
});

test('звонок прибору: не подключаемся — адрес, порт, петля на себя, дубль; подключаемся; закрыто', () => {
  const off = (code, port = 5600) => dialLine({ device_id: 7, host: '8.8.8.8', port, state: 'off', code }, Date.now());
  assert.deepEqual(off('bad_address'), { kind: 'warn', parts: [{ key: 'адрес не из локальной сети — не подключаемся', params: {} }] });
  assert.equal(off('bad_address', null).parts[0].key, 'порт прибора не задан — не подключаемся');
  assert.equal(dialLine({ state: 'off', code: 'bad_address', host: '', port: 5600 }).parts[0].key, 'адрес прибора не задан — не подключаемся');
  assert.equal(off('self').parts[0].key, 'это порт самого Easy-Med — не подключаемся');
  assert.equal(off('duplicate').parts[0].key, 'этот адрес и порт уже у другого прибора — не подключаемся');
  assert.deepEqual(dialLine({ state: 'connecting', host: '10.0.0.30', port: 5600 }), { kind: '', parts: [{ key: 'подключаемся к {host}:{port}…', params: { host: '10.0.0.30', port: 5600 } }] });
  assert.deepEqual(dialLine({ state: 'closed' }), { kind: '', parts: [{ key: 'соединение закрыто', params: {} }] });
  assert.equal(dialLine(null), null);
});

test('подпись звонка для перерисовки — без секунд: «сигнал N с назад» не перестраивает таблицу', () => {
  const e = { device_id: 7, state: 'connected', since: '2026-10-01T10:02:00Z', last_rx_at: '2026-10-01T10:02:28Z', code: null, retry_at: null };
  assert.equal(dialSig(e), dialSig({ ...e, last_rx_at: '2026-10-01T10:02:33Z' }));
  assert.equal(dialSig({ ...e, state: 'waiting', code: 'refused', retry_at: 'a' }), dialSig({ ...e, state: 'waiting', code: 'refused', retry_at: 'b' }));
  assert.notEqual(dialSig(e), dialSig({ ...e, state: 'waiting', code: 'closed' }));
  assert.notEqual(dialSig(e), dialSig({ ...e, last_rx_at: null }), 'сигнал появился — у строки появилась вторая часть');
  assert.equal(dialSig(null), '');
});

test('служебные сообщения за сегодня: только ненулевые, подсказка — когда запросов много', () => {
  assert.equal(serviceSummary(null), null);
  assert.equal(serviceSummary({ device_id: 1, qc: 0, calibration: 0, query: 0 }), null);
  assert.deepEqual(serviceSummary({ device_id: 1, qc: 3, calibration: 1, query: 12 }), {
    parts: [{ key: 'контроль {n}', params: { n: 3 } }, { key: 'калибровка {n}', params: { n: 1 } }, { key: 'запросы {n}', params: { n: 12 } }],
    queryHint: true });
  assert.deepEqual(serviceSummary({ device_id: 1, qc: 2, calibration: 0, query: QUERY_HINT_MIN - 1 }).parts.map((p) => p.key), ['контроль {n}', 'запросы {n}']);
  assert.equal(serviceSummary({ device_id: 1, qc: 0, calibration: 0, query: QUERY_HINT_MIN - 1 }).queryHint, false);
  assert.equal(serviceSummary({ device_id: 1, qc: 0, calibration: 0, query: QUERY_HINT_MIN }).queryHint, true);
});

test('подпись модели — по тому, откуда известен список показателей и формат', () => {
  assert.equal(modelNote(null), null);
  assert.equal(modelNote({ channelsSource: 'documented' }), 'формат документирован');
  assert.equal(modelNote({ channelsSource: 'screenshot' }), 'список показателей — со снимка экрана прибора, сверьте по прибору');
  assert.equal(modelNote({ channelsSource: 'conventional' }), 'список показателей типовой — сверьте по прибору');
  assert.equal(modelNote({}), 'список показателей типовой — сверьте по прибору', 'сервер старее — как раньше');
  // BS-200: формат по руководству, показатели задаёт клиника — не «набор типовой».
  assert.equal(modelNote({ channelsSource: 'device', wireSource: 'documented' }), 'формат документирован; показатели — из проб прибора');
  // A1000: формат по чужим рабочим программам.
  assert.equal(modelNote({ channelsSource: 'device', wireSource: 'driver' }), 'формат — по программам других LIS: сверьте первую пробу');
  // BC-780: по документам соседних моделей.
  assert.equal(modelNote({ channelsSource: 'siblings', wireSource: 'siblings' }), 'по документам соседних моделей: сверьте первую пробу');
});

test('колонка «Подключение»: кто кому звонит', () => {
  assert.deepEqual(connectionOf({ transport: 'mllp', host: '10.0.0.30', port: 5600, dial: 1 }), { key: 'сеть · Easy-Med звонит {host}:{port}', params: { host: '10.0.0.30', port: 5600 } });
  assert.deepEqual(connectionOf({ transport: 'mllp', host: '10.0.0.20', port: 2575, dial: 0 }), { key: 'сеть · прибор звонит на {port}', params: { port: 2575 } });
  assert.deepEqual(connectionOf({ transport: 'mllp', host: '', port: null }), { key: 'сеть · прибор звонит на {port}', params: { port: 2575 } }, 'порт по умолчанию; dial нет — сервер старее');
  assert.deepEqual(connectionOf({ transport: 'mllp', host: '', port: null, dial: 1 }).params, { host: '—', port: '—' });
  assert.equal(connectionOf({ transport: 'serial' }), null, 'кабель COM — подписью транспорта, как прежде');
});

// ── LIS_VENDOR_EXACT_V1 — D14: соединения с портом приёма (lis_listeners.peers) ──
// Прибор подключился и шлёт не то (ASTM, формат Autobio, Unicode) — раньше это
// выглядело так же, как «никто не подключался». Теперь — строкой с адресом и
// подсказкой, что поправить на приборе; подключился и молчит — «ждёт первую пробу».
test('D14: соединения — непонятные данные с подсказкой; подключён и молчит — ждёт первую пробу', async () => {
  const { peerNotes, NOISE_HINT, PEER_NOISE_WINDOW_MIN } = await import('./lab-devices-lists.js');
  assert.equal(typeof peerNotes, 'function');
  const NOW = Date.parse('2026-10-06T08:00:00Z');
  const ago = (min) => new Date(NOW - min * 60000).toISOString();
  const peer = (over) => ({ ip: '192.168.1.33', port: 2575, connectedAt: ago(5), lastRxAt: ago(1), frames: 0, noiseBytes: 0, noiseHint: null, open: true, ...over });

  // Непонятное — по подсказке слушателя; неизвестная подсказка — «неизвестный формат».
  assert.deepEqual(NOISE_HINT, {
    astm: 'похоже на ASTM',
    autobio: 'похоже на собственный формат Autobio — выберите HL7',
    utf16: 'кодировка Unicode — выберите UTF-8',
    'hl7-unframed': 'HL7 без рамки MLLP',
    other: 'неизвестный формат',
  });
  const NOISE = 'С адреса {ip} приходят данные, которые Easy-Med не понимает ({hint}). Проверьте на анализаторе протокол HL7.';
  for (const [hint, key] of [['astm', NOISE_HINT.astm], ['autobio', NOISE_HINT.autobio], ['utf16', NOISE_HINT.utf16],
    ['hl7-unframed', NOISE_HINT['hl7-unframed']], ['other', NOISE_HINT.other], [null, NOISE_HINT.other], ['что-то новое', NOISE_HINT.other]]) {
    assert.deepEqual(peerNotes([peer({ noiseBytes: 412, noiseHint: hint })], [], NOW),
      [{ ip: '192.168.1.33', kind: 'warn', key: NOISE, params: { ip: '192.168.1.33' }, hintKey: key }], String(hint));
  }
  // Подключён, ничего не прислал — ждёт первую пробу.
  const WAIT = 'Прибор {ip} подключён и ждёт первую пробу';
  assert.deepEqual(peerNotes([peer({ ip: '::ffff:192.168.1.40', lastRxAt: null })], [], NOW),
    [{ ip: '192.168.1.40', kind: '', key: WAIT, params: { ip: '192.168.1.40' }, hintKey: null }], 'адрес IPv4 — без «::ffff:»');
  // Кадры идут — прибор работает, строки нет (даже если между кадрами был мусор).
  assert.deepEqual(peerNotes([peer({ frames: 3 }), peer({ frames: 2, noiseBytes: 4, noiseHint: 'other' })], [], NOW), []);
  // Прибор с этого адреса уже присылал пробы (в таблице) — переподключился и ждёт: не «первую пробу».
  assert.deepEqual(peerNotes([peer({})], [{ host: '192.168.1.33', last_seen_at: ago(600) }], NOW), []);
  // Строка прибора есть, но он ни разу не присылал — подсказка нужна.
  assert.equal(peerNotes([peer({})], [{ host: '192.168.1.33', last_seen_at: null }], NOW).length, 1);
  // Соединение закрыто: непонятное — пока свежее; ожидание — нет (соединения уже нет).
  assert.equal(peerNotes([peer({ open: false, noiseBytes: 20, noiseHint: 'astm', lastRxAt: ago(PEER_NOISE_WINDOW_MIN - 1) })], [], NOW).length, 1);
  assert.deepEqual(peerNotes([peer({ open: false, noiseBytes: 20, noiseHint: 'astm', lastRxAt: ago(PEER_NOISE_WINDOW_MIN + 1) })], [], NOW), []);
  assert.deepEqual(peerNotes([peer({ open: false })], [], NOW), []);
  // Один адрес — одна строка; непонятное важнее ожидания; сначала беды, потом ожидание.
  const many = peerNotes([
    peer({ ip: '192.168.1.50' }),
    peer({ ip: '192.168.1.33', noiseBytes: 10, noiseHint: 'astm' }),
    peer({ ip: '192.168.1.33' }),
    peer({ ip: '192.168.1.33', noiseBytes: 30, noiseHint: 'astm' }),
  ], [], NOW);
  assert.deepEqual(many.map((n) => [n.ip, n.kind]), [['192.168.1.33', 'warn'], ['192.168.1.50', '']]);
  // Нет ответа сервера или списка — строк нет.
  assert.deepEqual(peerNotes(undefined, [], NOW), []);
  assert.deepEqual(peerNotes([null, 'мусор', { open: true }], [], NOW), [], 'без адреса строки нет');
});

// ── LIS_VENDOR_EXACT_V1 — D10: непрочитанные буквы (U+FFFD) в сообщении лотка ──
test('D10: сообщение с U+FFFD узнаётся — лоток скажет, что коды тестов должны быть латиницей', async () => {
  const { hasUnreadableText } = await import('./lab-devices-lists.js');
  const BAD = String.fromCharCode(0xFFFD);
  assert.equal(hasUnreadableText({ raw: 'OBX|1|NM|' + BAD + BAD + BAD + '|Glucose|5.23' }), true);
  assert.equal(hasUnreadableText({ raw: 'OBX|1|NM|GLU|Глюкоза|5.23' }), false, 'кириллица, прочитанная верно, — не беда');
  assert.equal(hasUnreadableText({ raw: null }), false);
  assert.equal(hasUnreadableText(null), false);
});
