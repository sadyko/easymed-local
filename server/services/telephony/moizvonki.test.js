// MOIZVONKI_V2 — история звонков «Моих Звонков» по действующей документации
// (https://www.moizvonki.ru/guide/api/, прочитано 2026-10-17): действие
// `calls.list` с курсором from_id / from_date и страницами from_offset →
// results_next_offset; разбор звонка в словарь журнала (normalizeMzCall):
// направление, номер клиента, почта сотрудника как «кто», итог ANSWER /
// NOANSWER, запись разговора — полем recording, которое находит общий разбор.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mzListCalls, mzHistory, normalizeMzCall } from './moizvonki.js';
import { recordingUrlOf } from './recording.js';

const OPTS = { userName: 'boss@clinic.uz', apiKey: 'TESTONLY-key' };
const jsonRes = (body) => ({ ok: true, status: 200, headers: { get: () => null }, body: null, text: async () => JSON.stringify(body),
  // readBounded читает поток; для подмены достаточно arrayBuffer/text — см. control/checkin.js
  arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer });

function stub(pages, seen = []) {
  // pages: массив тел ответа по порядку вызовов
  let i = 0;
  return async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(init.body) });
    const page = pages[Math.min(i, pages.length - 1)];
    const body = typeof page === 'function' ? page(i) : page;
    i += 1;
    return jsonRes(body);
  };
}

const CALL = {
  direction: 0, user_account: 'reg@clinic.uz', user_id: 7, client_number: '+998 90 123-45-67', client_name: '',
  start_time: 1760000000, answer_time: 1760000012, end_time: 1760000100, upload_time: 1760000200, duration: 88,
  src_number: '+998711234567', src_id: 3, src_slot: 0, recording: 'https://clinic.moizvonki.ru/rec/abc.mp3',
  answered: 1, db_call_id: 1224, event_pbx_call_id: '1.1760000000',
};

test('mzListCalls: действие calls.list, подпись в теле, from_id/from_offset/max_results/supervised — как в документации', async () => {
  const seen = [];
  const r = await mzListCalls('clinic.moizvonki.ru', { fromId: 1225 }, { ...OPTS, fetchImpl: stub([{ results: [CALL], results_count: 1, results_next_offset: 0, results_remains: 0 }], seen) });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.data.map((c) => c.db_call_id), [1224]);
  assert.equal(r.truncated, false);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://clinic.moizvonki.ru/api/v1');
  const b = seen[0].body;
  assert.equal(b.action, 'calls.list');
  assert.equal(b.user_name, OPTS.userName);
  assert.equal(b.api_key, OPTS.apiKey);
  assert.equal(b.from_id, 1225);
  assert.equal(b.supervised, 1);
  assert.equal(b.max_results, 100);
  assert.equal(b.from_offset, 0);
  assert.ok(!('from_date' in b), 'при from_id дата не посылается — документация берёт только from_id');
});

test('mzListCalls: без from_id — from_date; страницы идут по results_next_offset, пока results_remains > 0; предел страниц честно отмечен', async () => {
  const seen = [];
  const pages = [
    { results: [{ ...CALL, db_call_id: 1 }, { ...CALL, db_call_id: 2 }], results_count: 2, results_next_offset: 2, results_remains: 3 },
    { results: [{ ...CALL, db_call_id: 3 }, { ...CALL, db_call_id: 4 }], results_count: 2, results_next_offset: 4, results_remains: 1 },
    { results: [{ ...CALL, db_call_id: 5 }], results_count: 1, results_next_offset: 5, results_remains: 0 },
  ];
  const r = await mzListCalls('clinic.moizvonki.ru', { fromDate: 1759990000 }, { ...OPTS, fetchImpl: stub(pages, seen) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.map((c) => c.db_call_id), [1, 2, 3, 4, 5]);
  assert.deepEqual(seen.map((s) => [s.body.from_date, s.body.from_offset]), [[1759990000, 0], [1759990000, 2], [1759990000, 4]]);
  const seen2 = [];
  const endless = (i) => ({ results: [{ ...CALL, db_call_id: 9 + i }], results_count: 1, results_next_offset: i + 1, results_remains: 999 });
  const r2 = await mzListCalls('clinic.moizvonki.ru', { fromDate: 1 }, { ...OPTS, fetchImpl: stub([endless], seen2), maxPages: 3 });
  assert.equal(r2.ok, true);
  assert.equal(r2.truncated, true);
  assert.equal(seen2.length, 3);
});

test('mzListCalls: отказ на второй странице — отказ с той же причиной, собранное отдаётся; пустые учётные данные — без запроса', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    if (n === 1) return jsonRes({ results: [{ ...CALL, db_call_id: 1 }], results_next_offset: 1, results_remains: 5 });
    return { ok: false, status: 429, text: async () => '' };
  };
  const r = await mzListCalls('clinic.moizvonki.ru', { fromDate: 1 }, { ...OPTS, fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'rate_limited');
  assert.deepEqual(r.data.map((c) => c.db_call_id), [1]);
  const none = await mzListCalls('clinic.moizvonki.ru', { fromDate: 1 }, { userName: '', apiKey: '', fetchImpl: async () => { throw new Error('must not fetch'); } });
  assert.deepEqual(none, { ok: false, reason: 'bad_credentials', data: [] });
});

test('mzHistory (проверка связи): тоже calls.list, по дате, одна страница', async () => {
  const seen = [];
  const r = await mzHistory('clinic.moizvonki.ru', 1760000000, { ...OPTS, fetchImpl: stub([{ results: [CALL], results_next_offset: 0, results_remains: 0 }], seen) });
  assert.equal(r.ok, true);
  assert.equal(seen[0].body.action, 'calls.list');
  assert.equal(seen[0].body.from_date, 1760000000);
  assert.ok(Array.isArray(r.data.results) && r.data.results.length === 1, 'ответ провайдера отдаётся как есть — testProvider читает results');
});

test('normalizeMzCall: входящий отвеченный — словарь журнала: id, время, направление, номер, почта, ожидание/разговор, ANSWER, запись', () => {
  const c = normalizeMzCall(CALL);
  assert.equal(c.general_call_id, 'moizvonki:1224');
  assert.equal(c.started_at, '2025-10-09T08:53:20Z');
  assert.equal(c.call_type, 0);
  assert.equal(c.external_number, '+998 90 123-45-67', 'номер отдаётся как есть — приводит recordCall');
  assert.equal(c.internal_number, 'reg@clinic.uz');
  assert.equal(c.waitsec, 12);
  assert.equal(c.billsec, 88);
  assert.equal(c.disposition, 'ANSWER');
  assert.equal(c.internal, false);
  assert.equal(c.is_new_call, null);
  assert.equal(recordingUrlOf(c.raw), 'https://clinic.moizvonki.ru/rec/abc.mp3', 'запись находит общий разбор');
});

test('normalizeMzCall: пропущенный входящий — NOANSWER, ожидание = длительность звонка, разговора нет; исходящий — call_type 1', () => {
  const missed = normalizeMzCall({ ...CALL, db_call_id: 2, answered: 0, answer_time: 0, duration: 0, end_time: 1760000025, recording: '' });
  assert.equal(missed.general_call_id, 'moizvonki:2');
  assert.equal(missed.disposition, 'NOANSWER');
  assert.equal(missed.waitsec, 25);
  assert.equal(missed.billsec, 0);
  assert.equal(recordingUrlOf(missed.raw), '');
  const out = normalizeMzCall({ ...CALL, db_call_id: 3, direction: 1 });
  assert.equal(out.call_type, 1);
  assert.equal(out.external_number, '+998 90 123-45-67');
});

test('normalizeMzCall: без db_call_id — по event_pbx_call_id; без обоих или без времени — null; без почты — номер сим-карты', () => {
  const byEvent = normalizeMzCall({ ...CALL, db_call_id: undefined });
  assert.equal(byEvent.general_call_id, 'moizvonki:1.1760000000');
  assert.equal(normalizeMzCall({ ...CALL, db_call_id: undefined, event_pbx_call_id: undefined }), null);
  assert.equal(normalizeMzCall({ ...CALL, start_time: 0 }), null);
  assert.equal(normalizeMzCall(null), null);
  assert.equal(normalizeMzCall({ ...CALL, user_account: undefined }).internal_number, '+998711234567');
});
